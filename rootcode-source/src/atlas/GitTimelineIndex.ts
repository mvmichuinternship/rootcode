import { execFile } from 'node:child_process';

export interface RecentFile { path: string; /** 0 = uncommitted; 1.. = commits back in history. */ rank: number }

const run = (cwd: string, args: string[]) => new Promise<string>(resolve => {
	execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => resolve(err ? '' : stdout));
});

/**
 * Recently changed files: working-tree changes first, then `git log --name-only -n 50` newest first.
 * Empty outside a git repo. Refresh on save.
 */
export class GitTimelineIndex {
	private files: RecentFile[] = [];
	private byPath = new Map<string, number>();
	private cochange = new Map<string, Map<string, number>>();

	constructor(private readonly root: string, private readonly commits = 50) {}

	async refresh(): Promise<void> {
		// git reports repo-root-relative paths; the workspace may be a subfolder of the repo.
		const prefix = (await run(this.root, ['rev-parse', '--show-prefix'])).trim();
		const [log, status] = await Promise.all([
			run(this.root, ['log', '--name-only', '-n', String(this.commits), '--pretty=format:%x00', '--no-renames']),
			run(this.root, ['status', '--porcelain', '--untracked-files=normal']),
		]);
		const out: RecentFile[] = [];
		const seen = new Set<string>();
		const add = (p: string, rank: number) => {
			if (!p.startsWith(prefix)) { return; }
			const rel = p.slice(prefix.length);
			if (rel && !seen.has(rel)) { seen.add(rel); out.push({ path: rel, rank }); }
		};
		for (const line of status.split('\n')) {
			if (line.length > 3) { add(line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!, 0); }
		}
		const co = new Map<string, Map<string, number>>();
		log.split('\0').filter(c => c.trim()).forEach((commit, i) => {
			const files = commit.split('\n').map(f => f.trim()).filter(f => f.startsWith(prefix) && f.length > prefix.length).map(f => f.slice(prefix.length));
			for (const f of files) { add(prefix + f, i + 1); }
			// Files changed together (skip bulk commits: renames/reformat touch everything and say nothing).
			if (files.length >= 2 && files.length <= 25) {
				for (const a of files) { for (const b of files) { if (a !== b) { const m = co.get(a) ?? co.set(a, new Map()).get(a)!; m.set(b, (m.get(b) ?? 0) + 1); } } }
			}
		});
		this.cochange = co;
		this.files = out;
		this.byPath = new Map(out.map(f => [f.path, f.rank]));
	}

	/** Files that changed in the same commits as `p`, most often first (at least `min` shared commits). */
	coChanged(p: string, min = 2, limit = 3): string[] {
		return [...(this.cochange.get(p) ?? [])].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([f]) => f);
	}

	/** Ordered newest first. */
	recentFiles(limit = Infinity): RecentFile[] { return this.files.slice(0, limit); }
	rankOf(p: string): number { return this.byPath.get(p) ?? -1; }
	isRecent(p: string): boolean { return this.byPath.has(p); }
}
