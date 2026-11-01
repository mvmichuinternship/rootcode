import * as path from 'node:path';
import type { TrajectoryStore } from './TrajectoryStore';
import type { TrajectoryMemory } from './types';

const MAX_CHARS = 1500 * 4;
const ENTRY_LIMIT = 300;
const CANDIDATES = 20;
const HEADER = '=== Rootcode learned from past sessions ===';
const FOOTER = '==========================================';

function oneLine(text: string, limit = ENTRY_LIMIT): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export class MemoryInjector {
	constructor(private readonly store: TrajectoryStore) { }

	getInjection(query: string, activeFile: string, queryType: string): string {
		const strong = this.store.getRelevantTo(query, activeFile, queryType, CANDIDATES)
			.filter(m => Math.abs(m.reward.finalReward) > 0.3);
		const failures = strong.filter(m => m.reward.finalReward < -0.3);
		const successes = strong.filter(m => m.reward.finalReward > 0.3);
		if (!failures.length && !successes.length) { return ''; }

		const avoid = new Map<string, string>();
		for (const m of failures) {
			const p = m.extractedPattern;
			if (p && !avoid.has(p.avoided)) {
				avoid.set(p.avoided, `- ${oneLine(p.avoided)} → prefer ${oneLine(p.preferred)}${p.observedCount > 1 ? ` (seen ${p.observedCount} times)` : ''}`);
			}
		}
		const failed = failures.filter(m => m.failureReason).map(m => `- ${this.describe(m)}: ${oneLine(m.failureReason ?? '')} (confidence: ${this.confidence(m)})`);
		const worked = successes.map(m => `- ${this.describe(m)}: ${oneLine(m.failureReason ?? 'Accepted without changes')}`);

		const sections: Array<[string, string[]]> = [
			['AVOID (seen repeatedly):', [...avoid.values()]],
			["PREVIOUSLY FAILED for similar queries:", failed],
			['WORKED WELL:', worked],
		];
		const lines = [HEADER, ''];
		let size = HEADER.length + FOOTER.length + 4;
		for (const [title, entries] of sections) {
			const kept: string[] = [];
			for (const entry of entries) {
				if (size + title.length + entry.length + 4 > MAX_CHARS) { break; }
				kept.push(entry);
				size += entry.length + 1;
			}
			if (!kept.length) { continue; }
			size += title.length + 2;
			lines.push(title, ...kept, '');
		}
		if (lines.length === 2) { return ''; }
		lines.push(FOOTER);
		return lines.join('\n');
	}

	private describe(m: TrajectoryMemory): string {
		const file = m.turn.entryPointFile ? path.basename(m.turn.entryPointFile) : 'unknown file';
		return `Query type '${m.turn.queryType}', working in '${file}'`;
	}

	private confidence(m: TrajectoryMemory): string {
		return (m.extractedPattern?.confidence ?? Math.abs(m.reward.finalReward)).toFixed(1);
	}
}
