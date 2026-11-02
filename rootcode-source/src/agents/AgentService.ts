import { InMemoryRunner, StreamingMode, getFunctionCalls, getFunctionResponses, REQUEST_CONFIRMATION_FUNCTION_CALL_NAME } from '@google/adk';
import type { Content } from '@google/genai';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { APP_NAME, type AgentConfig } from './config';
import { buildAgentSystem, type AgentSystem } from './agents';
import { MEMORY_STATE_KEY, REPO_MAP_STATE_KEY } from './prompts';
import { isMemoryEnabled, RL_ARMS, type AgentStep, type AgentTurn, type MemorySystem, type RlDecision } from '../memory';

/**
 * What the UI renders. `partial` text/thought events are streamed deltas to append; a non-partial
 * event carries the complete text and replaces whatever was accumulated for that step.
 */
export type AgentEvent =
	| { type: 'thought'; author: string; text: string; partial: boolean }
	| { type: 'text'; author: string; text: string; partial: boolean }
	| { type: 'tool-call'; author: string; id: string; name: string; args: Record<string, unknown> }
	| { type: 'tool-result'; author: string; id: string; name: string; ok: boolean; preview: string }
	| { type: 'handoff'; from: string; to: string }
	| { type: 'approval'; description: string }
	| { type: 'approval-result'; approved: boolean }
	| { type: 'memory-used'; count: number; items: string[] }
	| { type: 'context-used'; count: number; files: string[] }
	| ({ type: 'rl-decision' } & RlDecision)
	| { type: 'error'; message: string };

/** Asked when a tool (e.g. git push) needs a human decision. */
export type ApprovalHandler = (description: string) => Promise<boolean>;

const PREVIEW_LIMIT = 1500;
const ARGS_LIMIT = 1500;

function clip(value: unknown, limit: number): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
	return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

/** Large arguments (e.g. a whole file being written) are shortened so they stay cheap to render and store. */
function boundedArgs(args: Record<string, unknown>): Record<string, unknown> {
	const bounded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		bounded[key] = typeof value === 'string' && value.length > ARGS_LIMIT ? clip(value, ARGS_LIMIT) : value;
	}
	return bounded;
}

/** Tool results come back as plain objects, or MCP-style `{content:[{type:'text',text}], isError?}`. */
function describeResult(response: Record<string, unknown> | undefined): { ok: boolean; preview: string } {
	if (!response) { return { ok: true, preview: '' }; }
	const content = response.content;
	const texts = Array.isArray(content)
		? content.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).filter(Boolean)
		: [];
	const ok = !response.error && response.isError !== true;
	const preview = texts.length ? texts.join('\n') : response.error ? String(response.error) : clip(response, PREVIEW_LIMIT);
	return { ok, preview: clip(preview, PREVIEW_LIMIT) };
}

const PATH_KEYS = new Set(['path', 'file', 'filePath', 'file_path', 'filename', 'imports', 'importedBy']);
/** Collects file paths named in a tool's args or result (shallow JSON walk). */
function pathsIn(value: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
	if (depth > 4 || value === null || typeof value !== 'object') { return out; }
	if (Array.isArray(value)) { for (const v of value.slice(0, 100)) { pathsIn(v, out, depth + 1); } return out; }
	for (const [k, v] of Object.entries(value)) {
		if (PATH_KEYS.has(k) && typeof v === 'string') { out.add(v); }
		else if (PATH_KEYS.has(k) && Array.isArray(v)) { for (const s of v.slice(0, 100)) { if (typeof s === 'string') { out.add(s); } } }
		else { pathsIn(v, out, depth + 1); }
	}
	return out;
}

const FILE_ARG_KEYS = ['path', 'file', 'filePath', 'file_path', 'filename'];

function classifyQuery(text: string): AgentTurn['queryType'] {
	if (/\b(bug|fix|error|fail(s|ed|ing)?|crash|exception|debug|broken)\b/i.test(text)) { return 'debug'; }
	if (/\b(refactor|rename|clean ?up|simplify|restructure)\b/i.test(text)) { return 'refactor'; }
	if (/\b(explain|what does|why|how does|describe)\b/i.test(text)) { return 'explain'; }
	if (/\b(add|create|implement|write|generate|build)\b/i.test(text)) { return 'generate'; }
	return 'unknown';
}

export class AgentService {
	private readonly system: AgentSystem;
	private readonly runner: InMemoryRunner;
	private readonly userId = 'local-user';
	private readonly runs = new Map<string, AbortController>();
	private readonly toolNames = new Map<string, string>();

	private readonly pendingTurns = new Map<string, AgentTurn>();
	private readonly trackingListener?: vscode.Disposable;

