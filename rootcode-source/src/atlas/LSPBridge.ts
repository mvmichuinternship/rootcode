import * as vscode from 'vscode';
import * as path from 'node:path';

export interface FileDiagnostics { path: string; errors: number; warnings: number; firstErrorLine?: number; messages: string[]; items: { line: number; message: string }[] }
export interface Location { path: string; line: number }

/**
 * Thin wrapper over VS Code's built-in language features. Not pre-indexed: called at query time,
 * typically for the active file only.
 */
export class LSPBridge {
	constructor(private readonly root: string) {}

	private rel(uri: vscode.Uri): string | undefined {
		if (uri.scheme !== 'file') { return undefined; }
		const r = path.relative(this.root, uri.fsPath);
		return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : undefined;
	}

	toUri(rel: string): vscode.Uri { return vscode.Uri.file(path.join(this.root, rel)); }

	/** Active editor file (workspace-relative) and cursor line, if any. */
	activeFile(): { path: string; line: number } | undefined {
		const ed = vscode.window.activeTextEditor;
		const p = ed && this.rel(ed.document.uri);
		return ed && p ? { path: p, line: ed.selection.active.line + 1 } : undefined;
	}

	/** Workspace files open in editor tabs (workspace-relative), in tab order. */
	openTabs(): string[] {
		const out: string[] = [];
		for (const g of vscode.window.tabGroups.all) {
			for (const t of g.tabs) {
				const p = t.input instanceof vscode.TabInputText ? this.rel(t.input.uri) : undefined;
				if (p && !out.includes(p)) { out.push(p); }
			}
		}
		return out;
	}

	/** Text currently selected in the active editor (bounded). */
	selectionText(): string {
		const ed = vscode.window.activeTextEditor;
		return ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection).slice(0, 2000) : '';
	}

	/** Resolves when diagnostics for `uri` change and settle, or after `timeoutMs`. */
	waitForDiagnostics(uri: vscode.Uri, timeoutMs = 2500): Promise<void> {
		return new Promise(resolve => {
			let settle: NodeJS.Timeout | undefined;
			const done = () => { clearTimeout(settle); clearTimeout(timer); sub.dispose(); resolve(); };
			const timer = setTimeout(done, timeoutMs);
			const sub = vscode.languages.onDidChangeDiagnostics(e => {
				if (e.uris.some(u => u.toString() === uri.toString())) { clearTimeout(settle); settle = setTimeout(done, 350); }
			});
		});
	}

	/** Workspace diagnostics grouped per file; files with errors first. */
	diagnostics(): Map<string, FileDiagnostics> {
		const out = new Map<string, FileDiagnostics>();
		for (const [uri, diags] of vscode.languages.getDiagnostics()) {
			const p = this.rel(uri);
			if (!p) { continue; }
			const errs = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
			const warns = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);
			if (!errs.length && !warns.length) { continue; }
			out.set(p, {
				path: p, errors: errs.length, warnings: warns.length,
				firstErrorLine: errs[0] ? errs[0].range.start.line + 1 : undefined,
				messages: errs.slice(0, 3).map(d => d.message.split('\n')[0].slice(0, 200)),
				items: errs.slice(0, 5).map(d => ({ line: d.range.start.line + 1, message: d.message.split('\n')[0].slice(0, 200) })),
			});
		}
		return out;
	}

	async definition(p: string, line: number, character = 0): Promise<Location[]> {
		const res = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
			'vscode.executeDefinitionProvider', this.toUri(p), new vscode.Position(Math.max(0, line - 1), character)) ?? [];
		return res.flatMap(r => {
			const uri = 'targetUri' in r ? r.targetUri : r.uri;
			const range = 'targetRange' in r ? r.targetRange : r.range;
			const rel = this.rel(uri);
			return rel ? [{ path: rel, line: range.start.line + 1 }] : [];
		});
	}

	/** Type info / docs at a position as plain markdown text. */
	async hover(p: string, line: number, character = 0): Promise<string> {
		const res = await vscode.commands.executeCommand<vscode.Hover[]>(
			'vscode.executeHoverProvider', this.toUri(p), new vscode.Position(Math.max(0, line - 1), character)) ?? [];
		return res.flatMap(h => h.contents.map(c => typeof c === 'string' ? c : c.value)).join('\n\n').trim();
	}
}
