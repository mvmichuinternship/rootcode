import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
	FireworksClient, runFireworksPipeline, runFireworksServerless, pollFireworksJob, deployTrainedModel, isJobSuccess, toResourceId,
	BasetenClient, runBasetenPipeline, pollBasetenJob, deployBasetenCheckpoint, isBasetenJobSuccess,
	generateDataset, datasetPaths, loadEnvFile,
	type TrainingConfig, type TrainingStatus, type DeployedEndpoint
} from 'muse-lora-trainer';

type Provider = 'fireworks' | 'baseten';

export interface LastJob {
	id: string;
	provider: Provider;
	accountId: string;
	projectId?: string;
	serverless?: boolean;
	repoPath: string;
	baseModel: string;
	outputModelName: string;
	deploymentId?: string;
	trainedModel?: string;
	endpoint?: DeployedEndpoint;
}

interface Resolved {
	provider: Provider;
	apiKey: string;
	gpu: string;
	gpuCount: number;
	deployGpu: string;
	hfSecretName: string;
	load4bit: boolean;
	maxSeqLen: number;
	explicitSeqLen: boolean;
	fwMode: 'serverless' | 'managed';
	nEval: number;
	allowPaid: boolean;
	downloadAdapter: boolean;
	accountId: string;
	baseModel: string;
	deploymentId: string;
	autoDeploy: boolean;
	loraRank: number;
	learningRate: number;
	epochs: number;
	env: Record<string, string>;
}

const num = (v: string | undefined, fallback: number) => {
	const n = Number(v);
	return v && Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Precedence: <repo>/.env > process environment > VS Code settings. */
export function resolveSettings(repoPath: string, forceProvider?: Provider): Resolved {
	const c = vscode.workspace.getConfiguration('loraTrainer');
	const clean = (o: Record<string, string | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as Record<string, string>;
	const env = { ...clean(process.env), ...clean(loadEnvFile(path.join(repoPath, '.env'))) };
	const provider: Provider = forceProvider ?? ((env.LORA_PROVIDER || env.PROVIDER || c.get<string>('provider') || 'baseten').toLowerCase() === 'fireworks' ? 'fireworks' : 'baseten');
	const gpu = env.BASETEN_GPU || 'H100';
	return {
		provider,
		apiKey: provider === 'fireworks'
			? env.FIREWORKS_API_KEY || c.get<string>('fireworksApiKey') || ''
			: env.BASETEN_API_KEY || c.get<string>('basetenApiKey') || '',
		gpu,
		gpuCount: Math.max(1, Math.floor(num(env.BASETEN_GPU_COUNT, 1))),
		deployGpu: env.BASETEN_DEPLOY_GPU || gpu,
		hfSecretName: env.BASETEN_HF_SECRET_NAME ?? 'hf_access_token',
		load4bit: (env.LORA_LOAD_IN_4BIT ?? 'true').toLowerCase() !== 'false',
		maxSeqLen: Math.floor(num(env.LORA_MAX_SEQ_LEN, 4096)),
		explicitSeqLen: !!env.LORA_MAX_SEQ_LEN,
		fwMode: (env.FIREWORKS_TRAINING_MODE || 'serverless').toLowerCase() === 'managed' ? 'managed' : 'serverless',
		nEval: Math.max(1, Math.floor(num(env.LORA_N_EVAL, 16))),
		allowPaid: (env.LORA_ALLOW_PAID ?? 'false').toLowerCase() === 'true',
		downloadAdapter: (env.LORA_DOWNLOAD_ADAPTER ?? 'true').toLowerCase() !== 'false',
		accountId: env.FIREWORKS_ACCOUNT_ID || '',
		baseModel: provider === 'fireworks'
			? env.FIREWORKS_BASE_MODEL || c.get<string>('baseModel') || 'accounts/fireworks/models/llama-v3p1-8b-instruct'
			: env.BASETEN_BASE_MODEL || c.get<string>('baseModel') || 'meta-models/muse-spark-open-1026',
		deploymentId: provider === 'fireworks' ? env.FIREWORKS_DEPLOYMENT_ID || '' : '',
		autoDeploy: (env.LORA_AUTO_DEPLOY ?? 'true').toLowerCase() !== 'false',
		loraRank: num(env.LORA_RANK, c.get<number>('loraRank', 16)),
		learningRate: num(env.LORA_LEARNING_RATE, c.get<number>('learningRate', 0.0002)),
		epochs: num(env.LORA_EPOCHS, c.get<number>('epochs', 3)),
		env
	};
}

async function pickWorkspaceFolder(): Promise<string | undefined> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) { return undefined; }
	if (folders.length === 1) { return folders[0].uri.fsPath; }
	return (await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the repository to fine-tune on' }))?.uri.fsPath;
}

const countLines = (file: string): number => {
	try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).length; } catch { return 0; }
};

