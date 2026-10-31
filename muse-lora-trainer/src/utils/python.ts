import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const isWin = process.platform === 'win32';
const binDir = (venv: string) => path.join(venv, isWin ? 'Scripts' : 'bin');
export const venvPython = (venv: string) => path.join(binDir(venv), isWin ? 'python.exe' : 'python');
export const venvTool = (venv: string, name: string) => path.join(binDir(venv), isWin ? `${name}.exe` : name);

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

/** Runs a command, streams its output lines to onLog and resolves with the exit code plus captured stdout. */
export function execCapture(cmd: string, args: string[], opts: ExecOptions = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { reject(new Error('Cancelled')); return; }
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const pipe = (stream: NodeJS.ReadableStream, capture: boolean) => {
      let buf = '';
      stream.on('data', (d: Buffer) => {
        const text = d.toString();
        if (capture) { stdout += text; }
        buf += text;
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop() ?? '';
        parts.filter(p => p.trim()).forEach(l => opts.onLog?.(l));
      });
      stream.on('end', () => { if (buf.trim()) { opts.onLog?.(buf); } });
    };
    pipe(child.stdout, true);
    pipe(child.stderr, false);
    const abort = () => child.kill();
    opts.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', e => { opts.signal?.removeEventListener('abort', abort); reject(e); });
    child.on('close', code => {
      opts.signal?.removeEventListener('abort', abort);
      if (opts.signal?.aborted) { reject(new Error('Cancelled')); } else { resolve({ code: code ?? 1, stdout }); }
    });
  });
}

export async function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<number> {
  return (await execCapture(cmd, args, opts)).code;
}

export async function findPython(minMinor = 9): Promise<string> {
  const candidates = isWin ? ['py', 'python', 'python3'] : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3', 'python'];
  const check = `import sys; raise SystemExit(0 if sys.version_info >= (3, ${minMinor}) else 1)`;
  for (const c of candidates) {
    try {
      if (await exec(c, ['-c', check]) === 0) { return c; }
    } catch { /* not installed */ }
  }
  throw new Error(`Python 3.${minMinor}+ is required but was not found on PATH.`);
}

/** Creates the venv if missing and pip-installs `packages`, skipping the install when `stampValue` is unchanged. */
export async function ensureVenv(
  venvDir: string, packages: string[], stampValue: string, opts: ExecOptions = {}, minMinor = 9
): Promise<void> {
  if (!fs.existsSync(venvPython(venvDir))) {
    opts.onLog?.('Creating Python virtual environment...');
    const py = await findPython(minMinor);
    await fs.promises.mkdir(path.dirname(venvDir), { recursive: true });
    if (await exec(py, ['-m', 'venv', venvDir], opts) !== 0) { throw new Error('Failed to create virtual environment'); }
  }
  const stamp = path.join(venvDir, '.installed-stamp');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === stampValue) { return; }
  opts.onLog?.(`Installing ${packages.map(p => path.basename(p)).join(', ')}...`);
  const code = await exec(venvPython(venvDir), ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', ...packages], opts);
  if (code !== 0) { throw new Error(`Failed to install ${packages.join(', ')}`); }
  await fs.promises.writeFile(stamp, stampValue);
}
