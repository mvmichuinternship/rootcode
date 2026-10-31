import fetch from 'node-fetch';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BasetenJob, DeployedEndpoint, StatusCallback, TrainingConfig, TrainingResult } from '../types';
import { sleep, validateDataset } from '../utils/datasetUploader';
import { ensureVenv, execCapture, venvPython } from '../utils/python';
import { TRAIN_SCRIPT } from './trainScript';

const API = process.env.BASETEN_API_HOST || 'https://api.baseten.co';
const APP_URL = 'https://app.baseten.co';
export const BASETEN_POLL_MS = 15_000;
export const DEFAULT_HF_SECRET = 'hf_access_token';
const RESULT_MARK = '__MUSE_RESULT__';

const OK_STATES = ['COMPLETED'];
const BAD_STATES = ['FAILED', 'STOPPED', 'CANCELLED', 'ERROR', 'DEPLOY_FAILED', 'DEPLOYING_FAILED'];
const isOk = (s: string) => OK_STATES.some(x => s.toUpperCase().includes(x));
const isBad = (s: string) => BAD_STATES.some(x => s.toUpperCase().includes(x));

export interface BasetenTrainOptions {
  apiKey: string;
  config: TrainingConfig;
  /** Directory of the private venv that holds the `truss` CLI/SDK. */
  venvDir: string;
  /** truss Accelerator name, e.g. H100, H100_40GB, A100, H200. */
  gpu?: string;
  gpuCount?: number;
  /** Name of the Baseten secret that holds a Hugging Face token with access to the base model. */
  hfSecretName?: string;
  maxSeqLen?: number;
  load4bit?: boolean;
  /** GPU used to serve the adapter after training. Defaults to the training GPU. */
  deployGpu?: string;
  deploy?: boolean;
  pollIntervalMs?: number;
  onStatus?: StatusCallback;
  onLog?: (line: string) => void;
  onJobCreated?: (job: { jobId: string; projectId: string }) => void | Promise<void>;
  signal?: AbortSignal;
}

function tailLogger(onLog?: (l: string) => void) {
  let last = '';
  return {
    log: (l: string) => { if (l.trim()) { last = l.trim(); } onLog?.(l); },
    last: () => last || 'no output',
  };
}

const pyStr = (s: string) => JSON.stringify(s);

function assertIdent(value: string, what: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) { throw new Error(`Invalid ${what}: ${value}`); }
  return value;
}

export function renderConfigPy(cfg: TrainingConfig, o: Pick<BasetenTrainOptions, 'gpu' | 'gpuCount' | 'hfSecretName' | 'maxSeqLen' | 'load4bit'> = {}): string {
  const gpu = assertIdent(o.gpu ?? 'H100', 'GPU type');
  const count = Math.max(1, Math.floor(o.gpuCount ?? 1));
  const projectName = cfg.outputModelName.slice(0, 60);
  return `from truss.base import truss_config
from truss_train import definitions

training_job = definitions.TrainingJob(
    image=definitions.Image(base_image="pytorch/pytorch:2.5.1-cuda12.4-cudnn9-devel"),
    compute=definitions.Compute(
        cpu_count=8,
        memory="64Gi",
        accelerator=truss_config.AcceleratorSpec(accelerator=truss_config.Accelerator.${gpu}, count=${count}),
    ),
    runtime=definitions.Runtime(
        start_commands=[
            "pip install -q -U transformers peft trl accelerate datasets bitsandbytes sentencepiece protobuf",
            "python train_lora.py",
        ],
        environment_variables={
            "BASE_MODEL": ${pyStr(cfg.baseModel)},
            "LORA_RANK": ${pyStr(String(cfg.loraRank))},
            "LORA_ALPHA": ${pyStr(String(cfg.loraRank * 2))},
            "LEARNING_RATE": ${pyStr(String(cfg.learningRate))},
            "EPOCHS": ${pyStr(String(cfg.epochs))},
            "MAX_SEQ_LEN": ${pyStr(String(o.maxSeqLen ?? 4096))},
            "LOAD_IN_4BIT": ${pyStr(String(o.load4bit ?? true))},
${(o.hfSecretName ?? DEFAULT_HF_SECRET) ? `            "HF_TOKEN": definitions.SecretReference(name=${pyStr(o.hfSecretName ?? DEFAULT_HF_SECRET)}),\n` : ''}        },
        checkpointing_config=definitions.CheckpointingConfig(enabled=True),
    ),
)

training_project = definitions.TrainingProject(name=${pyStr(projectName)}, job=training_job)
`;
}

