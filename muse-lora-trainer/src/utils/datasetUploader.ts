import * as fs from 'fs';
import * as path from 'path';

/** Validates a JSONL dataset (chat `messages` or `prompt`/`completion` lines). Returns the example count. */
export async function validateDataset(filePath: string): Promise<number> {
  let text: string;
  try { text = await fs.promises.readFile(filePath, 'utf8'); } catch { throw new Error(`Dataset not found: ${filePath}`); }
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) { throw new Error(`Dataset is empty: ${filePath}`); }
  lines.forEach((line, i) => {
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { throw new Error(`${path.basename(filePath)} line ${i + 1}: invalid JSON`); }
    const o = obj as Record<string, unknown> | null;
    const ok = o && ((typeof o.prompt === 'string' && typeof o.completion === 'string') || (Array.isArray(o.messages) && o.messages.length > 0));
    if (!ok) {
      throw new Error(`${path.basename(filePath)} line ${i + 1}: expected { "prompt", "completion" } or { "messages": [...] }`);
    }
    if (Array.isArray(o.messages)) {
      const msgs = o.messages as Array<{ role?: unknown; content?: unknown }>;
      const last = msgs[msgs.length - 1];
      if (msgs.some(m => !m || typeof m.role !== 'string') || last?.role !== 'assistant' || (typeof last.content === 'string' && !last.content.trim())) {
        throw new Error(`${path.basename(filePath)} line ${i + 1}: messages must have roles and end with a non-empty assistant reply`);
      }
    }
  });
  return lines.length;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
