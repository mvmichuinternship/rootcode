import * as vscode from 'vscode';

/** Teal identifies everything produced by the memory module, so it is never mistaken for a core agent. */
export const MEMORY_BRAND = {
	name: 'Rootcode Recall',
	short: 'Recall',
	color: '#14b8a6',
	codicon: 'history',
} as const;

export function isMemoryEnabled(): boolean {
	return vscode.workspace.getConfiguration('rootcode.memory').get<boolean>('enabled', true);
}
