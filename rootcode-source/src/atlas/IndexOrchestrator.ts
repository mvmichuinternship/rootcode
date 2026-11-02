import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { AtlasIndex, isIndexablePath } from './AtlasIndex';
import { CausalContextScorer, type SelectOptions } from './CausalContextScorer';
import { resolveEntryPoints } from './EntryPointResolver';
import { formatContext } from './format';
import { GitTimelineIndex } from './GitTimelineIndex';
import { hopsForQueryType, traverse, type TraversalOptions } from './GraphTraversalEngine';
import { planClusters, repoMap as buildRepoMap, waves } from './clusters';
import { createHash } from 'node:crypto';
import { computeFocus } from './focus';
import { LSPBridge } from './LSPBridge';
import { fileNeighbors } from './queries';
import type { ContextItem, EntryPoint } from './types';

export interface ContextOptions extends TraversalOptions, SelectOptions {
	/** Multiplier on the configured token budget (RL strategies shrink or grow it). */
	budgetScale?: number;
}

export interface WriteCheck {
	/** Compiler/linter errors in the written file and the files that import it. */
	errors: { file: string; line: number; message: string }[];
	/** Files that import the written file; they may need updating or re-checking. */
	importers: string[];
}

/**
 * Owns every index and the single API agents call:
 *   getContext(entryPoints) -> ContextItem[]          explicit entry points
 *   resolveAndGetContext(query) -> { entries, items }  entry points chosen by the resolver
 * Builds on activate, keeps itself fresh on file changes (incremental) and saves (git timeline).
 */
export class IndexOrchestrator implements vscode.Disposable {
	readonly git: GitTimelineIndex;
	readonly lsp: LSPBridge;
	readonly scorer: CausalContextScorer;
	private index: AtlasIndex | undefined;
	private building: Promise<AtlasIndex> | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private timer: NodeJS.Timeout | undefined;
	private gitTimer: NodeJS.Timeout | undefined;
	/** Per conversation: what was already sent for each file (content hash), to avoid re-sending unchanged files. */
	private readonly sent = new Map<string, Map<string, string>>();
	private readonly dirty = new Set<string>();

