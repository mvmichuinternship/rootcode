import fetch, { Response } from 'node-fetch';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';
import { DeployedEndpoint, FireworksJob, StatusCallback, TrainingConfig, TrainingResult } from '../types';
import { sleep, validateDataset } from '../utils/datasetUploader';

/** Overridable for tests against a mock server. */
const HOST = process.env.FIREWORKS_API_HOST || 'https://api.fireworks.ai';
export const FIREWORKS_INFERENCE_URL = `${HOST}/inference/v1`;
export const FIREWORKS_MIN_POLL_MS = 30_000;
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

const TERMINAL_OK = new Set(['JOB_STATE_COMPLETED', 'JOB_STATE_EARLY_STOPPED']);
const TERMINAL_BAD = new Set(['JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED', 'JOB_STATE_DELETED']);

/** Lowercase letters, digits and dashes, max 63 chars, as required for Fireworks resource ids. */
export function toResourceId(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/g, '');
  if (!id) { throw new Error(`"${name}" cannot be converted to a valid resource id`); }
  return id;
}

const lastSegment = (resource: string) => resource.slice(resource.lastIndexOf('/') + 1);

export class FireworksClient {
  private account?: string;

  constructor(private readonly apiKey: string, accountId?: string) {
    if (!apiKey) { throw new Error('FIREWORKS_API_KEY is not set'); }
    this.account = accountId || undefined;
  }

  private async request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const res = await fetch(`${HOST}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.parse<T>(res, `${method} ${urlPath}`);
  }

  private async parse<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) { throw new Error(`Fireworks ${what} failed (${res.status}): ${text.slice(0, 500)}`); }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async accountId(): Promise<string> {
    if (this.account) { return this.account; }
    const r = await this.request<{ accounts?: { name: string }[] }>('GET', '/v1/accounts');
    const name = r.accounts?.[0]?.name;
    if (!name) { throw new Error('Could not determine the Fireworks account id. Set FIREWORKS_ACCOUNT_ID.'); }
    this.account = lastSegment(name);
    return this.account;
  }

  async createDataset(datasetId: string, exampleCount: number): Promise<void> {
    const a = await this.accountId();
    await this.request('POST', `/v1/accounts/${a}/datasets`, {
      datasetId,
      dataset: { userUploaded: {}, exampleCount: String(exampleCount) },
    });
  }

  async uploadDatasetFile(datasetId: string, filePath: string): Promise<void> {
    const a = await this.accountId();
    const data = await fs.promises.readFile(filePath);
    if (data.length > MAX_UPLOAD_BYTES) { throw new Error(`${path.basename(filePath)} exceeds the 150MB single-request upload limit`); }
    const form = new FormData();
    form.append('file', data, { filename: path.basename(filePath), contentType: 'application/jsonl' });
    const res = await fetch(`${HOST}/v1/accounts/${a}/datasets/${datasetId}:upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, ...form.getHeaders(), 'Content-Length': String(form.getLengthSync()) },
      body: form.getBuffer(),
    });
    await this.parse(res, 'dataset upload');
  }

  async waitDatasetReady(datasetId: string, signal?: AbortSignal, timeoutMs = 10 * 60_000): Promise<void> {
    const a = await this.accountId();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !signal?.aborted) {
      const d = await this.request<{ state?: string }>('GET', `/v1/accounts/${a}/datasets/${datasetId}`);
      if (d.state === 'READY') { return; }
      await sleep(3000, signal);
    }
    if (signal?.aborted) { throw new Error('Cancelled'); }
    throw new Error(`Dataset ${datasetId} did not become READY in time`);
  }

  async createJob(cfg: TrainingConfig, datasetId: string, evalDatasetId?: string): Promise<FireworksJob> {
    const a = await this.accountId();
    const base = cfg.baseModel.startsWith('accounts/') ? cfg.baseModel : `accounts/fireworks/models/${cfg.baseModel}`;
    return this.request<FireworksJob>('POST', `/v1/accounts/${a}/supervisedFineTuningJobs`, {
      displayName: cfg.outputModelName,
      baseModel: base,
      dataset: `accounts/${a}/datasets/${datasetId}`,
      ...(evalDatasetId ? { evaluationDataset: `accounts/${a}/datasets/${evalDatasetId}` } : {}),
      outputModel: `accounts/${a}/models/${toResourceId(cfg.outputModelName)}`,
      epochs: cfg.epochs,
      learningRate: cfg.learningRate,
      loraRank: cfg.loraRank,
      ...(cfg.maxContextLength ? { maxContextLength: cfg.maxContextLength } : {}),
    });
  }

  async getJob(jobId: string): Promise<FireworksJob> {
    const a = await this.accountId();
    return this.request<FireworksJob>('GET', `/v1/accounts/${a}/supervisedFineTuningJobs/${encodeURIComponent(lastSegment(jobId))}`);
  }

  async getDeployment(deploymentId: string): Promise<{ name: string; state?: string; baseModel?: string; status?: { message?: string } } | undefined> {
    const a = await this.accountId();
    try {
      return await this.request('GET', `/v1/accounts/${a}/deployments/${deploymentId}`);
    } catch (e) {
      if (e instanceof Error && /\(404\)/.test(e.message)) { return undefined; }
      throw e;
    }
  }

  async createDeployment(deploymentId: string, baseModel: string): Promise<void> {
    const a = await this.accountId();
    await this.request('POST', `/v1/accounts/${a}/deployments?deploymentId=${encodeURIComponent(deploymentId)}`, {
      displayName: deploymentId,
      baseModel,
      enableAddons: true,
      minReplicaCount: 0,
      maxReplicaCount: 1,
    });
  }

  async loadLora(modelResource: string, deploymentId: string, displayName: string): Promise<string> {
    const a = await this.accountId();
    const r = await this.request<{ name: string }>('POST', `/v1/accounts/${a}/deployedModels`, {
      displayName,
      model: modelResource,
      deployment: `accounts/${a}/deployments/${deploymentId}`,
      default: true,
    });
    return lastSegment(r.name);
  }

  async getDeployedModel(id: string): Promise<{ state?: string; status?: { message?: string } }> {
    const a = await this.accountId();
    return this.request('GET', `/v1/accounts/${a}/deployedModels/${id}`);
  }
}

