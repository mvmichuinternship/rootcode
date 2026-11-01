import { LlmAgent, MCPToolset, SequentialAgent } from '@google/adk';
import { DEFAULT_GITHUB_MCP_TOOLSETS, DEFAULT_GITHUB_MCP_URL, type AgentConfig } from './config';
import { OpenAICompatLlm } from './OpenAICompatLlm';
import { createReadTools, createWriteTools } from './tools/workspace';
import { createSandboxTools } from './tools/sandbox';
import { createGitTools } from './tools/git';
import * as P from './prompts';

export interface AgentSystem {
	root: LlmAgent;
	close(): Promise<void>;
}

export function buildAgentSystem(cfg: AgentConfig): AgentSystem {
	const model = new OpenAICompatLlm('main', cfg.mainModel);
	const prModel = new OpenAICompatLlm('pr-review', cfg.prReviewModel);
	const read = createReadTools(cfg.workspaceRoot);
	const write = createWriteTools(cfg.workspaceRoot);

	const developer = new LlmAgent({
		name: 'developer_agent', model, description: 'Implements code changes in the workspace.',
		instruction: P.DEVELOPER_INSTRUCTION, tools: [...read, ...write], outputKey: 'dev_summary',
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
		instruction: P.ROOT_INSTRUCTION, tools: read, subAgents: [devWorkflow, prReview],
	});
	return { root, close: async () => { await github?.close(); } };
}
