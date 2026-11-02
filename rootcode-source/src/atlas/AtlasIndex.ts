import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { extractPython } from './extractors/python';
import { extractTypeScript } from './extractors/typescript';
import { createResolver } from './resolveImports';
import type { AtlasEdge, AtlasNode, EdgeKind, Extraction, Language, RefRecord } from './types';
import type { ResolvedBinding } from './resolveImports';

const EXT_LANG: Record<string, Language> = {
	'.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
	'.js': 'typescript', '.jsx': 'typescript', '.mjs': 'typescript', '.cjs': 'typescript',
	'.py': 'python',
};
const IGNORE_DIRS = new Set([
	'node_modules', 'bin', 'obj', '.git', '.rootcode', 'dist', 'out', '.angular', '__pycache__', '.venv', 'venv',
	'site-packages', '.tox', '.mypy_cache', '.pytest_cache', 'build', 'coverage', '.next',
]);
const MAX_FILE_BYTES = 1_000_000;
const CACHE_VERSION = 2;
/** Max time the indexer holds the extension host before yielding to the event loop. */
const SLICE_MS = 8;
const CACHE_FILE = path.join('.rootcode', 'atlas', 'index.json');

interface FileRecord { hash: string; mtime: number; bytes: number; extraction: Extraction }
interface CacheShape { version: number; files: Record<string, FileRecord> }

/** True for source files the index tracks (right extension, not under an ignored directory). */
export function isIndexablePath(rel: string): boolean {
	return !!EXT_LANG[path.extname(rel)] && !rel.split('/').some(s => IGNORE_DIRS.has(s) || (s.startsWith('.') && s.length > 1 && s !== rel.split('/').pop()));
}

const edgeKey = (src: number, kind: EdgeKind, ref: string) => `${src}|${kind}|${ref}`;

/**
 * Deterministic structural index of a workspace: symbols, import graph, call/inheritance/DI edges.
 * Extraction is cached per file by content hash; linking (cross-file resolution) is re-run in memory
 * after every change, so incremental updates stay cheap and always consistent.
 */
export class AtlasIndex {
	/** Incremented on every relink; lets derived data (clusters) cache safely. */
	version = 0;
	nodes: AtlasNode[] = [];
	edges: AtlasEdge[] = [];
	private files = new Map<string, FileRecord>();
	/** Live view of indexed paths; the resolver (and its tsconfig parse) is created once and reused across relinks. */
	private readonly fileSet = new Set<string>();
	private resolver: ReturnType<typeof createResolver> | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private nodeById = new Map<number, AtlasNode>();
	private fileNodeByPath = new Map<string, AtlasNode>();
	private symbolsByPath = new Map<string, Map<string, AtlasNode>>();
	/** O(1) lookup by short or qualified name. */
	private symbolTable = new Map<string, AtlasNode[]>();
	private outgoing = new Map<number, AtlasEdge[]>();
	private incoming = new Map<number, AtlasEdge[]>();

	constructor(readonly root: string) {}

	// ── building ──

	/**
	 * Full (re)index. Time-sliced so the extension host stays responsive; unchanged files (same mtime and size)
	 * are never re-read. Returns the number of files re-parsed.
	 */
	async build(): Promise<{ files: number; parsed: number }> {
		this.loadCache();
		const found = await this.walk(this.root);
		const seen = new Set(found);
		for (const p of [...this.files.keys()]) { if (!seen.has(p)) { this.files.delete(p); } }
		let parsed = 0;
		let sliceStart = Date.now();
		for (const rel of found) {
			if (await this.extractFile(rel)) { parsed++; }
			if (Date.now() - sliceStart > SLICE_MS) { await new Promise(r => setImmediate(r)); sliceStart = Date.now(); }
		}
		this.link();
		this.saveCache();
		return { files: found.length, parsed };
	}

