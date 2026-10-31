import * as assert from 'assert';

import * as vscode from 'vscode';
import { activate } from '../extension';

suite('Extension Test Suite', () => {
	test('Registers and opens the Rootcode studio command', async () => {
		const subscriptions: vscode.Disposable[] = [];
		activate({ subscriptions, extensionUri: vscode.Uri.file(process.cwd()) } as vscode.ExtensionContext);
		try {
			const commands = await vscode.commands.getCommands(true);
			assert.ok(commands.includes('rootcode.open'));
			await vscode.commands.executeCommand('rootcode.open');
			await vscode.commands.executeCommand('rootcode.open');
		} finally {
			subscriptions.reverse().forEach(disposable => disposable.dispose());
		}
	});
});
