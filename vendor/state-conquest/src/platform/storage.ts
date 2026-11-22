/**
 * Settings persistence with a safe fallback chain:
 *   9.46+ setStorage/getStorage -> localStorage (compatibility only) -> session memory.
 *
 * - SDK storage is only enabled after readBuildVersion() reports >= 9.46.
 * - `persistent` reflects the medium that actually accepted the latest write;
 *   a memory-only write returns false even though the session keeps the value.
 * - Reads check the session cache first, then the newest persistent medium, so a
 *   failed SDK read cannot roll settings back to stale local data.
 * - When the SDK is available and only legacy local data exists, it is migrated
 *   into SDK storage on first read.
 * - Every read/write/remove is serialized through one operation queue. A wipe
 *   therefore cannot interleave with an in-flight write or local->SDK migration,
 *   and no pre-wipe operation can repopulate the session cache afterwards.
 * - removeMany reports each persistent medium separately: one backend accepting
 *   the deletion is not enough while another still holds the key.
 */
import { readBuildVersion, isClientVersionAtLeast, STORAGE_MIN_CLIENT_VERSION } from './xhs';
import type { MiniToolApi, StorageInfo } from './xhs';

export type StorageMedium = 'unknown' | 'sdk' | 'local' | 'memory';

/** Per-medium wipe outcome. `unavailable` means the medium exists but cannot delete. */
export type StorageRemoveOutcome =
  | 'removed'
  | 'skipped'
  | 'failed'
  | 'unavailable'
  /** The SDK API exists but its client support could not be confirmed. */
  | 'unknown';

export interface StorageRemoveFailure {
  /** Base key without the shared prefix. */
  key: string;
  medium: 'sdk' | 'local';
  reason: 'threw' | 'unavailable' | 'unconfirmed';
  message: string;
}

/**
 * Structured wipe result. `ok` is true only when every configured persistent
 * medium removed every requested key. A memory-only environment reports
 * `persistent: false` and still succeeds for this session.
 */
export interface StorageRemoveReport {
  ok: boolean;
  keys: string[];
  cacheCleared: number;
  memoryCleared: number;
  sdk: StorageRemoveOutcome;
  local: StorageRemoveOutcome;
  memory: 'removed';
  persistent: boolean;
  failures: StorageRemoveFailure[];
}

/**
 * Raw read result. `read()` collapses "key absent" and "stored JSON is broken"
 * into null, which is fine for settings but not for archives: a truncated
 * write must be reported as corrupt instead of looking like a first launch.
 */
export type RawReadResult =
  | { state: 'missing' }
  | { state: 'ok'; value: unknown; raw: string }
  | { state: 'corrupt'; raw: string };

export interface KeyValueStore {
  readonly persistent: boolean;
  ready(): Promise<boolean>;
  medium(): StorageMedium;
  read<T>(key: string): Promise<T | null>;
  readRaw(key: string): Promise<RawReadResult>;
  write<T>(key: string, value: T): Promise<boolean>;
  remove(key: string): Promise<StorageRemoveReport>;
  /** Wipes all keys as one ordered operation; reports each medium separately. */
  removeMany(keys: readonly string[]): Promise<StorageRemoveReport>;
  info(): Promise<StorageInfo | null>;
}

export interface StorageDeps {
  prefix?: string;
  local?: Storage | null;
  memory?: Map<string, string>;
}