export interface PipelineOptions {
  apiKey: string;
  accountId?: string;
  config: TrainingConfig;
  /** Existing on-demand deployment (with addons enabled) to load the LoRA onto. Created when omitted. */
  deploymentId?: string;
  deploy?: boolean;
  pollIntervalMs?: number;
  onStatus?: StatusCallback;
  /** Called as soon as the job exists so callers can persist its id. */
  onJobCreated?: (job: { jobId: string; accountId: string }) => void | Promise<void>;
  signal?: AbortSignal;
}

export async function pollFireworksJob(
  client: FireworksClient, jobId: string, onStatus?: StatusCallback, intervalMs = FIREWORKS_MIN_POLL_MS, signal?: AbortSignal
): Promise<FireworksJob> {
  const interval = process.env.FIREWORKS_API_HOST ? intervalMs : Math.max(intervalMs, FIREWORKS_MIN_POLL_MS);
  for (;;) {
    const job = await client.getJob(jobId);
    if (TERMINAL_OK.has(job.state) || TERMINAL_BAD.has(job.state)) { return job; }
    onStatus?.({ stage: 'running', message: `Training job ${lastSegment(jobId)}: ${job.state.replace('JOB_STATE_', '')}` });
    await sleep(interval, signal);
    if (signal?.aborted) { throw new Error('Cancelled'); }
  }
}

export function isJobSuccess(job: FireworksJob): boolean { return TERMINAL_OK.has(job.state); }
export function isJobFailure(job: FireworksJob): boolean { return TERMINAL_BAD.has(job.state); }

