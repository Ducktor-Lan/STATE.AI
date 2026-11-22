import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunErrorDiagnostic } from './types.js';

/** Read a project .env without publishing credentials or mutating process.env. */
export async function loadEnvironment(rootDir: string, supplied: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const fromFile: NodeJS.ProcessEnv = {};
  let text: string;
  try { text = await readFile(join(rootDir, '.env'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...supplied }; throw error; }
  for (const line of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?$/u.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = (match[2] ?? '').trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/gu, '\n').replace(/\\r/gu, '\r').replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/u, '').trim();
    fromFile[key] = value;
  }
  return { ...fromFile, ...supplied };
}
export function sanitizeError(error: unknown, env: NodeJS.ProcessEnv): string {
  let message = error instanceof Error ? error.message : String(error);
  // Runtime errors may contain URLs or credentials echoed by a remote provider.
  message = message.replace(/https?:\/\/[^\s<>"']+/giu, '[endpoint]')
    .replace(/(?:Bearer\s+)[^\s,;]+/giu, 'Bearer [redacted]');
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 4 && /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(key)) message = message.split(value).join('[redacted]');
  }
  return message.slice(0, 2_000);
}
/** Preserve filesystem evidence from nested causes without serializing arbitrary provider objects. */
export function errorDiagnostics(error: unknown, env: NodeJS.ProcessEnv): RunErrorDiagnostic[] {
  const result: RunErrorDiagnostic[] = [], seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && result.length < 8 && !seen.has(current)) {
    seen.add(current);
    const value = typeof current === 'object' ? current as Record<string, unknown> : undefined;
    const diagnostic: RunErrorDiagnostic = {
      name: typeof value?.name === 'string' ? sanitizeError(value.name, env) : 'Error',
      message: typeof value?.message === 'string' ? sanitizeError(value.message, env) : sanitizeError(current, env),
    };
    for (const key of ['code', 'syscall', 'path', 'dest', 'phase', 'operation', 'entryType', 'stack'] as const) {
      if (typeof value?.[key] === 'string' || (key === 'code' && typeof value?.[key] === 'number')) diagnostic[key] = sanitizeError(value[key], env);
    }
    for (const key of ['errno', 'roundIndex'] as const) if (typeof value?.[key] === 'number' && Number.isFinite(value[key])) diagnostic[key] = value[key];
    if (typeof value?.durable === 'boolean') diagnostic.durable = value.durable;
    result.push(diagnostic);
    current = value?.cause;
  }
  return result;
}
