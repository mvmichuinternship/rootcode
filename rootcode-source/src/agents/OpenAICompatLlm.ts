import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import type { Content, FunctionDeclaration, Part } from '@google/genai';

interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
}

interface OpenAIResponse {
	choices?: { message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: OpenAIMessage['tool_calls'] }; finish_reason?: string }[];
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
	error?: { message?: string };
}

interface OpenAIStreamChunk {
	choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
	usage?: OpenAIResponse['usage'];
	error?: { message?: string };
}

/** Names the model and host that were called (never the key) so misconfiguration is obvious. */
function describeHttpError(status: number, raw: string, opts: OpenAICompatOptions): string {
	let host = opts.baseUrl;
	try { host = new URL(opts.baseUrl).host; } catch { /* keep as given */ }
	const hint = status === 401 || status === 403 ? 'The API key was rejected for this endpoint.'
		: status === 404 ? 'Check that the model id is exact, the deployment is running (not scaled to zero or deleted), and the API key belongs to the account that owns it.'
		: '';
	return `Model endpoint error ${status} from ${host}\nModel: ${opts.model}\n${hint ? `${hint}\n` : ''}${raw.slice(0, 500)}`;
}

function toUsage(usage: OpenAIResponse['usage']) {
	return usage && { promptTokenCount: usage.prompt_tokens, candidatesTokenCount: usage.completion_tokens, totalTokenCount: usage.total_tokens };
}

/** Reasoning is kept as a `thought` part so the UI can show it; it is never sent back to the model. */
function buildParts(reasoning: string | null | undefined, text: string | null | undefined, toolCalls: OpenAIMessage['tool_calls']): Part[] {
	const parts: Part[] = [];
	if (reasoning) { parts.push({ text: reasoning, thought: true }); }
	if (text) { parts.push({ text }); }
	for (const call of toolCalls ?? []) {
		let args: Record<string, unknown> = {};
		try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>; } catch { /* leave empty; tool validation reports it */ }
		parts.push({ functionCall: { id: call.id, name: call.function.name, args } });
	}
	return parts;
}

export interface OpenAICompatOptions {
	model: string;
	baseUrl: string;
	apiKey: string;
	/** Defaults to Bearer on inference.baseten.co (as OpenAI clients send it) and Api-Key on dedicated deployments. */
	authScheme?: 'Api-Key' | 'Bearer';
	maxTokens?: number;
	/** Sent as `reasoning_effort`; Muse Spark Open otherwise defaults to the slowest setting. */
	reasoningEffort?: string;
}

// genai Schema stores these limits as strings, but JSON Schema (and Baseten) require integers.
const INTEGER_KEYS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']);
const DROPPED_KEYS = new Set(['nullable', 'propertyOrdering']);

/** Converts a genai Schema (upper-case types) into plain JSON Schema. */
function toJsonSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) { return schema.map(toJsonSchema); }
	if (!schema || typeof schema !== 'object') { return schema; }
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema)) {
		if (k === 'type' && typeof v === 'string') { out[k] = v.toLowerCase(); }
		else if (DROPPED_KEYS.has(k)) { continue; }
		else if (INTEGER_KEYS.has(k) && typeof v === 'string') { out[k] = Number(v); }
		else { out[k] = toJsonSchema(v); }
	}
	return out;
}

function toTools(declarations: FunctionDeclaration[]) {
	return declarations.map(d => ({
		type: 'function' as const,
		function: {
			name: d.name,
			description: d.description,
			parameters: (d.parametersJsonSchema ?? toJsonSchema(d.parameters)) ?? { type: 'object', properties: {} },
		},
	}));
}

function toMessages(system: string | undefined, contents: Content[]): OpenAIMessage[] {
	const messages: OpenAIMessage[] = [];
	if (system) { messages.push({ role: 'system', content: system }); }
	let counter = 0;
	// Calls without an id get a synthetic one so each response can be paired back by name.
	const pendingIds = new Map<string, string[]>();
	for (const content of contents) {
		const parts: Part[] = content.parts ?? [];
		const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
		const calls = parts.filter(p => p.functionCall);
		const responses = parts.filter(p => p.functionResponse);
		if (content.role === 'model') {
			const tool_calls = calls.map(p => {
				const id = p.functionCall?.id ?? `call_${counter++}`;
				const name = p.functionCall?.name ?? 'unknown';
				pendingIds.set(name, [...(pendingIds.get(name) ?? []), id]);
				return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(p.functionCall?.args ?? {}) } };
			});
			messages.push({ role: 'assistant', content: text || null, ...(tool_calls.length ? { tool_calls } : {}) });
		} else {
			for (const p of responses) {
				const name = p.functionResponse?.name ?? 'unknown';
				const id = p.functionResponse?.id ?? pendingIds.get(name)?.shift() ?? `call_${counter++}`;
				messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(p.functionResponse?.response ?? {}) });
			}
			if (text) { messages.push({ role: 'user', content: text }); }
		}
	}
	return messages;
}

