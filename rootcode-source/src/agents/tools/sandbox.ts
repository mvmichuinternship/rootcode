import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSecretFile } from './paths';

const MAX_OUTPUT = 20_000;

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
	return new Promise(resolve => {
		execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
			resolve({ code, output: `${stdout}${stderr}`.slice(-MAX_OUTPUT) });
		});
	});
}

/**
 * Runs commands in a throwaway Docker container against a disposable copy of the
 * workspace: no network, capped resources, and nothing is written back.
 */
export function createSandboxTools(root: string, image: string): FunctionTool[] {
	return [
		new FunctionTool({
			name: 'run_in_sandbox',
			description: 'Runs a shell command (build, lint, run tests) inside an isolated Docker sandbox holding a copy of the workspace. Network is disabled, so dependencies must already be present. Returns exit code and combined output.',
			parameters: z.object({
				command: z.string().min(1).describe('Shell command, run with sh -c from the workspace copy'),
				timeoutSeconds: z.number().int().min(1).max(600).default(120),
			}),
			execute: async ({ command, timeoutSeconds }) => {
				const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'rootcode-sandbox-'));
				try {
					await fs.cp(root, copy, { recursive: true, filter: src => path.basename(src) !== '.git' && !isSecretFile(src) });
					const result = await run('docker', [
						'run', '--rm', '--network', 'none', '--memory', '2g', '--cpus', '2', '--pids-limit', '512',
						'-v', `${copy}:/work`, '-w', '/work', image, 'sh', '-c', command,
					], timeoutSeconds * 1000);
					return { exitCode: result.code, passed: result.code === 0, output: result.output };
				} finally {
					await fs.rm(copy, { recursive: true, force: true });
				}
			},
		}),
	];
}
