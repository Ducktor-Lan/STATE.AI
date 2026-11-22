import { createHash } from 'node:crypto';
import type { BenchmarkProfile, ScheduleConfig } from './types.js';

/** Sorted object keys, unchanged array order, finite JSON numbers, and no silent omissions. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Canonical JSON requires finite numbers.');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('Canonical JSON rejects non-JSON values, including undefined.');
    if (active.has(item)) throw new TypeError('Canonical JSON rejects circular references.');
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Canonical JSON rejects symbol keys.');
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const values: string[] = [];
        for (let index = 0; index < item.length; index++) {
          if (!Object.hasOwn(item, index)) throw new TypeError('Canonical JSON rejects sparse arrays.');
          values.push(encode(item[index]));
        }
        if (Object.keys(item).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) {
          throw new TypeError('Canonical JSON rejects additional array properties.');
        }
        return `[${values.join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Canonical JSON requires plain objects.');
      const object = item as Record<string, unknown>;
      return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${encode(object[key])}`).join(',')}}`;
    } finally {
      active.delete(item);
    }
  }
  return encode(value);
}

/** Public SHA-256 identity. Persist the input profile/config as well as this versioned hash. */
export function benchmarkIdentity(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export function profileIdentity(profile: BenchmarkProfile): string {
  validateProfile(profile);
  return benchmarkIdentity({ schemaVersion: 1, profile });
}

/** Duration and faction count also change the contest and must not share a leaderboard. */
export function comparisonGroupId(config: Pick<ScheduleConfig, 'track' | 'profile' | 'durationSeconds' | 'factionCount'>): string {
  validateContest(config);
  return benchmarkIdentity({
    schemaVersion: 1,
    track: config.track,
    profileKey: profileIdentity(config.profile),
    durationSeconds: config.durationSeconds,
    factionCount: config.factionCount,
  });
}

export function validateProfile(profile: BenchmarkProfile): void {
  if (!profile || typeof profile !== 'object') throw new TypeError('A benchmark profile is required.');
  for (const field of ['engineVersion', 'protocolVersion', 'promptVersion'] as const) {
    requireText(profile[field], `profile.${field}`);
  }
  for (const field of ['budget', 'context', 'rules'] as const) {
    if (!Object.hasOwn(profile, field)) throw new TypeError(`profile.${field} is required, including when explicitly null.`);
  }
  canonicalJson(profile);
}

export function validateContest(config: Pick<ScheduleConfig, 'track' | 'durationSeconds' | 'factionCount'>): void {
  if (config.track !== 'strategy' && config.track !== 'diplomacy') throw new RangeError('Unknown evaluation track.');
  if (![2, 3, 4].includes(config.factionCount)) throw new RangeError('factionCount must be 2, 3 or 4.');
  if (config.track === 'diplomacy' && config.factionCount === 2) throw new RangeError('Diplomacy requires three or four factions.');
  requireInteger(config.durationSeconds, 'durationSeconds', 1);
}

export function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a nonempty string.`);
}

export function requireInteger(value: number, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be a safe integer from ${minimum} to ${maximum}.`);
  }
}

export function requireNonnegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be finite and nonnegative.`);
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}
