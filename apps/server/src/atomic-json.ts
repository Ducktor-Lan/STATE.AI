import { randomUUID } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const RENAME_DELAYS_MS = [20, 50, 100, 200, 400] as const;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export interface AtomicJsonOperations {
  /** Injection points for deterministic filesystem regression tests. */
  rename?: (source: string, destination: string) => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
}
/** Publish an already serialized JSON snapshot. Failed attempts retain their unique .pending file. */
export async function atomicWriteJson(file: string, json: string, operations: AtomicJsonOperations = {}): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(file)}.${process.pid}.${randomUUID()}.pending`);
  const handle = await open(temporary, 'wx', 0o600);
  let failed = false;
  let failure: unknown;
  try {
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } catch (error) { failed = true; failure = error; }
  try { await handle.close(); } catch (error) { if (!failed) { failed = true; failure = error; } }
  if (failed) throw failure;

  const publish = operations.rename ?? rename;
  const wait = operations.wait ?? delay;
  for (let attempt = 0; ; attempt++) {
    try {
      // A successful rename consumes our temporary file; the old target is never unlinked.
      await publish(temporary, file);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (typeof code !== 'string' || !RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_DELAYS_MS.length) throw error;
      // Retry only publication of the same completed file, never the write or any arena action.
      await wait(RENAME_DELAYS_MS[attempt]!);
    }
  }
}
