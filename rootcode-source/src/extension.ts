import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TrainerPanel, checkJobStatus } from './providers/TrainerPanel';
import { WorkflowRunner, type WorkflowKind } from './workflow';
import { registerAgent, createAgentHost, type AgentHost } from './agents/register';
import { AtlasPanel } from './atlas/AtlasPanel';
import { IndexOrchestrator } from './atlas/IndexOrchestrator';
import { createMemorySystem, registerMemoryUi, type MemorySystem } from './memory';

function getWebviewContent(webview: vscode.Webview, context: vscode.ExtensionContext, nonce: string): string {
	const resource = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...segments)).toString();
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('media', 'codicons', 'codicon.css')}">
<link rel="stylesheet" href="${resource('media', 'studio.css')}"><title>Rootcode</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${resource('media', 'studio.js')}"></script></body></html>`;
}

/** Bridges the Studio webview's task chat to the real agents. Returns true when the message was handled. */
function handleAgentMessage(message: unknown, host: AgentHost, post: (event: unknown) => void, memory?: MemorySystem): boolean {
	if (!message || typeof message !== 'object' || !('type' in message)) { return false; }
	if (message.type === 'rl-feedback') {
		const turnId = 'turnId' in message && typeof message.turnId === 'string' ? message.turnId : '';
		const value = 'value' in message ? message.value : 0;
		if (turnId && (value === 1 || value === -1)) {
			let update: ReturnType<NonNullable<typeof memory>['policy']['reward']>;
			try { update = memory?.policy.reward(turnId, value, 'you'); } catch { update = undefined; }
			// Always answer, so the card never hangs on "Updating policy…".
			post(update ? { type: 'rl-update', ...update } : { type: 'rl-update', turnId, failed: true });
		}
		return true;
	}
	if (message.type === 'atlas-open') {
		const paths = 'paths' in message && Array.isArray(message.paths) ? message.paths.filter((p): p is string => typeof p === 'string').slice(0, 50) : [];
		void vscode.commands.executeCommand('rootcode.atlas.highlight', paths);
		return true;
	}
	if (message.type === 'ready') { post({ type: 'agent-config', ...host.info() }); return true; }
	if (message.type === 'cancel') {
		host.cancel('sessionId' in message && typeof message.sessionId === 'string' ? message.sessionId : undefined);
		return false;
	}
	if (message.type !== 'agent-send') { return false; }
	const prompt = 'prompt' in message && typeof message.prompt === 'string' ? message.prompt.trim() : '';
	const sessionId = 'sessionId' in message && typeof message.sessionId === 'string' ? message.sessionId.slice(0, 64) : '';
	if (!prompt || prompt.length > 8000 || !sessionId) { return true; }
	void (async () => {
		try {
			const r = await host.prepare();
			if ('error' in r) { post({ type: 'agent-error', sessionId, message: r.error }); return; }
			for await (const e of r.service.send(sessionId, prompt)) { post({ ...e, type: `agent-${e.type}`, sessionId }); }
		} catch (e) {
			post({ type: 'agent-error', sessionId, message: e instanceof Error ? e.message : String(e) });
		} finally {
			post({ type: 'agent-done', sessionId });
		}
	})();
	return true;
}

