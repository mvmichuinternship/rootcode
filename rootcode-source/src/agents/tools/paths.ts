import * as path from 'node:path';

/** Resolves a model-supplied path and guarantees it stays inside the workspace. */
export function resolveInside(root: string, relative: string): string {
	const resolved = path.resolve(root, relative);
	const rel = path.relative(root, resolved);
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		throw new Error(`Path escapes workspace: ${relative}`);
	}
	return resolved;
}

/** .env files hold API keys; the agents must never read, write, search, copy or commit them. */
export function isSecretFile(p: string): boolean {
	const base = path.basename(p).toLowerCase();
	return base === '.env' || base.startsWith('.env.') && base !== '.env.example' && base !== '.env.sample' || base === '.npmrc' || base.endsWith('.pem') || base.endsWith('.key');
}
