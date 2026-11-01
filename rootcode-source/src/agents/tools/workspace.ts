import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isSecretFile, resolveInside } from './paths';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'out', '.venv']);
const MAX_READ = 200_000;

async function walk(dir: string, root: string, out: string[], limit: number): Promise<void> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (out.length >= limit) { return; }
		if (IGNORED.has(entry.name) || isSecretFile(entry.name)) { continue; }
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) { await walk(full, root, out, limit); }
		else { out.push(path.relative(root, full)); }
	}
}

export function createReadTools(root: string): FunctionTool[] {
	return [
		new FunctionTool({
			name: 'list_files',
			description: 'Lists files in the workspace (ignores node_modules, .git, build output). Capped at 500 entries.',
			parameters: z.object({ directory: z.string().default('.').describe('Directory relative to workspace root') }),
			execute: async ({ directory }) => {
				const files: string[] = [];
				await walk(resolveInside(root, directory), root, files, 500);
				return { files };
			},
		}),
		new FunctionTool({
			name: 'read_file',
			description: 'Reads a UTF-8 text file from the workspace.',
			parameters: z.object({ path: z.string() }),
			execute: async ({ path: p }) => {
				const target = resolveInside(root, p);
				if (isSecretFile(target)) { throw new Error('Reading secret files (.env, keys) is not allowed.'); }
				const content = await fs.readFile(target, 'utf8');
				return { content: content.slice(0, MAX_READ), truncated: content.length > MAX_READ };
			},
		}),
		new FunctionTool({
			name: 'search_code',
			description: 'Case-insensitive substring search across workspace text files. Returns up to 50 matches.',
			parameters: z.object({ query: z.string().min(1) }),
			execute: async ({ query }) => {
				const files: string[] = [];
				await walk(root, root, files, 2000);
				const needle = query.toLowerCase();
				const matches: { file: string; line: number; text: string }[] = [];
				for (const file of files) {
					if (matches.length >= 50) { break; }
					let text: string;
					try { text = await fs.readFile(path.join(root, file), 'utf8'); } catch { continue; }
					if (text.includes('\0')) { continue; }
					text.split('\n').forEach((line, i) => {
						if (matches.length < 50 && line.toLowerCase().includes(needle)) {
							matches.push({ file, line: i + 1, text: line.trim().slice(0, 200) });
						}
					});
				}
				return { matches };
			},
		}),
	];
}

export function createWriteTools(root: string): FunctionTool[] {
	return [
		new FunctionTool({
			name: 'write_file',
			description: 'Creates or overwrites a file in the workspace with the given content.',
			parameters: z.object({ path: z.string(), content: z.string() }),
			execute: async ({ path: p, content }) => {
				const target = resolveInside(root, p);
				if (isSecretFile(target)) { throw new Error('Writing secret files (.env, keys) is not allowed.'); }
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.writeFile(target, content, 'utf8');
				return { written: p, bytes: Buffer.byteLength(content) };
			},
		}),
	];
}