	/** Re-extracts the given files and relinks once. Returns false (and does nothing else) when no content changed. */
	async updateFiles(rels: string[]): Promise<boolean> {
		let changed = false;
		for (const rel of rels) {
			if (!isIndexablePath(rel)) { continue; }
			if (!fs.existsSync(path.join(this.root, rel))) { changed = this.files.delete(rel) || changed; continue; }
			changed = (await this.extractFile(rel)) || changed;
		}
		if (changed) { this.link(); this.scheduleSave(); }
		return changed;
	}

	save(): void { this.saveCache(); }

	private async walk(dir: string, acc: string[] = []): Promise<string[]> {
		let entries: fs.Dirent[];
		try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return acc; }
		for (const e of entries) {
			if (IGNORE_DIRS.has(e.name) || (e.name.startsWith('.') && e.isDirectory())) { continue; }
			const full = path.join(dir, e.name);
			if (e.isDirectory()) { await this.walk(full, acc); }
			else if (EXT_LANG[path.extname(e.name)]) { acc.push(path.relative(this.root, full).split(path.sep).join('/')); }
		}
		return acc;
	}

	/** Returns true when the file was actually re-parsed. */
	private async extractFile(rel: string): Promise<boolean> {
		const abs = path.join(this.root, rel);
		try {
			const st = await fsp.stat(abs);
			if (st.size > MAX_FILE_BYTES) { this.files.delete(rel); return false; }
			const prev = this.files.get(rel);
			if (prev && prev.mtime === st.mtimeMs && prev.bytes === st.size) { return false; }
			const text = await fsp.readFile(abs, 'utf8');
			const hash = createHash('sha1').update(text).digest('hex');
			if (prev?.hash === hash) { prev.mtime = st.mtimeMs; prev.bytes = st.size; return false; }
			const lang = EXT_LANG[path.extname(rel)];
			const extraction = lang === 'python' ? extractPython(text) : extractTypeScript(text, rel);
			this.files.set(rel, { hash, mtime: st.mtimeMs, bytes: st.size, extraction });
			return true;
		} catch {
			// Unparseable / unreadable file: keep it as a bare file node so the graph stays complete.
			this.files.set(rel, { hash: '', mtime: 0, bytes: 0, extraction: { symbols: [], imports: [], lineCount: 1, size: 0 } });
			return false;
		}
	}

	// ── linking ──

	private link(): void {
		this.version++;
		this.nodes = [];
		this.edges = [];
		this.nodeById.clear();
		this.fileNodeByPath.clear();
		this.symbolsByPath.clear();
		this.symbolTable.clear();
		this.outgoing.clear();
		this.incoming.clear();

		this.fileSet.clear();
		for (const p of this.files.keys()) { this.fileSet.add(p); }
		this.resolver ??= createResolver(this.root, this.fileSet);
		const resolver = this.resolver;
		const emitted = new Set<string>();
		const pending: { edge: AtlasEdge; srcPath: string }[] = [];
		let nextId = 1;
		const addNode = (n: Omit<AtlasNode, 'id'>): AtlasNode => {
			const node = { ...n, id: nextId++ };
			this.nodes.push(node);
			if (node.kind !== 'file') {
				for (const k of new Set([node.name, node.qualifiedName])) { (this.symbolTable.get(k) ?? this.symbolTable.set(k, []).get(k)!).push(node); }
			}
			this.nodeById.set(node.id, node);
			return node;
		};
		const emit = (src: number, dst: number | null, dstRef: string, kind: EdgeKind, srcPath: string) => {
			const key = edgeKey(src, kind, dstRef);
			if (emitted.has(key)) { return; }
			emitted.add(key);
			const edge: AtlasEdge = { src, dst, dstRef, kind };
			this.edges.push(edge);
			if (dst === null && kind !== 'references') { pending.push({ edge, srcPath }); }
		};

		const sortedPaths = [...this.files.keys()].sort();
		// Pass 1: nodes (so cross-file resolution can see every symbol).
		for (const rel of sortedPaths) {
			const { extraction } = this.files.get(rel)!;
			const fileNode = addNode({ path: rel, kind: 'file', name: path.posix.basename(rel), qualifiedName: rel, startLine: 1, endLine: extraction.lineCount });
			this.fileNodeByPath.set(rel, fileNode);
			const byQ = new Map<string, AtlasNode>();
			for (const s of extraction.symbols) {
				byQ.set(s.qualifiedName, addNode({ path: rel, kind: s.kind, name: s.name, qualifiedName: s.qualifiedName, startLine: s.startLine, endLine: s.endLine, signature: s.signature }));
			}
			this.symbolsByPath.set(rel, byQ);
		}

		// Pass 2: edges per file.
		for (const rel of sortedPaths) {
			const { extraction } = this.files.get(rel)!;
			const lang = EXT_LANG[path.extname(rel)];
			const fileNode = this.fileNodeByPath.get(rel)!;
			const local = this.symbolsByPath.get(rel)!;
			const bindMap = new Map<string, ResolvedBinding>();
			const importedPaths = new Set<string>();
			for (const imp of extraction.imports) {
				const r = resolver.resolveImport(rel, lang, imp);
				if (r.path && r.path !== rel) { importedPaths.add(r.path); }
				for (const b of r.bindings) {
					bindMap.set(b.local, b);
					if (b.path && b.path !== rel) { importedPaths.add(b.path); }
				}
			}
			const resolveRef = (rec: RefRecord, keepUnresolved: boolean): { dst: number | null; ref: string } | null => {
				const b = bindMap.get(rec.name);
				if (b) {
					if (!b.path) { return null; } // third-party / stdlib
					const imported = b.imported === 'default' ? rec.name : b.imported;
					const qn = b.kind === 'namespace' ? rec.member : rec.member ? `${imported}.${rec.member}` : imported;
					return qn ? { dst: null, ref: `${b.path}::${qn}` } : null;
				}
				const qn = rec.member ? `${rec.name}.${rec.member}` : rec.name;
				const hit = local.get(qn);
				if (hit) { return { dst: hit.id, ref: qn }; }
				return keepUnresolved ? { dst: null, ref: qn } : null;
			};
			for (const s of extraction.symbols) {
				const src = local.get(s.qualifiedName)!.id;
				for (const c of s.calls) { const r = resolveRef(c, false); if (r) { emit(src, r.dst, r.ref, 'calls', rel); } }
				for (const [list, kind] of [[s.injects, 'injects'], [s.implements, 'implements'], [s.inherits, 'inherits']] as const) {
					for (const t of list) { const r = resolveRef(t, true); if (r) { emit(src, r.dst, r.ref, kind, rel); } }
				}
				for (const ref of s.references) { emit(src, null, ref, 'references', rel); }
			}
			for (const p of importedPaths) {
				const target = this.fileNodeByPath.get(p);
				emit(fileNode.id, target?.id ?? null, p, 'imports', rel);
			}
		}

		this.resolveCrossFile(pending);

		for (const e of this.edges) {
			(this.outgoing.get(e.src) ?? this.outgoing.set(e.src, []).get(e.src)!).push(e);
			if (e.dst !== null) { (this.incoming.get(e.dst) ?? this.incoming.set(e.dst, []).get(e.dst)!).push(e); }
		}
	}

	/** Repairs edges that only carry a `dstRef`: follows barrel re-exports a few hops, then falls back to the owning class. */
	private resolveCrossFile(pending: { edge: AtlasEdge; srcPath: string }[]): void {
		const importsOf = new Map<string, string[]>();
		for (const e of this.edges) {
			if (e.kind !== 'imports') { continue; }
			const p = this.nodeById.get(e.src)!.path;
			(importsOf.get(p) ?? importsOf.set(p, []).get(p)!).push(e.dstRef);
		}
		const findIn = (p: string, qn: string) => this.symbolsByPath.get(p)?.get(qn);
		const viaBarrels = (start: string, qn: string): AtlasNode | undefined => {
			const seen = new Set([start]);
			let frontier = [start];
			for (let hop = 0; hop < 3 && frontier.length; hop++) {
				const next: string[] = [];
				for (const p of frontier) {
					for (const dep of importsOf.get(p) ?? []) {
						if (seen.has(dep)) { continue; }
						seen.add(dep);
						const hit = findIn(dep, qn);
						if (hit) { return hit; }
						next.push(dep);
					}
				}
				frontier = next;
			}
			return undefined;
		};
		const byName = new Map<string, AtlasNode[]>();
		for (const n of this.nodes) { if (n.kind !== 'file') { (byName.get(n.name) ?? byName.set(n.name, []).get(n.name)!).push(n); } }

		for (const { edge, srcPath } of pending) {
			if (edge.kind === 'imports') { continue; }
			let target: AtlasNode | undefined;
			const sep = edge.dstRef.indexOf('::');
			if (sep > 0) {
				const p = edge.dstRef.slice(0, sep);
				const qn = edge.dstRef.slice(sep + 2);
				target = findIn(p, qn) ?? viaBarrels(p, qn);
				if (!target && qn.includes('.')) {
					// Member not indexed (inherited, mixin, dynamic): link to its owning class instead of dropping the edge.
					const owner = qn.split('.')[0];
					target = findIn(p, owner) ?? viaBarrels(p, owner);
				}
			} else {
				const candidates = byName.get(edge.dstRef.split('.').pop()!) ?? [];
				const imported = new Set(importsOf.get(srcPath) ?? []);
				target = candidates.find(c => c.qualifiedName === edge.dstRef && imported.has(c.path)) ?? candidates.find(c => c.qualifiedName === edge.dstRef);
			}
			if (target && target.id !== edge.src) { edge.dst = target.id; }
		}
	}

	// ── lookups ──

	/** "Where is UserAuth defined?" — exact name or qualified name, no search. */
	lookupSymbol(name: string): AtlasNode[] { return this.symbolTable.get(name) ?? []; }
	hasFile(p: string): boolean { return this.fileNodeByPath.has(p); }
	getNode(id: number): AtlasNode | undefined { return this.nodeById.get(id); }
	getFileNode(p: string): AtlasNode | undefined { return this.fileNodeByPath.get(p); }
	filePaths(): string[] { return [...this.fileNodeByPath.keys()]; }
	symbolsInFile(p: string): AtlasNode[] { return [...(this.symbolsByPath.get(p)?.values() ?? [])]; }
	edgesFrom(id: number, kinds?: EdgeKind[]): AtlasEdge[] { return (this.outgoing.get(id) ?? []).filter(e => !kinds || kinds.includes(e.kind)); }
	edgesTo(id: number, kinds?: EdgeKind[]): AtlasEdge[] { return (this.incoming.get(id) ?? []).filter(e => !kinds || kinds.includes(e.kind)); }

	// ── persistence (extraction cache only; the graph is relinked on load) ──

	private loadCache(): void {
		try {
			const cache = JSON.parse(fs.readFileSync(path.join(this.root, CACHE_FILE), 'utf8')) as CacheShape;
			if (cache.version !== CACHE_VERSION) { return; }
			this.files = new Map(Object.entries(cache.files));
		} catch { /* no cache yet */ }
	}

	sizeOf(p: string): number { return this.files.get(p)?.extraction.size ?? 0; }

	private scheduleSave(): void {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.saveCache(), 3000);
	}

	private saveCache(): void {
		try {
			const file = path.join(this.root, CACHE_FILE);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const cache: CacheShape = { version: CACHE_VERSION, files: Object.fromEntries(this.files) };
			fs.writeFileSync(file, JSON.stringify(cache));
		} catch { /* read-only workspace: index stays in memory */ }
	}
}
