import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import type { IndexOrchestrator } from '../../atlas/IndexOrchestrator';
import { fileBlastRadius, fileNeighbors, findSymbols, getCallees, getCallers, symbolBlastRadius } from '../../atlas/queries';

/** Structural queries over the workspace dependency graph: deterministic, no text search. */
export function createContextTools(atlas: IndexOrchestrator): FunctionTool[] {
	const loc = (n: { path: string; startLine: number; qualifiedName: string; kind: string; signature?: string }) =>
		({ symbol: n.qualifiedName, kind: n.kind, file: n.path, line: n.startLine, signature: n.signature });
	return [
		new FunctionTool({
			name: 'find_symbol',
			description: 'Looks up where a class/function/method is defined (exact name first, then prefix/substring). Returns file, line and signature.',
			parameters: z.object({ name: z.string().min(1) }),
			execute: async ({ name }) => {
				const idx = await atlas.getIndex();
				if (!idx) { return { error: 'Index unavailable.' }; }
				const exact = idx.lookupSymbol(name);
				return { matches: (exact.length ? exact : findSymbols(idx, name, 10)).slice(0, 10).map(loc) };
			},
		}),
		new FunctionTool({
			name: 'get_dependencies',
			description: 'For a workspace file: the files it imports, the files that import it, and what would break if it changed (reverse import traversal).',
			parameters: z.object({ path: z.string().describe('Workspace-relative file path'), depth: z.number().int().min(1).max(5).default(2) }),
			execute: async ({ path: p, depth }) => {
				const idx = await atlas.getIndex();
				if (!idx?.hasFile(p)) { return { error: `Not an indexed file: ${p}` }; }
				return { ...fileNeighbors(idx, p), blastRadius: fileBlastRadius(idx, p, depth).slice(0, 60) };
			},
		}),
		new FunctionTool({
			name: 'trace_symbol',
			description: 'For a symbol: what it calls/depends on, what calls/uses it, and everything transitively affected if it changes.',
			parameters: z.object({ name: z.string().min(1), depth: z.number().int().min(1).max(4).default(2) }),
			execute: async ({ name, depth }) => {
				const idx = await atlas.getIndex();
				const node = idx && (idx.lookupSymbol(name)[0] ?? findSymbols(idx, name, 1)[0]);
				if (!idx || !node) { return { error: `Symbol not found: ${name}` }; }
				return {
					symbol: loc(node),
					dependsOn: getCallees(idx, node.id).filter(c => c.node).slice(0, 30).map(c => ({ relation: c.kind, ...loc(c.node!) })),
					usedBy: getCallers(idx, node.id).slice(0, 30).map(c => ({ relation: c.kind, ...loc(c.node) })),
					blastRadius: symbolBlastRadius(idx, node.id, depth).slice(0, 60).map(b => ({ hops: b.hops, ...loc(b.node) })),
				};
			},
		}),
		new FunctionTool({
			name: 'get_context',
			description: 'Ranked, budgeted context for a task: starts from the active file, compile errors, recent git changes and files named in the query, expands through the import graph and returns the most relevant files.',
			parameters: z.object({ query: z.string().describe('The task or question'), entry_files: z.array(z.string()).optional().describe('Workspace-relative files to start from instead of auto-detecting') }),
			execute: async ({ query, entry_files }) => {
				if (entry_files?.length) {
					const items = await atlas.getContext(entry_files);
					return { files: items.map(i => ({ path: i.path, why: i.source, hops: i.hopDistance, score: +i.score.toFixed(2), symbols: i.symbols.map(s => s.signature ?? s.name) })) };
				}
				const { entries, items } = await atlas.resolveAndGetContext(query);
				return {
					entryPoints: entries.map(e => ({ path: e.path, reason: e.reason })),
					files: items.map(i => ({ path: i.path, why: i.source, hops: i.hopDistance, score: +i.score.toFixed(2), hasErrors: i.hasErrors, recentlyChanged: i.recentlyChanged, symbols: i.symbols.map(s => s.signature ?? s.name) })),
				};
			},
		}),
	];
}