const PUSH_PY = `
import json, sys
from pathlib import Path
from truss_train.public_api import push
r = push(config=Path("config.py"), remote="<environment>")
job, proj = r["training_job"], r["training_project"]
print("${RESULT_MARK}" + json.dumps({"job_id": job["id"], "project_id": proj["id"], "status": str(job.get("current_status", ""))}))
`;

const DEPLOY_PY = `
import json, os, sys
from truss.remote.remote_factory import RemoteFactory
from truss_train import definitions as d
from truss.base import truss_config
from truss.cli.train.deploy_checkpoints import deploy_checkpoints as dc

project_id, job_id, name, base_model, rank, gpu, secret = sys.argv[1:8]
remote = RemoteFactory.create(remote="<environment>")
cfg = d.DeployCheckpointsConfig(
    checkpoint_details=d.CheckpointList(
        base_model_id=base_model,
        checkpoints=[d.LoRACheckpoint(training_job_id=job_id, checkpoint_name=name, lora_details=d.LoRADetails(rank=int(rank)))],
    ),
    model_name=os.environ.get("DEPLOY_MODEL_NAME") or None,
    runtime=d.DeployCheckpointsRuntime(environment_variables={"HF_TOKEN": d.SecretReference(name=secret)} if secret else {}),
    compute=d.Compute(cpu_count=8, memory="64Gi", accelerator=truss_config.AcceleratorSpec(accelerator=truss_config.Accelerator[gpu], count=1)),
)
res = dc.create_model_version_from_inference_template(remote, cfg, project_id, job_id, None, False, False)
mv = res.model_version
print("${RESULT_MARK}" + json.dumps({"model_id": mv.model_id, "version_id": mv.id, "name": mv.name}))
`;

export class BasetenClient {
  constructor(private readonly apiKey: string, private readonly venvDir?: string) {
    if (!apiKey) { throw new Error('BASETEN_API_KEY is not set'); }
  }

  private async get<T>(urlPath: string): Promise<T> {
    const res = await fetch(`${API}${urlPath}`, { headers: { Authorization: `Api-Key ${this.apiKey}` } });
    const text = await res.text();
    if (!res.ok) { throw new Error(`Baseten GET ${urlPath} failed (${res.status}): ${text.slice(0, 500)}`); }
    return JSON.parse(text) as T;
  }

