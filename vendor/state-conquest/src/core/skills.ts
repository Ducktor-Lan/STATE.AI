import {
  BETRAYAL_COOLDOWN_TICKS,
  BETRAYAL_SOLDIERS_PER_LEVEL,
  BETRAYAL_TARGET_POOL_FACTOR,
} from '../config/balance';
import { resolveBattle } from './combat';
import { pushEvent } from './events';
import { cancelFrontsForSource } from './fronts';
import { isHostile } from './diplomacy';
import { markProgress } from './stalemate';
import { resetCapturedTerritory } from './movement';
import type { Rng } from './rng';
import type { MatchState, Territory } from './types';

export type BetrayalReason =
  | 'not_playing'
  | 'locked'
  | 'cooldown'
  | 'no_target'
  | 'invalid';

export interface BetrayalPlanResult {
  ok: boolean;
  reason?: BetrayalReason;
  level: number;
  /** Converted soldiers allowed at this level (level * 10). */
  quota: number;
  targetId?: string;
  /** Enemy troops turned into attackers (>= 1). */
  removed: number;
  captured: boolean;
  survivors: number;
  /** Cooldown end recorded when this plan is applied. */
  readyTick: number;
}

export interface BetrayalResult {
  ok: boolean;
  reason?: BetrayalReason;
  targetId?: string;
  removed: number;
  captured: boolean;
  survivors: number;
  uses: number;
  readyTick: number;
}

export function betrayalQuota(level: number): number {
  if (!isFinite(level) || level <= 0) return 0;
  return Math.floor(level) * BETRAYAL_SOLDIERS_PER_LEVEL;
}

/**
 * Betrayal targets every seated enemy faction. "Non-player, non-neutral" and
 * "ai1/ai2/ai3" are the same set (owners are a closed enum and unseated
 * factions can never own a territory), so 2-faction targeting is unchanged.
 */
function isEnemyTerritory(state: MatchState, territory: Territory): boolean {
  return (
    territory.owner !== 'player' &&
    territory.owner !== 'neutral' &&
    isHostile(state, 'player', territory.owner)
  );
}

/**
 * Target rule: random pick among enemy territories whose garrison is at most
 * quota * 1.5. An empty pool falls back to the weakest enemy territory; ties
 * keep the earlier territoryOrder entry. Uses the main match RNG only when a
 * pool exists, so every accepted betrayal advances the player-visible stream.
 */
function pickBetrayalTarget(state: MatchState, quota: number, rng: Rng): Territory | null {
  const poolLimit = quota * BETRAYAL_TARGET_POOL_FACTOR;
  const pool: Territory[] = [];
  let weakest: Territory | null = null;
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    if (!isEnemyTerritory(state, territory)) continue;
    if (territory.troops <= poolLimit) pool.push(territory);
    if (!weakest || territory.troops < weakest.troops) weakest = territory;
  }
  if (pool.length > 0) return rng.pick(pool);
  return weakest;
}

function validateBetrayal(state: MatchState): BetrayalReason | null {
  if (state.status !== 'playing' || state.tick >= state.durationTicks) return 'not_playing';
  if (state.skill.betrayalLevel <= 0) return 'locked';
  if (state.tick < state.skill.readyTick) return 'cooldown';
  return null;
}

/**
 * Planning step: it advances the target-selection RNG but never mutates the
 * match. The returned target/removed values freeze exactly what apply uses.
 */
export function computeBetrayalPlan(state: MatchState, rng: Rng): BetrayalPlanResult {
  const level = state.skill.betrayalLevel;
  const quota = betrayalQuota(level);
  const failure = validateBetrayal(state);
  if (failure !== null) {
    return {
      ok: false,
      reason: failure,
      level: level,
      quota: quota,
      removed: 0,
      captured: false,
      survivors: 0,
      readyTick: state.skill.readyTick,
    };
  }

  const target = pickBetrayalTarget(state, quota, rng);
  if (!target) {
    return {
      ok: false,
      reason: 'no_target',
      level: level,
      quota: quota,
      removed: 0,
      captured: false,
      survivors: 0,
      readyTick: state.skill.readyTick,
    };
  }

  // Never betray the last defender away: at least one soldier is converted,
  // and the defender keeps at least one (except a single-troop cell, which is
  // converted entirely and left at 0).
  const removed = Math.max(1, Math.min(quota, target.troops - 1));
  const remainingGarrison = target.troops - removed;
  const battle = resolveBattle(
    remainingGarrison + target.shield,
    target.terrain,
    removed,
    target.shield
  );
  return {
    ok: true,
    level: level,
    quota: quota,
    targetId: target.id,
    removed: removed,
    captured: battle.captured,
    survivors: battle.survivors,
    readyTick: state.tick + BETRAYAL_COOLDOWN_TICKS,
  };
}

/**
 * Applies one betrayal immediately: the converted troops attack their own
 * territory through the normal battle rule (shield + terrain included). The
 * cooldown is charged on success only; invalid attempts change nothing.
 */
export function applyBetrayal(state: MatchState, rng: Rng): BetrayalResult {
  const plan = computeBetrayalPlan(state, rng);
  if (!plan.ok || !plan.targetId) {
    return {
      ok: false,
      reason: plan.reason || 'invalid',
      removed: 0,
      captured: false,
      survivors: 0,
      uses: state.skill.uses,
      readyTick: state.skill.readyTick,
    };
  }

  const target = state.territories[plan.targetId];
  const battle = resolveBattle(
    target.troops - plan.removed + target.shield,
    target.terrain,
    plan.removed,
    target.shield
  );
  if (battle.captured) {
    // Read the real pre-transfer state before the shared reset wipes it; the
    // capture event feeds renderers that collapse the defences that really fell.
    const previousDefenseLevel = target.defenseLevel;
    const previousOwner = target.owner;
    const garrison = Math.min(target.capacity, battle.survivors);
    resetCapturedTerritory(target, 'player', garrison);
    // Betrayal really transfers ownership: any supply line STARTING on the
    // converted territory dies with its old owner. Waves already in flight are
    // untouched.
    cancelFrontsForSource(state, target.id);
    state.stats.capturesByPlayer += 1;
    pushEvent(state.events, {
      type: 'capture',
      tick: state.tick,
      targetId: target.id,
      amount: target.troops,
      owner: 'player',
      previousDefenseLevel: previousDefenseLevel,
      previousOwner: previousOwner,
    });
    const overflow = battle.survivors - target.troops;
    if (overflow > 0) {
      pushEvent(state.events, {
        type: 'overflow',
        tick: state.tick,
        targetId: target.id,
        amount: overflow,
        owner: 'player',
      });
    }
  } else {
    const beforeDefence = target.troops + target.shield;
    target.troops = battle.defenderRemaining;
    target.shield = battle.shieldRemaining === undefined ? 0 : battle.shieldRemaining;
    const afterDefence = target.troops + target.shield;
    if (afterDefence < beforeDefence) markProgress(state);
  }
  if (battle.captured) markProgress(state);

  state.skill.readyTick = state.tick + BETRAYAL_COOLDOWN_TICKS;
  state.skill.uses += 1;
  return {
    ok: true,
    targetId: target.id,
    removed: plan.removed,
    captured: battle.captured,
    survivors: battle.survivors,
    uses: state.skill.uses,
    readyTick: state.skill.readyTick,
  };
}