/** Loads a trained LoRA onto a deployment (creating the deployment if needed) and waits until it serves traffic. */
export async function deployTrainedModel(
  client: FireworksClient, trainedModel: string, baseModel: string, deploymentId: string,
  onStatus?: StatusCallback, signal?: AbortSignal
): Promise<DeployedEndpoint> {
  const a = await client.accountId();
  const base = baseModel.startsWith('accounts/') ? baseModel : `accounts/fireworks/models/${baseModel}`;
  onStatus?.({ stage: 'deploying', message: `Preparing deployment ${deploymentId}...` });

  if (!(await client.getDeployment(deploymentId))) {
    await client.createDeployment(deploymentId, base);
  }
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    const d = await client.getDeployment(deploymentId);
    if (d?.state === 'READY') { break; }
    if (d?.state === 'FAILED' || d?.state === 'DELETED') { throw new Error(`Deployment ${deploymentId} ${d.state}: ${d.status?.message ?? ''}`); }
    if (Date.now() > deadline) { throw new Error(`Deployment ${deploymentId} was not READY within 30 minutes`); }
    onStatus?.({ stage: 'deploying', message: `Deployment ${deploymentId}: ${d?.state ?? 'pending'}` });
    await sleep(10_000, signal);
    if (signal?.aborted) { throw new Error('Cancelled'); }
  }

  onStatus?.({ stage: 'deploying', message: 'Loading LoRA adapter onto deployment...' });
  const deployedId = await client.loadLora(trainedModel, deploymentId, lastSegment(trainedModel));
  for (;;) {
    const m = await client.getDeployedModel(deployedId);
    if (m.state === 'DEPLOYED') { break; }
    if (Date.now() > deadline) { throw new Error('LoRA adapter did not finish loading in time'); }
    onStatus?.({ stage: 'deploying', message: `Adapter: ${m.state ?? 'pending'}` });
    await sleep(5_000, signal);
    if (signal?.aborted) { throw new Error('Cancelled'); }
  }

  return {
    provider: 'fireworks',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    model: `${trainedModel}#accounts/${a}/deployments/${deploymentId}`,
    baseUrl: FIREWORKS_INFERENCE_URL,
    accountId: a,
    deploymentId,
    trainedModel,
  };
}

/** Full remote flow: upload datasets -> create job -> poll -> (optionally) deploy. */
export async function runFireworksPipeline(opts: PipelineOptions): Promise<TrainingResult & { endpoint?: DeployedEndpoint }> {
  const { config: cfg, onStatus, signal } = opts;
  const client = new FireworksClient(opts.apiKey, opts.accountId);
  const account = await client.accountId();
  const outId = toResourceId(cfg.outputModelName);
  const suffix = Date.now().toString(36);

  const trainCount = await validateDataset(cfg.datasetPath);
  const valCount = cfg.validationPath && fs.existsSync(cfg.validationPath) ? await validateDataset(cfg.validationPath).catch(() => 0) : 0;

  const upload = async (file: string, count: number, kind: string) => {
    const id = toResourceId(`${outId.slice(0, 40)}-${kind}-${suffix}`);
    onStatus?.({ stage: 'uploading', message: `Uploading ${kind} dataset (${count} examples)...` });
    await client.createDataset(id, count);
    await client.uploadDatasetFile(id, file);
    await client.waitDatasetReady(id, signal);
    return id;
  };

  const trainId = await upload(cfg.datasetPath, trainCount, 'train');
  const valId = valCount > 0 ? await upload(cfg.validationPath!, valCount, 'val') : undefined;
  if (signal?.aborted) { throw new Error('Cancelled'); }

  onStatus?.({ stage: 'starting', message: 'Creating fine-tuning job...' });
  const created = await client.createJob(cfg, trainId, valId);
  const jobId = lastSegment(created.name);
  await opts.onJobCreated?.({ jobId, accountId: account });
  onStatus?.({ stage: 'running', message: `Job ${jobId} created` });

  const job = await pollFireworksJob(client, jobId, onStatus, opts.pollIntervalMs, signal);
  if (!isJobSuccess(job)) {
    throw new Error(`Training job ${jobId} ended as ${job.state}${job.status?.message ? `: ${job.status.message}` : ''}`);
  }
  const trainedModel = job.outputModel ?? `accounts/${account}/models/${outId}`;
  onStatus?.({ stage: 'running', message: `Training complete: ${trainedModel}` });

  let endpoint: DeployedEndpoint | undefined;
  if (opts.deploy !== false) {
    endpoint = await deployTrainedModel(client, trainedModel, cfg.baseModel, opts.deploymentId || toResourceId(`${outId}-deploy`), onStatus, signal);
    onStatus?.({ stage: 'done', message: `Deployed. Use model "${endpoint.model}" at ${endpoint.baseUrl}` });
  } else {
    onStatus?.({ stage: 'done', message: `Training complete: ${trainedModel}` });
  }
  return { provider: 'fireworks', jobId, finalStatus: job.state, model: trainedModel, endpoint };
}
