import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AtlasIndex } from './AtlasIndex';
import type { GitTimelineIndex } from './GitTimelineIndex';
import type { FileDiagnostics } from './LSPBridge';
import { fileNeighbors } from './queries';
import type { EntryPoint } from './types';

export interface ResolverInputs {
	root: string;
	index: AtlasIndex;
	git: GitTimelineIndex;
	active?: { path: string; line: number };
	diagnostics: Map<string, FileDiagnostics>;
	/** Files open in editor tabs, in tab order. */
	openTabs?: string[];
	/** Text selected in the active editor; identifiers in it count as mentions. */
	selection?: string;
}

const MAX_PER_SOURCE = 5;

/** Files whose name (or path suffix) the user mentioned. String match on file paths only. */
export function mentionedFiles(query: string, files: string[]): string[] {
	const q = query.toLowerCase();
	const words = new Set(q.split(/[^a-z0-9_.\-/]+/).map(w => w.replace(/^[./]+|[.,;:]+$/g, '')).filter(Boolean));
	const hits: { path: string; score: number }[] = [];
	for (const f of files) {
		const lower = f.toLowerCase();
		const base = path.posix.basename(lower);
		const stem = base.replace(/\.[^.]+$/, '');
		let score = 0;
		if (words.has(lower) || [...words].some(w => w.includes('/') && lower.endsWith(w))) { score = 3; }
		else if (words.has(base)) { score = 2; }
		else if (stem.length >= 4 && words.has(stem)) { score = 1; }
		if (score) { hits.push({ path: f, score }); }
	}
	return hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length).slice(0, MAX_PER_SOURCE).map(h => h.path);
}

const STACK_RES = [
	/([\w@./\\-]+\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py)):(\d+)(?::\d+)?/g,
	/File "([^"]+\.py)", line (\d+)/g,
];

