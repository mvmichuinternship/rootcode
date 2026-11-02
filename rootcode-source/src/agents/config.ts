import type { IndexOrchestrator } from '../atlas/IndexOrchestrator';
import type { OpenAICompatOptions } from './OpenAICompatLlm';

export interface AgentConfig {
	/** Both resolvers run on every model call, so env/settings edits apply immediately. */
	mainModel: () => OpenAICompatOptions;
	prReviewModel: () => OpenAICompatOptions;
	/** Evaluated per message; false falls back to non-streaming model calls. */
	streaming?: () => boolean;
	workspaceRoot: string;
	sandboxImage: string;
	/** Structured workspace context (dependency graph, git timeline, diagnostics); optional. */
	context?: IndexOrchestrator;
	/** Files the agent is looking at right now (from tool calls/results), for live graph highlighting. */
	onActivity?: (paths: string[], label: string, reset?: boolean) => void;
	github?: { token: string; mcpUrl: string; toolsets: string };
}

export const APP_NAME = 'rootcode';
export const DEFAULT_GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';
export const DEFAULT_GITHUB_MCP_TOOLSETS = 'context,repos,pull_requests';
export const DEFAULT_BASE_URL = 'https://inference.baseten.co/v1';
export const DEFAULT_MODEL = 'meta-models/muse-spark-open-1026';
export const DEFAULT_PR_REVIEW_BASE_URL = 'https://api.fireworks.ai/inference/v1';
