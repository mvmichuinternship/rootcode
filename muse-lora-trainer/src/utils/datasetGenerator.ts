import * as fs from 'fs';
import * as path from 'path';
import { loadEnvFile } from './env';
import { ensureVenv, exec, venvTool } from './python';

export interface GenerateOptions {
  /** Repository to mine; the dataset is written to <repoPath>/.repo2lora. */
  repoPath: string;
  /** Path to the repo2lora wheel. */
  wheelPath: string;
  /** Directory where the private virtualenv is kept. */
  venvDir: string;
  onLog: (line: string) => void;
  signal?: AbortSignal;
}

export interface DatasetPaths { dir: string; train: string; val: string }

export function datasetPaths(repoPath: string): DatasetPaths {
  const dir = path.join(repoPath, '.repo2lora', 'dataset');
  return { dir, train: path.join(dir, 'train.jsonl'), val: path.join(dir, 'val.jsonl') };
}

/** Creates/updates the venv, installs repo2lora and runs `repo2lora run` against the repo. */
export async function generateDataset(opts: GenerateOptions): Promise<DatasetPaths> {
  const { repoPath, wheelPath, venvDir, onLog, signal } = opts;
  if (!fs.existsSync(wheelPath)) { throw new Error(`repo2lora wheel not found: ${wheelPath}`); }
  if (!fs.existsSync(repoPath)) { throw new Error(`Repository not found: ${repoPath}`); }

  const fileEnv = loadEnvFile(path.join(repoPath, '.env'));
  const env: NodeJS.ProcessEnv = { ...process.env, ...fileEnv, PYTHONUNBUFFERED: '1' };

  const wheelId = `${path.basename(wheelPath)}:${fs.statSync(wheelPath).size}`;
  await ensureVenv(venvDir, [wheelPath, 'tree-sitter>=0.23', 'tree-sitter-javascript', 'tree-sitter-typescript'], wheelId, { onLog, signal, env });

  const outDir = path.join(repoPath, '.repo2lora');
  const args = ['run', '--repo', repoPath, '--out', outDir];
  const hasGithubAuth = !!(env.GITHUB_TOKEN || env.GH_TOKEN || env.REPO2LORA_ALLOW_REVIEWS);
  if (!hasGithubAuth) { args.push('--no-github'); }
  const slug = env.REPO2LORA_GITHUB_SLUG || env.REPO2LORA_GITHUB_REPO;
  if (slug) { args.push('--github', slug); }

  onLog(`Running repo2lora on ${repoPath}`);
  const code = await exec(venvTool(venvDir, 'repo2lora'), args, { cwd: repoPath, env, onLog, signal });
  if (code !== 0) { throw new Error(`repo2lora exited with code ${code}`); }

  const paths = datasetPaths(repoPath);
  if (!fs.existsSync(paths.train)) { throw new Error(`repo2lora finished but ${paths.train} was not created`); }
  return paths;
}
