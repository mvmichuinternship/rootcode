export interface TrainingConfig {
  provider: 'fireworks' | 'baseten';
  datasetPath: string;
  validationPath?: string;
  /** Fireworks maxContextLength; omitted = platform default. */
  maxContextLength?: number;
  baseModel: string;
  outputModelName: string;
  loraRank: number;
  learningRate: number;
  epochs: number;
}

export type FireworksJobState =
  | 'JOB_STATE_CREATING' | 'JOB_STATE_PENDING' | 'JOB_STATE_VALIDATING' | 'JOB_STATE_RUNNING'
  | 'JOB_STATE_WRITING_RESULTS' | 'JOB_STATE_COMPLETED' | 'JOB_STATE_FAILED' | 'JOB_STATE_CANCELLED'
  | 'JOB_STATE_EARLY_STOPPED' | 'JOB_STATE_EXPIRED' | (string & {});

export interface FireworksJob {
  /** accounts/{account}/supervisedFineTuningJobs/{id} */
  name: string;
  state: FireworksJobState;
  outputModel?: string;
  status?: { code?: string; message?: string };
  createTime?: string;
}

export interface BasetenJob {
  id: string;
  current_status: string;
  name: string;
  training_project_id: string;
}

export type TrainingStatus = {
  stage: 'uploading' | 'starting' | 'running' | 'deploying' | 'done' | 'error';
  message: string;
};

export type StatusCallback = (status: TrainingStatus) => void;

export interface TrainingResult {
  provider: 'fireworks' | 'baseten';
  jobId: string;
  finalStatus: string;
  model?: string;
}

export interface DeployedEndpoint {
  provider?: 'fireworks' | 'baseten';
  /** Value to pass as `model` in inference requests. */
  model: string;
  /** OpenAI-compatible base URL. */
  baseUrl: string;
  accountId?: string;
  modelId?: string;
  deploymentId: string;
  trainedModel: string;
  /** Name of the environment variable that holds the API key for this endpoint. */
  apiKeyEnv?: string;
}
