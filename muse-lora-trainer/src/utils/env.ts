import * as fs from 'fs';

/** Parses dotenv-style text (KEY=VALUE, # comments, optional quotes, optional `export `). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) { continue; }
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) { continue; }
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) || (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '');
    }
    out[m[1]] = val;
  }
  return out;
}

export function loadEnvFile(filePath: string): Record<string, string> {
  try { return parseEnv(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}
