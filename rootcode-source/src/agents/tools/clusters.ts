import { FunctionTool } from '@google/adk';
import * as path from 'node:path';
import { z } from 'zod';
import { allClusters, planClusters, waves } from '../../atlas/clusters';
import type { IndexOrchestrator } from '../../atlas/IndexOrchestrator';
import { createWriteTools } from './workspace';

/** Runs one worker agent to completion and returns its final text. */
export type WorkerRunner = (name: string, instruction: string, tools: FunctionTool[]) => Promise<string>;

const MAX_WORKERS = 4;

/**
 * Splits a multi-area change across the dependency graph's clusters. Each worker may only write inside its own
 * cluster, so parallel workers can't touch the same files; clusters that depend on each other run in dependency
 * order (upstream first) and receive the upstream summaries.
 */
export function createClusterTools(
	atlas: IndexOrchestrator, root: string, workerReadTools: FunctionTool[], runWorker: WorkerRunner,
	onActivity?: (paths: string[], label: string) => void,
): FunctionTool[] {
	return [
		new FunctionTool({
			name: 'plan_clusters',
			description: 'Groups files by dependency-graph cluster (communities of files that import each other). Returns, for each cluster touched, its id, name, the files, which other touched clusters it depends on, and a safe execution order (waves). Use before run_cluster_workers.',
			parameters: z.object({ files: z.array(z.string()).min(1).describe('Workspace-relative files the task will touch') }),
			execute: async ({ files }) => {
				const idx = await atlas.getIndex();
				if (!idx) { return { error: 'Index unavailable.' }; }
				const plan = planClusters(idx, files);
				return { clusters: plan.clusters, waves: waves(plan.clusters), unknown: plan.unknown };
			},
		}),
		new FunctionTool({
			name: 'run_cluster_workers',
			description: `Delegates a change that spans several graph clusters to parallel workers (max ${MAX_WORKERS}). Each task names a cluster id from plan_clusters and what to do there; the worker may only modify files in that cluster. Clusters run in dependency order, upstream first, with their summaries passed on. Only worth it when the work genuinely spans 2+ clusters; do single-cluster work yourself.`,
			parameters: z.object({
				goal: z.string().describe('The overall objective, shared with every worker'),
				tasks: z.array(z.object({ cluster: z.string().describe('Cluster id, e.g. c2'), instruction: z.string().describe('What to do inside this cluster') })).min(1).max(MAX_WORKERS),
			}),
			execute: async ({ goal, tasks }) => {
				const idx = await atlas.getIndex();
				if (!idx) { return { error: 'Index unavailable.' }; }
				const clusters = new Map(allClusters(idx).map(c => [c.id, c]));
				const seen = new Set<string>();
				for (const t of tasks) {
					if (!clusters.has(t.cluster)) { return { error: `Unknown cluster ${t.cluster}. Call plan_clusters first.` }; }
					if (seen.has(t.cluster)) { return { error: `Cluster ${t.cluster} appears twice; give each cluster one task.` }; }
					seen.add(t.cluster);
				}
				const selected = tasks.map(t => ({ ...clusters.get(t.cluster)!, instruction: t.instruction }));
				const order = waves(selected.map(c => ({ id: c.id, dependsOn: c.dependsOn })));
				const results = new Map<string, { cluster: string; summary: string; filesChanged: string[]; error?: string }>();

				const runOne = async (c: typeof selected[number]) => {
					const owned = new Set(c.files);
					const dirs = new Set(c.files.map(f => path.posix.dirname(f)));
					const changed = new Set<string>();
					const canWrite = (rel: string) => {
						const norm = path.isAbsolute(rel) ? path.relative(root, rel).split(path.sep).join('/') : path.posix.normalize(rel);
						if (owned.has(norm) || dirs.has(path.posix.dirname(norm))) { changed.add(norm); onActivity?.([norm], `worker ${c.id}`); return undefined; }
						return `Cluster ${c.id} workers may only modify its own files (${c.files.slice(0, 12).join(', ')}${c.files.length > 12 ? ', …' : ''}) or add files next to them. Report the needed change in your summary instead.`;
					};
					const upstream = c.dependsOn.map(d => results.get(d)).filter((r): r is NonNullable<typeof r> => !!r && !!r.summary)
						.map(r => `- ${r.cluster}: ${r.summary}`).join('\n');
					const instruction = [
						`You are a worker responsible ONLY for cluster ${c.id} (${c.name}). Overall goal: ${goal}`,
						`Your task: ${c.instruction}`,
						`Files in your cluster: ${c.files.join(', ')}`,
						upstream ? `Changes already made upstream by other workers:\n${upstream}` : '',
						'Other clusters are handled by other workers. If you need a change outside your cluster, say so in your summary. Finish with a short summary of what you changed.',
					].filter(Boolean).join('\n\n');
					const tools = [...workerReadTools, ...createWriteTools(root, p => atlas.checkAfterWrite(p), canWrite)];
					try {
						const summary = await runWorker(`cluster_worker_${c.id}`, instruction, tools);
						results.set(c.id, { cluster: c.id, summary, filesChanged: [...changed].sort() });
					} catch (e) {
						results.set(c.id, { cluster: c.id, summary: '', filesChanged: [...changed].sort(), error: e instanceof Error ? e.message : String(e) });
					}
				};

				for (const wave of order) { await Promise.all(wave.map(id => runOne(selected.find(c => c.id === id)!))); }
				return { waves: order, results: order.flat().map(id => results.get(id)!) };
			},
		}),
	];
}
