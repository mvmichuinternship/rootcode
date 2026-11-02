import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Candidate, ContextFeatures, ContextItem } from './types';

/** Phase-2 swap point: anything that ranks candidates can replace the built-in scorer. */
export interface ContextScorer {
	score(candidates: Candidate[]): { candidate: Candidate; score: number; features: ContextFeatures }[];
}

export interface SelectOptions {
	/** Query type (debug/refactor/...): picks the learned weight set. */
	queryType?: string;
	/** Which RL strategy arm was active, recorded in the session log. */
	arm?: string;
	/** Probability of adding one exploratory (lower-ranked) file; 0 disables. Default 0.15. */
	explore?: number;
	/** Max number of files returned. */
	topK?: number;
	/** Approximate token budget for everything returned (chars / 4). */
	tokenBudget?: number;
}

export const DEFAULT_WEIGHTS: Record<string, number> = {
	hop: -1.0,
	entryActive: 3.0,
	entryDiagnostic: 2.5,
	entryQuery: 2.2,
	entryGit: 1.2,
	entryPackage: 0.5,
	entrySymbol: 2.0,
	entryStack: 2.6,
	entryTab: 0.8,
	entryOverview: 1.0,
	cochange: 0.6,
	test: 0.5,
	focus: 0.8, // holds symbols the entry points are about
	hasErrors: 2.0,
	errorCount: 0.3,
	recency: 1.0,
	dependency: 0.3, // reached by following the entry's imports: needed to understand it
	hub: 0.2,
	sizePenalty: -0.3,
	bias: 0,
};

/** Files up to this size are always sent whole; larger ones with a focus are trimmed to the relevant symbols. */
const SMALL_FILE_CHARS = 6000;
const AVG_LINE_CHARS = 40;
const tokensOf = (s: string) => Math.ceil(s.length / 4);
const outlineOf = (c: Candidate) => c.symbols.map(s => `${s.signature ?? s.name} [L${s.startLine}-${s.endLine}]`).join('\n');

export function extractFeatures(c: Candidate): ContextFeatures {
	return {
		hop: c.hopDistance,
		entryActive: c.source === 'active-editor' ? 1 : 0,
		entryDiagnostic: c.source === 'diagnostic' ? 1 : 0,
		entryQuery: c.source === 'query' ? 1 : 0,
		entryGit: c.source === 'git' ? 1 : 0,
		entryPackage: c.source === 'package-main' ? 1 : 0,
		entrySymbol: c.source === 'symbol' ? 1 : 0,
		entryStack: c.source === 'stack-trace' ? 1 : 0,
		entryTab: c.source === 'open-tab' ? 1 : 0,
		entryOverview: c.source === 'overview' ? 1 : 0,
		cochange: c.source === 'cochange' ? 1 : 0,
		test: c.source === 'test' ? 1 : 0,
		focus: c.focus?.length ? 1 : 0,
		hasErrors: c.hasErrors ? 1 : 0,
		errorCount: Math.min(c.errorCount, 5),
		recency: c.recentlyChanged ? 1 / (1 + Math.max(0, c.gitRank) * 0.2) : 0,
		dependency: c.source === 'imports' ? 1 : 0,
		hub: Math.log1p(c.importedByCount),
		sizePenalty: Math.log1p(c.size / 4000),
		bias: 1,
	};
}

interface LogEntry { turnId: string; ts: number; query: string; queryType: string; arm?: string; candidates: { path: string; features: ContextFeatures; selected: boolean; explored?: boolean }[] }

/**
 * Scores traversal candidates and picks the best within a token budget.
 *
 * Phase 1: a weighted linear scorer with hand-set weights (DEFAULT_WEIGHTS).
 * Phase 2 hook: every selection is logged (features + which files were offered), and once the agent
 * reports which files it actually used (and the user's implicit reward arrives) the weights are updated by
 * online logistic-regression SGD. Learned weights persist and replace the defaults on next start.
 */
export class CausalContextScorer implements ContextScorer {
	/** One weight vector per query type, so "debug" can learn to value errors more than "explain" does. */
	private weightSets = new Map<string, Record<string, number>>();
	private pending = new Map<string, LogEntry>();
	private used = new Map<string, Set<string>>();
	private readonly weightsFile: string;
	private readonly logFile: string;

	constructor(dataDir: string, private readonly learningRate = 0.05) {
		this.weightsFile = path.join(dataDir, 'scorer-weights.json');
		this.logFile = path.join(dataDir, 'context-log.jsonl');
		try {
			const saved = JSON.parse(fs.readFileSync(this.weightsFile, 'utf8')) as Record<string, unknown>;
			// Older files held a single flat vector; treat it as the shared default.
			const sets = typeof saved.hop === 'number' ? { default: saved as Record<string, number> } : saved as Record<string, Record<string, number>>;
			for (const [k, w] of Object.entries(sets)) { this.weightSets.set(k, { ...DEFAULT_WEIGHTS, ...w }); }
		} catch { /* defaults */ }
	}