const defaultModelName = (repoPath: string) => {
	const d = new Date();
	const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
	let base: string;
	try { base = toResourceId(`${path.basename(repoPath)}-lora`).slice(0, 40).replace(/-+$/, ''); } catch { base = 'repo-lora'; }
	return `${base}-${stamp}`;
};

const errText = (e: unknown) => e instanceof Error ? e.message : String(e);

/** One-shot status check used by the "LoRA: Check Job Status" command. */
export async function checkJobStatus(context: vscode.ExtensionContext, onStatus: (s: TrainingStatus) => void): Promise<void> {
	const last = context.globalState.get<LastJob | string>('lastJobId');
	if (!last || typeof last === 'string') { onStatus({ stage: 'error', message: 'No previous job found. Start a fine-tuning job first.' }); return; }
	const keyName = last.provider === 'baseten' ? 'BASETEN_API_KEY' : 'FIREWORKS_API_KEY';
	const apiKey = resolveSettings(last.repoPath, last.provider).apiKey;
	if (!apiKey) { onStatus({ stage: 'error', message: `${keyName} is not set (repo .env, environment or settings).` }); return; }
	try {
		const suffix = last.endpoint ? ` Endpoint model: ${last.endpoint.model}` : '';
		if (last.provider === 'baseten') {
			if (!last.projectId) { onStatus({ stage: 'error', message: 'Saved job has no Baseten project id.' }); return; }
			const job = await new BasetenClient(apiKey).getJob(last.projectId, last.id);
			const state = job.current_status;
			onStatus({ stage: isBasetenJobSuccess(job) ? 'done' : /FAIL|STOP/i.test(state) ? 'error' : 'running', message: `Job ${last.id}: ${state}.${suffix}` });
			return;
		}
		if (last.serverless) {
			onStatus({ stage: last.trainedModel ? 'done' : 'error', message: `Serverless run ${last.id}: ${last.trainedModel ? `trained model ${last.trainedModel}.` : 'no model was produced.'}${suffix}` });
			return;
		}
		const job = await new FireworksClient(apiKey, last.accountId).getJob(last.id);
		const state = job.state.replace('JOB_STATE_', '');
		onStatus({ stage: isJobSuccess(job) ? 'done' : state === 'FAILED' ? 'error' : 'running', message: `Job ${last.id}: ${state}.${suffix || (job.outputModel ? ` Model: ${job.outputModel}` : '')}` });
	} catch (e) {
		onStatus({ stage: 'error', message: errText(e) });
	}
}

export class TrainerPanel {
	private static current: TrainerPanel | undefined;
	private controller?: AbortController;
	private op: 'idle' | 'generating' | 'training' = 'idle';

