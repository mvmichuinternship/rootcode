import * as path from 'node:path';
import type { AtlasIndex } from './AtlasIndex';
import type { AtlasNode, EdgeKind, FileDependencyGraph } from './types';

const IMPACT_KINDS: EdgeKind[] = ['calls', 'inherits', 'implements', 'injects'];

/** O(n) name search ranked: exact qualified name, exact name, prefix, substring. Files are excluded. */
export function findSymbols(index: AtlasIndex, query: string, limit = 20): AtlasNode[] {
	const q = query.toLowerCase();
	const scored: { n: AtlasNode; s: number }[] = [];
	for (const n of index.nodes) {
		if (n.kind === 'file') { continue; }
		const name = n.name.toLowerCase();
		const qn = n.qualifiedName.toLowerCase();
		const s = qn === q ? 0 : name === q ? 1 : name.startsWith(q) ? 2 : qn.includes(q) ? 3 : -1;
		if (s >= 0) { scored.push({ n, s }); }
	}
	return scored.sort((a, b) => a.s - b.s || a.n.qualifiedName.length - b.n.qualifiedName.length).slice(0, limit).map(x => x.n);
}

export function getCallees(index: AtlasIndex, id: number): { kind: EdgeKind; node: AtlasNode | null; ref: string }[] {
	return index.edgesFrom(id).map(e => ({ kind: e.kind, node: e.dst === null ? null : index.getNode(e.dst) ?? null, ref: e.dstRef }));
}

export function getCallers(index: AtlasIndex, id: number): { kind: EdgeKind; node: AtlasNode }[] {
	return index.edgesTo(id).flatMap(e => { const node = index.getNode(e.src); return node ? [{ kind: e.kind, node }] : []; });
}

/** Everything that transitively depends on a symbol (reverse calls/inherits/implements/injects), nearest first. */
export function symbolBlastRadius(index: AtlasIndex, id: number, depth = 2): { node: AtlasNode; hops: number }[] {
	const visited = new Set([id]);
	let frontier = [id];
	const out: { node: AtlasNode; hops: number }[] = [];
	for (let hop = 1; hop <= depth && frontier.length; hop++) {
		const next: number[] = [];
		for (const cur of frontier) {
			for (const e of index.edgesTo(cur, IMPACT_KINDS)) {
				if (visited.has(e.src)) { continue; }
				visited.add(e.src);
				const node = index.getNode(e.src);
				if (node) { out.push({ node, hops: hop }); next.push(e.src); }
			}
		}
		frontier = next;
	}
	return out;
}

/** Files directly imported by `p` (`imports`) or that import `p` (`importedBy`). */
export function fileNeighbors(index: AtlasIndex, p: string): { imports: string[]; importedBy: string[] } {
	const f = index.getFileNode(p);
	if (!f) { return { imports: [], importedBy: [] }; }
	const imports = index.edgesFrom(f.id, ['imports']).flatMap(e => e.dst === null ? [] : [index.getNode(e.dst)!.path]);
	const importedBy = index.edgesTo(f.id, ['imports']).map(e => index.getNode(e.src)!.path);
	return { imports: imports.sort(), importedBy: importedBy.sort() };
}

/** BFS over the import graph; `reverse` walks importers ("what breaks if I change this file?"). */
export function traverseFiles(index: AtlasIndex, starts: string[], hops: number, reverse: boolean): Map<string, number> {
	const dist = new Map<string, number>(starts.filter(s => index.getFileNode(s)).map(s => [s, 0]));
	let frontier = [...dist.keys()];
	for (let h = 1; h <= hops && frontier.length; h++) {
		const next: string[] = [];
		for (const p of frontier) {
			const n = fileNeighbors(index, p);
			for (const q of reverse ? n.importedBy : n.imports) {
				if (!dist.has(q)) { dist.set(q, h); next.push(q); }
			}
		}
		frontier = next;
	}
	return dist;
}

export function fileBlastRadius(index: AtlasIndex, p: string, depth = 2): { path: string; hops: number }[] {
	return [...traverseFiles(index, [p], depth, true)].filter(([q]) => q !== p).map(([q, hops]) => ({ path: q, hops })).sort((a, b) => a.hops - b.hops || a.path.localeCompare(b.path));
}

/** File-level dependency graph for visualisation (edges as index pairs). */
export function fileDependencyGraph(index: AtlasIndex): FileDependencyGraph {
	const out = new Map<string, number>();
	const inn = new Map<string, number>();
	const pairs: [string, string][] = [];
	for (const e of index.edges) {
		if (e.kind !== 'imports' || e.dst === null) { continue; }
		const s = index.getNode(e.src)!.path;
		const t = index.getNode(e.dst)!.path;
		pairs.push([s, t]);
		out.set(s, (out.get(s) ?? 0) + 1);
		inn.set(t, (inn.get(t) ?? 0) + 1);
	}
	const paths = index.filePaths().sort();
	const pos = new Map(paths.map((p, i) => [p, i]));
	const nodes = paths.map(p => ({
		path: p,
		dir: path.posix.dirname(p).split('/').slice(0, 2).join('/'),
		symbols: index.symbolsInFile(p).length,
		imports: out.get(p) ?? 0,
		importedBy: inn.get(p) ?? 0,
	}));
	return { nodes, edges: pairs.map(([s, t]) => [pos.get(s)!, pos.get(t)!] as [number, number]) };
}
