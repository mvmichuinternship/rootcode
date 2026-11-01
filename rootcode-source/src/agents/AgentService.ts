import { InMemoryRunner, StreamingMode, getFunctionCalls, getFunctionResponses, REQUEST_CONFIRMATION_FUNCTION_CALL_NAME } from '@google/adk';
import type { Content } from '@google/genai';
import { APP_NAME, type AgentConfig } from './config';
import { buildAgentSystem, type AgentSystem } from './agents';

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

export class AgentService {
	private readonly system: AgentSystem;
	private readonly runner: InMemoryRunner;
	private readonly userId = 'local-user';
	private readonly runs = new Map<string, AbortController>();
	private readonly toolNames = new Map<string, string>();

	constructor(private readonly cfg: AgentConfig, private readonly approve: ApprovalHandler) {
		this.system = buildAgentSystem(cfg);
		this.runner = new InMemoryRunner({ agent: this.system.root, appName: APP_NAME });
	}

	/** Cancels one conversation's run, or every run when no id is given. */
	cancel(sessionId?: string): void {
		if (sessionId) { this.runs.get(sessionId)?.abort(); } else { this.runs.forEach(c => c.abort()); }
	}
	isRunning(sessionId: string): boolean { return this.runs.has(sessionId); }
	async dispose(): Promise<void> { this.cancel(); await this.system.close(); }

	/** Each sessionId is an independent conversation with its own ADK session state. */
	async *send(sessionId: string, text: string): AsyncGenerator<AgentEvent> {
		if (this.runs.has(sessionId)) { yield { type: 'error', message: 'This conversation is already running.' }; return; }
		const abort = new AbortController();
		this.runs.set(sessionId, abort);
		try {
			const ids = { appName: APP_NAME, userId: this.userId, sessionId };
			if (!(await this.runner.sessionService.getSession(ids))) {
				await this.runner.sessionService.createSession(ids);
			}
			const streaming = this.cfg.streaming?.() ?? true;
			let message: Content = { role: 'user', parts: [{ text }] };
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
						else if (part.text && !part.functionCall && !part.functionResponse) { yield { type: 'text', author, text: part.text, partial }; }
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
							yield { type: 'tool-call', author, id, name: call.name ?? 'unknown', args: boundedArgs(call.args ?? {}) };
						}
					}
					for (const res of getFunctionResponses(event)) {
						const id = res.id ?? '';
						const name = res.name ?? this.toolNames.get(id) ?? 'unknown';
						this.toolNames.delete(id);
						if (name === 'transfer_to_agent' || name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) { continue; }
						yield { type: 'tool-result', author, id, name, ...describeResult(res.response as Record<string, unknown> | undefined) };
					}
				}
				if (!pending) { return; }
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
}