/** `file.ts:12:5` / `File "x.py", line 9` references in the request, resolved to indexed files by path suffix. */
export function stackTraceRefs(query: string, files: string[]): { path: string; line: number }[] {
	const out: { path: string; line: number }[] = [];
	for (const re of STACK_RES) {
		for (const m of query.matchAll(re)) {
			const want = m[1].replace(/\\/g, '/').replace(/^\.?\//, '');
			const hit = files.find(f => f === want) ?? files.filter(f => f.endsWith('/' + want) || want.endsWith('/' + f)).sort((a, b) => a.length - b.length)[0];
			if (hit && !out.some(o => o.path === hit)) { out.push({ path: hit, line: Number(m[2]) }); }
		}
	}
	return out.slice(0, MAX_PER_SOURCE);
}

/** Identifier-like tokens that are specific enough to be a symbol name (camelCase, snake_case, qualified, or long). */
function symbolTokens(text: string): string[] {
	const seen = new Set<string>();
	for (const m of text.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
		const t = m[0];
		if (t.length >= 4 && (/[a-z][A-Z]/.test(t) || /^[A-Z][a-z]+[A-Z]/.test(t) || t.includes('_') || t.includes('.') || t.length >= 8)) { seen.add(t); }
	}
	return [...seen];
}

const OVERVIEW_RE = /\b(overview|architecture|project structure|walk me through|(how|what) (does|is) (this|the) (project|repo|repository|codebase|app|extension))\b/i;

/** Last resort: package.json `main`, mapped back to a source file when it points at build output. */
function packageMain(root: string, index: AtlasIndex): string | undefined {
	try {
		const main = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { main?: string }).main;
		if (!main) { return undefined; }
		const norm = path.posix.normalize(main.replace(/^\.\//, ''));
		if (index.hasFile(norm)) { return norm; }
		const stem = path.posix.basename(norm).replace(/\.[^.]+$/, '');
		for (const c of [`src/${stem}`, `${stem}`, 'src/index', 'index']) {
			for (const ext of ['.ts', '.tsx', '.js', '.jsx']) { if (index.hasFile(c + ext)) { return c + ext; } }
		}
	} catch { /* no package.json */ }
	return undefined;
}

/**
 * Decides where graph traversal starts. Priority:
 * 1 active editor, 2 diagnostics, 3 recent git changes, 4 files named in the query, 5 package.json main (only if nothing else).
 * A file hit by several sources keeps its highest-priority entry.
 */
export function resolveEntryPoints(query: string, inp: ResolverInputs): EntryPoint[] {
	const out = new Map<string, EntryPoint>();
	const add = (e: EntryPoint) => {
		if (!inp.index.hasFile(e.path)) { return; }
		const cur = out.get(e.path);
		if (!cur || e.priority < cur.priority) { out.set(e.path, { ...e, symbol: e.symbol ?? cur?.symbol, line: e.line ?? cur?.line }); }
		// A weaker source can still say *which symbol* the file matters for; keep that detail.
		else if (e.symbol && !cur.symbol) { cur.symbol = e.symbol; cur.line = e.line ?? cur.line; }
	};

	if (inp.active) {
		add({ path: inp.active.path, source: 'active-editor', priority: 1, line: inp.active.line, reason: `active editor, line ${inp.active.line}` });
	}
	[...inp.diagnostics.values()].filter(d => d.errors > 0).sort((a, b) => b.errors - a.errors || a.path.localeCompare(b.path)).slice(0, MAX_PER_SOURCE)
		.forEach(d => add({ path: d.path, source: 'diagnostic', priority: 2, line: d.firstErrorLine, reason: `${d.errors} error${d.errors > 1 ? 's' : ''}: ${d.messages[0] ?? ''}` }));
	inp.git.recentFiles().filter(f => inp.index.hasFile(f.path)).slice(0, MAX_PER_SOURCE)
		.forEach(f => add({ path: f.path, source: 'git', priority: 3, reason: f.rank === 0 ? 'uncommitted change' : `changed ${f.rank} commit${f.rank > 1 ? 's' : ''} ago` }));
	mentionedFiles(query, inp.index.filePaths()).forEach(p => add({ path: p, source: 'query', priority: 4, reason: 'mentioned in the request' }));

	// Stack-trace references are as strong as a compiler error: the user is pointing at the failing line.
	for (const r of stackTraceRefs(query, inp.index.filePaths())) {
		add({ path: r.path, source: 'stack-trace', priority: 2, line: r.line, reason: `stack trace points at line ${r.line}` });
	}
	for (const p of (inp.openTabs ?? []).filter(t => t !== inp.active?.path).slice(0, MAX_PER_SOURCE)) {
		add({ path: p, source: 'open-tab', priority: 3, reason: 'open in an editor tab' });
	}
	// Symbols named in the request or selection resolve through the O(1) symbol table, not a text search.
	let symbolHits = 0;
	for (const tok of symbolTokens(`${query}\n${inp.selection ?? ''}`)) {
		const defs = inp.index.lookupSymbol(tok);
		if (!defs.length || defs.length > 3) { continue; }
		for (const d of defs) {
			if (symbolHits++ >= MAX_PER_SOURCE) { break; }
			add({ path: d.path, source: 'symbol', priority: 4, line: d.startLine, symbol: d.qualifiedName, reason: `defines ${d.qualifiedName}` });
		}
	}
	if (OVERVIEW_RE.test(query)) {
		const main = packageMain(inp.root, inp.index);
		if (main) { add({ path: main, source: 'overview', priority: 5, reason: 'project entry point' }); }
		const hubs = inp.index.filePaths().map(p => ({ p, n: fileNeighbors(inp.index, p).importedBy.length })).sort((a, b) => b.n - a.n || a.p.localeCompare(b.p)).slice(0, MAX_PER_SOURCE);
		for (const h of hubs) { if (h.n > 0) { add({ path: h.p, source: 'overview', priority: 5, reason: `imported by ${h.n} files (hub)` }); } }
	}

	if (!out.size) {
		const main = packageMain(inp.root, inp.index);
		if (main) { add({ path: main, source: 'package-main', priority: 5, reason: 'package.json main entry' }); }
	}
	return [...out.values()].sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
}