/** ADK model backed by any OpenAI-compatible chat-completions endpoint (e.g. a Baseten deployment). */
export class OpenAICompatLlm extends BaseLlm {
	/** `resolve` runs on every request so .env / settings changes apply without a restart. */
	constructor(label: string, private readonly resolve: () => OpenAICompatOptions) {
		super({ model: label });
	}

	/** Dedicated Baseten deployments (*.api.baseten.co) take `Api-Key`; everything else takes Bearer. */
	private authScheme(opts: OpenAICompatOptions): 'Api-Key' | 'Bearer' {
		if (opts.authScheme) { return opts.authScheme; }
		try { return new URL(opts.baseUrl).hostname.endsWith('.api.baseten.co') ? 'Api-Key' : 'Bearer'; } catch { return 'Bearer'; }
	}

	async *generateContentAsync(request: LlmRequest, stream?: boolean, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
		const opts = this.resolve();
		const system = typeof request.config?.systemInstruction === 'string' ? request.config.systemInstruction : undefined;
		const declarations = (request.config?.tools ?? []).flatMap(t => ('functionDeclarations' in t && t.functionDeclarations) || []);
		const body: Record<string, unknown> = {
			model: opts.model,
			messages: toMessages(system, request.contents),
		};
		if (declarations.length) { body.tools = toTools(declarations); }
		if (request.config?.temperature !== undefined) { body.temperature = request.config.temperature; }
		if (opts.maxTokens) { body.max_tokens = opts.maxTokens; }
		if (opts.reasoningEffort) { body.reasoning_effort = opts.reasoningEffort; }

		const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
		const send = (streaming: boolean) => fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `${this.authScheme(opts)} ${opts.apiKey}` },
			body: JSON.stringify(streaming ? { ...body, stream: true } : body),
			signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
		});

		if (stream) {
			const res = await send(true);
			// Some endpoints reject or mishandle streaming; fall back to a plain request rather than failing.
			if (res.ok && res.body) {
				yield* this.readStream(res.body);
				return;
			}
			await res.body?.cancel().catch(() => undefined);
		}

		const res = await send(false);
		const raw = await res.text();
		if (!res.ok) {
			yield { errorCode: String(res.status), errorMessage: describeHttpError(res.status, raw, opts) };
			return;
		}
		const data = JSON.parse(raw) as OpenAIResponse;
		const choice = data.choices?.[0];
		if (!choice?.message) {
			yield { errorCode: 'EMPTY', errorMessage: data.error?.message ?? 'Model returned no choices' };
			return;
		}
		yield {
			content: { role: 'model', parts: buildParts(choice.message.reasoning_content ?? choice.message.reasoning, choice.message.content, choice.message.tool_calls) },
			turnComplete: true,
			usageMetadata: toUsage(data.usage),
		};
	}

	private async *readStream(body: ReadableStream<Uint8Array>): AsyncGenerator<LlmResponse, void> {
		const decoder = new TextDecoder();
		let buffer = '';
		let reasoning = '';
		let text = '';
		let usage: OpenAIResponse['usage'];
		const calls = new Map<number, { id: string; name: string; arguments: string }>();
		const reader = body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) { break; }
				buffer += decoder.decode(value, { stream: true });
				let newline: number;
				while ((newline = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line.startsWith('data:')) { continue; }
					const payload = line.slice(5).trim();
					if (payload === '[DONE]') { continue; }
					let chunk: OpenAIStreamChunk;
					try { chunk = JSON.parse(payload) as OpenAIStreamChunk; } catch { continue; }
					if (chunk.error) {
						yield { errorCode: 'STREAM', errorMessage: chunk.error.message ?? 'Model stream error' };
						return;
					}
					if (chunk.usage) { usage = chunk.usage; }
					const delta = chunk.choices?.[0]?.delta;
					if (!delta) { continue; }
					const thought = delta.reasoning_content ?? delta.reasoning;
					if (thought) {
						reasoning += thought;
						yield { partial: true, content: { role: 'model', parts: [{ text: thought, thought: true }] } };
					}
					if (delta.content) {
						text += delta.content;
						yield { partial: true, content: { role: 'model', parts: [{ text: delta.content }] } };
					}
					for (const tc of delta.tool_calls ?? []) {
						const entry = calls.get(tc.index ?? 0) ?? { id: '', name: '', arguments: '' };
						entry.id ||= tc.id ?? '';
						entry.name ||= tc.function?.name ?? '';
						entry.arguments += tc.function?.arguments ?? '';
						calls.set(tc.index ?? 0, entry);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
		const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([i, c]) => ({
			id: c.id || `call_${i}`, type: 'function' as const, function: { name: c.name, arguments: c.arguments },
		}));
		if (!text && !reasoning && !toolCalls.length) {
			yield { errorCode: 'EMPTY', errorMessage: 'Model returned an empty stream' };
			return;
		}
		yield { content: { role: 'model', parts: buildParts(reasoning, text, toolCalls) }, turnComplete: true, usageMetadata: toUsage(usage) };
	}

	async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
		throw new Error('Live connections are not supported by OpenAICompatLlm');
	}
}
