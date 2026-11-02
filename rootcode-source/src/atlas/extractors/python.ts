import type { ExtractedImport, ExtractedSymbol, Extraction, ImportBinding, RefRecord } from '../types';

// Indentation-based Python extractor (no native/WASM parser dependency).
// Same output contract as the TypeScript extractor; decorators become 'references' edges.

const KEYWORDS = new Set(['if', 'elif', 'while', 'for', 'return', 'print', 'not', 'and', 'or', 'in', 'is', 'lambda', 'def', 'class', 'with', 'assert', 'yield', 'await', 'except', 'raise', 'super', 'isinstance', 'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'range', 'type', 'bool']);

const indentOf = (s: string) => s.length - s.trimStart().length;

function parseImports(lines: string[], imports: ExtractedImport[], bindings: Map<string, ImportBinding>): void {
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].replace(/#.*$/, '');
		let m = /^\s*import\s+(.+)$/.exec(raw);
		if (m) {
			for (const part of m[1].split(',')) {
				const am = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
				if (!am) { continue; }
				const dotted = am[1];
				const local = am[2] ?? dotted.split('.')[0];
				const b: ImportBinding = { local, imported: '*', kind: 'module' };
				imports.push({ spec: am[2] ? dotted : dotted.split('.')[0], level: 0, bindings: [b] });
				bindings.set(local, b);
			}
			continue;
		}
		m = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.*)$/.exec(raw);
		if (!m) { continue; }
		let names = m[3];
		if (names.includes('(') && !names.includes(')')) {
			while (++i < lines.length) {
				const next = lines[i].replace(/#.*$/, '');
				names += ' ' + next;
				if (next.includes(')')) { break; }
			}
		}
		const rec: ExtractedImport = { spec: m[2], level: m[1].length, bindings: [] };
		for (const part of names.replace(/[()]/g, '').split(',')) {
			const am = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
			if (!am) { continue; }
			const b: ImportBinding = { local: am[2] ?? am[1], imported: am[1], kind: 'named' };
			rec.bindings.push(b);
			bindings.set(b.local, b);
		}
		imports.push(rec);
	}
}

export function extractPython(text: string): Extraction {
	const lines = text.split('\n');
	const symbols: ExtractedSymbol[] = [];
	const imports: ExtractedImport[] = [];
	const bindings = new Map<string, ImportBinding>();
	parseImports(lines, imports, bindings);

	// End of a block starting at `start`: last non-blank line indented deeper than the header.
	const blockEnd = (start: number, indent: number): number => {
		let end = start;
		for (let i = start + 1; i < lines.length; i++) {
			if (!lines[i].trim()) { continue; }
			if (indentOf(lines[i]) <= indent) { break; }
			end = i;
		}
		return end;
	};
	const collectCalls = (from: number, to: number, className: string | undefined, own: string): RefRecord[] => {
		const out: RefRecord[] = [];
		const seen = new Set<string>();
		const add = (name: string, member?: string) => {
			const key = member ? `${name}.${member}` : name;
			if (seen.has(key) || key === own || KEYWORDS.has(name)) { return; }
			seen.add(key);
			out.push(member ? { name, member } : { name });
		};
		const re = /(?<![\w.])(\w+)(?:\.(\w+))?\s*\(/g;
		for (let i = from; i <= to; i++) {
			const code = lines[i].replace(/#.*$/, '');
			for (const m of code.matchAll(re)) {
				if (m[2] === undefined) { add(m[1]); }
				else if ((m[1] === 'self' || m[1] === 'cls') && className) { add(className, m[2]); }
				else if (bindings.has(m[1]) || /^[A-Z]/.test(m[1])) { add(m[1], m[2]); }
			}
		}
		return out;
	};

	const stack: { indent: number; name: string }[] = [];
	let decorators: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (!l.trim() || /^\s*#/.test(l)) { continue; }
		const indent = indentOf(l);
		while (stack.length && indent <= stack[stack.length - 1].indent) { stack.pop(); }
		const dm = /^\s*@([\w.]+)/.exec(l);
		if (dm) { decorators.push(`@${dm[1]}`); continue; }

		const cm = /^\s*class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/.exec(l);
		const fm = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/.exec(l);
		const className = stack.length ? stack[stack.length - 1].name : undefined;
		if (cm) {
			const name = cm[1];
			const end = blockEnd(i, indent);
			const inherits: RefRecord[] = [];
			for (const base of (cm[2] ?? '').split(',')) {
				const b = base.trim().replace(/\[.*$/, '');
				if (!b || b.includes('=')) { continue; }
				const parts = b.split('.');
				inherits.push(parts.length > 1 ? { name: parts[0], member: parts[parts.length - 1] } : { name: b });
			}
			symbols.push({ kind: 'class', name, qualifiedName: name, startLine: i + 1, endLine: end + 1, calls: [], injects: [], implements: [], inherits, references: decorators, signature: l.trim().replace(/:\s*$/, '') });
			stack.push({ indent, name });
		} else if (fm) {
			const end = blockEnd(i, indent);
			const q = className ? `${className}.${fm[1]}` : fm[1];
			symbols.push({
				kind: className ? 'method' : 'function', name: fm[1], qualifiedName: q, startLine: i + 1, endLine: end + 1,
				calls: collectCalls(i + 1, end, className, q), injects: [], implements: [], inherits: [], references: decorators, signature: l.trim().replace(/:\s*$/, ''),
			});
			// Nested defs are folded into their owner; skip past the body.
			i = end;
		}
		decorators = [];
	}
	return { symbols, imports, lineCount: lines.length, size: text.length };
}