export async function activate(context: vscode.ExtensionContext) {
	let panel: vscode.WebviewPanel | undefined;
	let runner: WorkflowRunner | undefined;
	// Cross-session memory is a best-effort feedback loop: if it fails to start, the agents run without it.
	let memory: MemorySystem | undefined;
	const webviews = new Set<(event: unknown) => void>();
	try {
		memory = createMemorySystem(context);
		await memory.store.initialize();
		context.subscriptions.push(memory.store, memory.tracker);
		await memory.policy.initialize();
		context.subscriptions.push(memory.policy, memory.policy.onDidUpdate(u => {
			for (const post of webviews) { post({ type: 'rl-update', ...u }); }
		}));
		registerMemoryUi(context, memory);
	} catch { memory = undefined; }
	// Structured deterministic context: indexes build in the background; agents and the graph UI share one orchestrator.
	let orchestrator: IndexOrchestrator | undefined;
	const getOrchestrator = () => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) { return undefined; }
		if (orchestrator?.root !== root) {
			orchestrator?.dispose();
			orchestrator = new IndexOrchestrator(root);
			void orchestrator.initialize().catch(() => undefined);
		}
		return orchestrator;
	};
	context.subscriptions.push({ dispose: () => orchestrator?.dispose() });
	getOrchestrator();
	const atlas = new AtlasPanel(context, getOrchestrator);
	context.subscriptions.push(atlas);
	const agentHost = createAgentHost(context, memory, getOrchestrator, (paths, label, reset) => {
		const root = orchestrator?.root;
		const rel = root ? paths.map(p => path.isAbsolute(p) ? path.relative(root, p).split(path.sep).join('/') : p.replace(/^\.\//, '')) : [];
		if (rel.length) { atlas.highlight(rel, label, false, reset); }
	});
	registerAgent(context, agentHost);
	// Register the webview view provider for the sidebar
	const viewProvider = new (class implements vscode.WebviewViewProvider {
		resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void {
			webviewView.webview.options = {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'media', 'codicons')]
			};
			const nonce = randomBytes(16).toString('hex');
			webviewView.webview.html = getWebviewContent(webviewView.webview, context, nonce);
			
			runner = new WorkflowRunner(event => { void webviewView.webview.postMessage(event); });
			const postView = (e: unknown) => { void webviewView.webview.postMessage(e); };
			webviews.add(postView);
			const listener = webviewView.webview.onDidReceiveMessage((message: unknown) => {
				if (handleAgentMessage(message, agentHost, e => { void webviewView.webview.postMessage(e); }, memory)) { return; }
				if (!message || typeof message !== 'object' || !('type' in message)) { return; }
				if (message.type === 'cancel') { runner?.cancel(); }
				if (message.type === 'open-trainer') { void vscode.commands.executeCommand('loraTrainer.startTraining'); }
				if (message.type === 'start' && 'kind' in message) {
					const kind = message.kind;
					if (kind !== 'tuning' && kind !== 'task') { return; }
					const prompt = 'prompt' in message && typeof message.prompt === 'string' ? message.prompt.trim() : '';
					if (kind === 'task' && (!prompt || prompt.length > 8000)) { return; }
					void runner?.start(kind as WorkflowKind, prompt);
				}
			});
			webviewView.onDidDispose(() => {
				webviews.delete(postView);
				runner?.dispose();
				listener.dispose();
				runner = undefined;
			}, undefined, context.subscriptions);
		}
	})();

	context.subscriptions.push(
		vscode.commands.registerCommand('loraTrainer.startTraining', () => TrainerPanel.show(context)),
		vscode.commands.registerCommand('loraTrainer.checkStatus', () => checkJobStatus(context, s => {
			void (s.stage === 'error' ? vscode.window.showErrorMessage(s.message) : vscode.window.showInformationMessage(s.message));
		})),
		vscode.window.registerWebviewViewProvider('rootcode.welcome', viewProvider, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('rootcode.atlas.open', () => atlas.show()),
		vscode.commands.registerCommand('rootcode.atlas.stats', () => {
			const o = getOrchestrator();
			if (!o) { return; }
			const s = o.scorer.stats();
			const pct = (v: number) => `${Math.round(v * 100)}%`;
			void vscode.window.showInformationMessage(s.turns
				? `Atlas context, ${s.turns} turn${s.turns === 1 ? '' : 's'}: ${pct(s.recallSelected)} of the code files the agent used were in the injected context (${pct(s.recallCandidates)} reachable by the graph); ${pct(s.precisionSelected)} of injected files were used.${s.exploredShown ? ` Exploratory picks: ${s.exploredHits}/${s.exploredShown} used.` : ''} By task: ${Object.entries(s.byType).map(([k, t]) => `${k} ${pct(t.recallSelected)} (${t.turns})`).join(', ')}.`
				: 'Atlas: no agent turns recorded yet. Run some agent tasks first.');
		}),
		vscode.commands.registerCommand('rootcode.atlas.highlight', (paths?: string[]) => atlas.highlight(Array.isArray(paths) ? paths : [], 'context', true)),
		vscode.commands.registerCommand('rootcode.atlas.showFile', (uri?: vscode.Uri) => {
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			atlas.show(target && root ? vscode.workspace.asRelativePath(target, false) : undefined);
		}),
		vscode.commands.registerCommand('rootcode.open', () => {
			if (panel) {
				panel.reveal();
				return;
			}
			panel = vscode.window.createWebviewPanel('rootcode.studio', 'Rootcode', vscode.ViewColumn.One, {
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'media', 'codicons')]
			});
			const current = panel;
			runner = new WorkflowRunner(event => { void current.webview.postMessage(event); });
			const postPanel = (e: unknown) => { void current.webview.postMessage(e); };
			webviews.add(postPanel);
			const listener = current.webview.onDidReceiveMessage((message: unknown) => {
				if (handleAgentMessage(message, agentHost, e => { void current.webview.postMessage(e); }, memory)) { return; }
				if (!message || typeof message !== 'object' || !('type' in message)) { return; }
				if (message.type === 'cancel') { runner?.cancel(); }
				if (message.type === 'open-trainer') { void vscode.commands.executeCommand('loraTrainer.startTraining'); }
				if (message.type === 'start' && 'kind' in message) {
					const kind = message.kind;
					if (kind !== 'tuning' && kind !== 'task') { return; }
					const prompt = 'prompt' in message && typeof message.prompt === 'string' ? message.prompt.trim() : '';
					if (kind === 'task' && (!prompt || prompt.length > 8000)) { return; }
					void runner?.start(kind as WorkflowKind, prompt);
				}
			});
			current.onDidDispose(() => {
				webviews.delete(postPanel);
				runner?.dispose();
				listener.dispose();
				panel = undefined;
			}, undefined, context.subscriptions);
			const nonce = randomBytes(16).toString('hex');
			current.webview.html = getWebviewContent(current.webview, context, nonce);
			context.subscriptions.push(current);
		})
	);
}
