import type { ContextItem, EntryPoint } from './types';

const why = (i: ContextItem) => {
	const bits = [i.source === 'cochange' ? 'changes together with an entry file in git' : i.source === 'test' ? 'test for an entry file' : i.source === 'imports' ? `imported by an entry file (${i.hopDistance} hop${i.hopDistance > 1 ? 's' : ''})` : i.source === 'importedBy' ? `imports an entry file (${i.hopDistance} hop${i.hopDistance > 1 ? 's' : ''})` : i.source];
	if (i.explored) { bits.push('exploratory pick'); }
	if (i.hasErrors) { bits.push(`${i.errorCount} error${i.errorCount > 1 ? 's' : ''}`); }
	if (i.recentlyChanged) { bits.push(i.gitRank === 0 ? 'uncommitted' : 'recently changed'); }
	return bits.join(', ');
};

/** Renders scored context for a prompt: full files where the budget allowed, symbol outlines otherwise. */
export function formatContext(items: ContextItem[], entries: EntryPoint[], clusterNote = ''): string {
	if (!items.length) { return ''; }
	const parts = [
		'[Rootcode structured context — deterministic, from the workspace dependency graph. Entry points: ' +
		(entries.map(e => `${e.path} (${e.reason})`).join('; ') || 'none') + ']',
	];
	if (clusterNote) { parts.push(clusterNote); }
	for (const i of items) {
		parts.push(`\n### ${i.path} — ${why(i)}`);
		if (i.mode === 'seen') { parts.push('(unchanged since it was shown earlier in this conversation — see above)'); continue; }
		if (i.mode === 'full') { parts.push('```\n' + i.content + '\n```'); }
		else if (i.mode === 'focus') { parts.push('(relevant symbols in full, the rest as signatures — read_file for everything)\n```\n' + i.content + '\n```'); }
		else { parts.push('(outline only — read_file for the body)\n' + i.symbols.map(s => `- ${s.signature ?? s.name} [L${s.startLine}-${s.endLine}]`).join('\n')); }
	}
	return parts.join('\n');
}
