import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { Reproducibility } from './types.js';

const exec = promisify(execFile);
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
export function hash(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
async function sourceHash(directory: string): Promise<string> {
  const entries: Array<[string, string]> = [];
  async function walk(current: string): Promise<void> {
    for (const item of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === 'node_modules' || item.name === '.git') continue;
      const file = join(current, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) entries.push([relative(directory, file).replaceAll('\\', '/'), createHash('sha256').update(await readFile(file)).digest('hex')]);
    }
  }
  await walk(directory);
  return hash(entries);
}
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
export async function codeIdentity(rootDir: string): Promise<{ codeHEAD: string | null; dirty: boolean | null }> {
  const gitOptions = { cwd: rootDir, timeout: 5_000, windowsHide: true };
  let worktreeHead: string | undefined;
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-prefix', '--verify', 'HEAD'], gitOptions);
    const [prefix, head] = stdout.split(/\r?\n/u, 2);
    // A source archive extracted inside a checkout has its own identity.
    if (prefix === '' && head && COMMIT_HASH.test(head)) worktreeHead = head;
  } catch { /* Git may be absent in a deployment archive. */ }
  if (worktreeHead) {
    const { stdout: status } = await exec('git', ['status', '--porcelain', '--untracked-files=all'], gitOptions)
      .catch(() => ({ stdout: null }));
    return { codeHEAD: worktreeHead, dirty: status === null ? null : status.trim().length > 0 };
  }
  const revision = await readFile(join(rootDir, 'deploy', 'REVISION'), 'utf8').catch(() => '');
  const codeHEAD = revision.trim();
  return COMMIT_HASH.test(codeHEAD) ? { codeHEAD, dirty: false } : { codeHEAD: null, dirty: null };
}
export async function reproducibility(rootDir: string, config: unknown, profiles: unknown, engine: string, prompt: unknown): Promise<Reproducibility> {
  const [identity, engineHash, protocolHash] = await Promise.all([
    codeIdentity(rootDir),
    sourceHash(join(rootDir, '.generated', 'state-conquest')),
    sourceHash(join(rootDir, 'packages', 'arena', 'src')),
  ]);
  return {
    ...identity, development: !identity.codeHEAD || identity.dirty !== false,
    engine, engineHash, protocolHash, promptHash: hash(prompt), configHash: hash(config), profilesHash: hash(profiles),
  };
}
