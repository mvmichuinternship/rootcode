import * as fs from 'fs';
import * as path from 'path';
import { DeployedEndpoint, StatusCallback, TrainingConfig, TrainingResult } from '../types';
import { validateDataset } from '../utils/datasetUploader';
import fetch from 'node-fetch';
import { ensureVenv, exec, execCapture, findPython, venvPython } from '../utils/python';
import { FireworksClient, deployTrainedModel, toResourceId } from './fireworks';

/** fw-ai/cookbook commit this integration was tested against. */
export const COOKBOOK_REF = '57968a2237b663be33078d2747a28463983ae134';
const STARTER_MODULE = 'examples.sft.muse_glimmer_starter';

export interface ServerlessOptions {
  apiKey: string;
  accountId?: string;
  config: TrainingConfig;
  /** Venv that holds the Fireworks training SDK and the cookbook. Needs Python 3.11+. */
  venvDir: string;
  /** Where the fw-ai/cookbook repo is cloned. */
  cookbookDir: string;
  maxSeqLen?: number;
  /** Rows held out from the dataset to compare base against tuned. */
  nEval?: number;
  allowPaid?: boolean;
  deploy?: boolean;
  deploymentId?: string;
  /** If set, the promoted adapter's files are downloaded into <downloadDir>/<model id>. */
  downloadDir?: string;
  onStatus?: StatusCallback;
  /** Called once the tuned adapter exists as a model, before any deployment is attempted. */
  onTrained?: (info: { runId: string; model: string }) => void | Promise<void>;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export async function downloadModelFiles(
  apiKey: string,
  model: string,
  accountId: string | undefined,
  destRoot: string,
  onStatus?: StatusCallback,
  signal?: AbortSignal
): Promise<string> {
  const m = /^accounts\/([^/]+)\/models\/([^/]+)$/.exec(model);
  const account = m?.[1] ?? accountId;
  const modelId = m?.[2] ?? model;
  if (!account) { throw new Error('Cannot determine the account id for the download.'); }

  const res = await fetch(`https://api.fireworks.ai/v1/accounts/${account}/models/${modelId}:getDownloadEndpoint`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: signal as any
  });
  if (!res.ok) { throw new Error(`getDownloadEndpoint ${res.status}: ${(await res.text()).slice(0, 200)}`); }
  const urls = ((await res.json()) as { filenameToSignedUrls?: Record<string, string> }).filenameToSignedUrls ?? {};
  const names = Object.keys(urls);
  if (!names.length) { throw new Error('Fireworks returned no downloadable files for this model.'); }

  const dir = path.join(destRoot, modelId);
  for (const name of names) {
    const target = path.resolve(dir, name);
    if (!target.startsWith(path.resolve(dir) + path.sep)) { continue; }
    onStatus?.({ stage: 'running', message: `Downloading ${name}…` });
    const r = await fetch(urls[name], { signal: signal as any });
    if (!r.ok || !r.body) { throw new Error(`Download of ${name} failed: ${r.status}`); }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(target);
      (r.body as any).pipe(out);
      (r.body as any).on('error', reject);
      out.on('finish', () => resolve());
      out.on('error', reject);
    });
  }
  return dir;
}

function tail(onLog?: (l: string) => void) {
  const lines: string[] = [];
  return {
    log: (l: string) => { if (l.trim()) { lines.push(l.trim()); if (lines.length > 8) { lines.shift(); } } onLog?.(l); },
    text: () => lines.slice(-1).join('') || 'no output'
  };
}

async function downloadTo(url: string, file: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal: signal as never });
  if (!res.ok || !res.body) { throw new Error(`Download failed (${res.status}): ${url}`); }
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file);
    (res.body as unknown as NodeJS.ReadableStream).pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    (res.body as unknown as NodeJS.ReadableStream).on('error', reject);
  });
}

async function ensureCookbook(opts: ServerlessOptions): Promise<string> {
  const root = path.join(opts.cookbookDir, COOKBOOK_REF);
  const trainingDir = path.join(root, 'training');
  const logOpts = { onLog: opts.onLog, signal: opts.signal };
  if (!fs.existsSync(path.join(trainingDir, 'pyproject.toml'))) {
    opts.onStatus?.({ stage: 'starting', message: 'Downloading the Fireworks cookbook...' });
    await fs.promises.rm(opts.cookbookDir, { recursive: true, force: true });
    await fs.promises.mkdir(opts.cookbookDir, { recursive: true });
    const zip = path.join(opts.cookbookDir, 'cookbook.zip');
    await downloadTo(`https://codeload.github.com/fw-ai/cookbook/zip/${COOKBOOK_REF}`, zip, opts.signal);
    const py = await findPython(11);
    const tmp = path.join(opts.cookbookDir, 'extract');
    if (await exec(py, ['-m', 'zipfile', '-e', zip, tmp], logOpts) !== 0) { throw new Error('Could not extract the cookbook archive.'); }
    const [inner] = await fs.promises.readdir(tmp);
    await fs.promises.rename(path.join(tmp, inner), root);
    await fs.promises.rm(tmp, { recursive: true, force: true });
    await fs.promises.rm(zip, { force: true });
  }
  opts.onStatus?.({ stage: 'starting', message: 'Preparing the training environment (first run can take a few minutes)...' });
  await ensureVenv(opts.venvDir, ['fireworks-ai[training]>=1.2.9', '-e', trainingDir], `serverless-v1-${COOKBOOK_REF}`, logOpts, 11);
  return trainingDir;
}

