import { InMemoryRunner, LlmAgent, MCPToolset, SequentialAgent, type FunctionTool } from '@google/adk';
import { randomUUID } from 'node:crypto';
import { APP_NAME, DEFAULT_GITHUB_MCP_TOOLSETS, DEFAULT_GITHUB_MCP_URL, type AgentConfig } from './config';
import { OpenAICompatLlm } from './OpenAICompatLlm';
import { createReadTools, createWriteTools } from './tools/workspace';
import { createSandboxTools } from './tools/sandbox';
import { createGitTools } from './tools/git';
import { createClusterTools } from './tools/clusters';
import { createContextTools } from './tools/context';
import * as P from './prompts';

export interface AgentSystem {
	root: LlmAgent;
	close(): Promise<void>;
}

export function buildAgentSystem(cfg: AgentConfig): AgentSystem {
	const model = new OpenAICompatLlm('main', cfg.mainModel);
	const prModel = new OpenAICompatLlm('pr-review', cfg.prReviewModel);
	const read = [...createReadTools(cfg.workspaceRoot), ...(cfg.context ? createContextTools(cfg.context) : [])];
	const write = createWriteTools(cfg.workspaceRoot, cfg.context ? p => cfg.context!.checkAfterWrite(p) : undefined);
	const hint = cfg.context ? P.CONTEXT_HINT : '';

	// Cluster workers: one extra agent per graph cluster, confined to that cluster's files (see tools/clusters.ts).
	const runWorker = async (name: string, instruction: string, tools: FunctionTool[]): Promise<string> => {
		const worker = new LlmAgent({ name, model, description: 'Cluster worker', instruction: P.WORKER_INSTRUCTION, tools });
		const runner = new InMemoryRunner({ agent: worker, appName: APP_NAME });
		const ids = { appName: APP_NAME, userId: 'cluster-worker', sessionId: randomUUID() };
		await runner.sessionService.createSession(ids);
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 5 * 60_000);
		let last = '';
		try {
			for await (const e of runner.runAsync({ userId: ids.userId, sessionId: ids.sessionId, newMessage: { role: 'user', parts: [{ text: instruction }] }, abortSignal: abort.signal })) {
				if (e.errorMessage) { throw new Error(e.errorMessage); }
				if (e.partial) { continue; }
				for (const part of e.content?.parts ?? []) { if (part.text && !part.thought && !part.functionCall && !part.functionResponse) { last = part.text; } }
			}
		} finally { clearTimeout(timer); }
		return last;
	};
	const clusterTools = cfg.context ? createClusterTools(cfg.context, cfg.workspaceRoot, read, runWorker, cfg.onActivity) : [];
	const clusterHint = cfg.context ? P.CLUSTER_HINT : '';

	const developer = new LlmAgent({
		name: 'developer_agent', model, description: 'Implements code changes in the workspace.',
		instruction: P.compose(P.DEVELOPER_INSTRUCTION, hint, clusterHint), tools: [...read, ...write, ...clusterTools], outputKey: 'dev_summary',
	});
	const qa = new LlmAgent({
		name: 'qa_agent', model, description: 'Tests changes inside a Docker sandbox.',
		instruction: P.QA_INSTRUCTION, tools: [...createSandboxTools(cfg.workspaceRoot, cfg.sandboxImage), ...read, ...write], outputKey: 'qa_report',
	});
	const vcs = new LlmAgent({
		name: 'version_control_agent', model, description: 'Commits to a branch and pushes after human approval.',
		instruction: P.VCS_INSTRUCTION, tools: createGitTools(cfg.workspaceRoot),
	});
	const devWorkflow = new SequentialAgent({
		name: 'dev_workflow',
		description: 'Development pipeline: implement, test in sandbox, then commit/push on approval.',
		subAgents: [developer, qa, vcs],
	});

	// Without a token the PR agent still exists but has no GitHub tools, and its prompt tells it so.
	const github = cfg.github ? new MCPToolset({
		type: 'StreamableHTTPConnectionParams',
		url: cfg.github.mcpUrl || DEFAULT_GITHUB_MCP_URL,
		header: {
			Authorization: `Bearer ${cfg.github.token}`,
			// Limits the remote server to the tools a reviewer needs; the model handles fewer tools better.
			'X-MCP-Toolsets': cfg.github.toolsets || DEFAULT_GITHUB_MCP_TOOLSETS,
		},
	}) : undefined;
	const prReview = new LlmAgent({
		name: 'pr_review_agent', model: prModel, description: 'Reviews GitHub pull requests and comments on them.',
		instruction: cfg.github ? P.PR_REVIEW_INSTRUCTION : P.PR_REVIEW_NO_GITHUB_INSTRUCTION,
		tools: github ? [...read, github] : read,
	});

	const root = new LlmAgent({
		name: 'rootcode_agent', model, description: 'Orchestrator that handles basic requests and routes the rest.',
		instruction: P.compose(P.ROOT_INSTRUCTION, hint), tools: read, subAgents: [devWorkflow, prReview],
	});
	return { root, close: async () => { await github?.close(); } };
}
