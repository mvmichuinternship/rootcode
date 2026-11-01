import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { execFile } from 'node:child_process';

function git(root: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd: root, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) { reject(new Error((stderr || err.message).trim())); } else { resolve(stdout.trim()); }
		});
	});
}

const branchName = z.string().regex(/^[\w./-]+$/).refine(b => !b.startsWith('-') && !b.includes('..'), 'invalid branch name');

export function createGitTools(root: string): FunctionTool[] {
	return [
		new FunctionTool({
			name: 'git_status',
			description: 'Shows the current branch and working tree status.',
			execute: async () => ({ status: await git(root, ['status', '--short', '--branch']) }),
		}),
		new FunctionTool({
			name: 'git_diff',
			description: 'Shows the diff of uncommitted changes (staged and unstaged).',
			execute: async () => ({ diff: (await git(root, ['diff', 'HEAD'])).slice(0, 50_000) }),
		}),
		new FunctionTool({
			name: 'git_create_branch',
			description: 'Creates and checks out a new branch for the change.',
			parameters: z.object({ name: branchName }),
			execute: async ({ name }) => ({ output: await git(root, ['checkout', '-b', name]) }),
		}),
		new FunctionTool({
			name: 'git_commit',
			description: 'Stages all changes and commits them locally with the given message.',
			parameters: z.object({ message: z.string().min(1).max(500) }),
			execute: async ({ message }) => {
				// Secrets are excluded even if the repo forgot to gitignore them.
				await git(root, ['add', '-A', '--', '.', ':(exclude,glob)**/.env', ':(exclude,glob)**/.env.local', ':(exclude,glob)**/.env.*.local', ':(exclude,glob)**/.env.production', ':(exclude,glob)**/.env.development', ':(exclude,glob)**/*.pem', ':(exclude,glob)**/*.key']);
				return { output: await git(root, ['commit', '-m', message]) };
			},
		}),
		new FunctionTool({
			name: 'git_push',
			description: 'Pushes a branch to the remote. Requires explicit human approval.',
			parameters: z.object({ branch: branchName, remote: z.string().regex(/^[\w.-]+$/).default('origin') }),
			requireConfirmation: true,
			execute: async ({ branch, remote }) => ({ output: await git(root, ['push', '-u', remote, branch]) }),
		}),
	];
}
