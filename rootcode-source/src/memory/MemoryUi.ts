import * as vscode from 'vscode';
import * as path from 'node:path';
import { MEMORY_BRAND, isMemoryEnabled } from './brand';
import type { MemorySystem } from './index';
import type { TrajectoryMemory } from './types';

const esc = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function signed(value: number): string { return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`; }

function panelHtml(memories: TrajectoryMemory[], filePath: string): string {
	const rows = [...memories].sort((a, b) => b.turn.timestamp - a.turn.timestamp).map(m => {
		const r = m.reward.finalReward;
		const tone = r > 0.3 ? 'good' : r < -0.3 ? 'bad' : 'flat';
		const file = m.turn.entryPointFile ? path.basename(m.turn.entryPointFile) : '—';
		const pattern = m.extractedPattern
			? `<div class="pat">avoid: ${esc(m.extractedPattern.avoided)}<br>prefer: ${esc(m.extractedPattern.preferred)}<br><span>seen ${m.extractedPattern.observedCount}× · confidence ${m.extractedPattern.confidence.toFixed(1)}</span></div>`
			: '';
		return `<tr><td>${esc(new Date(m.turn.timestamp).toLocaleString())}</td><td>${esc(m.turn.queryType)}</td><td>${esc(file)}</td>
			<td><div class="bar ${tone}"><i style="width:${Math.round(Math.abs(r) * 100)}%"></i></div><b class="${tone}">${signed(r)}</b></td>
			<td>${esc(m.failureReason ?? '')}${pattern}</td><td>${m.turn.steps.length}</td></tr>`;
	}).join('');
	return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
:root { --recall: ${MEMORY_BRAND.color}; }
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px 28px; }
h1 { display: flex; align-items: center; gap: 10px; font-size: 18px; margin: 0 0 4px; }
h1 span { width: 10px; height: 10px; border-radius: 50%; background: var(--recall); }
h1 em { font-style: normal; color: var(--recall); }
p.note { color: var(--vscode-descriptionForeground); max-width: 760px; margin: 4px 0 18px; line-height: 1.5; }
code { color: var(--recall); }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th { text-align: left; color: var(--recall); border-bottom: 2px solid var(--recall); padding: 6px 8px; }
td { border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3)); padding: 6px 8px; vertical-align: top; }
.bar { display: inline-block; width: 60px; height: 6px; border-radius: 3px; background: rgba(128,128,128,.25); margin-right: 8px; vertical-align: middle; }
.bar i { display: block; height: 100%; border-radius: 3px; background: var(--vscode-descriptionForeground); }
.bar.good i { background: var(--recall); } .bar.bad i { background: var(--vscode-errorForeground, #f85149); }
b.good { color: var(--recall); } b.bad { color: var(--vscode-errorForeground, #f85149); } b.flat { color: var(--vscode-descriptionForeground); }
.pat { margin-top: 4px; color: var(--vscode-descriptionForeground); } .pat span { opacity: .8; }
.empty { color: var(--vscode-descriptionForeground); padding: 24px 0; }
</style></head><body>
<h1><span></span><em>${MEMORY_BRAND.name}</em> · agent memory</h1>
<p class="note">Rootcode scores each agent response from what you do next (edits, errors, tests, git reverts) and feeds the lessons into future prompts for this project. The model itself is not retrained. Only metadata is stored, never your code.<br>File: <code>${esc(filePath)}</code></p>
${memories.length ? `<table><tr><th>When</th><th>Type</th><th>File</th><th>Reward</th><th>Outcome</th><th>Steps</th></tr>${rows}</table>` : '<div class="empty">No memories recorded yet for this project.</div>'}
</body></html>`;
}

/** Status bar item, memory viewer and maintenance commands, all in the Recall color. */
export function registerMemoryUi(context: vscode.ExtensionContext, memory: MemorySystem): void {
	const { store } = memory;
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	item.color = MEMORY_BRAND.color;
	item.command = 'rootcode.memory.show';
	const refresh = (last?: TrajectoryMemory) => {
		if (!isMemoryEnabled()) { item.hide(); return; }
		const count = store.getAll().length;
		item.text = last
			? `$(${MEMORY_BRAND.codicon}) ${MEMORY_BRAND.short} ${signed(last.reward.finalReward)}`
			: `$(${MEMORY_BRAND.codicon}) ${MEMORY_BRAND.short} · ${count}`;
		const tip = new vscode.MarkdownString(last
			? `**${MEMORY_BRAND.name}** learned from the last response: ${last.failureReason ?? 'recorded'} (reward ${signed(last.reward.finalReward)}).\n\n${count} memories for this project. Click to view.`
			: `**${MEMORY_BRAND.name}**: ${count} memories for this project. Click to view.`);
		item.tooltip = tip;
		item.show();
	};
	refresh();

	let panel: vscode.WebviewPanel | undefined;
	const render = () => { if (panel) { panel.webview.html = panelHtml(store.getAll(), store.filePath); } };

	context.subscriptions.push(
		item,
		store.onDidSave(m => { refresh(m); render(); }),
		vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('rootcode.memory')) { refresh(); } }),
		vscode.commands.registerCommand('rootcode.memory.show', () => {
			if (panel) { panel.reveal(); render(); return; }
			panel = vscode.window.createWebviewPanel('rootcode.memory', `${MEMORY_BRAND.name}`, vscode.ViewColumn.Beside, { enableScripts: false });
			panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'rootcode.svg');
			panel.onDidDispose(() => { panel = undefined; });
			render();
		}),
		vscode.commands.registerCommand('rootcode.memory.openFile', async () => {
			try { await vscode.window.showTextDocument(vscode.Uri.file(store.filePath)); }
			catch { void vscode.window.showInformationMessage('No memory file has been written for this project yet.'); }
		}),
		vscode.commands.registerCommand('rootcode.memory.clear', async () => {
			const choice = await vscode.window.showWarningMessage(`Clear all ${MEMORY_BRAND.name} memories for this project?`, { modal: true }, 'Clear');
			if (choice === 'Clear') { await store.clear(); refresh(); render(); }
		}),
		{ dispose: () => panel?.dispose() },
	);
}
