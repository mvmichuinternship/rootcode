import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashString } from './TrajectoryStore';

/** How an arm changes the mechanics of a turn, beyond the hint text. */
export interface ArmContext {
	/** Base import-graph depth for context traversal. */
	hops?: number;
	/** Max files injected. */
	topK?: number;
	/** Multiplier on the configured context token budget. */
	tokenBudgetScale?: number;
}

/** A strategy the policy can pick; `hint` is what the model is told, `context` how the injected context is built. */
export interface RlArm { id: string; label: string; hint: string; context?: ArmContext }

export const RL_ARMS: readonly RlArm[] = [
	{ id: 'survey-first', label: 'Survey first', context: { hops: 3, topK: 16, tokenBudgetScale: 1.5 },
		hint: 'Survey before acting: start from the injected structural context, widen it with get_dependencies/trace_symbol, and read related files before changing or answering anything.' },
	{ id: 'minimal-diff', label: 'Minimal diff', context: { hops: 1, topK: 6, tokenBudgetScale: 0.6 },
		hint: 'Make the smallest change that satisfies the request. Do not touch unrelated code.' },
	{ id: 'verify-first', label: 'Verify first', context: { hops: 2, topK: 10 },
		hint: 'Decide how the result will be verified (tests, build, diagnostics) before you start. After every write_file, read its check.errors (this file and its importers) and fix them before finishing.' },
	{ id: 'plan-then-act', label: 'Plan then act', context: { hops: 2, topK: 12 },
		hint: 'State a brief numbered plan first, then execute it step by step.' },
];

export interface ArmStat { id: string; label: string; q: number; n: number }

export interface RlDecision {
	turnId: string;
	context: string;                 // query type the bandit conditions on
	armId: string;
	label: string;
	hint: string;
	mode: 'explore' | 'exploit';
	arms: ArmStat[];                 // snapshot of the table at decision time
	totalPulls: number;
}

export interface RlUpdate {
	turnId: string;
	context: string;
	armId: string;
	label: string;
	reward: number;
	source: 'you' | 'implicit';
	qBefore: number;
	qAfter: number;
	n: number;
	arms: ArmStat[];
}

interface Bank { version: number; workspaceId: string; stats: Record<string, Record<string, { q: number; n: number }>> }

const BANK_VERSION = 1;
const EXPLORATION = 0.6;             // UCB bonus weight
const MIN_ALPHA = 0.1;               // recent feedback never stops mattering entirely

/**
 * Contextual bandit (UCB1) over response strategies, one value table per query type. Learns online
 * from a reward in [-1, 1]; unseen arms are tried first, so the very first turn already shows
 * exploration and the first piece of feedback visibly moves the values.
 */
export class RlPolicy implements vscode.Disposable {
	private bank: Bank;
	private readonly file: string;
	private readonly pending = new Map<string, RlDecision>();
	private readonly rewarded = new Set<string>();
	private writeQueue: Promise<void> = Promise.resolve();
	private readonly emitter = new vscode.EventEmitter<RlUpdate>();
	readonly onDidUpdate: vscode.Event<RlUpdate> = this.emitter.event;

	constructor(context: vscode.ExtensionContext) {
		const id = hashString(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default');
		this.file = path.join(context.globalStorageUri.fsPath, `rl-policy-${id}.json`);
		this.bank = { version: BANK_VERSION, workspaceId: id, stats: {} };
	}

	get filePath(): string { return this.file; }

	async initialize(): Promise<void> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<Bank>;
			if (parsed.version === BANK_VERSION && parsed.workspaceId === this.bank.workspaceId && parsed.stats) { this.bank.stats = parsed.stats; }
		} catch { /* first run: start untrained */ }
	}

	table(context: string): ArmStat[] {
		const row = this.bank.stats[context] ?? {};
		return RL_ARMS.map(a => ({ id: a.id, label: a.label, q: row[a.id]?.q ?? 0, n: row[a.id]?.n ?? 0 }));
	}

	select(turnId: string, context: string): RlDecision {
		const arms = this.table(context);
		const total = arms.reduce((s, a) => s + a.n, 0);
		const score = (a: ArmStat) => a.n === 0 ? Infinity : a.q + EXPLORATION * Math.sqrt(Math.log(total + 1) / a.n);
		const best = Math.max(...arms.map(score));
		const tied = arms.filter(a => score(a) === best);
		const pick = tied[Math.floor(Math.random() * tied.length)];
		const greedy = Math.max(...arms.map(a => a.q));
		const arm = RL_ARMS.find(a => a.id === pick.id)!;
		const decision: RlDecision = {
			turnId, context, armId: arm.id, label: arm.label, hint: arm.hint,
			mode: pick.n === 0 || pick.q < greedy ? 'explore' : 'exploit',
			arms, totalPulls: total,
		};
		this.pending.set(turnId, decision);
		// Decisions stay answerable for late thumbs-up/down; bound the map so it can't grow forever.
		if (this.pending.size > 500) { this.pending.delete(this.pending.keys().next().value!); }
		return decision;
	}

	/** Applies a reward; explicit feedback is applied at once, and a later implicit signal for the same turn is ignored. */
	reward(turnId: string, reward: number, source: RlUpdate['source']): RlUpdate | undefined {
		const decision = this.pending.get(turnId);
		if (!decision) { return undefined; }
		const already = this.rewarded.has(turnId);
		if (already && source === 'implicit') { return undefined; }
		const r = Math.max(-1, Math.min(1, reward));
		const row = (this.bank.stats[decision.context] ??= {});
		const stat = (row[decision.armId] ??= { q: 0, n: 0 });
		const qBefore = stat.q;
		if (!already) { stat.n += 1; }
		stat.q += (r - stat.q) * Math.max(1 / stat.n, MIN_ALPHA);
		this.rewarded.add(turnId);
		void this.persist();
		const update: RlUpdate = {
			turnId, context: decision.context, armId: decision.armId, label: decision.label, reward: r, source,
			qBefore, qAfter: stat.q, n: stat.n, arms: this.table(decision.context),
		};
		this.emitter.fire(update);
		return update;
	}

	async reset(): Promise<void> {
		this.bank.stats = {}; this.pending.clear(); this.rewarded.clear();
		await this.persist();
	}

	dispose(): void { this.emitter.dispose(); }

	private persist(): Promise<void> {
		const snapshot = JSON.stringify(this.bank);
		this.writeQueue = this.writeQueue.then(async () => {
			try {
				await fs.mkdir(path.dirname(this.file), { recursive: true });
				const tmp = `${this.file}.tmp`;
				await fs.writeFile(tmp, snapshot, 'utf8');
				await fs.rename(tmp, this.file);
			} catch { /* best-effort */ }
		});
		return this.writeQueue;
	}
}
