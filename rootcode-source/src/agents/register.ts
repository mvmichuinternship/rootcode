import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentService } from './AgentService';
import { DEFAULT_MODEL, type AgentConfig } from './config';
import { MAIN_SLOT, readEnv, resolveGithub, resolveModel, resolvePrReviewModel, type ResolvedModel } from './env';
import { resolveSettings } from '../providers/TrainerPanel';
import type { MemorySystem } from '../memory';
import type { IndexOrchestrator } from '../atlas/IndexOrchestrator';

const GITHUB_KEY = 'rootcode.githubToken';
const PARTICIPANT_ID = 'rootcode.agent';

/**
 * Main agents' model: provider/model/key from ROOTCODE_* and the provider's key var in the env. VS Code
 * settings and the trainer's saved LoRA deployment only fill Baseten values the env leaves unset.
 */
function resolveMainModel(root: string): ResolvedModel {
	const settings = vscode.workspace.getConfiguration('rootcode.agent');
	return resolveModel(root, MAIN_SLOT, provider => {
		if (provider !== 'baseten') { return {}; }
		let saved: { baseUrl?: string; model?: string } = {};
		if ((readEnv(root).ROOTCODE_MODEL_SOURCE || settings.get<string>('modelSource')) === 'trained-endpoint') {
			try {
				saved = JSON.parse(fs.readFileSync(path.join(root, '.repo2lora', 'rootcode-endpoint.json'), 'utf8')) as typeof saved;
			} catch { /* no deployed endpoint yet */ }
		}
		return {
			apiKey: resolveSettings(root, 'baseten').apiKey || undefined,
			model: settings.get<string>('model') || saved.model || undefined,
			baseUrl: settings.get<string>('baseUrl') || saved.baseUrl || undefined,
			maxTokens: settings.get<number>('maxTokens', 8192),
			reasoningEffort: settings.get<string>('reasoningEffort') || undefined,
		};
	});
}

export interface AgentHost {
	/** Returns an error message when the agent can't start (missing folder or key). */
	prepare(): Promise<{ service: AgentService } | { error: string }>;
	/** Non-secret status for the UI header. */
	info(): { provider: string; model: string; workspace: string; hasKey: boolean; error?: string };
	cancel(sessionId?: string): void;
	reset(): Promise<void>;
}

export function createAgentHost(context: vscode.ExtensionContext, memory?: MemorySystem, atlas?: () => IndexOrchestrator | undefined, onActivity?: (paths: string[], label: string, reset?: boolean) => void): AgentHost {
	let service: AgentService | undefined;
	let structureKey = '';
	const approve = async (description: string) => {
		const choice = await vscode.window.showWarningMessage(`Rootcode agent wants to run: ${description}`, { modal: true }, 'Approve');
		return choice === 'Approve';
	};
	const host: AgentHost = {
		async prepare() {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!root) { return { error: 'Open a folder to use the Rootcode agent.' }; }
			try { resolveMainModel(root); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
			const sandboxImage = vscode.workspace.getConfiguration('rootcode.agent').get<string>('sandboxImage', 'node:22-slim');
			const gh = resolveGithub(root, await context.secrets.get(GITHUB_KEY));
			const github = gh.token ? { token: gh.token, mcpUrl: gh.mcpUrl ?? '', toolsets: gh.toolsets ?? '' } : undefined;
			// Models re-read env on every call; only the GitHub MCP connection and sandbox need a rebuild.
			const key = JSON.stringify([root, sandboxImage, github]);
			if (service && key !== structureKey) { await host.reset(); }
			if (!service) {
				const cfg: AgentConfig = {
					mainModel: () => resolveMainModel(root),
					prReviewModel: () => resolvePrReviewModel(root),
					streaming: () => !['0', 'false', 'off'].includes((readEnv(root).ROOTCODE_STREAM ?? '').toLowerCase()),
					sandboxImage,
					workspaceRoot: root,
					context: atlas?.(),
					onActivity,
					github,
				};
				service = new AgentService(cfg, approve, memory);
				structureKey = key;
			}
			return { service };
		},
		info() {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!root) { return { provider: '', model: DEFAULT_MODEL, workspace: '', hasKey: false, error: 'Open a folder first.' }; }
			try {
				const m = resolveMainModel(root);
				return { provider: m.provider, model: m.model, workspace: path.basename(root), hasKey: true };
			} catch (e) {
				return { provider: '', model: '', workspace: path.basename(root), hasKey: false, error: e instanceof Error ? e.message : String(e) };
			}
		},
		cancel(sessionId) { service?.cancel(sessionId); },
		async reset() { const s = service; service = undefined; structureKey = ''; await s?.dispose(); },
	};
	return host;
}

const chatSessions = new WeakMap<object, string>();
/** The chat panel keeps one history array per thread, so it identifies the thread. */
function chatSessionId(ctx: vscode.ChatContext): string {
	let id = chatSessions.get(ctx.history);
	if (!id) { id = randomUUID(); chatSessions.set(ctx.history, id); }
	return id;
}

export function registerAgent(context: vscode.ExtensionContext, host: AgentHost): void {
	const reset = () => host.reset();
	async function getService(stream: vscode.ChatResponseStream): Promise<AgentService | undefined> {
		const r = await host.prepare();
		if ('error' in r) { stream.markdown(r.error); return undefined; }
		return r.service;
	}

	const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
		const svc = await getService(stream);
		if (!svc) { return; }
		const sessionId = chatSessionId(chatContext);
		const cancel = token.onCancellationRequested(() => svc.cancel(sessionId));
		let lastAuthor = '';
		try {
			for await (const e of svc.send(sessionId, request.prompt)) {
				if (e.type === 'tool-call') {
					stream.progress(`${e.author}: ${e.name}`);
				} else if (e.type === 'text' && !e.partial) {
					if (e.author !== lastAuthor) { stream.markdown(`\n\n**${e.author}**\n\n`); lastAuthor = e.author; }
					stream.markdown(`${e.text}\n\n`);
				} else if (e.type === 'context-used') {
					stream.progress(`Atlas: ${e.count} relevant file${e.count === 1 ? '' : 's'} from the dependency graph`);
				} else if (e.type === 'memory-used') {
					stream.progress(`Recall: applying ${e.count} lesson${e.count === 1 ? '' : 's'} from past sessions`);
				} else if (e.type === 'error') {
					stream.markdown(`\n\n$(error) ${e.message}`);
				}
			}
		} finally {
			cancel.dispose();
		}
	};

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'rootcode.svg');

	context.subscriptions.push(
		participant,
		{ dispose: () => { void host.reset(); } },
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('rootcode.agent') || e.affectsConfiguration('loraTrainer')) { void reset(); }
		}),
		vscode.commands.registerCommand('rootcode.agent.setGithubToken', async () => {
			const value = await vscode.window.showInputBox({ prompt: 'GitHub token (for the PR review agent)', password: true, ignoreFocusOut: true });
			if (value) { await context.secrets.store(GITHUB_KEY, value); await reset(); }
		}),
		vscode.commands.registerCommand('rootcode.agent.openChat', () => vscode.commands.executeCommand('workbench.action.chat.open', { query: '@rootcode ' })),
	);
}
