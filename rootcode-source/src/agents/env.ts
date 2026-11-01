import * as path from 'node:path';
import { loadEnvFile } from 'muse-lora-trainer';
import type { OpenAICompatOptions } from './OpenAICompatLlm';
import { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_PR_REVIEW_BASE_URL } from './config';

/** Precedence: <repo>/.env, then the process environment. Re-read on every call. */
export function readEnv(root: string): Record<string, string> {
	const fromProcess = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) as Record<string, string>;
	const fromFile = Object.fromEntries(Object.entries(loadEnvFile(path.join(root, '.env'))).filter(([, v]) => v));
	return { ...fromProcess, ...fromFile };
}

export type Provider = 'baseten' | 'fireworks';

const PROVIDERS: Record<Provider, { label: string; baseUrl: string; keyVar: string }> = {
	baseten: { label: 'Baseten', baseUrl: DEFAULT_BASE_URL, keyVar: 'BASETEN_API_KEY' },
	fireworks: { label: 'Fireworks', baseUrl: DEFAULT_PR_REVIEW_BASE_URL, keyVar: 'FIREWORKS_API_KEY' },
};

export interface ModelSlot {
	/** Env var prefix: <PREFIX>_PROVIDER, _MODEL, _API_KEY, _BASE_URL, _MAX_TOKENS, _REASONING_EFFORT. */
	prefix: 'ROOTCODE' | 'PR_REVIEW';
	label: string;
	defaultProvider: Provider;
	defaultMaxTokens: number;
	/** Used when <PREFIX>_MODEL is unset. */
	defaultModel?: Partial<Record<Provider, string>>;
}

export interface ModelFallbacks {
	apiKey?: string;
	model?: string;
	baseUrl?: string;
	maxTokens?: number;
	reasoningEffort?: string;
}

export type ResolvedModel = OpenAICompatOptions & { provider: Provider };

const positiveInt = (v: string | undefined, fallback: number) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function parseProvider(value: string | undefined, fallback: Provider, name: string): Provider {
	const v = value?.trim().toLowerCase();
	if (!v) { return fallback; }
	if (v === 'baseten' || v === 'fireworks') { return v; }
	throw new Error(`${name} must be "baseten" or "fireworks" (got "${value}").`);
}

/**
 * Provider, model and key come from the env (repo .env, then process env), re-read on every call.
 * `fallbacks` is consulted per provider for values the env leaves unset (e.g. VS Code settings).
 */
export function resolveModel(root: string, slot: ModelSlot, fallbacks?: (provider: Provider) => ModelFallbacks): ResolvedModel {
	const env = readEnv(root);
	const get = (suffix: string) => env[`${slot.prefix}_${suffix}`]?.trim() || undefined;
	const envFile = path.join(root, '.env');
	const provider = parseProvider(get('PROVIDER'), slot.defaultProvider, `${slot.prefix}_PROVIDER`);
	const info = PROVIDERS[provider];
	const fb = fallbacks?.(provider) ?? {};

	const apiKey = get('API_KEY') || env[info.keyVar]?.trim() || fb.apiKey;
	if (!apiKey) { throw new Error(`${slot.label} uses ${info.label} but no API key was found. Set ${info.keyVar} (or ${slot.prefix}_API_KEY) in ${envFile}.`); }
	const model = get('MODEL') || fb.model || slot.defaultModel?.[provider];
	if (!model) { throw new Error(`${slot.label} uses ${info.label} but no model is set. Set ${slot.prefix}_MODEL in ${envFile}.`); }
	const effort = get('REASONING_EFFORT') ?? fb.reasoningEffort;

	return {
		provider,
		model,
		apiKey,
		baseUrl: get('BASE_URL') || fb.baseUrl || info.baseUrl,
		maxTokens: positiveInt(get('MAX_TOKENS'), fb.maxTokens ?? slot.defaultMaxTokens),
		// Only Muse Spark Open on Baseten documents reasoning_effort; other models may reject it.
		reasoningEffort: provider === 'baseten' && model.startsWith('meta-models/muse-spark-open') && effort ? effort : undefined,
	};
}

export const MAIN_SLOT: ModelSlot = {
	prefix: 'ROOTCODE', label: 'The main agents', defaultProvider: 'baseten', defaultMaxTokens: 8192,
	defaultModel: { baseten: DEFAULT_MODEL },
};
export const PR_REVIEW_SLOT: ModelSlot = { prefix: 'PR_REVIEW', label: 'The PR review agent', defaultProvider: 'fireworks', defaultMaxTokens: 4000 };

export function resolvePrReviewModel(root: string): ResolvedModel {
	return resolveModel(root, PR_REVIEW_SLOT);
}

export function resolveGithub(root: string, storedToken: string | undefined) {
	const env = readEnv(root);
	const token = env.GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_PERSONAL_ACCESS_TOKEN || storedToken;
	return { token, mcpUrl: env.GITHUB_MCP_URL, toolsets: env.GITHUB_MCP_TOOLSETS };
}
