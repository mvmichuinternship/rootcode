export type WorkflowKind = 'tuning' | 'task';
export type WorkflowEvent = {
	type: 'progress' | 'complete' | 'cancelled';
	kind: WorkflowKind;
	step: number;
	message?: string;
};

export const tuningSteps = ['Collecting data', 'Cleansing data', 'Transforming data', 'Preparing dataset', 'Sending to fine-tuning pipeline'];
export const taskSteps = ['Understanding task', 'Planning workflow', 'Preparing agent handoff'];

export class WorkflowRunner {
	private active?: { kind: WorkflowKind; controller: AbortController };

	constructor(private readonly emit: (event: WorkflowEvent) => void, private readonly delay = 1100) {}

	async start(kind: WorkflowKind, prompt = ''): Promise<void> {
		if (this.active) { return; }
		const run = { kind, controller: new AbortController() };
		this.active = run;
		const steps = kind === 'tuning' ? tuningSteps : taskSteps;
		try {
			for (let step = 0; step < steps.length; step++) {
				if (run.controller.signal.aborted) { return; }
				this.emit({ type: 'progress', kind, step });
				await new Promise<void>(resolve => {
					const finish = () => {
						clearTimeout(timer);
						run.controller.signal.removeEventListener('abort', finish);
						resolve();
					};
					const timer = setTimeout(finish, this.delay);
					run.controller.signal.addEventListener('abort', finish, { once: true });
				});
			}
			if (!run.controller.signal.aborted) {
				this.emit({ type: 'complete', kind, step: steps.length, message: kind === 'tuning'
					? 'Demo handoff complete. No data was collected or uploaded; the fine-tuning pipeline is not connected.'
					: `Demo workflow prepared for: "${prompt}". No agent has run or changed files. Connect an agent service to execute this task.` });
			}
		} finally {
			if (this.active === run) { this.active = undefined; }
		}
	}

	cancel(): void {
		if (!this.active) { return; }
		const { kind, controller } = this.active;
		controller.abort();
		this.active = undefined;
		this.emit({ type: 'cancelled', kind, step: -1 });
	}

	dispose(): void {
		this.active?.controller.abort();
		this.active = undefined;
	}
}