	private weightsFor(queryType = 'default'): Record<string, number> {
		let w = this.weightSets.get(queryType);
		if (!w) { w = { ...(this.weightSets.get('default') ?? DEFAULT_WEIGHTS) }; this.weightSets.set(queryType, w); }
		return w;
	}

	getWeights(queryType?: string): Record<string, number> { return { ...this.weightsFor(queryType) }; }

	score(candidates: Candidate[], queryType?: string) {
		const weights = this.weightsFor(queryType);
		return candidates.map(candidate => {
			const features = extractFeatures(candidate);
			let score = 0;
			for (const [k, v] of Object.entries(features)) { score += (weights[k] ?? 0) * v; }
			return { candidate, score, features };
		});
	}

	select(candidates: Candidate[], opts: SelectOptions = {}, turnId?: string, query = ''): ContextItem[] {
		const topK = opts.topK ?? 12;
		const budget = opts.tokenBudget ?? 12_000;
		const ranked = this.score(candidates, opts.queryType).sort((a, b) => b.score - a.score || a.candidate.path.localeCompare(b.candidate.path));
		const items: ContextItem[] = [];
		let used = 0;
		for (const r of ranked) {
			if (items.length >= topK) { break; }
			const c = r.candidate;
			const full = Math.ceil(c.size / 4);
			const outline = tokensOf(outlineOf(c));
			const focusChars = (c.focus ?? []).reduce((n, f) => n + (f.endLine - f.startLine + 1) * AVG_LINE_CHARS, 0);
			const focus = outline + Math.ceil(focusChars / 4);
			// Small files go in whole. Big files with known-relevant symbols get just those bodies + an outline.
			const options: ['full' | 'focus' | 'outline', number][] = c.size > SMALL_FILE_CHARS && c.focus?.length
				? [['focus', focus], ['outline', outline]]
				: [['full', full], ['outline', outline]];
			// The best candidate is always kept (cheapest form if nothing fits); the rest must fit the budget.
			// A file with no extracted symbols has nothing to outline: send it whole or not at all.
			const usable = outline === 0 ? options.filter(([m]) => m !== 'outline') : options;
			const pick = usable.find(([, t]) => used + t <= budget) ?? (items.length ? undefined : options[options.length - 1]);
			if (!pick) { continue; }
			used += pick[1];
			items.push({ ...c, score: r.score, features: r.features, mode: pick[0], tokens: pick[1] });
		}

		// Exploration slot: occasionally surface one lower-ranked file (as an outline) so the scorer can learn
		// whether files it normally hides matter. Seeded by turnId, so a given turn is still reproducible.
		const rate = opts.explore ?? 0.15;
		if (turnId && rate > 0 && items.length >= 2) {
			const chosen = new Set(items.map(i => i.path));
			const rest = ranked.filter(r => !chosen.has(r.candidate.path)).slice(0, 10);
			const rng = seeded(turnId);
			if (rest.length && rng() < rate) {
				const r = rest[Math.floor(rng() * rest.length)];
				items.push({ ...r.candidate, score: r.score, features: r.features, mode: 'outline', tokens: tokensOf(outlineOf(r.candidate)), explored: true });
			}
		}

		if (turnId) {
			const chosen = new Map(items.map(i => [i.path, i]));
			const entry: LogEntry = {
				turnId, ts: Date.now(), query: query.slice(0, 500), queryType: opts.queryType ?? 'default', arm: opts.arm,
				candidates: ranked.map(r => ({ path: r.candidate.path, features: r.features, selected: chosen.has(r.candidate.path), explored: chosen.get(r.candidate.path)?.explored })),
			};
			this.pending.set(turnId, entry);
			if (this.pending.size > 50) { this.pending.delete(this.pending.keys().next().value!); }
			this.append({ type: 'offered', ...entry });
		}
		return items;
	}

	/**
	 * The agent finished a turn. Files it edited are the strongest positives, files it only read weaker ones,
	 * offered-but-untouched files negatives.
	 */
	recordUsage(turnId: string, usedPaths: string[], editedPaths: string[] = []): void {
		const entry = this.pending.get(turnId);
		if (!entry) { return; }
		const usedSet = new Set([...usedPaths, ...editedPaths]);
		const edited = new Set(editedPaths);
		this.used.set(turnId, usedSet);
		this.append({ type: 'used', turnId, ts: Date.now(), used: [...usedSet], edited: [...edited] });
		this.sgd(entry, p => edited.has(p) ? 1 : usedSet.has(p) ? 0.6 : 0, 1);
	}

	/** Implicit reward (-1..1) from the memory system: reinforce or undo the usage signal, scaled by magnitude. */
	applyReward(turnId: string, reward: number): void {
		const entry = this.pending.get(turnId);
		const usedSet = this.used.get(turnId);
		if (!entry || !usedSet || !Number.isFinite(reward) || reward === 0) { return; }
		this.append({ type: 'reward', turnId, ts: Date.now(), reward });
		// Used files are credited only when the outcome was good; a bad outcome pushes them down.
		this.sgd(entry, p => usedSet.has(p) ? (reward > 0 ? 1 : 0) : 0.5, Math.abs(reward));
		this.pending.delete(turnId);
		this.used.delete(turnId);
	}