function getLocalStorageOrNull(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const probe = '__sc_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function createStorage(miniTool: MiniToolApi | null, deps?: StorageDeps): KeyValueStore {
  const prefix = (deps && deps.prefix) || 'state-conquest:';
  const local = deps && 'local' in deps ? deps.local : getLocalStorageOrNull();
  const memory = (deps && deps.memory) || new Map<string, string>();
  const cache = new Map<string, string>();

  let mediumValue: StorageMedium = 'unknown';
  let sdkEnabled = false;
  /** True once readBuildVersion returned a usable value; 0 is "unknown". */
  let sdkVersionKnown = false;
  /** The reported client version officially supports storage (9.46+). */
  let sdkVersionSupported = false;
  /** Any platform storage method is present (even if the version is unknown). */
  let sdkApisPresent = false;
  let initPromise: Promise<void> | null = null;

  /**
   * One serialized queue for every operation that touches the cache, a
   * persistent medium or memory. Reads are included because a local->SDK
   * migration is a write: a wipe must either run before that read or after its
   * migration settled, never in the middle. This is the ordering barrier that
   * keeps a pre-wipe operation from repopulating deleted keys.
   */
  let opChain: Promise<void> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = opChain.then(task, task);
    opChain = result.then(
      function () {
        return undefined;
      },
      function () {
        return undefined;
      }
    );
    return result;
  }

  const fullKey = (key: string) => prefix + key;

  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function readVersionValue(): Promise<number> {
    try {
      return await readBuildVersion();
    } catch {
      return 0;
    }
  }

  function applyVersion(version: number): void {
    sdkVersionKnown = version > 0;
    sdkVersionSupported = Boolean(
      version > 0 && isClientVersionAtLeast(version, STORAGE_MIN_CLIENT_VERSION)
    );
    sdkApisPresent = Boolean(
      miniTool
      && (typeof miniTool.setStorage === 'function'
        || typeof miniTool.getStorage === 'function'
        || typeof miniTool.removeStorage === 'function')
    );
    sdkEnabled = Boolean(
      sdkVersionSupported
      && miniTool
      && typeof miniTool.setStorage === 'function'
      && typeof miniTool.getStorage === 'function',
    );
    mediumValue = sdkEnabled ? 'sdk' : local ? 'local' : 'memory';
  }

  function init(): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        applyVersion(await readVersionValue());
      })();
    }
    return initPromise;
  }

  async function readPersistent(name: string): Promise<{ raw: string; source: 'sdk' | 'local' } | null> {
    // If a write already fell back to local, local is newer than SDK for this session.
    if (mediumValue === 'local' && local) {
      try {
        const raw = local.getItem(name);
        if (typeof raw === 'string') return { raw, source: 'local' };
      } catch {
        // fall through
      }
    }
    if (sdkEnabled && miniTool && typeof miniTool.getStorage === 'function') {
      try {
        const result = await miniTool.getStorage({ key: name });
        const raw = result && result.data;
        if (typeof raw === 'string') return { raw, source: 'sdk' };
      } catch {
        // fall through to local
      }
    }
    if (local) {
      try {
        const raw = local.getItem(name);
        if (typeof raw === 'string') return { raw, source: 'local' };
      } catch {
        // fall through
      }
    }
    return null;
  }

  /** Newest raw string for a key: session cache -> persistent media -> memory. */
  async function fetchRaw(name: string): Promise<string | null> {
    if (cache.has(name)) return cache.get(name) as string;

    const found = await readPersistent(name);
    if (found) {
      cache.set(name, found.raw);
      // Local is the newer medium; copy it into SDK storage when possible.
      if (found.source === 'local' && sdkEnabled && miniTool && typeof miniTool.setStorage === 'function') {
        try {
          await miniTool.setStorage({ key: name, data: found.raw });
          mediumValue = 'sdk';
        } catch {
          // keep the local value; a later write will report the real medium
        }
      } else if (found.source === 'sdk') {
        mediumValue = 'sdk';
      }
      return found.raw;
    }

    if (memory.has(name)) {
      const value = memory.get(name) as string;
      cache.set(name, value);
      return value;
    }
    return null;
  }

  /** Tries SDK, then local, then session memory. `ok` means a persistent medium took it. */
  async function writePersistent(
    name: string,
    serialized: string
  ): Promise<{ ok: boolean; medium: 'sdk' | 'local' | 'memory' }> {
    if (sdkEnabled && miniTool && typeof miniTool.setStorage === 'function') {
      try {
        await miniTool.setStorage({ key: name, data: serialized });
        mediumValue = 'sdk';
        return { ok: true, medium: 'sdk' };
      } catch {
        // fall through
      }
    }
    if (local) {
      try {
        local.setItem(name, serialized);
        mediumValue = 'local';
        return { ok: true, medium: 'local' };
      } catch {
        // fall through
      }
    }
    memory.set(name, serialized);
    mediumValue = 'memory';
    return { ok: false, medium: 'memory' };
  }

  async function readInternal<T>(key: string): Promise<T | null> {
    await init();
    const raw = await fetchRaw(fullKey(key));
    if (raw === null) return null;
    return parseJson<T>(raw);
  }

  async function readRawInternal(key: string): Promise<RawReadResult> {
    await init();
    const raw = await fetchRaw(fullKey(key));
    if (raw === null) return { state: 'missing' };
    try {
      return { state: 'ok', value: JSON.parse(raw) as unknown, raw: raw };
    } catch {
      return { state: 'corrupt', raw: raw };
    }
  }

  async function writeInternal<T>(key: string, value: T): Promise<boolean> {
    await init();
    const name = fullKey(key);
    let serialized: string;
    try {
      const json = JSON.stringify(value);
      if (typeof json !== 'string') return false;
      serialized = json;
    } catch {
      return false;
    }

    // Session cache is always the newest value for this run.
    cache.set(name, serialized);
    const written = await writePersistent(name, serialized);
    return written.ok;
  }

  async function removeManyInternal(keys: readonly string[]): Promise<StorageRemoveReport> {
    await init();
    const names = keys.map(fullKey);
    const failures: StorageRemoveFailure[] = [];
    let cacheCleared = 0;
    let memoryCleared = 0;

    for (let i = 0; i < names.length; i += 1) {
      if (cache.delete(names[i])) cacheCleared += 1;
      if (memory.delete(names[i])) memoryCleared += 1;
    }

    // A first version read can transiently fail even though the SDK is present.
    // Before a wipe, retry once; deletion is allowed only when the version is
    // known to support official storage.
    if (!sdkVersionKnown && sdkApisPresent) {
      const version = await readVersionValue();
      if (version > 0) applyVersion(version);
    }

    let sdkOutcome: StorageRemoveOutcome = 'skipped';
    if (sdkVersionSupported) {
      if (!miniTool || typeof miniTool.removeStorage !== 'function') {
        sdkOutcome = 'unavailable';
        for (let i = 0; i < keys.length; i += 1) {
          failures.push({
            key: keys[i],
            medium: 'sdk',
            reason: 'unavailable',
            message: '平台存储未提供删除接口',
          });
        }
      } else {
        sdkOutcome = 'removed';
        for (let i = 0; i < names.length; i += 1) {
          try {
            await miniTool.removeStorage({ key: names[i] });
          } catch (error) {
            sdkOutcome = 'failed';
            failures.push({
              key: keys[i],
              medium: 'sdk',
              reason: 'threw',
              message: errorText(error),
            });
          }
        }
      }
    } else if (sdkApisPresent && !sdkVersionKnown) {
      // Storage APIs exist but the client version is unknown: the SDK may hold
      // a copy we cannot confirm deleting. Never report a silent success.
      sdkOutcome = 'unknown';
      for (let i = 0; i < keys.length; i += 1) {
        failures.push({
          key: keys[i],
          medium: 'sdk',
          reason: 'unconfirmed',
          message: '无法确认当前客户端的平台存储版本，未能确认 SDK 数据已清除',
        });
      }
    }

    let localOutcome: StorageRemoveOutcome = 'skipped';
    if (local) {
      localOutcome = 'removed';
      for (let i = 0; i < names.length; i += 1) {
        try {
          local.removeItem(names[i]);
        } catch (error) {
          localOutcome = 'failed';
          failures.push({
            key: keys[i],
            medium: 'local',
            reason: 'threw',
            message: errorText(error),
          });
        }
      }
    }

    const ok = failures.length === 0;
    if (ok) {
      // Nothing is stored right after a wipe; report the medium that future
      // writes would use so `persistent` stays truthful for the next action.
      mediumValue = sdkEnabled ? 'sdk' : local ? 'local' : 'memory';
    }

    return {
      ok: ok,
      keys: keys.slice(),
      cacheCleared: cacheCleared,
      memoryCleared: memoryCleared,
      sdk: sdkOutcome,
      local: localOutcome,
      memory: 'removed',
      persistent: Boolean(sdkEnabled || local),
      failures: failures,
    };
  }

  function removeManyQueued(keys: readonly string[]): Promise<StorageRemoveReport> {
    return enqueue(function () {
      return removeManyInternal(keys);
    });
  }

  return {
    get persistent(): boolean {
      return mediumValue === 'sdk' || mediumValue === 'local';
    },

    async ready(): Promise<boolean> {
      await init();
      return mediumValue === 'sdk' || mediumValue === 'local';
    },

    medium(): StorageMedium {
      return mediumValue;
    },

    read<T>(key: string): Promise<T | null> {
      return enqueue(function () {
        return readInternal<T>(key);
      });
    },

    readRaw(key: string): Promise<RawReadResult> {
      return enqueue(function () {
        return readRawInternal(key);
      });
    },

    write<T>(key: string, value: T): Promise<boolean> {
      return enqueue(function () {
        return writeInternal(key, value);
      });
    },

    remove(key: string): Promise<StorageRemoveReport> {
      return removeManyQueued([key]);
    },

    removeMany(keys: readonly string[]): Promise<StorageRemoveReport> {
      return removeManyQueued(keys);
    },

    async info(): Promise<StorageInfo | null> {
      await init();
      if (sdkEnabled && miniTool && typeof miniTool.getStorageInfo === 'function') {
        try {
          const info = await miniTool.getStorageInfo();
          return info || null;
        } catch {
          return null;
        }
      }
      return null;
    },
  };
}