	constructor(private readonly cfg: AgentConfig, private readonly approve: ApprovalHandler, private readonly memory?: MemorySystem) {
		this.system = buildAgentSystem(cfg);
		this.runner = new InMemoryRunner({ agent: this.system.root, appName: APP_NAME });
		this.trackingListener = memory?.tracker.onTrackingComplete(signals => {
			const turn = this.pendingTurns.get(signals.turnId);
			this.pendingTurns.delete(signals.turnId);
			if (!turn) { return; }
			const { store, rewardComputer } = memory;
			const reward = rewardComputer.compute(signals, turn);
			memory.policy.reward(turn.id, reward.finalReward, 'implicit');
			this.cfg.context?.applyReward(turn.id, reward.finalReward);
			void store.save({
				turn, reward,
				failureReason: rewardComputer.extractFailureReason(signals, turn),
				extractedPattern: rewardComputer.extractPattern(signals, turn, reward),
			}).catch(() => undefined);
		});
	}

	/** Cancels one conversation's run, or every run when no id is given. */
	cancel(sessionId?: string): void {
		if (sessionId) { this.runs.get(sessionId)?.abort(); } else { this.runs.forEach(c => c.abort()); }
	}
	isRunning(sessionId: string): boolean { return this.runs.has(sessionId); }
	async dispose(): Promise<void> { this.cancel(); this.trackingListener?.dispose(); this.pendingTurns.clear(); await this.system.close(); }

