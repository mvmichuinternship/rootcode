import type { AtlasIndex } from './AtlasIndex';
import type { AtlasNode, EntryPoint } from './types';

const IDENT = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/g;
const MAX_NEIGHBORS = 8;

/**
 * Symbols worth showing in full: the ones the entry points are *about* (the symbol under the cursor / failing line /
 * mentioned by name) plus their direct callers and callees. Everything else in a big file is shown as signatures only.
 */
export function computeFocus(index: AtlasIndex, entries: EntryPoint[], query: string): Map<string, AtlasNode[]> {
	const seeds = new Map<number, AtlasNode>();
	for (const e of entries) {
		if (!index.hasFile(e.path)) { continue; }
		const syms = index.symbolsInFile(e.path);
		if (e.symbol) {
			for (const s of syms) { if (s.qualifiedName === e.symbol) { seeds.set(s.id, s); } }
		} else if (e.line !== undefined) {
			const line = e.line;
			const inner = syms.filter(s => s.startLine <= line && line <= s.endLine).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
			if (inner) { seeds.set(inner.id, inner); }
		}
		// Symbols of the entry file named in the request ("why does loadUser fail").
		for (const word of query.match(IDENT) ?? []) {
			for (const s of syms) { if (s.kind !== 'file' && (s.name === word || s.qualifiedName === word)) { seeds.set(s.id, s); } }
		}
	}
	const out = new Map<string, Map<number, AtlasNode>>();
	const add = (n: AtlasNode) => { (out.get(n.path) ?? out.set(n.path, new Map()).get(n.path)!).set(n.id, n); };
	for (const s of seeds.values()) {
		add(s);
		let k = 0;
		for (const e of index.edgesFrom(s.id, ['calls', 'injects', 'inherits', 'implements'])) {
			const n = e.dst === null ? undefined : index.getNode(e.dst);
			if (n && n.kind !== 'file' && k++ < MAX_NEIGHBORS) { add(n); }
		}
		k = 0;
		for (const e of index.edgesTo(s.id, ['calls', 'injects'])) {
			const n = index.getNode(e.src);
			if (n && n.kind !== 'file' && k++ < MAX_NEIGHBORS) { add(n); }
		}
	}
	return new Map([...out].map(([p, m]) => [p, [...m.values()].sort((a, b) => a.startLine - b.startLine)]));
}
