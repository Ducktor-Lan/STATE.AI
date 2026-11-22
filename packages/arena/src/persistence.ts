import { mkdir, readFile, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArenaStore, ArenaRecord, ArenaLogEntry, ArenaCheckpoint, ArenaPersistenceDiagnostic, ArenaPersistenceErrorDetails } from './types.js';
import { canonicalJson, clone, sha256 } from './canonical.js';

function errorDetails(error: unknown, depth = 0): ArenaPersistenceErrorDetails {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const details: ArenaPersistenceErrorDetails = { name: typeof source.name === 'string' ? source.name : 'Error', message: typeof source.message === 'string' ? source.message : String(error) };
  if (typeof source.code === 'string' || typeof source.code === 'number') details.code = source.code;
  for (const key of ['syscall', 'path', 'dest', 'phase'] as const) if (typeof source[key] === 'string') details[key] = source[key];
  if (source.cause !== undefined && source.cause !== error && depth < 5) details.cause = errorDetails(source.cause, depth + 1);
  return details;
}
/** A failed authority write is uncertain. The original OS error remains the cause. */
export class ArenaPersistenceError extends Error {
  readonly phase: string;
  readonly durable: boolean;
  readonly code?: string | number;
  readonly syscall?: string;
  readonly path?: string;
  readonly dest?: string;
  constructor(phase: string, cause: unknown, context: { path?: string; dest?: string; durable?: boolean } = {}) {
    const details = errorDetails(cause);
    super(`Arena persistence ${phase} failed${details.code !== undefined ? ` (${details.code})` : ''}: ${details.message}`, { cause });
    this.name = 'ArenaPersistenceError'; this.phase = phase; this.durable = context.durable ?? false;
    this.code = details.code; this.syscall = details.syscall; this.path = details.path ?? context.path; this.dest = details.dest ?? context.dest;
  }
}
export interface FileArenaStore extends ArenaStore {
  readonly diagnostics: ArenaPersistenceDiagnostic[];
  drainDiagnostics(): ArenaPersistenceDiagnostic[];
}
/** JSONL is the authority. Checkpoint/manifest are repairable caches, never a commit gate. */
export function createFileArenaStore(directory: string): FileArenaStore {
  const paths = { initial: join(directory, 'initial.json'), log: join(directory, 'arena.jsonl'), manifest: join(directory, 'manifest.json'), checkpoint: join(directory, 'checkpoint.json') };
  let queue: Promise<unknown> = Promise.resolve();
  let initialized = false;
  let failure: unknown;
  let manifest: ArenaRecord['manifest'] | undefined;
  const diagnostics: ArenaPersistenceDiagnostic[] = [];
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(async () => { if (failure) throw failure; try { return await task(); } catch (error) { failure = error; throw error; } });
    queue = next.catch(() => {}); return next;
  };
  const contextual = (phase: string, error: unknown, path: string, dest?: string) => error instanceof ArenaPersistenceError ? error : new ArenaPersistenceError(phase, error, { path, dest });
  const warn = (error: unknown, phase: string, cp?: ArenaCheckpoint, entryType?: ArenaLogEntry['type']) => {
    const details = errorDetails(error);
    diagnostics.push({ severity: 'warning', phase: details.phase ?? phase, durable: true, ...(entryType ? { entryType } : {}), ...(cp ? { roundIndex: cp.roundIndex, tick: cp.state.tick } : {}), error: details });
  };
  const atomic = async (path: string, value: unknown, kind: string) => {
    const temporary = path + '.pending';
    let phase = `${kind}-open`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let primary: unknown;
    try {
      handle = await open(temporary, 'w');
      phase = `${kind}-write`; await handle.writeFile(canonicalJson(value) + '\n', 'utf8');
      phase = `${kind}-sync`; await handle.sync();
    } catch (error) { primary = contextual(phase, error, temporary, path); }
    if (handle) try { await handle.close(); } catch (error) { primary ??= contextual(`${kind}-close`, error, temporary, path); }
    if (primary) throw primary;
    try { await rename(temporary, path); } catch (error) { throw contextual(`${kind}-rename`, error, temporary, path); }
  };
  const durableAppend = async (text: string, cp?: ArenaCheckpoint, entryType?: ArenaLogEntry['type']) => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let phase = 'log-open';
    let primary: unknown;
    let synced = false;
    try {
      handle = await open(paths.log, 'a');
      phase = 'log-write'; await handle.writeFile(text, 'utf8');
      phase = 'log-sync'; await handle.sync(); synced = true;
    } catch (error) { primary = contextual(phase, error, paths.log); }
    if (handle) try { await handle.close(); } catch (error) {
      if (synced) warn(new ArenaPersistenceError('log-close', error, { path: paths.log, durable: true }), 'log-close', cp, entryType);
      else primary ??= contextual('log-close', error, paths.log);
    }
    if (primary) throw primary;
  };
  const refreshCaches = async (cp: ArenaCheckpoint, entryType?: ArenaLogEntry['type']) => {
    // No blind retry: failures are visible, and the next committed checkpoint repairs each cache independently.
    try { await atomic(paths.checkpoint, cp, 'checkpoint'); } catch (error) { warn(error, 'checkpoint', cp, entryType); }
    try { await atomic(paths.manifest, { ...manifest, lastCommittedRound: cp.roundIndex, lastCommittedTick: cp.state.tick, fingerprint: cp.fingerprint }, 'manifest'); } catch (error) { warn(error, 'manifest', cp, entryType); }
  };
  const read = async (): Promise<ArenaRecord> => {
    let initial: ArenaRecord;
    try { initial = JSON.parse(await readFile(paths.initial, 'utf8')) as ArenaRecord; } catch (error) { throw contextual('initial-read', error, paths.initial); }
    let text = ''; try { text = await readFile(paths.log, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw contextual('log-read', error, paths.log); }
    const lastNewline = text.lastIndexOf('\n');
    const complete = text.slice(0, lastNewline + 1);
    // A crash may leave a torn final append. Discard only that incomplete tail, durably.
    if (complete.length !== text.length) {
      const handle = await open(paths.log, 'r+');
      try { await handle.truncate(Buffer.byteLength(complete)); await handle.sync(); } catch (error) { throw contextual('log-recover-tail', error, paths.log); } finally { await handle.close(); }
    }
    const entries: ArenaLogEntry[] = complete.split('\n').filter(Boolean).map((line, index) => { try { return JSON.parse(line); } catch { throw new Error(`Malformed arena JSONL line ${index + 1}`); } });
    return { ...initial, entries };
  };
  return {
    get diagnostics() { return clone(diagnostics); },
    drainDiagnostics() { return diagnostics.splice(0).map(value => clone(value)); },
    initialize(record) { return serialize(async () => {
      try { await mkdir(directory, { recursive: true }); } catch (error) { throw contextual('initialize-directory', error, directory); }
      let exists = false; try { await stat(paths.initial); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw contextual('initial-stat', error, paths.initial); }
      if (exists) { const existing = await read(); if (sha256(existing) !== sha256(record)) throw new Error('Arena store already contains a different record; restore it before stepping'); }
      else {
        let size = 0; try { size = (await stat(paths.log)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw contextual('log-stat', error, paths.log); }
        if (size) throw new Error('Arena log exists without initial checkpoint');
        await atomic(paths.initial, { ...clone(record), entries: [] }, 'initial');
        if (record.entries.length) await durableAppend(record.entries.map(e => canonicalJson(e) + '\n').join(''));
      }
      manifest = clone(record.manifest);
      const latest = [...record.entries].reverse().find(e => e.type === 'COMMIT');
      const cp = latest?.type === 'COMMIT' ? latest.checkpoint : record.initialCheckpoint;
      initialized = true;
      await refreshCaches(cp);
    }); },
    append(entry) { return serialize(async () => {
      if (!initialized) throw new Error('Initialize arena store before appending');
      const cp = entry.type === 'COMMIT' ? entry.checkpoint : undefined;
      await durableAppend(canonicalJson(entry) + '\n', cp, entry.type);
      // From this point the append MUST resolve, even if an auxiliary cache cannot be replaced.
      if (cp) await refreshCaches(cp, entry.type);
    }); },
    read() { return serialize(read); },
  };
}
/** Useful for tests and server adapters; production persistence should use createFileArenaStore. */
export function createMemoryArenaStore(): ArenaStore {
  let record: ArenaRecord | undefined;
  return { async initialize(value) { if (record && sha256(record) !== sha256(value)) throw new Error('Memory store record mismatch'); record = clone(value); }, async append(entry) { if (!record) throw new Error('Uninitialized store'); record.entries.push(clone(entry)); }, async read() { if (!record) throw new Error('Uninitialized store'); return clone(record); } };
}