	static async show(context: vscode.ExtensionContext): Promise<void> {
		if (TrainerPanel.current) { TrainerPanel.current.panel.reveal(); return; }
		const repoPath = await pickWorkspaceFolder();
		if (!repoPath) { void vscode.window.showErrorMessage('Open a repository folder before starting a fine-tuning job.'); return; }
		const existing = TrainerPanel.current as TrainerPanel | undefined;
		if (existing) { existing.panel.reveal(); return; }
		const panel = vscode.window.createWebviewPanel('loraTrainer.panel', 'Rootcode: Fine-Tuning', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
		TrainerPanel.current = new TrainerPanel(panel, context, repoPath);
	}

	private constructor(private readonly panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext, private readonly repoPath: string) {
		panel.webview.html = this.html(randomBytes(16).toString('hex'));
		panel.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m), undefined, context.subscriptions);
		panel.onDidDispose(() => {
			this.controller?.abort();
			TrainerPanel.current = undefined;
		}, undefined, context.subscriptions);
	}

	private send(message: Record<string, unknown>) { void this.panel.webview.postMessage(message); }
	private log(text: string, stage = 'info') { this.send({ type: 'log', stage, text }); }
	private setOp(op: 'idle' | 'generating' | 'training') { this.op = op; this.send({ type: 'op', op }); this.pushInfo(); }

	private pushInfo() {
		const p = datasetPaths(this.repoPath);
		const s = resolveSettings(this.repoPath);
		const last = this.context.globalState.get<LastJob | string>('lastJobId');
		this.send({
			type: 'info',
			repo: this.repoPath,
			train: countLines(p.train),
			val: countLines(p.val),
			hasKey: !!s.apiKey,
			provider: s.provider,
			keyName: s.provider === 'baseten' ? 'BASETEN_API_KEY' : 'FIREWORKS_API_KEY',
			baseModel: s.baseModel,
			outputName: defaultModelName(this.repoPath),
			endpoint: last && typeof last !== 'string' && last.repoPath === this.repoPath ? last.endpoint : undefined
		});
	}

	private async onMessage(m: unknown): Promise<void> {
		if (!m || typeof m !== 'object') { return; }
		const msg = m as Record<string, unknown>;
		switch (msg.type) {
			case 'ready': this.pushInfo(); this.send({ type: 'op', op: this.op }); break;
			case 'generate': await this.generate(); break;
			case 'train': await this.train(typeof msg.outputName === 'string' ? msg.outputName : ''); break;
			case 'resume': await this.resume(); break;
			case 'cancel': this.controller?.abort(); break;
			case 'copy':
				if (typeof msg.text === 'string' && msg.text) {
					await vscode.env.clipboard.writeText(msg.text);
					void vscode.window.showInformationMessage('Copied to clipboard');
				}
				break;
		}
	}

	private resolveWheel(env: Record<string, string>): string {
		if (env.REPO2LORA_WHEEL) { return env.REPO2LORA_WHEEL; }
		const dir = path.join(this.context.extensionPath, 'resources');
		const wheels = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^repo2lora-.*\.whl$/.test(f)).sort() : [];
		if (!wheels.length) { throw new Error(`No repo2lora wheel found in ${dir}`); }
		return path.join(dir, wheels[wheels.length - 1]);
	}

	private async generate(): Promise<void> {
		if (this.op !== 'idle') { return; }
		const controller = this.controller = new AbortController();
		this.setOp('generating');
		try {
			const s = resolveSettings(this.repoPath);
			this.log(`Generating dataset for ${this.repoPath}`);
			const venvDir = path.join(this.context.globalStorageUri.fsPath, 'repo2lora-venv');
			const paths = await generateDataset({
				repoPath: this.repoPath,
				wheelPath: this.resolveWheel(s.env),
				venvDir,
				onLog: l => this.log(l),
				signal: controller.signal
			});
			this.log(`Dataset ready: ${countLines(paths.train)} train / ${countLines(paths.val)} val examples in ${paths.dir}`, 'done');
		} catch (e) {
			this.log(controller.signal.aborted ? 'Cancelled.' : errText(e), controller.signal.aborted ? 'info' : 'error');
		} finally {
			this.controller = undefined;
			this.setOp('idle');
		}
	}

	private saveJob(patch: Partial<LastJob> & { id: string }): Thenable<void> {
		const prev = this.context.globalState.get<LastJob | string>('lastJobId');
		const base = prev && typeof prev !== 'string' && prev.id === patch.id ? prev : {};
		return this.context.globalState.update('lastJobId', { ...base, ...patch } as LastJob);
	}

	private async train(outputNameRaw: string): Promise<void> {
		if (this.op !== 'idle') { return; }
		const p = datasetPaths(this.repoPath);
		if (!fs.existsSync(p.train)) { this.log('No dataset found. Generate the dataset first.', 'error'); return; }
		const s = resolveSettings(this.repoPath);
		const keyName = s.provider === 'baseten' ? 'BASETEN_API_KEY' : 'FIREWORKS_API_KEY';
		if (!s.apiKey) { this.log(`${keyName} is not set. Add it to the repo .env, your environment or the loraTrainer settings.`, 'error'); return; }
		if (!s.baseModel) { this.log('Base model is not set. Set BASETEN_BASE_MODEL / FIREWORKS_BASE_MODEL in .env or loraTrainer.baseModel.', 'error'); return; }
		let outputModelName: string;
		try { outputModelName = toResourceId(outputNameRaw.trim() || defaultModelName(this.repoPath)); } catch (e) { this.log(errText(e), 'error'); return; }

		const config: TrainingConfig = {
			provider: s.provider, datasetPath: p.train, validationPath: p.val, baseModel: s.baseModel, outputModelName,
			loraRank: s.loraRank, learningRate: s.learningRate, epochs: s.epochs,
			maxContextLength: s.explicitSeqLen ? s.maxSeqLen : undefined
		};
		const controller = this.controller = new AbortController();
		this.setOp('training');
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Rootcode fine-tuning', cancellable: true }, async (progress, token) => {
				token.onCancellationRequested(() => controller.abort());
				const report = (st: TrainingStatus) => { progress.report({ message: st.message }); this.log(st.message, st.stage); };
				const base = { id: '', repoPath: this.repoPath, baseModel: s.baseModel, outputModelName, endpoint: undefined, trainedModel: undefined };
				if (s.provider === 'baseten') {
					const result = await runBasetenPipeline({
						apiKey: s.apiKey, config, venvDir: this.trussVenv(), gpu: s.gpu, gpuCount: s.gpuCount, deployGpu: s.deployGpu,
						hfSecretName: s.hfSecretName, load4bit: s.load4bit, maxSeqLen: s.maxSeqLen, deploy: s.autoDeploy,
						onStatus: report, onLog: l => this.log(l), signal: controller.signal,
						onJobCreated: async ({ jobId, projectId }) => {
							await this.saveJob({ ...base, id: jobId, provider: 'baseten', accountId: '', projectId });
						}
					});
					if (result.endpoint) { await this.persistEndpoint(result.jobId, result.endpoint.trainedModel, result.endpoint); }
				} else if (s.fwMode === 'serverless') {
					const result = await runFireworksServerless({
						apiKey: s.apiKey, accountId: s.accountId || undefined, config, venvDir: this.serverlessVenv(), cookbookDir: this.cookbookDir(),
						maxSeqLen: s.explicitSeqLen ? s.maxSeqLen : 8192, nEval: s.nEval, allowPaid: s.allowPaid,
						deploymentId: s.deploymentId || undefined, deploy: s.autoDeploy,
						downloadDir: s.downloadAdapter ? path.join(this.repoPath, '.repo2lora', 'adapters') : undefined,
						onStatus: report, onLog: l => this.log(l), signal: controller.signal,
						onTrained: async ({ runId, model }) => {
							await this.saveJob({ ...base, id: runId, provider: 'fireworks', accountId: s.accountId, serverless: true, trainedModel: model, deploymentId: s.deploymentId || undefined });
						}
					});
					if (result.endpoint) { await this.persistEndpoint(result.jobId, result.model ?? '', result.endpoint); }
				} else {
					const result = await runFireworksPipeline({
						apiKey: s.apiKey, accountId: s.accountId || undefined, config, deploymentId: s.deploymentId || undefined,
						deploy: s.autoDeploy, onStatus: report, signal: controller.signal,
						onJobCreated: async ({ jobId, accountId }) => {
							await this.saveJob({ ...base, id: jobId, provider: 'fireworks', accountId, deploymentId: s.deploymentId || undefined });
						}
					});
					if (result.endpoint) { await this.persistEndpoint(result.jobId, result.model ?? '', result.endpoint); }
				}
			});
		} catch (e) {
			if (controller.signal.aborted) {
				this.log(`Stopped watching. The remote job (if created) keeps running on ${s.provider}; use "Resume last job" to continue.`, 'info');
			} else {
				this.log(errText(e), 'error');
			}
		} finally {
			this.controller = undefined;
			this.setOp('idle');
		}
	}

	private trussVenv(): string { return path.join(this.context.globalStorageUri.fsPath, 'truss-venv'); }
	private serverlessVenv(): string { return path.join(this.context.globalStorageUri.fsPath, 'fireworks-venv'); }
	private cookbookDir(): string { return path.join(this.context.globalStorageUri.fsPath, 'fireworks-cookbook'); }

	/** Re-attaches to the last job: waits for it to finish, then deploys if it has not been deployed yet. */
	private async resume(): Promise<void> {
		if (this.op !== 'idle') { return; }
		const last = this.context.globalState.get<LastJob | string>('lastJobId');
		if (!last || typeof last === 'string' || last.repoPath !== this.repoPath) { this.log('No previous job for this repository.', 'error'); return; }
		const s = resolveSettings(this.repoPath, last.provider);
		if (!s.apiKey) { this.log(`${last.provider === 'baseten' ? 'BASETEN_API_KEY' : 'FIREWORKS_API_KEY'} is not set.`, 'error'); return; }
		const controller = this.controller = new AbortController();
		this.setOp('training');
		const report = (st: TrainingStatus) => this.log(st.message, st.stage);
		try {
			if (last.endpoint) { this.log(`Already deployed: ${last.endpoint.model}`, 'done'); return; }
			if (last.provider === 'baseten') {
				if (!last.projectId) { throw new Error('Saved job has no Baseten project id.'); }
				const client = new BasetenClient(s.apiKey, this.trussVenv());
				const job = await pollBasetenJob(client, last.projectId, last.id, report, undefined, controller.signal);
				if (!isBasetenJobSuccess(job)) { throw new Error(`Job ${last.id} ended as ${job.current_status}`); }
				if (!s.autoDeploy) { this.log('Training complete.', 'done'); return; }
				const endpoint = await deployBasetenCheckpoint(client, {
					projectId: last.projectId, jobId: last.id, baseModel: last.baseModel, outputModelName: last.outputModelName,
					loraRank: s.loraRank, gpu: s.deployGpu, hfSecretName: s.hfSecretName
				}, report, l => this.log(l), controller.signal);
				await this.persistEndpoint(last.id, endpoint.trainedModel, endpoint);
				return;
			}
			const client = new FireworksClient(s.apiKey, last.accountId);
			if (last.serverless) {
				if (!last.trainedModel) { throw new Error('The serverless run did not produce a model. Start training again.'); }
				if (!s.autoDeploy) { this.log(`Training complete: ${last.trainedModel}. Set LORA_AUTO_DEPLOY=true and resume to deploy it.`, 'done'); return; }
				const deploymentId = s.deploymentId || last.deploymentId || toResourceId(`${last.outputModelName}-deploy`);
				const endpoint = await deployTrainedModel(client, last.trainedModel, last.baseModel, deploymentId, report, controller.signal);
				await this.persistEndpoint(last.id, last.trainedModel, endpoint);
				return;
			}
			const job = await pollFireworksJob(client, last.id, report, undefined, controller.signal);
			if (!isJobSuccess(job)) { throw new Error(`Job ${last.id} ended as ${job.state}${job.status?.message ? `: ${job.status.message}` : ''}`); }
			const trained = job.outputModel ?? last.trainedModel;
			if (!trained) { throw new Error('Job completed but no output model was reported.'); }
			if (!s.autoDeploy) { this.log(`Training complete: ${trained}`, 'done'); return; }
			const deploymentId = s.deploymentId || last.deploymentId || toResourceId(`${last.outputModelName}-deploy`);
			const endpoint = await deployTrainedModel(client, trained, last.baseModel, deploymentId, report, controller.signal);
			await this.persistEndpoint(last.id, trained, endpoint);
		} catch (e) {
			this.log(controller.signal.aborted ? 'Stopped.' : errText(e), controller.signal.aborted ? 'info' : 'error');
		} finally {
			this.controller = undefined;
			this.setOp('idle');
		}
	}

	private async persistEndpoint(jobId: string, trainedModel: string, endpoint: DeployedEndpoint): Promise<void> {
		await this.saveJob({ id: jobId, trainedModel, endpoint });
		const file = path.join(this.repoPath, '.repo2lora', 'rootcode-endpoint.json');
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		await fs.promises.writeFile(file, JSON.stringify({ ...endpoint, updatedAt: new Date().toISOString() }, null, 2));
		this.log(`Endpoint saved to ${file}`, 'done');
		this.log(`Deployed. Use model "${endpoint.model}" at ${endpoint.baseUrl}`, 'done');
	}

	private html(nonce: string): string {
		return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;max-width:760px}
