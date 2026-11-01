import type { AgentTurn, ImplicitReward, TrackingSignals, TrajectoryMemory } from './types';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export class ImplicitRewardComputer {
	constructor(private readonly windowMs = 5 * 60 * 1000) { }

	compute(signals: TrackingSignals, _turn: AgentTurn): ImplicitReward {
		const base = signals.acceptedAsIs ? 1.0 : -signals.editDistance;
		const diagnosticBonus = signals.diagnosticDelta < 0 ? 0.3 : signals.diagnosticDelta > 0 ? -0.4 : 0;
		const testBonus = signals.testOutcome === 'passed' ? 0.2 : signals.testOutcome === 'failed' ? -0.3 : 0;
		const gitPenalty = signals.revertedInGit ? -0.5 : 0;
		return {
			turnId: signals.turnId,
			finalReward: clamp(base + diagnosticBonus + testBonus + gitPenalty, -1.0, 1.0),
			signals,
			computedAt: Date.now(),
			windowMs: this.windowMs,
		};
	}

	extractFailureReason(signals: TrackingSignals, turn: AgentTurn): string {
		if (signals.editDistance > 0.7 && signals.diagnosticDelta > 0) { return 'Agent suggestion introduced new errors'; }
		if (signals.editDistance > 0.7 && turn.steps.length > 5) { return 'Agent took excessive steps before reaching answer'; }
		if (signals.editDistance > 0.5) { return 'Suggestion significantly edited by user'; }
		if (signals.acceptedAsIs && signals.diagnosticDelta < 0) { return 'Successful fix — reduced errors'; }
		if (signals.acceptedAsIs) { return 'Accepted without changes'; }
		return 'Partial edit — suggestion partially used';
	}

	/** Deterministic, code-free lesson derived from a failure so repeated mistakes can be deduplicated. */
	extractPattern(signals: TrackingSignals, turn: AgentTurn, reward: ImplicitReward): TrajectoryMemory['extractedPattern'] {
		if (reward.finalReward >= -0.3) { return undefined; }
		const type = turn.queryType;
		let avoided: string;
		let preferred: string;
		if (signals.diagnosticDelta > 0) {
			avoided = `Introducing new errors while handling '${type}' requests`;
			preferred = 'Check diagnostics and existing conventions before finalizing a change';
		} else if (turn.steps.length > 5) {
			avoided = `Long tool-call chains for '${type}' requests`;
			preferred = 'Answer with fewer, more targeted tool calls';
		} else if (signals.revertedInGit) {
			avoided = `Changes the user reverted in git for '${type}' requests`;
			preferred = 'Make smaller, more conservative changes and explain them';
		} else {
			avoided = `Suggestions the user heavily rewrote for '${type}' requests`;
			preferred = 'Follow the surrounding code style and keep changes minimal';
		}
		return { avoided, preferred, confidence: 0.2, observedCount: 1 };
	}
}
