import * as path from 'node:path';
import type { AtlasIndex } from './AtlasIndex';
import { fileDependencyGraph, fileNeighbors } from './queries';
import type { FileDependencyGraph } from './types';

export interface Cluster {
	/** Stable within one index version: c1 is the biggest cluster. */
	id: string;
	name: string;
	files: string[];
	/** Other clusters whose files these files import (what must be settled first). */
	dependsOn: string[];
}

export interface ClusterPlan {
	clusters: Cluster[];
	/** Requested files that aren't in the index. */
	unknown: string[];
}

const MAX_ROUNDS = 20;
const cache = new WeakMap<AtlasIndex, { version: number; clusters: Cluster[]; byFile: Map<string, string> }>();

/**
 * Communities of the import graph, found by deterministic label propagation: every file starts in its own
 * community and repeatedly adopts the label most common among its import neighbours (neighbours in the same
 * directory count extra). Visiting order and tie-breaks are fixed, so the same graph always gives the same clusters.
 * Hub files (imported by many) are ignored as links, otherwise one shared utility glues everything together.
 */
function compute(index: AtlasIndex, hubLimit = 25): { clusters: Cluster[]; byFile: Map<string, string> } {
	const files = index.filePaths().sort();
	const adj = new Map<string, string[]>();
	const isHub = new Set(files.filter(f => fileNeighbors(index, f).importedBy.length > hubLimit));
	for (const f of files) {
		const n = fileNeighbors(index, f);
		adj.set(f, [...n.imports, ...n.importedBy].filter(q => !isHub.has(q) && !isHub.has(f)));
	}
	const label = new Map(files.map(f => [f, f]));
	for (let round = 0; round < MAX_ROUNDS; round++) {
		let changed = false;
		for (const f of files) {
			const nbrs = adj.get(f)!;
			if (!nbrs.length) { continue; }
			const score = new Map<string, number>();
			for (const q of nbrs) {
				const l = label.get(q)!;
				score.set(l, (score.get(l) ?? 0) + 1 + (path.posix.dirname(q) === path.posix.dirname(f) ? 0.5 : 0));
			}
			let best = label.get(f)!;
			let bestScore = score.get(best) ?? 0;
			for (const [l, s] of [...score].sort((a, b) => a[0].localeCompare(b[0]))) {
				if (s > bestScore) { best = l; bestScore = s; }
			}
			if (best !== label.get(f)) { label.set(f, best); changed = true; }
		}
		if (!changed) { break; }
	}

	// Files with no usable links (or hubs) group by directory so they don't each become a cluster of one.
	const groups = new Map<string, string[]>();
	for (const f of files) {
		const linked = adj.get(f)!.length > 0;
		const key = linked ? `g:${label.get(f)}` : `d:${path.posix.dirname(f)}`;
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
	}
	const sorted = mergeSmall([...groups.values()], adj, files.length)
		.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
	const byFile = new Map<string, string>();
	sorted.forEach((fs, i) => { for (const f of fs) { byFile.set(f, `c${i + 1}`); } });

	const shortDir = (d: string) => { const parts = d.split('/'); return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : d; };
	const clusters: Cluster[] = sorted.map((fs, i) => {
		const dirs = new Map<string, number>();
		for (const f of fs) { const d = path.posix.dirname(f); dirs.set(d, (dirs.get(d) ?? 0) + 1); }
		const topDir = [...dirs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
		const id = `c${i + 1}`;
		const deps = new Set<string>();
		for (const f of fs) { for (const q of fileNeighbors(index, f).imports) { const c = byFile.get(q); if (c && c !== id) { deps.add(c); } } }
		return { id, name: `${topDir === '.' ? 'root' : shortDir(topDir)} (${fs.length} file${fs.length === 1 ? '' : 's'})`, files: fs, dependsOn: [...deps].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) };
	});
	return { clusters, byFile };
}

const MIN_CLUSTER = 3;

/**
 * Label propagation on sparse graphs leaves hundreds of tiny groups, which is as unreadable as the file graph.
 * Merge the smallest group into the neighbour it is linked to most (else the group sharing the longest directory
 * prefix) until there are at most ~1.5·√files clusters and none is tiny. Deterministic: fixed tie-breaks.
 */
function mergeSmall(groups: string[][], adj: Map<string, string[]>, fileCount: number): string[][] {
	const maxClusters = Math.max(8, Math.round(Math.sqrt(fileCount) * 1.5));
	let live = groups.map(g => g.slice());
	const owner = new Map<string, number>();
	live.forEach((g, i) => g.forEach(f => owner.set(f, i)));
	const link = new Map<number, Map<number, number>>();
	for (const [f, ns] of adj) {
		const a = owner.get(f)!;
		for (const q of ns) {
			const b = owner.get(q)!;
			if (a === b) { continue; }
			const m = link.get(a) ?? link.set(a, new Map()).get(a)!;
			m.set(b, (m.get(b) ?? 0) + 1);
		}
	}
	const alive = new Set(live.map((_, i) => i));
	const stuck = new Set<number>();
	const dirOf = (i: number) => path.posix.dirname(live[i][0]);
	const commonPrefix = (a: string, b: string) => { const x = a.split('/'), y = b.split('/'); let n = 0; while (n < x.length && n < y.length && x[n] === y[n]) { n++; } return n; };
	for (;;) {
		const over = alive.size > maxClusters;
		const cand = [...alive].filter(i => !stuck.has(i) && (over || live[i].length < MIN_CLUSTER))
			.sort((a, b) => live[a].length - live[b].length || a - b)[0];
		if (cand === undefined) { break; }
		let best = -1;
		let bestW = 0;
		for (const [j, w] of [...(link.get(cand) ?? [])].sort((a, b) => a[0] - b[0])) {
			if (alive.has(j) && (w > bestW || (w === bestW && live[j].length > live[best]?.length))) { best = j; bestW = w; }
		}
		if (best < 0) {   // no import links at all: join the group whose directory is closest
			let bestP = 0;
			for (const j of [...alive].sort((a, b) => a - b)) {
				if (j === cand) { continue; }
				const p = commonPrefix(dirOf(cand), dirOf(j));
				if (p > bestP || (p === bestP && p > 0 && live[j].length > live[best]?.length)) { best = j; bestP = p; }
			}
			if (best < 0) { stuck.add(cand); continue; }
		}
		live[best] = live[best].concat(live[cand]);
		for (const [j, w] of link.get(cand) ?? []) {
			if (j === best || !alive.has(j)) { continue; }
			const mb = link.get(best) ?? link.set(best, new Map()).get(best)!;
			mb.set(j, (mb.get(j) ?? 0) + w);
			const mj = link.get(j)!;
			mj.set(best, (mj.get(best) ?? 0) + (mj.get(cand) ?? 0));
			mj.delete(cand);
		}
		link.get(best)?.delete(cand);
		link.delete(cand);
		alive.delete(cand);
		stuck.clear();
	}
	live = [...alive].sort((a, b) => a - b).map(i => live[i]);
	return live;
}

