/** Deterministic PRNG (mulberry32). All game randomness goes through this. */
export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  chance(probability: number): boolean;
  pick<T>(values: T[]): T;
}

export function normalizeSeed(seed: number): number {
  if (!isFinite(seed)) return 1;
  const value = Math.floor(seed) >>> 0;
  return value === 0 ? 1 : value;
}

export function createRng(seed: number): Rng {
  let state = normalizeSeed(seed);

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next: next,
    int: function (maxExclusive: number): number {
      if (!isFinite(maxExclusive) || maxExclusive <= 1) return 0;
      return Math.floor(next() * maxExclusive);
    },
    chance: function (probability: number): boolean {
      return next() < probability;
    },
    pick: function <T>(values: T[]): T {
      return values[Math.floor(next() * values.length)];
    },
  };
}
