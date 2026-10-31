import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { TrainerPanel, checkJobStatus } from './providers/TrainerPanel';
import { WorkflowRunner, type WorkflowKind } from './workflow';

function getWebviewContent(webview: vscode.Webview, context: vscode.ExtensionContext, nonce: string): string {
	const resource = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...segments)).toString();
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource('node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')}">
<link rel="stylesheet" href="${resource('media', 'studio.css')}"><title>Rootcode</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${resource('media', 'studio.js')}"></script></body></html>`;
}

export function activate(context: vscode.ExtensionContext) {
	let panel: vscode.WebviewPanel | undefined;
	let runner: WorkflowRunner | undefined;

	// Register the webview view provider for the sidebar
	const viewProvider = new (class implements vscode.WebviewViewProvider {
		resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void {
			webviewView.webview.options = {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')]
			};
			const nonce = randomBytes(16).toString('hex');
			webviewView.webview.html = getWebviewContent(webviewView.webview, context, nonce);
			
			runner = new WorkflowRunner(event => { void webviewView.webview.postMessage(event); });
			const listener = webviewView.webview.onDidReceiveMessage((message: unknown) => {
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
		vscode.commands.registerCommand('rootcode.open', () => {
			if (panel) {
				panel.reveal();
				return;
			}
			panel = vscode.window.createWebviewPanel('rootcode.studio', 'Rootcode', vscode.ViewColumn.One, {
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')]
			});
			const current = panel;
			runner = new WorkflowRunner(event => { void current.webview.postMessage(event); });
			const listener = current.webview.onDidReceiveMessage((message: unknown) => {
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
