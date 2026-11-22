import {
  DISASTER_CHANCE,
  DISASTER_DAMAGE_SEED_SALT,
  DISASTER_MAX_LOSS_RATIO,
  DISASTER_MIN_LOSS_RATIO,
  DISASTER_SCHEDULE_SEED_SALT,
  DISASTER_WARN_TICKS,
  DISASTER_WINDOW_END_RATIO,
  DISASTER_WINDOW_START_RATIO,
} from '../config/balance';
import { markNeutralDamaged } from './movement';
import { createRng } from './rng';
import type { Rng } from './rng';
import type { DisasterState, MatchState } from './types';

/** Local pure hash; never touches the gameplay PRNG. */
function seedHash(seed: number): number {
  const safeSeed = isFinite(seed) ? (Math.floor(seed) >>> 0) : 0;
  const text = String(safeSeed);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Independent disaster streams, like seeded map selection: scheduling and
 * damage draw from their own seed-derived PRNGs, so the main match RNG stream
 * (AI decisions) is exactly the same as before the disaster feature.
 */
export function disasterScheduleRng(seed: number): Rng {
  return createRng((seedHash(seed) ^ DISASTER_SCHEDULE_SEED_SALT) >>> 0);
}

export function disasterDamageRng(seed: number): Rng {
  return createRng((seedHash(seed) ^ DISASTER_DAMAGE_SEED_SALT) >>> 0);
}

export function noDisaster(): DisasterState {
  return { scheduledAtTick: null, struck: false, warned: false };
}

/**
 * One deterministic scheduling draw: 35% of matches get a disaster, placed at
 * round(durationTicks * (0.25 + r * 0.35)) with r uniform in [0, 1).
 */
export function planDisasterSchedule(rng: Rng, durationTicks: number): DisasterState {
  if (!rng.chance(DISASTER_CHANCE)) return noDisaster();
  const span = DISASTER_WINDOW_END_RATIO - DISASTER_WINDOW_START_RATIO;
  const ratio = DISASTER_WINDOW_START_RATIO + rng.next() * span;
  return {
    scheduledAtTick: Math.round(durationTicks * ratio),
    struck: false,
    warned: false,
  };
}

export function createDisasterState(seed: number, durationTicks: number): DisasterState {
  return planDisasterSchedule(disasterScheduleRng(seed), durationTicks);
}

/**
 * Applies the disaster to every territory with more than one troop. Each cell
 * draws its own r in [0.10, 0.20): loss = floor(troops * r), garrison never
 * drops below 1. Shield and production remainder are untouched; a damaged
 * neutral territory records the usual quiet-recovery timestamp.
 *
 * Returns the total troops actually lost (for tests/telemetry only).
 */
export function applyDisasterStrike(state: MatchState, rng: Rng): number {
  const span = DISASTER_MAX_LOSS_RATIO - DISASTER_MIN_LOSS_RATIO;
  let totalLoss = 0;
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    if (territory.troops <= 1) continue;
    const ratio = DISASTER_MIN_LOSS_RATIO + rng.next() * span;
    const loss = Math.floor(territory.troops * ratio);
    if (territory.owner === 'neutral') markNeutralDamaged(territory, state.tick);
    if (loss <= 0) continue;
    const before = territory.troops;
    territory.troops = Math.max(1, before - loss);
    totalLoss += before - territory.troops;
  }
  state.disaster.struck = true;
  state.disaster.warned = true;
  return totalLoss;
}

/**
 * Per-tick disaster hook. Marks `warned` DISASTER_WARN_TICKS ahead and strikes
 * once the scheduled tick arrives. Must run after tick++ and before AI.
 * Returns the troops lost on the strike tick (0 on every other tick).
 */
export function resolveDisasterTick(state: MatchState, rng?: Rng): number {
  const disaster = state.disaster;
  if (disaster.scheduledAtTick === null || disaster.struck) return 0;
  if (state.tick >= disaster.scheduledAtTick - DISASTER_WARN_TICKS) {
    disaster.warned = true;
  }
  if (state.tick < disaster.scheduledAtTick) return 0;
  return applyDisasterStrike(state, rng || disasterDamageRng(state.seed));
}
