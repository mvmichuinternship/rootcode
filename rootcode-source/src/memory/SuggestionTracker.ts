import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import type { AgentTurn, TrackingSignals } from './types';

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const GIT_BUFFER = 8 * 1024 * 1024;

interface Session {
	turn: AgentTurn;
	files: Set<string>;
	snapshots: Map<string, string>;
	errorsBefore: number;
	agentLines: Set<string>;
	edited: Set<string>;
	testOutcome: TrackingSignals['testOutcome'];
	timer: ReturnType<typeof setTimeout>;
	listeners: vscode.Disposable[];
}

function countErrors(files: Set<string>): number {
	let total = 0;
	for (const file of files) {
		total += vscode.languages.getDiagnostics(vscode.Uri.file(file)).filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
	}
	return total;
}

/** Lines added relative to HEAD, keyed by their trimmed text (blank/trivial lines ignored). */
function runGitAddedLines(cwd: string | undefined): Promise<Set<string>> {
	return new Promise(resolve => {
		if (!cwd) { resolve(new Set()); return; }
		exec('git diff HEAD', { cwd, maxBuffer: GIT_BUFFER }, (error, stdout) => {
			const lines = new Set<string>();
			if (!error) {
				for (const line of stdout.split('\n')) {
					if (line.startsWith('+') && !line.startsWith('+++')) {
						const text = line.slice(1).trim();
						if (text.length > 3) { lines.add(text); }
					}
				}
			}
			resolve(lines);
		});
	});
}

export class SuggestionTracker implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<TrackingSignals>();
	readonly onTrackingComplete: vscode.Event<TrackingSignals> = this.emitter.event;
	private session: Session | undefined;

	startTracking(turn: AgentTurn): void {
		this.stopTracking();
		const files = new Set(turn.filesReferenced.filter(Boolean));
		if (turn.entryPointFile) { files.add(turn.entryPointFile); }
		const windowMs = vscode.workspace.getConfiguration('rootcode').get<number>('memoryTrackingWindowMs', DEFAULT_WINDOW_MS);

		const snapshots = new Map<string, string>();
		for (const doc of vscode.workspace.textDocuments) {
			if (files.has(doc.uri.fsPath)) { snapshots.set(doc.uri.fsPath, doc.getText()); }
		}
		const session: Session = {
			turn, files, snapshots,
			errorsBefore: countErrors(files),
			agentLines: new Set(),
			edited: new Set(),
			testOutcome: 'unknown',
			timer: setTimeout(() => { void this.finish(session); }, windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS),
			listeners: [],
		};
		session.listeners.push(
			vscode.workspace.onDidChangeTextDocument(e => {
				const file = e.document.uri.fsPath;
				if (e.document.uri.scheme !== 'file' || !files.has(file)) { return; }
				if (!e.contentChanges.some(c => c.text.length > 0 || c.rangeLength > 0)) { return; }
				session.edited.add(file);
			}),
			vscode.tasks.onDidEndTaskProcess(e => {
				if (/test/i.test(e.execution.task.name) && e.exitCode !== undefined) {
					session.testOutcome = e.exitCode === 0 ? 'passed' : 'failed';
				}
			}),
		);
		this.session = session;

		// Not-yet-open files and the agent's own git additions are captured asynchronously.
		for (const file of files) {
			if (snapshots.has(file)) { continue; }
			fs.readFile(file, 'utf8').then(text => { if (!snapshots.has(file)) { snapshots.set(file, text); } }, () => undefined);
		}
		void runGitAddedLines(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).then(lines => { session.agentLines = lines; });
	}

	/** Ends tracking early and reports whatever was observed so far. */
	stopTracking(): void {
		const session = this.session;
		if (session) { void this.finish(session); }
	}

	dispose(): void {
		this.release(this.session);
		this.session = undefined;
		this.emitter.dispose();
	}

	private release(session: Session | undefined): void {
		if (!session) { return; }
		clearTimeout(session.timer);
		session.listeners.forEach(l => l.dispose());
		session.listeners = [];
	}

	private async finish(session: Session): Promise<void> {
		if (this.session !== session) { return; }
		this.session = undefined;
		this.release(session);
		try {
			const signals = await this.collect(session);
			this.emitter.fire(signals);
		} catch { /* tracking is best-effort */ }
	}

	private async collect(s: Session): Promise<TrackingSignals> {
		let editDistance = 0;
		for (const file of s.edited) {
			const original = s.snapshots.get(file) ?? await fs.readFile(file, 'utf8').catch(() => '');
			const current = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file)?.getText() ?? original;
			const distance = Math.abs(original.length - current.length) / Math.max(original.length, 1);
			editDistance = Math.max(editDistance, Math.min(1, Math.max(0, distance)));
		}
		const acceptedAsIs = s.edited.size === 0;

		let revertedInGit = false;
		if (s.agentLines.size > 0) {
			const now = await runGitAddedLines(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
			let missing = 0;
			for (const line of s.agentLines) { if (!now.has(line)) { missing++; } }
			revertedInGit = missing / s.agentLines.size > 0.5;
		}
		return {
			turnId: s.turn.id,
			editDistance: acceptedAsIs ? 0 : editDistance,
			diagnosticDelta: countErrors(s.files) - s.errorsBefore,
			acceptedAsIs,
			revertedInGit,
			testOutcome: s.testOutcome,
			filesEdited: [...s.edited],
		};
	}
}
