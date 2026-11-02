import type { AtlasIndex } from './AtlasIndex';
import type { GitTimelineIndex } from './GitTimelineIndex';
import type { FileDiagnostics } from './LSPBridge';
import { fileNeighbors } from './queries';
import type { AtlasNode, Candidate, EntryPoint } from './types';

export interface TraversalOptions {
	/** Base BFS depth through the import graph (default 2). */
	hops?: number;
	/** Per-direction depth; overrides `hops`. forward = what the entry imports, reverse = what imports the entry. */
	forwardHops?: number;
	reverseHops?: number;
	/** Hard cap on candidates so hub files can't explode the set. */
	maxFiles?: number;
	/** Per-file cap on characters that may be sent as full content. */
	maxContentChars?: number;
	/** Files imported by more than this many files are included but not expanded through (default 25). */
	hubLimit?: number;
	/** Include files that git shows changing together with an entry file, and its tests (default true). */
	siblings?: boolean;
	/** Symbols the entry points are about, by file (see focus.ts). */
	focus?: Map<string, AtlasNode[]>;
}

/** What a task type needs: bugs need both sides, refactors the dependents, explanations the dependencies. */
export function hopsForQueryType(queryType: string | undefined, base = 2): { forwardHops: number; reverseHops: number } {
	switch (queryType) {
		case 'refactor': return { forwardHops: 1, reverseHops: base + 1 };
		case 'explain':
		case 'generate': return { forwardHops: base, reverseHops: 1 };
		default: return { forwardHops: base, reverseHops: base };
	}
}

const TEST_RE = /(?:^|\/)(?:test_[^/]+\.py|[^/]+(?:\.test|\.spec|_test)\.[a-z]+)$/;
const stemOf = (p: string) => p.split('/').pop()!.replace(/(?:\.test|\.spec|_test)?\.[^.]+$/, '').replace(/^test_/, '');

/**
 * BFS from the entry points through the import graph, with independent forward/reverse depth.
 * Deterministic: neighbours are visited in sorted order, results ordered by hop distance then path.
 * Files are described, not read: bodies are loaded later for the few that make the cut.
 */
export function traverse(
	index: AtlasIndex, git: GitTimelineIndex, diagnostics: Map<string, FileDiagnostics>,
	entries: EntryPoint[], opts: TraversalOptions = {},
): Candidate[] {
	const base = opts.hops ?? 2;
	const fwd = opts.forwardHops ?? base;
	const rev = opts.reverseHops ?? base;
	const maxFiles = opts.maxFiles ?? 60;
	const maxChars = opts.maxContentChars ?? 24_000;
	const hubLimit = opts.hubLimit ?? 25;
	const found = new Map<string, { source: Candidate['source']; hop: number; priority: number }>();

	for (const e of entries) {
		if (index.hasFile(e.path)) { found.set(e.path, { source: e.source, hop: 0, priority: e.priority }); }
	}
	const entryPaths = [...found.keys()];
	let frontier = [...entryPaths];
	for (let h = 1; h <= Math.max(fwd, rev) && frontier.length && found.size < maxFiles; h++) {
		const next: string[] = [];
		for (const p of frontier) {
			const n = fileNeighbors(index, p);
			const lists: [string[], Candidate['source']][] = [];
			if (h <= fwd) { lists.push([n.imports, 'imports']); }
			// A hub's importers are "everything": don't walk through it in reverse.
			if (h <= rev && n.importedBy.length <= hubLimit) { lists.push([n.importedBy, 'importedBy']); }
			for (const [list, source] of lists) {
				for (const q of list) {
					if (found.has(q) || found.size >= maxFiles) { continue; }
					found.set(q, { source, hop: h, priority: 6 });
					next.push(q);
				}
			}
		}
		frontier = next;
	}

	if (opts.siblings !== false) {
		const tests = new Map<string, string[]>();
		for (const f of index.filePaths()) { if (TEST_RE.test(f)) { (tests.get(stemOf(f)) ?? tests.set(stemOf(f), []).get(stemOf(f))!).push(f); } }
		for (const p of entryPaths) {
			for (const q of git.coChanged(p)) { if (index.hasFile(q) && !found.has(q) && found.size < maxFiles) { found.set(q, { source: 'cochange', hop: 1, priority: 6 }); } }
			if (!TEST_RE.test(p)) {
				for (const q of tests.get(stemOf(p)) ?? []) { if (!found.has(q) && found.size < maxFiles) { found.set(q, { source: 'test', hop: 1, priority: 6 }); } }
			}
		}
	}

	const out: Candidate[] = [];
	for (const [p, meta] of found) {
		const diag = diagnostics.get(p);
		const rank = git.rankOf(p);
		const focus = opts.focus?.get(p)?.map(n => ({ name: n.qualifiedName, startLine: n.startLine, endLine: n.endLine }));
		out.push({
			path: p, content: '', size: Math.min(index.sizeOf(p), maxChars), source: meta.source, hopDistance: meta.hop,
			hasErrors: !!diag && diag.errors > 0, errorCount: diag?.errors ?? 0,
			recentlyChanged: rank >= 0, gitRank: rank, entryPriority: meta.priority,
			importedByCount: fileNeighbors(index, p).importedBy.length, focus,
			symbols: index.symbolsInFile(p).map(s => ({ name: s.qualifiedName, kind: s.kind, startLine: s.startLine, endLine: s.endLine, signature: s.signature })),
		});
	}
	return out.sort((a, b) => a.hopDistance - b.hopDistance || a.entryPriority - b.entryPriority || a.path.localeCompare(b.path));
}
