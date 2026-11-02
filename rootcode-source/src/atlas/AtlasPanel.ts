import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IndexOrchestrator } from './IndexOrchestrator';
import { fileGraphWithClusters } from './clusters';
import { fileBlastRadius, fileNeighbors, getCallers, getCallees } from './queries';

/** The dependency-graph webview. The index itself lives in the IndexOrchestrator. */
export class AtlasPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private focusPath: string | undefined;
	private ready = false;
	private queued: { paths: string[]; label: string; reset: boolean }[] = [];
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext, private readonly orchestrator: () => IndexOrchestrator | undefined) {}

	show(focusPath?: string): void {
		this.focusPath = focusPath;
		if (this.panel) { this.panel.reveal(); if (focusPath) { void this.panel.webview.postMessage({ type: 'focus', path: focusPath }); } return; }
		this.openPanel(false);
	}

	private openPanel(preserveFocus: boolean): void {
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		this.ready = false;
		const panel = this.panel = vscode.window.createWebviewPanel('rootcode.atlas', 'Rootcode Atlas', { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [media],
		});
		const nonce = randomBytes(16).toString('hex');
		const res = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
		panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${res('atlas.css')}"><title>Rootcode Atlas</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${res('atlas.js')}"></script></body></html>`;
		const orch = this.orchestrator();
		const sub = orch?.onDidChange(() => void this.postGraph());
		panel.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m), undefined, this.disposables);
		panel.onDidDispose(() => { sub?.dispose(); this.panel = undefined; this.ready = false; this.queued = []; });
	}

	/**
	 * Highlights files in the graph (agent activity). Opens the panel beside the editor, without stealing
	 * focus, when `rootcode.atlas.autoOpen` is on (or `force` is set).
	 */
	highlight(paths: string[], label: string, force = false, reset = false): void {
		const orch = this.orchestrator();
		const known = orch?.knownPaths(paths) ?? [];
		if (!known.length) { return; }
		const auto = vscode.workspace.getConfiguration('rootcode.atlas').get<boolean>('autoOpen', true);
		if (!this.panel) {
			if (!auto && !force) { return; }
			this.queued.push({ paths: known, label, reset });
			this.openPanel(!force);
			return;
		}
		if (force) { this.panel.reveal(undefined, false); }
		if (!this.ready) { this.queued.push({ paths: known, label, reset }); return; }
		void this.panel.webview.postMessage({ type: 'activity', paths: known, label, reset });
	}

	private async onMessage(message: unknown): Promise<void> {
		if (!message || typeof message !== 'object' || !('type' in message)) { return; }
		const m = message as { type: string; path?: unknown; line?: unknown };
		const str = typeof m.path === 'string' ? m.path : '';
		const orch = this.orchestrator();
		switch (m.type) {
			case 'ready':
				this.ready = true;
				await this.postGraph();
				if (this.focusPath) { void this.panel?.webview.postMessage({ type: 'focus', path: this.focusPath }); }
				for (const q of this.queued.splice(0)) { void this.panel?.webview.postMessage({ type: 'activity', ...q }); }
				break;
			case 'reindex':
				await orch?.initialize(true);
				await this.postGraph();
				break;
			case 'open': {
				const index = await orch?.getIndex();
				if (!orch || !index || !str || !index.hasFile(str)) { return; }
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(orch.root, str)));
				const line = typeof m.line === 'number' ? Math.max(0, m.line - 1) : 0;
				await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(line, 0, line, 0) });
				break;
			}
			case 'detail':
				await this.postDetail(str);
				break;
		}
	}

	private async postGraph(): Promise<void> {
		if (!this.panel) { return; }
		const orch = this.orchestrator();
		const idx = await orch?.getIndex();
		if (!orch || !idx) { void this.panel.webview.postMessage({ type: 'error', message: 'Open a folder to build the dependency graph.' }); return; }
		void this.panel.webview.postMessage({ type: 'graph', root: path.basename(orch.root), graph: fileGraphWithClusters(idx) });
	}

	private async postDetail(p: string): Promise<void> {
		const orch = this.orchestrator();
		const idx = await orch?.getIndex();
		if (!orch || !idx || !this.panel || !idx.getFileNode(p)) { return; }
		const { imports, importedBy } = fileNeighbors(idx, p);
		const symbols = idx.symbolsInFile(p).map(s => ({
			name: s.qualifiedName, kind: s.kind, line: s.startLine, signature: s.signature,
			callers: getCallers(idx, s.id).filter(c => c.node.id !== s.id).slice(0, 12).map(c => ({ name: c.node.qualifiedName, path: c.node.path, line: c.node.startLine, kind: c.kind })),
			callees: getCallees(idx, s.id).filter(c => c.node).slice(0, 12).map(c => ({ name: c.node!.qualifiedName, path: c.node!.path, line: c.node!.startLine, kind: c.kind })),
		}));
		const recent = orch.git.rankOf(p);
		void this.panel.webview.postMessage({ type: 'detail', path: p, imports, importedBy, symbols, blast: fileBlastRadius(idx, p, 3), gitRank: recent });
	}

	dispose(): void {
		this.panel?.dispose();
		for (const d of this.disposables) { d.dispose(); }
	}
}
