import { createHash } from 'node:crypto';
/** Canonical JSON hashes ALL enumerable internal state, including seed/disaster/remainders/ids. */
export function canonicalJson(value: unknown): string {
  const visit = (v: unknown): unknown => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('Non-finite number in arena state'); return v; }
    if (Array.isArray(v)) return v.map(x => x === undefined ? null : visit(x));
    if (typeof v === 'object' && v) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) {
        const item = (v as Record<string, unknown>)[key];
        if (item !== undefined) Object.defineProperty(out, key, { value: visit(item), enumerable: true });
      }
      return out;
    }
    throw new Error('Non-JSON value in arena state');
  };
  return JSON.stringify(visit(value));
}
export function sha256(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function clone<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