  private pyEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      BASETEN_TRUSS_AUTH_REMOTE_URL: process.env.BASETEN_TRUSS_AUTH_REMOTE_URL || APP_URL,
      BASETEN_TRUSS_AUTH_API_KEY: this.apiKey,
      BASETEN_API_KEY: this.apiKey,
    };
  }

  async ensureTruss(onLog?: (l: string) => void, signal?: AbortSignal): Promise<string> {
    if (!this.venvDir) { throw new Error('A venv directory is required to run the truss SDK'); }
    await ensureVenv(this.venvDir, ['truss'], 'truss:latest', { onLog, signal });
    return venvPython(this.venvDir);
  }

  private async runPy(code: string, args: string[], cwd: string, onLog?: (l: string) => void, signal?: AbortSignal): Promise<Record<string, string>> {
    const py = await this.ensureTruss(onLog, signal);
    const tail = tailLogger(onLog);
    const { code: exit, stdout } = await execCapture(py, ['-c', code, ...args], { cwd, env: this.pyEnv(), onLog: tail.log, signal });
    const line = stdout.split('\n').find(l => l.startsWith(RESULT_MARK));
    if (exit !== 0 || !line) { throw new Error(`truss command failed: ${tail.last()}`); }
    return JSON.parse(line.slice(RESULT_MARK.length));
  }

  /** Writes config.py, train_lora.py and the datasets into a temp dir and pushes it as a training job. */
  async push(cfg: TrainingConfig, o: BasetenTrainOptions): Promise<{ jobId: string; projectId: string; status: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'muse-baseten-'));
    try {
      await fs.promises.writeFile(path.join(dir, 'config.py'), renderConfigPy(cfg, o));
      await fs.promises.writeFile(path.join(dir, 'train_lora.py'), TRAIN_SCRIPT);
      await fs.promises.copyFile(cfg.datasetPath, path.join(dir, 'train.jsonl'));
      if (cfg.validationPath && fs.existsSync(cfg.validationPath)) {
        await fs.promises.copyFile(cfg.validationPath, path.join(dir, 'val.jsonl'));
      }
      const r = await this.runPy(PUSH_PY, [], dir, o.onLog, o.signal);
      return { jobId: r.job_id, projectId: r.project_id, status: r.status };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  async getJob(projectId: string, jobId: string): Promise<BasetenJob> {
    const r = await this.get<{ training_job: BasetenJob }>(`/v1/training_projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`);
    return r.training_job;
  }

  async listCheckpoints(projectId: string, jobId: string): Promise<{ checkpoint_id: string; created_at: string; checkpoint_type: string }[]> {
    const r = await this.get<{ checkpoints?: { checkpoint_id: string; created_at: string; checkpoint_type: string }[] }>(
      `/v1/training_projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/checkpoints`);
    return r.checkpoints ?? [];
  }

  async getDeploymentStatus(modelId: string, versionId: string): Promise<string> {
    const r = await this.get<{ status?: string }>(`/v1/models/${encodeURIComponent(modelId)}/deployments/${encodeURIComponent(versionId)}`);
    return r.status ?? 'UNKNOWN';
  }

  async deployCheckpoint(
    projectId: string, jobId: string, checkpointName: string, baseModel: string, rank: number, gpu: string,
    secret: string, modelName: string, onLog?: (l: string) => void, signal?: AbortSignal
  ): Promise<{ modelId: string; versionId: string; name: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'muse-baseten-deploy-'));
    try {
      const py = await this.ensureTruss(onLog, signal);
      const env = { ...this.pyEnv(), DEPLOY_MODEL_NAME: modelName };
      const tail = tailLogger(onLog);
      const { code, stdout } = await execCapture(py, ['-c', DEPLOY_PY, projectId, jobId, checkpointName, baseModel, String(rank), assertIdent(gpu, 'GPU type'), secret], { cwd: dir, env, onLog: tail.log, signal });
      const line = stdout.split('\n').find(l => l.startsWith(RESULT_MARK));
      if (code !== 0 || !line) { throw new Error(`Checkpoint deployment failed: ${tail.last()}`); }
      const r = JSON.parse(line.slice(RESULT_MARK.length));
      return { modelId: r.model_id, versionId: r.version_id, name: r.name };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }
}

export async function pollBasetenJob(
  client: BasetenClient, projectId: string, jobId: string, onStatus?: StatusCallback, intervalMs = BASETEN_POLL_MS, signal?: AbortSignal
): Promise<BasetenJob> {
  for (;;) {
    const job = await client.getJob(projectId, jobId);
    if (isOk(job.current_status) || isBad(job.current_status)) { return job; }
    onStatus?.({ stage: 'running', message: `Training job ${jobId}: ${job.current_status}` });
    await sleep(intervalMs, signal);
    if (signal?.aborted) { throw new Error('Cancelled'); }
  }
}

export const isBasetenJobSuccess = (job: BasetenJob) => isOk(job.current_status);

/** Picks the newest checkpoint (the final epoch) of a finished job. */
export async function latestCheckpoint(client: BasetenClient, projectId: string, jobId: string, signal?: AbortSignal): Promise<string> {
  // Checkpoints sync shortly after the job completes.
  for (let attempt = 0; attempt < 40; attempt++) {
    const list = await client.listCheckpoints(projectId, jobId);
    if (list.length) {
      return [...list].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0].checkpoint_id;
    }
    await sleep(15_000, signal);
    if (signal?.aborted) { throw new Error('Cancelled'); }
  }
  throw new Error(`No checkpoints were found for job ${jobId}`);
}