h2{margin-top:0}section{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px 16px;margin:12px 0}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 14px;margin:4px 6px 4px 0;cursor:pointer;border-radius:3px}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button:disabled{opacity:.5;cursor:default}
input{width:100%;box-sizing:border-box;padding:4px 6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent)}
.muted{opacity:.7}#log{white-space:pre-wrap;font-family:var(--vscode-editor-font-family);font-size:12px;max-height:340px;overflow:auto;background:var(--vscode-editor-background);padding:8px;border-radius:4px}
.error{color:var(--vscode-errorForeground)}.done{color:var(--vscode-testing-iconPassed,#3fb950)}code{user-select:all}
</style></head><body>
<h2>Fine-tune on this repository</h2>
<p class="muted" id="repo"></p>
<section><b>1. Generate dataset</b>
<p class="muted">Mines git history with repo2lora into <code>.repo2lora/dataset/</code> inside this repository.</p>
<div id="ds" class="muted"></div>
<button id="gen">Generate dataset</button></section>
<section><b id="trainTitle">2. Train</b>
<p class="muted" id="cfg"></p>
<label>Output model name<input id="name"></label>
<button id="train">Start training</button><button id="resume" class="secondary">Resume last job</button></section>
<section id="endpoint" hidden><b>Deployed endpoint</b><p>Model: <code id="emodel"></code></p><p>Base URL: <code id="eurl"></code></p><button id="copy" class="secondary">Copy model id</button></section>
<button id="cancel" class="secondary" hidden>Cancel</button>
<div id="log"></div>
<script nonce="${nonce}">
const vs=acquireVsCodeApi(),$=i=>document.getElementById(i);let op='idle',info={};
const upd=()=>{const b=op!=='idle';$('gen').disabled=b;$('train').disabled=b||!info.train||!info.hasKey||!info.baseModel;$('resume').disabled=b;$('cancel').hidden=!b;};
$('gen').onclick=()=>vs.postMessage({type:'generate'});
$('train').onclick=()=>vs.postMessage({type:'train',outputName:$('name').value});
$('resume').onclick=()=>vs.postMessage({type:'resume'});
$('cancel').onclick=()=>vs.postMessage({type:'cancel'});
$('copy').onclick=()=>vs.postMessage({type:'copy',text:info.endpoint&&info.endpoint.model});
addEventListener('message',e=>{const m=e.data;
 if(m.type==='op'){op=m.op;upd();}
 else if(m.type==='info'){info=m;$('repo').textContent=m.repo;
  $('ds').textContent=m.train?('Dataset: '+m.train+' train / '+m.val+' val examples'):'No dataset yet.';
  $('trainTitle').textContent='2. Train on '+(m.provider==='baseten'?'Baseten':'Fireworks');
  $('cfg').textContent='Base model: '+(m.baseModel||'NOT SET')+' | API key: '+(m.hasKey?'found':'MISSING ('+m.keyName+')');
  if(!$('name').value)$('name').value=m.outputName;
  $('endpoint').hidden=!m.endpoint;if(m.endpoint){$('emodel').textContent=m.endpoint.model;$('eurl').textContent=m.endpoint.baseUrl;}
  upd();}
 else if(m.type==='log'){const d=document.createElement('div');d.className=m.stage==='error'?'error':m.stage==='done'?'done':'';d.textContent=m.text;$('log').appendChild(d);$('log').scrollTop=1e9;}
});
vs.postMessage({type:'ready'});
</script></body></html>`;
	}
}