	private readLog(): { offered: Map<string, LogEntry>; used: Map<string, string[]> } {
		const offered = new Map<string, LogEntry>();
		const used = new Map<string, string[]>();
		let raw = '';
		try { raw = fs.readFileSync(this.logFile, 'utf8'); } catch { /* no log yet */ }
		for (const line of raw.split('\n')) {
			if (!line) { continue; }
			try {
				const e = JSON.parse(line);
				if (e.type === 'offered') { offered.set(e.turnId, e); } else if (e.type === 'used') { used.set(e.turnId, e.used); }
			} catch { /* skip corrupt line */ }
		}
		return { offered, used };
	}

	/** Offline pass over the whole log (used paths only; rewards ignored), e.g. after collecting many sessions. */
	trainFromLog(epochs = 3): number {
		const { offered, used } = this.readLog();
		let n = 0;
		for (let ep = 0; ep < epochs; ep++) {
			for (const [id, entry] of offered) {
				const u = used.get(id);
				if (!u) { continue; }
				const set = new Set(u);
				this.sgd(entry, p => set.has(p) ? 1 : 0, 1, false);
				if (ep === 0) { n++; }
			}
		}
		this.saveWeights();
		return n;
	}

	/** How well the offered context matched what the agent really needed, from the session log (code files only). */
	stats(): { turns: number; avgUsed: number; recallSelected: number; recallCandidates: number; precisionSelected: number; exploredHits: number; exploredShown: number; byType: Record<string, { turns: number; recallSelected: number }> } {
		const out = { turns: 0, avgUsed: 0, recallSelected: 0, recallCandidates: 0, precisionSelected: 0, exploredHits: 0, exploredShown: 0, byType: {} as Record<string, { turns: number; recallSelected: number }> };
		const { offered, used: usedBy } = this.readLog();
		let used = 0, inSel = 0, inCand = 0, sel = 0, selHit = 0;
		const per = new Map<string, { turns: number; used: number; hit: number }>();
		for (const [id, entry] of offered) {
			const u = (usedBy.get(id) ?? []).filter(p => /\.(tsx?|jsx?|mjs|cjs|mts|cts|py)$/.test(p));
			if (!usedBy.has(id) || !u.length) { continue; }
			out.turns++;
			const cand = new Set(entry.candidates.map(c => c.path));
			const chosen = new Set(entry.candidates.filter(c => c.selected).map(c => c.path));
			used += u.length; sel += chosen.size;
			const t = per.get(entry.queryType ?? 'default') ?? { turns: 0, used: 0, hit: 0 };
			t.turns++; t.used += u.length;
			for (const p of u) { if (cand.has(p)) { inCand++; } if (chosen.has(p)) { inSel++; t.hit++; } }
			per.set(entry.queryType ?? 'default', t);
			for (const p of chosen) { if (u.includes(p)) { selHit++; } }
			for (const c of entry.candidates) { if (c.explored) { out.exploredShown++; if (u.includes(c.path)) { out.exploredHits++; } } }
		}
		if (out.turns) {
			out.avgUsed = used / out.turns; out.recallSelected = inSel / used; out.recallCandidates = inCand / used; out.precisionSelected = sel ? selHit / sel : 0;
			for (const [k, t] of per) { out.byType[k] = { turns: t.turns, recallSelected: t.used ? t.hit / t.used : 0 }; }
		}
		return out;
	}

	private sgd(entry: LogEntry, label: (path: string) => number, scale: number, save = true): void {
		const weights = this.weightsFor(entry.queryType);
		for (const c of entry.candidates) {
			let z = 0;
			for (const [k, v] of Object.entries(c.features)) { z += (weights[k] ?? 0) * v; }
			const err = label(c.path) - 1 / (1 + Math.exp(-z));
			for (const [k, v] of Object.entries(c.features)) {
				// L2 pull toward the hand-set defaults keeps early noisy sessions from wrecking the prior.
				const prior = DEFAULT_WEIGHTS[k] ?? 0;
				weights[k] = (weights[k] ?? prior) + this.learningRate * scale * (err * v - 0.01 * ((weights[k] ?? prior) - prior));
			}
		}
		if (save) { this.saveWeights(); }
	}

	private saveWeights(): void { this.write(this.weightsFile, JSON.stringify(Object.fromEntries(this.weightSets), null, 2)); }
	private append(o: object): void {
		try { fs.mkdirSync(path.dirname(this.logFile), { recursive: true }); fs.appendFileSync(this.logFile, JSON.stringify(o) + '\n'); } catch { /* best effort */ }
	}
	private write(file: string, data: string): void {
		try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); } catch { /* best effort */ }
	}
}

/** Small deterministic PRNG (mulberry32) seeded from a string. */
function seeded(seed: string): () => number {
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
	let a = h >>> 0;
	return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