	constructor(readonly root: string) {
		this.git = new GitTimelineIndex(root);
		this.lsp = new LSPBridge(root);
		this.scorer = new CausalContextScorer(path.join(root, '.rootcode', 'atlas'));
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py}');
		const touch = (u: vscode.Uri) => this.markDirty(u);
		this.disposables.push(
			watcher, watcher.onDidChange(touch), watcher.onDidCreate(touch), watcher.onDidDelete(touch), this.changed,
			vscode.workspace.onDidSaveTextDocument(() => this.scheduleGitRefresh()),
		);
	}

	/** Builds all indexes; safe to call repeatedly. */
	initialize(force = false): Promise<AtlasIndex> {
		if (force) { this.building = undefined; }
		this.building ??= (async () => {
			await new Promise(r => setTimeout(r, 0)); // let activation finish before the synchronous parse
			const idx = new AtlasIndex(this.root);
			await idx.build();
			void this.git.refresh();
			this.index = idx;
			this.changed.fire();
			return idx;
		})();
		return this.building;
	}

	/** Resolves once the index exists; undefined if it failed to build. */
	async getIndex(): Promise<AtlasIndex | undefined> {
		try { return await this.initialize(); } catch { this.building = undefined; return undefined; }
	}

	/** Git state doesn't affect the graph's structure, so it never triggers a graph repaint. */
	private scheduleGitRefresh(): void {
		clearTimeout(this.gitTimer);
		this.gitTimer = setTimeout(() => void this.git.refresh(), 1000);
	}

	private markDirty(uri: vscode.Uri): void {
		if (!this.index) { return; }
		const rel = path.relative(this.root, uri.fsPath).split(path.sep).join('/');
		if (!isIndexablePath(rel)) { return; } // build output, node_modules, caches: never worth waking up for
		this.dirty.add(rel);
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flushDirty(), 500);
	}

	private async flushDirty(): Promise<void> {
		const idx = this.index;
		if (!idx || !this.dirty.size) { return; }
		const batch = [...this.dirty];
		this.dirty.clear();
		// Only repaint subscribers when file contents actually changed (touch/save-without-edit is a no-op).
		if (await idx.updateFiles(batch)) { this.changed.fire(); }
	}

	/** Filters to indexed workspace files (after the index is built); unknown paths are dropped. */
	knownPaths(paths: string[]): string[] {
		const idx = this.index;
		return idx ? [...new Set(paths)].filter(p => idx.hasFile(p)) : [];
	}

	/** Token budget for injected context (setting `rootcode.atlas.tokenBudget`), scaled by the active strategy. */
	private budget(scale = 1): number {
		return Math.round(vscode.workspace.getConfiguration('rootcode.atlas').get<number>('tokenBudget', 16_000) * scale);
	}

	private async run(entries: EntryPoint[], query: string, opts: ContextOptions, turnId?: string): Promise<ContextItem[]> {
		const index = await this.getIndex();
		if (!index) { return []; }
		const diagnostics = this.lsp.diagnostics();
		const base = opts.hops ?? 2;
		const dirs = hopsForQueryType(opts.queryType, base);
		const trav: TraversalOptions = { ...dirs, ...opts, focus: opts.focus ?? computeFocus(index, entries, query) };
		const candidates = traverse(index, this.git, diagnostics, entries, trav);
		const items = this.scorer.select(candidates, { ...opts, tokenBudget: opts.tokenBudget ?? this.budget(opts.budgetScale) }, turnId, query);
		return this.loadContent(items, index, opts.maxContentChars);
	}

	/** Spec API: context for explicit entry points (workspace-relative paths). */
	async getContext(entryPoints: (string | EntryPoint)[], opts: ContextOptions = {}, turnId?: string, query = ''): Promise<ContextItem[]> {
		const entries = entryPoints.map<EntryPoint>(e => typeof e === 'string' ? { path: e, source: 'query', priority: 4, reason: 'explicit entry point' } : e);
		return this.run(entries, query, opts, turnId);
	}

	/** Entry points from editor/diagnostics/stack traces/git/symbols/query, then traversal and scoring. */
	async resolveAndGetContext(query: string, opts: ContextOptions = {}, turnId?: string): Promise<{ entries: EntryPoint[]; items: ContextItem[] }> {
		const index = await this.getIndex();
		if (!index) { return { entries: [], items: [] }; }
		const entries = resolveEntryPoints(query, {
			root: this.root, index, git: this.git, active: this.lsp.activeFile(), diagnostics: this.lsp.diagnostics(),
			openTabs: this.lsp.openTabs(), selection: this.lsp.selectionText(),
		});
		return { entries, items: await this.run(entries, query, opts, turnId) };
	}

	/**
	 * Reads only what the selected items need: whole file (`full`), or for `focus` the bodies of the relevant
	 * symbols plus signatures of everything else.
	 */
	private async loadContent(items: ContextItem[], index: AtlasIndex, maxChars = 24_000): Promise<ContextItem[]> {
		await Promise.all(items.map(async i => {
			if (i.mode === 'outline') { return; }
			try {
				const text = await fsp.readFile(path.join(this.root, i.path), 'utf8');
				if (i.mode === 'full') { i.content = text.slice(0, maxChars); return; }
				const lines = text.split('\n');
				const focus = (i.focus ?? []).slice().sort((a, b) => a.startLine - b.startLine);
				const inFocus = (s: { startLine: number; endLine: number }) => focus.some(f => s.startLine >= f.startLine && s.endLine <= f.endLine);
				const outline = index.symbolsInFile(i.path).filter(s => !inFocus(s))
					.map(s => `${s.signature ?? s.qualifiedName}  // L${s.startLine}-${s.endLine}`);
				const bodies = focus.map(f => lines.slice(f.startLine - 1, f.endLine).map((l, k) => `${f.startLine + k}: ${l}`).join('\n'));
				i.content = `// signatures of the rest of the file\n${outline.join('\n')}\n\n// relevant symbols\n${bodies.join('\n...\n')}`.slice(0, maxChars);
				i.tokens = Math.ceil(i.content.length / 4);
			} catch { i.mode = 'outline'; }
		}));
		return items;
	}

	/** True when the active file currently has compiler errors (used to pick the RL context). */
	hasActiveErrors(): boolean {
		const a = this.lsp.activeFile();
		return !!a && (this.lsp.diagnostics().get(a.path)?.errors ?? 0) > 0;
	}

	/**
	 * After the agent writes a file: refresh the index for it, wait briefly for the language server, and report
	 * errors in that file and the files importing it. Returned to the model inside the write tool's result.
	 */
	async checkAfterWrite(rel: string): Promise<WriteCheck | undefined> {
		const index = this.index;
		const norm = (path.isAbsolute(rel) ? path.relative(this.root, rel) : rel).split(path.sep).join('/');
		if (!index || !isIndexablePath(norm)) { return undefined; }
		if (await index.updateFiles([norm])) { this.changed.fire(); }
		const uri = this.lsp.toUri(norm);
		try { await vscode.workspace.openTextDocument(uri); } catch { return undefined; }
		await this.lsp.waitForDiagnostics(uri);
		const importers = fileNeighbors(index, norm).importedBy.slice(0, 15);
		const diags = this.lsp.diagnostics();
		const errors = [norm, ...importers].flatMap(f => (diags.get(f)?.items ?? []).map(d => ({ file: f, line: d.line, message: d.message }))).slice(0, 12);
		return { errors, importers };
	}

	/** Stable, compact structure summary for the system prompt (same text until the graph changes). */
	async repoMap(): Promise<string> {
		const index = await this.getIndex();
		return index ? buildRepoMap(index) : '';
	}

	/**
	 * Prompt-ready context block for an agent turn ('' when nothing relevant was found). With a `sessionId`, files whose
	 * content was already sent earlier in the same conversation (and are unchanged) become one-line references, which
	 * saves tokens and keeps the conversation history append-only for prefix caching.
	 */
	async buildForQuery(query: string, turnId?: string, opts?: ContextOptions, sessionId?: string): Promise<{ text: string; files: string[]; clusters: number }> {
		const { entries, items } = await this.resolveAndGetContext(query, opts, turnId);
		if (sessionId) { this.dedupe(sessionId, items); }
		const index = this.index;
		const plan = index ? planClusters(index, items.map(i => i.path)) : undefined;
		const note = plan && plan.clusters.length >= 2
			? `Graph clusters in this context (a change spanning several can be split across workers; order: ${waves(plan.clusters).map(w => w.join('+')).join(' → ')}):\n` +
			  plan.clusters.map(c => `- ${c.id} ${c.name}: ${c.files.join(', ')}${c.dependsOn.length ? ` (uses ${c.dependsOn.join(', ')})` : ''}`).join('\n')
			: '';
		return { text: formatContext(items, entries, note), files: items.map(i => i.path), clusters: plan?.clusters.length ?? 0 };
	}

	private dedupe(sessionId: string, items: ContextItem[]): void {
		let seen = this.sent.get(sessionId);
		if (!seen) {
			seen = new Map();
			this.sent.set(sessionId, seen);
			if (this.sent.size > 20) { this.sent.delete(this.sent.keys().next().value!); }
		}
		for (const i of items) {
			if (i.mode === 'outline' || i.mode === 'seen' || !i.content) { continue; }
			const hash = createHash('sha1').update(i.mode).update(i.content).digest('hex');
			if (seen.get(i.path) === hash) { i.mode = 'seen'; i.tokens = 0; i.content = ''; } else { seen.set(i.path, hash); }
		}
	}

	/** Maps absolute or relative paths to workspace-relative ones, then feeds the scorer. */
	recordUsage(turnId: string, files: string[], edited: string[] = []): void {
		const rel = (f: string) => path.isAbsolute(f) ? path.relative(this.root, f).split(path.sep).join('/') : f;
		this.scorer.recordUsage(turnId, files.map(rel), edited.map(rel));
	}
	applyReward(turnId: string, reward: number): void { this.scorer.applyReward(turnId, reward); }

	dispose(): void {
		clearTimeout(this.timer);
		clearTimeout(this.gitTimer);
		for (const d of this.disposables) { d.dispose(); }
	}
}