export interface BasetenDeployInput {
  projectId: string;
  jobId: string;
  baseModel: string;
  outputModelName: string;
  loraRank: number;
  gpu?: string;
  hfSecretName?: string;
}

export async function deployBasetenCheckpoint(
  client: BasetenClient, input: BasetenDeployInput, onStatus?: StatusCallback, onLog?: (l: string) => void, signal?: AbortSignal
): Promise<DeployedEndpoint> {
  const checkpoint = await latestCheckpoint(client, input.projectId, input.jobId, signal);
  onStatus?.({ stage: 'deploying', message: `Deploying checkpoint ${checkpoint} on Baseten...` });
  const d = await client.deployCheckpoint(
    input.projectId, input.jobId, checkpoint, input.baseModel, input.loraRank, input.gpu ?? 'H100',
    input.hfSecretName ?? DEFAULT_HF_SECRET, input.outputModelName, onLog, signal);

  const deadline = Date.now() + 60 * 60_000;
  for (;;) {
    const status = await client.getDeploymentStatus(d.modelId, d.versionId);
    if (status.toUpperCase() === 'ACTIVE') { break; }
    if (/FAILED|UNHEALTHY/i.test(status)) { throw new Error(`Baseten deployment ${d.versionId} ended as ${status}`); }
    if (Date.now() > deadline) { throw new Error('Baseten deployment did not become ACTIVE within 60 minutes'); }
    onStatus?.({ stage: 'deploying', message: `Deployment ${d.versionId}: ${status}` });
    await sleep(15_000, signal);
    if (signal?.aborted) { throw new Error('Cancelled'); }
  }
  return {
    provider: 'baseten',
    model: checkpoint,
    baseUrl: `https://model-${d.modelId}.api.baseten.co/deployment/${d.versionId}/sync/v1`,
    deploymentId: d.versionId,
    modelId: d.modelId,
    trainedModel: checkpoint,
    apiKeyEnv: 'BASETEN_API_KEY',
  };
}

/** Full remote flow on Baseten: push job -> poll -> deploy newest checkpoint. */
export async function runBasetenPipeline(o: BasetenTrainOptions): Promise<TrainingResult & { projectId: string; endpoint?: DeployedEndpoint }> {
  const { config: cfg, onStatus, signal } = o;
  const count = await validateDataset(cfg.datasetPath);
  const client = new BasetenClient(o.apiKey, o.venvDir);

  onStatus?.({ stage: 'starting', message: `Submitting Baseten training job (${count} examples)...` });
  const pushed = await client.push(cfg, o);
  await o.onJobCreated?.({ jobId: pushed.jobId, projectId: pushed.projectId });
  onStatus?.({ stage: 'running', message: `Job ${pushed.jobId} created (${pushed.status})` });

  const job = await pollBasetenJob(client, pushed.projectId, pushed.jobId, onStatus, o.pollIntervalMs, signal);
  if (!isBasetenJobSuccess(job)) { throw new Error(`Training job ${pushed.jobId} ended as ${job.current_status}`); }
  onStatus?.({ stage: 'running', message: 'Training complete' });

  let endpoint: DeployedEndpoint | undefined;
  if (o.deploy !== false) {
    endpoint = await deployBasetenCheckpoint(client, {
      projectId: pushed.projectId, jobId: pushed.jobId, baseModel: cfg.baseModel, outputModelName: cfg.outputModelName,
      loraRank: cfg.loraRank, gpu: o.deployGpu ?? o.gpu, hfSecretName: o.hfSecretName
    }, onStatus, o.onLog, signal);
    onStatus?.({ stage: 'done', message: `Deployed. Use model "${endpoint.model}" at ${endpoint.baseUrl}` });
  } else {
    onStatus?.({ stage: 'done', message: 'Training complete' });
  }
  return { provider: 'baseten', jobId: pushed.jobId, projectId: pushed.projectId, finalStatus: job.current_status, endpoint };
}
