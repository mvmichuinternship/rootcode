import type * as vscode from 'vscode';
import { SuggestionTracker } from './SuggestionTracker';
import { ImplicitRewardComputer } from './ImplicitRewardComputer';
import { TrajectoryStore } from './TrajectoryStore';
import { MemoryInjector } from './MemoryInjector';
import { RlPolicy } from './RlPolicy';

export { SuggestionTracker } from './SuggestionTracker';
export { ImplicitRewardComputer } from './ImplicitRewardComputer';
export { TrajectoryStore } from './TrajectoryStore';
export { MemoryInjector } from './MemoryInjector';
export * from './RlPolicy';
export * from './types';
export { MEMORY_BRAND, isMemoryEnabled } from './brand';
export { registerMemoryUi } from './MemoryUi';

export function createMemorySystem(context: vscode.ExtensionContext) {
	const store = new TrajectoryStore(context);
	const tracker = new SuggestionTracker();
	const rewardComputer = new ImplicitRewardComputer();
	const injector = new MemoryInjector(store);
	const policy = new RlPolicy(context);
	return { store, tracker, rewardComputer, injector, policy };
}

export type MemorySystem = ReturnType<typeof createMemorySystem>;
