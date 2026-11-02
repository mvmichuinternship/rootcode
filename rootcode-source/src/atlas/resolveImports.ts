// Maps an import specifier to the repo file it points at (null for third-party / stdlib).
// Pure path logic against a Set of repo-relative files, so it never touches the filesystem per import.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtractedImport, ImportBinding, Language } from './types';

const posix = path.posix;
const TS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

interface Aliases {
	baseUrl: string;
	hasBaseUrl: boolean;
	rules: { prefix: string; wildcard: boolean; targets: { prefix: string; wildcard: boolean }[] }[];
}

function loadJsonLenient(file: string): { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | null {
	try {
		const raw = fs.readFileSync(file, 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '')
			.replace(/,(\s*[}\]])/g, '$1');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** tsconfig `baseUrl` + `paths` (root tsconfig only; `extends` is not followed). */
function loadTsAliases(repoRoot: string): Aliases {
	for (const name of ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json']) {
		const opts = loadJsonLenient(path.join(repoRoot, name))?.compilerOptions;
		if (!opts) { continue; }
		const baseUrl = posix.normalize(opts.baseUrl || '.');
		const rules = Object.entries(opts.paths || {}).map(([pattern, targets]) => ({
			prefix: pattern.replace(/\*$/, ''),
			wildcard: pattern.endsWith('*'),
			targets: targets.map(t => ({ prefix: t.replace(/\*$/, ''), wildcard: t.endsWith('*') })),
		}));
		return { baseUrl: baseUrl === '.' ? '' : baseUrl, hasBaseUrl: !!opts.baseUrl, rules };
	}
	return { baseUrl: '', hasBaseUrl: false, rules: [] };
}

export type ResolvedBinding = ImportBinding & { path: string | null };
export interface ResolvedImport { path: string | null; bindings: ResolvedBinding[] }

export interface ImportResolver {
	resolveImport(fromFile: string, lang: Language, imp: ExtractedImport): ResolvedImport;
}

export function createResolver(repoRoot: string, fileSet: Set<string>): ImportResolver {
	const aliases = loadTsAliases(repoRoot);
	const has = (p: string) => fileSet.has(p);

	function tryTsFile(base: string): string | null {
		if (has(base)) { return base; }
		const jsStripped = base.replace(/\.(m|c)?jsx?$/, '');
		if (jsStripped !== base) {
			for (const e of ['.ts', '.tsx']) { if (has(jsStripped + e)) { return jsStripped + e; } }
		}
		for (const e of TS_EXTS) { if (has(base + e)) { return base + e; } }
		for (const e of TS_EXTS) { if (has(posix.join(base, 'index' + e))) { return posix.join(base, 'index' + e); } }
		return null;
	}

	function resolveTs(fromFile: string, spec: string): string | null {
		if (spec.startsWith('.')) { return tryTsFile(posix.normalize(posix.join(posix.dirname(fromFile), spec))); }
		for (const rule of aliases.rules) {
			if (!(rule.wildcard ? spec.startsWith(rule.prefix) : spec === rule.prefix)) { continue; }
			const rest = rule.wildcard ? spec.slice(rule.prefix.length) : '';
			for (const t of rule.targets) {
				const hit = tryTsFile(posix.normalize(posix.join(aliases.baseUrl, t.prefix + (t.wildcard ? rest : ''))));
				if (hit) { return hit; }
			}
		}
		return aliases.hasBaseUrl ? tryTsFile(posix.normalize(posix.join(aliases.baseUrl, spec))) : null;
	}

	function tryPyModule(base: string): string | null {
		if (has(base + '.py')) { return base + '.py'; }
		if (has(posix.join(base, '__init__.py'))) { return posix.join(base, '__init__.py'); }
		return null;
	}

	function resolvePy(fromFile: string, spec: string, level: number): string | null {
		const rel = spec.replace(/\./g, '/');
		if (level > 0) {
			let dir = posix.dirname(fromFile);
			for (let i = 1; i < level; i++) { dir = posix.dirname(dir); }
			if (rel) { return tryPyModule(posix.normalize(posix.join(dir, rel))); }
			return tryPyModule(posix.join(dir, '__init__')) ?? (has(posix.join(dir, '__init__.py')) ? posix.join(dir, '__init__.py') : null);
		}
		if (!rel) { return null; }
		for (const root of ['', 'src', posix.dirname(fromFile)]) {
			const hit = tryPyModule(posix.normalize(posix.join(root, rel)));
			if (hit) { return hit; }
		}
		return null;
	}

	return {
		resolveImport(fromFile, lang, imp) {
			const level = imp.level ?? 0;
			const modulePath = lang === 'python' ? resolvePy(fromFile, imp.spec, level) : resolveTs(fromFile, imp.spec);
			const bindings: ResolvedBinding[] = imp.bindings.map(b => {
				if (lang === 'python') {
					if (b.kind === 'module') { return { ...b, kind: 'namespace', path: modulePath }; }
					// `from pkg import name` — name may be a submodule or a symbol in pkg/__init__.py
					const sub = resolvePy(fromFile, [imp.spec, b.imported].filter(Boolean).join('.'), level);
					return sub ? { ...b, kind: 'namespace', path: sub } : { ...b, path: modulePath };
				}
				return { ...b, path: modulePath };
			});
			return { path: modulePath, bindings };
		},
	};
}
