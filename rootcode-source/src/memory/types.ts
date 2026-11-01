export interface AgentStep {
	stepIndex: number;
	tool: string;
	args: Record<string, unknown>;
	resultSummary: string;           // first 200 chars of result only
	durationMs: number;
}

export interface AgentTurn {
	id: string;                      // uuid — use crypto.randomUUID()
	timestamp: number;
	sessionId: string;
	query: string;
	queryType: 'debug' | 'generate' | 'explain' | 'refactor' | 'unknown';
	steps: AgentStep[];
	finalResponse: string;
	filesReferenced: string[];       // all files the agent touched
	entryPointFile: string;          // active file when query was made
}

export interface TrackingSignals {
	turnId: string;
	editDistance: number;            // 0-1, how much user changed agent output
	diagnosticDelta: number;         // errors after minus errors before
	acceptedAsIs: boolean;
	revertedInGit: boolean;
	testOutcome: 'passed' | 'failed' | 'unknown';
	filesEdited: string[];
}

export interface ImplicitReward {
	turnId: string;
	finalReward: number;             // -1.0 to +1.0
	signals: TrackingSignals;
	computedAt: number;
	windowMs: number;
}

export interface TrajectoryMemory {
	turn: AgentTurn;
	reward: ImplicitReward;
	failureReason?: string;
	extractedPattern?: {
		avoided: string;
		preferred: string;
		confidence: number;            // 0-1
		observedCount: number;
	};
}

export interface MemoryBank {
	version: number;
	workspaceId: string;             // hash of workspace root path
	memories: TrajectoryMemory[];
	lastUpdated: number;
}