/**
 * Trains on Fireworks Serverless Training (shared trainer pool, LoRA) by running the cookbook's Muse Glimmer
 * starter on the local chat JSONL. The dataset never needs to be uploaded to the account.
 */
export async function runFireworksServerless(opts: ServerlessOptions): Promise<TrainingResult & { endpoint?: DeployedEndpoint }> {
  const { config: cfg, onStatus, signal } = opts;
  const rows = await validateDataset(cfg.datasetPath);
  const nEval = Math.max(1, Math.min(opts.nEval ?? 16, rows - 1));
  const runId = toResourceId(`${cfg.outputModelName.slice(0, 30)}-${Date.now().toString(36)}`);
  const trainingDir = await ensureCookbook(opts);
  const logDir = path.join(path.dirname(path.dirname(cfg.datasetPath)), 'serverless-runs', runId);

  const args = [
    '-m', STARTER_MODULE, 'launch', '--surface', 'serverless',
    '--file', cfg.datasetPath, '--run-id', runId, '--log-path', logDir,
    '--lora-rank', String(cfg.loraRank), '--epochs', String(cfg.epochs), '--learning-rate', String(cfg.learningRate),
    '--max-seq-len', String(opts.maxSeqLen ?? 8192), '--n-eval', String(nEval)
  ];
  if (opts.allowPaid) { args.push('--allow-paid'); }

  const t = tail(opts.onLog);
  const log = (line: string) => {
    t.log(line);
    const step = /^\{"step": (\d+), "epoch": (\d+), "loss": ([\d.]+)/.exec(line);
    if (step) { onStatus?.({ stage: 'running', message: `Epoch ${step[2]}/${cfg.epochs}, step ${step[1]}, loss ${step[3]}` }); }
    else if (line.includes('"label": "base"')) { onStatus?.({ stage: 'running', message: 'Baseline evaluation done; training...' }); }
    else if (line.includes('"label": "tuned"')) { onStatus?.({ stage: 'running', message: 'Tuned evaluation done; promoting adapter...' }); }
  };

  onStatus?.({ stage: 'starting', message: `Starting serverless training of ${cfg.baseModel} on ${rows} examples...` });
  const { code, stdout } = await execCapture(venvPython(opts.venvDir), args, {
    cwd: trainingDir,
    env: {
      ...process.env,
      FIREWORKS_API_KEY: opts.apiKey,
      ...(opts.accountId ? { FIREWORKS_ACCOUNT_ID: opts.accountId } : {}),
      PYTHONUNBUFFERED: '1'
    },
    onLog: log,
    signal
  });
  if (code !== 0) { throw new Error(`Serverless training failed: ${t.text()}`); }

  const promoted = /"promoted_model": "([^"]+)"/.exec(stdout)?.[1];
  if (!promoted) {
    throw new Error(`Training finished but the adapter was not promoted to a model (it stays session-only and cannot be deployed). ${t.text()}`);
  }
  await opts.onTrained?.({ runId, model: promoted });
  onStatus?.({ stage: 'running', message: `Training complete: ${promoted}` });

  if (opts.downloadDir) {
    try {
      const dir = await downloadModelFiles(opts.apiKey, promoted, opts.accountId, opts.downloadDir, onStatus, signal);
      onStatus?.({ stage: 'running', message: `Adapter downloaded to ${dir}` });
    } catch (e: any) {
      onStatus?.({ stage: 'running', message: `Adapter download failed (the model is still in your Fireworks account): ${e?.message ?? e}` });
    }
  }

  let endpoint: DeployedEndpoint | undefined;
  if (opts.deploy !== false) {
    const client = new FireworksClient(opts.apiKey, opts.accountId);
    endpoint = await deployTrainedModel(client, promoted, cfg.baseModel, opts.deploymentId || toResourceId(`${runId}-deploy`), onStatus, signal);
    onStatus?.({ stage: 'done', message: `Deployed. Use model "${endpoint.model}" at ${endpoint.baseUrl}` });
  } else {
    onStatus?.({ stage: 'done', message: `Training complete: ${promoted}` });
  }
  return { provider: 'fireworks', jobId: runId, finalStatus: 'COMPLETED', model: promoted, endpoint };
}
