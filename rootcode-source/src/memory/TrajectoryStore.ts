import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MemoryBank, TrajectoryMemory } from './types';

const BANK_VERSION = 1;
const MAX_MEMORIES = 200;
const MIN_SCORE = 1.0;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** djb2 string hash, hex encoded. */
export function hashString(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) { h = ((h << 5) + h + text.charCodeAt(i)) >>> 0; }
	return h.toString(16);
}

/** Only metadata goes to disk: no tool arguments, no response text, no query text. */
function sanitize(memory: TrajectoryMemory): TrajectoryMemory {
	const turn = memory.turn;
	return {
		...memory,
		turn: {
			...turn,
			query: '',
			finalResponse: '',
			steps: turn.steps.map(s => ({ ...s, args: {}, resultSummary: s.resultSummary.slice(0, 200) })),
		},
	};
}

export class TrajectoryStore implements vscode.Disposable {
	private bank: MemoryBank;
	private readonly workspaceId: string;
	private readonly file: string;
	private writeQueue: Promise<void> = Promise.resolve();
	private readonly saved = new vscode.EventEmitter<TrajectoryMemory>();
	/** Fires after a memory is recorded; UI uses it to show what was just learned. */
	readonly onDidSave: vscode.Event<TrajectoryMemory> = this.saved.event;

	constructor(context: vscode.ExtensionContext) {
		this.workspaceId = hashString(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default');
		// One file per workspace so projects never overwrite each other's memories.
		this.file = path.join(context.globalStorageUri.fsPath, `failure-memory-${this.workspaceId}.json`);
		this.bank = this.emptyBank();
	}

	get filePath(): string { return this.file; }

	async initialize(): Promise<void> {
		try {
			await fs.mkdir(path.dirname(this.file), { recursive: true });
			const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<MemoryBank>;
			if (parsed && parsed.version === BANK_VERSION && parsed.workspaceId === this.workspaceId && Array.isArray(parsed.memories)) {
				this.bank = { ...this.emptyBank(), memories: parsed.memories, lastUpdated: parsed.lastUpdated ?? 0 };
			}
		} catch {
			this.bank = this.emptyBank(); // missing or corrupted: start fresh
		}
	}

	async save(memory: TrajectoryMemory): Promise<void> {
		const incoming = sanitize(memory);
		const pattern = incoming.extractedPattern;
		const existing = pattern ? this.bank.memories.find(m => m.extractedPattern?.avoided === pattern.avoided) : undefined;
		if (existing && pattern && existing.extractedPattern) {
			const observedCount = existing.extractedPattern.observedCount + 1;
			existing.extractedPattern = { ...pattern, observedCount, confidence: Math.min(observedCount / 5, 1.0) };
			existing.turn = incoming.turn;
			existing.reward = incoming.reward;
			existing.failureReason = incoming.failureReason;
		} else {
			if (incoming.extractedPattern) {
				const count = incoming.extractedPattern.observedCount || 1;
				incoming.extractedPattern = { ...incoming.extractedPattern, observedCount: count, confidence: Math.min(count / 5, 1.0) };
			}
			this.bank.memories.push(incoming);
		}
		this.prune();
		this.bank.lastUpdated = Date.now();
		await this.persist();
		this.saved.fire(incoming);
	}

	getAll(): TrajectoryMemory[] { return [...this.bank.memories]; }

	/** `neighborhood` (absolute paths): files the dependency graph says are relevant to this request. */
	getRelevantTo(_query: string, activeFile: string, queryType: string, limit: number, neighborhood?: ReadonlySet<string>): TrajectoryMemory[] {
		const now = Date.now();
		const activeDir = activeFile ? path.dirname(activeFile) : '';
		return this.bank.memories
			.map(memory => {
				const { turn, reward } = memory;
				let score = 0;
				if (activeFile && turn.entryPointFile === activeFile) { score += 3; }
				if (turn.queryType === queryType) { score += 2; }
				if (activeDir && turn.filesReferenced.some(f => path.dirname(f) === activeDir)) { score += 1; }
				if (neighborhood?.size) {
					if (neighborhood.has(turn.entryPointFile)) { score += 2; }
					if (turn.filesReferenced.some(f => neighborhood.has(f))) { score += 1.5; }
				}
				if (reward.finalReward < -0.3) { score += 1; }
				if (now - turn.timestamp < WEEK_MS) { score += 0.5; }
				return { memory, score };
			})
			.filter(r => r.score >= MIN_SCORE)
			.sort((a, b) => b.score - a.score || b.memory.turn.timestamp - a.memory.turn.timestamp)
			.slice(0, limit)
			.map(r => r.memory);
	}

	async clear(): Promise<void> {
		this.bank = this.emptyBank();
		await this.persist();
	}

	dispose(): void { this.saved.dispose(); }

	/** Drops the weakest signals (lowest |reward|) first; older entries go first among ties. */
	private prune(): void {
		const excess = this.bank.memories.length - MAX_MEMORIES;
		if (excess <= 0) { return; }
		const drop = new Set([...this.bank.memories]
			.sort((a, b) => Math.abs(a.reward.finalReward) - Math.abs(b.reward.finalReward))
			.slice(0, excess));
		this.bank.memories = this.bank.memories.filter(m => !drop.has(m));
	}

	private persist(): Promise<void> {
		const snapshot = JSON.stringify(this.bank);
		const write = async () => {
			try {
				await fs.mkdir(path.dirname(this.file), { recursive: true });
				const tmp = `${this.file}.tmp`;
				await fs.writeFile(tmp, snapshot, 'utf8');
				await fs.rename(tmp, this.file);
			} catch { /* memory is best-effort and must never break the extension */ }
		};
		this.writeQueue = this.writeQueue.then(write);
		return this.writeQueue;
	}

	private emptyBank(): MemoryBank {
		return { version: BANK_VERSION, workspaceId: this.workspaceId, memories: [], lastUpdated: 0 };
	}
}