	/** Each sessionId is an independent conversation with its own ADK session state. */
	async *send(sessionId: string, text: string): AsyncGenerator<AgentEvent> {
		if (this.runs.has(sessionId)) { yield { type: 'error', message: 'This conversation is already running.' }; return; }
		const abort = new AbortController();
		this.runs.set(sessionId, abort);
		try {
			const ids = { appName: APP_NAME, userId: this.userId, sessionId };
			const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
			const queryType = classifyQuery(text);
			let newSession = false;
			if (!(await this.runner.sessionService.getSession(ids))) {
				newSession = true;
				// Past lessons are injected once, when a conversation starts, via session state.
				let injection = '';
				try { injection = this.memory && isMemoryEnabled() ? this.memory.injector.getInjection(text, activeFile, queryType) : ''; } catch { /* memory is optional */ }
				// Session-stable state lands at the end of the system prompt (see prompts.ts), after the static text.
				let repoMap = '';
				try { repoMap = (await this.cfg.context?.repoMap()) ?? ''; } catch { /* optional */ }
				const state: Record<string, string> = {};
				if (injection) { state[MEMORY_STATE_KEY] = injection; }
				if (repoMap) { state[REPO_MAP_STATE_KEY] = repoMap; }
				await this.runner.sessionService.createSession(Object.keys(state).length ? { ...ids, state } : ids);
				const items = injection.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2, 200));
				if (items.length) { yield { type: 'memory-used', count: items.length, items: items.slice(0, 6) }; }
			}
			const turn: AgentTurn = {
				id: randomUUID(), timestamp: Date.now(), sessionId, query: text, queryType,
				steps: [], finalResponse: '', filesReferenced: [], entryPointFile: activeFile,
			};
			// The RL policy picks a strategy for this turn; the UI shows the choice and the model is told to follow it.
			let promptText = text;
			let arm: { id: string; context?: { hops?: number; topK?: number; tokenBudgetScale?: number } } | undefined;
			if (this.memory && isMemoryEnabled()) {
				// Compile errors in the active file change what works, so they get their own bandit context.
				const rlContext = this.cfg.context?.hasActiveErrors() ? `${queryType}+errors` : queryType;
				const decision = this.memory.policy.select(turn.id, rlContext);
				arm = RL_ARMS.find(a => a.id === decision.armId);
				promptText = `[Rootcode RL policy — strategy "${decision.label}": ${decision.hint}]\n\n${text}`;
				yield { type: 'rl-decision', ...decision };
			}
			// Deterministic structural context: entry points -> import-graph traversal -> scored, budgeted files.
			if (this.cfg.context) {
				try {
					const ctx = await this.cfg.context.buildForQuery(text, turn.id, {
						queryType, arm: arm?.id, hops: arm?.context?.hops, topK: arm?.context?.topK, budgetScale: arm?.context?.tokenBudgetScale,
					}, sessionId);
					if (ctx.text) {
						promptText = `${ctx.text}\n\n${promptText}`;
						yield { type: 'context-used', count: ctx.files.length, files: ctx.files.slice(0, 12) };
						this.cfg.onActivity?.(ctx.files, 'context', true);
					}
					// Follow-up turns get lessons re-ranked by the dependency neighbourhood of *this* request.
					if (!newSession && this.memory && isMemoryEnabled()) {
						const hood = new Set(ctx.files.map(f => path.join(this.cfg.workspaceRoot, f)));
						const lessons = this.memory.injector.getInjection(text, activeFile, queryType, hood);
						if (lessons) {
							promptText = `${lessons}\n\n${promptText}`;
							const items = lessons.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2, 200));
							if (items.length) { yield { type: 'memory-used', count: items.length, items: items.slice(0, 6) }; }
						}
					}
				} catch { /* context is optional */ }
			}
			const edited = new Set<string>();
			const inFlight = new Map<string, { args: Record<string, unknown>; startedAt: number }>();
			const streaming = this.cfg.streaming?.() ?? true;
			let message: Content = { role: 'user', parts: [{ text: promptText }] };
			// A confirmation request pauses the run; resume it with the human's answer.
			for (;;) {
				let pending: { id: string; hint: string } | undefined;
				const runConfig = streaming ? { streamingMode: StreamingMode.SSE } : undefined;
				for await (const event of this.runner.runAsync({ userId: this.userId, sessionId, newMessage: message, runConfig, abortSignal: abort.signal })) {
					if (event.errorMessage) { yield { type: 'error', message: event.errorMessage }; return; }
					const author = event.author ?? 'agent';
					const partial = event.partial === true;

					for (const part of event.content?.parts ?? []) {
						if (part.thought && part.text) { yield { type: 'thought', author, text: part.text, partial }; }
						else if (part.text && !part.functionCall && !part.functionResponse) {
							if (!partial) { turn.finalResponse = part.text; }
							yield { type: 'text', author, text: part.text, partial }; }
					}
					if (partial) { continue; }

					for (const call of getFunctionCalls(event)) {
						const id = call.id ?? `${author}-${call.name}`;
						if (call.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
							const original = (call.args as { originalFunctionCall?: { name?: string; args?: unknown } } | undefined)?.originalFunctionCall;
							pending = { id, hint: `${original?.name ?? 'tool'} ${JSON.stringify(original?.args ?? {})}` };
						} else if (call.name === 'transfer_to_agent') {
							yield { type: 'handoff', from: author, to: String((call.args as { agent_name?: unknown } | undefined)?.agent_name ?? '') };
						} else {
							this.toolNames.set(id, call.name ?? 'unknown');
							inFlight.set(id, { args: call.args ?? {}, startedAt: Date.now() });
							this.notifyActivity([...pathsIn(call.args)], call.name ?? 'tool');
							if (call.name === 'write_file' && typeof call.args?.path === 'string') { edited.add(call.args.path); }
							yield { type: 'tool-call', author, id, name: call.name ?? 'unknown', args: boundedArgs(call.args ?? {}) };
						}
					}
					for (const res of getFunctionResponses(event)) {
						const id = res.id ?? '';
						const name = res.name ?? this.toolNames.get(id) ?? 'unknown';
						this.toolNames.delete(id);
						if (name === 'transfer_to_agent' || name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) { continue; }
						this.notifyActivity([...pathsIn(res.response)], name);
						const described = describeResult(res.response as Record<string, unknown> | undefined);
						this.recordStep(turn, inFlight.get(id), name, described.preview);
						inFlight.delete(id);
						yield { type: 'tool-result', author, id, name, ...described };
					}
				}
				if (!pending) { this.cfg.context?.recordUsage(turn.id, turn.filesReferenced, [...edited]); this.trackTurn(turn); return; }
				yield { type: 'approval', description: pending.hint };
				const confirmed = await this.approve(pending.hint);
				yield { type: 'approval-result', approved: confirmed };
				message = { role: 'user', parts: [{ functionResponse: { id: pending.id, name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME, response: { confirmed } } }] };
			}
		} catch (e) {
			if (!abort.signal.aborted) { yield { type: 'error', message: e instanceof Error ? e.message : String(e) }; }
		} finally {
			this.runs.delete(sessionId);
		}
	}

	private notifyActivity(paths: string[], label: string): void {
		if (!paths.length) { return; }
		try { this.cfg.onActivity?.(paths, label); } catch { /* visualisation must never break a run */ }
	}

	private recordStep(turn: AgentTurn, call: { args: Record<string, unknown>; startedAt: number } | undefined, tool: string, preview: string): void {
		const args = call?.args ?? {};
		const step: AgentStep = {
			stepIndex: turn.steps.length, tool, args: boundedArgs(args),
			resultSummary: preview.slice(0, 200), durationMs: call ? Date.now() - call.startedAt : 0,
		};
		turn.steps.push(step);
		for (const key of FILE_ARG_KEYS) {
			const value = args[key];
			if (typeof value !== 'string' || !value) { continue; }
			const file = path.isAbsolute(value) ? value : path.join(this.cfg.workspaceRoot, value);
			if (!turn.filesReferenced.includes(file)) { turn.filesReferenced.push(file); }
		}
	}

	/** Hands a finished run to the tracker, which watches how the user reacts to it. */
	private trackTurn(turn: AgentTurn): void {
		if (!this.memory || !isMemoryEnabled()) { return; }
		try {
			this.pendingTurns.set(turn.id, turn);
			this.memory.tracker.startTracking(turn);
		} catch { this.pendingTurns.delete(turn.id); }
	}
}