function get(index: AtlasIndex) {
	const hit = cache.get(index);
	if (hit && hit.version === index.version) { return hit; }
	const fresh = { version: index.version, ...compute(index) };
	cache.set(index, fresh);
	return fresh;
}

export function allClusters(index: AtlasIndex): Cluster[] { return get(index).clusters; }
export function clusterOf(index: AtlasIndex, file: string): string | undefined { return get(index).byFile.get(file); }

/** The clusters a set of files falls into, each restricted to the requested files. */
export function planClusters(index: AtlasIndex, files: string[]): ClusterPlan {
	const { clusters, byFile } = get(index);
	const picked = new Map<string, string[]>();
	const unknown: string[] = [];
	for (const f of [...new Set(files)]) {
		const c = byFile.get(f);
		if (!c) { unknown.push(f); continue; }
		(picked.get(c) ?? picked.set(c, []).get(c)!).push(f);
	}
	const chosen = clusters.filter(c => picked.has(c.id)).map(c => ({ ...c, files: picked.get(c.id)!.sort(), dependsOn: c.dependsOn.filter(d => picked.has(d)) }));
	return { clusters: chosen, unknown };
}

/** Execution order: clusters nothing else in the plan depends on first; a dependency cycle falls into one last wave. */
export function waves(plan: { id: string; dependsOn: string[] }[]): string[][] {
	const remaining = new Map(plan.map(c => [c.id, new Set(c.dependsOn.filter(d => plan.some(p => p.id === d)))]));
	const out: string[][] = [];
	while (remaining.size) {
		const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
		const wave = ready.length ? ready : [...remaining.keys()];
		out.push(wave);
		for (const id of wave) { remaining.delete(id); }
		for (const deps of remaining.values()) { for (const id of wave) { deps.delete(id); } }
	}
	return out;
}

/** Compact, deterministic overview of the repo's structure: stable across turns, so it caches well. */
export function repoMap(index: AtlasIndex, maxChars = 1800): string {
	const clusters = allClusters(index).filter(c => c.files.length >= 2).slice(0, 12);
	if (!clusters.length) { return ''; }
	const hubs = index.filePaths().map(p => ({ p, n: fileNeighbors(index, p).importedBy.length })).filter(h => h.n >= 3)
		.sort((a, b) => b.n - a.n || a.p.localeCompare(b.p)).slice(0, 6);
	const lines = ['Workspace structure (from the dependency graph):'];
	for (const c of clusters) {
		const top = c.files.map(f => ({ f, n: fileNeighbors(index, f).importedBy.length })).sort((a, b) => b.n - a.n || a.f.localeCompare(b.f)).slice(0, 3).map(x => path.posix.basename(x.f));
		lines.push(`- ${c.id} ${c.name}: ${top.join(', ')}${c.dependsOn.length ? ` — uses ${c.dependsOn.join(', ')}` : ''}`);
	}
	if (hubs.length) { lines.push(`Most-imported files: ${hubs.map(h => `${h.p} (${h.n})`).join(', ')}`); }
	return lines.join('\n').slice(0, maxChars);
}

/** The file graph plus its cluster overview (cluster per file, cluster sizes and cluster-to-cluster import counts). */
export function fileGraphWithClusters(index: AtlasIndex): FileDependencyGraph {
	const g = fileDependencyGraph(index);
	const { clusters, byFile } = get(index);
	const ci = new Map(clusters.map((c, i) => [c.id, i]));
	for (const n of g.nodes) { n.cluster = byFile.get(n.path); }
	const weights = new Map<number, number>();
	for (const [s, t] of g.edges) {
		const a = ci.get(byFile.get(g.nodes[s].path) ?? '');
		const b = ci.get(byFile.get(g.nodes[t].path) ?? '');
		if (a === undefined || b === undefined || a === b) { continue; }
		weights.set(a * clusters.length + b, (weights.get(a * clusters.length + b) ?? 0) + 1);
	}
	g.clusters = clusters.map(c => ({ id: c.id, name: c.name, size: c.files.length, dependsOn: c.dependsOn }));
	g.clusterEdges = [...weights].map(([k, w]) => [Math.floor(k / clusters.length), k % clusters.length, w] as [number, number, number]);
	return g;
}
