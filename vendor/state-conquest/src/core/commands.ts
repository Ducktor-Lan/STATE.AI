import {
  DEFENSE_COSTS,
  MARCH_COSTS,
  SHIELD_CAPACITY,
  UPGRADE_COSTS,
} from '../config/balance';
import { computeDispatch } from './dispatch';
import { pushEvent } from './events';
import { createArmy } from './movement';
import { planMoveRoute } from './reachability';
import { isHostile } from './diplomacy';
import type {
  CommandResult,
  DispatchPlan,
  MatchState,
  MoveReason,
  PlannedMovement,
  PlayerId,
  UpgradeKind,
} from './types';

export interface MovePlanResult {
  ok: boolean;
  reason?: MoveReason;
  dispatch: DispatchPlan;
  /** Frozen movement plan; present whenever the frontier rule is satisfied. */
  movement?: PlannedMovement;
}

function isValidRatio(ratio: unknown): ratio is number {
  return typeof ratio === 'number' && isFinite(ratio) && ratio >= 0 && ratio <= 1;
}

/**
 * Single validator for humans and AI. It is pure: no resources are spent here.
 */
export function computeMovePlan(
  state: MatchState,
  owner: PlayerId,
  sourceId: string,
  targetId: string,
  ratio: number
): MovePlanResult {
  const source = state.territories[sourceId];
  const target = state.territories[targetId];
  const dispatch = computeDispatch(
    source ? source.troops : 0,
    typeof ratio === 'number' && isFinite(ratio) ? ratio : 0
  );

  if (state.status !== 'playing' || state.tick >= state.durationTicks) {
    return { ok: false, reason: 'not_playing', dispatch: dispatch };
  }
  // Runtime guards: TypeScript types are not trusted at the command boundary.
  if (state.activeOwners.indexOf(owner) < 0 || owner === ('neutral' as PlayerId)) {
    return { ok: false, reason: 'invalid', dispatch: dispatch };
  }
  if (!isValidRatio(ratio)) {
    return { ok: false, reason: 'invalid', dispatch: dispatch };
  }
  if (!source || !target) {
    return { ok: false, reason: 'invalid', dispatch: dispatch };
  }
  if (sourceId === targetId) {
    return { ok: false, reason: 'self', dispatch: dispatch };
  }
  if (source.owner !== owner) {
    return { ok: false, reason: 'not_own', dispatch: dispatch };
  }
  if (
    target.owner !== owner &&
    target.owner !== 'neutral' &&
    !isHostile(state, owner, target.owner)
  ) {
    return { ok: false, reason: 'truce', dispatch: dispatch };
  }
  // The target must touch an owned frontier, and the source must reach that
  // frontier through real same-owner edges. The route planner freezes the exact
  // connected path used by the army; there is no cross-map straight-line jump.
  const movement = planMoveRoute(state, owner, sourceId, targetId);
  if (!movement) {
    return { ok: false, reason: 'not_adjacent', dispatch: dispatch };
  }
  if (dispatch.sent <= 0) {
    return { ok: false, reason: 'no_troops', dispatch: dispatch, movement: movement };
  }
  return { ok: true, dispatch: dispatch, movement: movement };
}

/** Validates, then atomically deducts troops and creates the army. */
export function applyMove(
  state: MatchState,
  owner: PlayerId,
  sourceId: string,
  targetId: string,
  ratio: number
): CommandResult {
  const plan = computeMovePlan(state, owner, sourceId, targetId, ratio);
  if (!plan.ok || !plan.movement) {
    return { ok: false, reason: plan.reason || 'invalid', sent: 0 };
  }
  const source = state.territories[sourceId];
  if (!source) {
    return { ok: false, reason: 'invalid', sent: 0 };
  }

  const sent = plan.dispatch.sent;
  source.troops -= sent;
  const army = createArmy(state, owner, sourceId, targetId, sent, plan.movement);
  state.armies.push(army);

  if (owner === 'player') {
    state.stats.ordersByPlayer += 1;
    state.stats.troopsSentByPlayer += sent;
  }
  return { ok: true, sent: sent };
}

export interface UpgradePlanResult {
  ok: boolean;
  reason?: MoveReason;
  cost: number;
  kind: UpgradeKind;
  currentLevel: number;
  nextLevel: number;
}

const UPGRADE_KINDS: UpgradeKind[] = ['production', 'march', 'defense'];

export function isUpgradeKind(value: unknown): value is UpgradeKind {
  return typeof value === 'string' && UPGRADE_KINDS.indexOf(value as UpgradeKind) >= 0;
}

interface UpgradeTrack {
  currentLevel: number;
  nextLevel: number;
  cost: number;
  maxed: boolean;
}

function upgradeTrack(territory: MatchState['territories'][string], kind: UpgradeKind): UpgradeTrack {
  if (kind === 'march') {
    const level = territory.marchLevel;
    return {
      currentLevel: level,
      nextLevel: level >= 3 ? level : level + 1,
      cost: level >= 3 ? 0 : MARCH_COSTS[level as 1 | 2],
      maxed: level >= 3,
    };
  }
  if (kind === 'defense') {
    const level = territory.defenseLevel;
    if (level >= 2) {
      return { currentLevel: level, nextLevel: level, cost: 0, maxed: true };
    }
    return {
      currentLevel: level,
      nextLevel: level + 1,
      cost: DEFENSE_COSTS[level as 0 | 1],
      maxed: false,
    };
  }
  const level = territory.productionLevel;
  return {
    currentLevel: level,
    nextLevel: level >= 3 ? level : level + 1,
    cost: level >= 3 ? 0 : UPGRADE_COSTS[level as 1 | 2],
    maxed: level >= 3,
  };
}

/**
 * Shared validator for all three upgrade tracks. It is pure and atomic: no
 * troops or levels change here. Human commands and AI candidates use it.
 */
export function computeUpgradePlan(
  state: MatchState,
  owner: PlayerId,
  territoryId: string,
  kind: UpgradeKind = 'production'
): UpgradePlanResult {
  const territory = state.territories[territoryId];
  const safeKind: UpgradeKind = isUpgradeKind(kind) ? kind : 'production';
  const fallback: UpgradePlanResult = {
    ok: false,
    reason: 'invalid',
    cost: 0,
    kind: safeKind,
    currentLevel: territory ? territory.productionLevel : 0,
    nextLevel: territory ? territory.productionLevel : 0,
  };
  if (state.status !== 'playing' || state.tick >= state.durationTicks) {
    return { ...fallback, reason: 'not_playing', currentLevel: 0, nextLevel: 0 };
  }
  if (state.activeOwners.indexOf(owner) < 0 || owner === ('neutral' as PlayerId)) {
    return { ...fallback, currentLevel: 0, nextLevel: 0 };
  }
  if (!territory) return { ...fallback, currentLevel: 0, nextLevel: 0 };
  if (territory.owner !== owner) {
    return {
      ok: false,
      reason: 'not_own',
      cost: 0,
      kind: safeKind,
      currentLevel: upgradeTrack(territory, safeKind).currentLevel,
      nextLevel: upgradeTrack(territory, safeKind).nextLevel,
    };
  }
  const track = upgradeTrack(territory, safeKind);
  if (track.maxed) {
    return {
      ok: false,
      reason: 'invalid',
      cost: 0,
      kind: safeKind,
      currentLevel: track.currentLevel,
      nextLevel: track.nextLevel,
    };
  }
  if (territory.troops <= track.cost) {
    return {
      ok: false,
      reason: 'no_troops',
      cost: track.cost,
      kind: safeKind,
      currentLevel: track.currentLevel,
      nextLevel: track.nextLevel,
    };
  }
  return {
    ok: true,
    cost: track.cost,
    kind: safeKind,
    currentLevel: track.currentLevel,
    nextLevel: track.nextLevel,
  };
}

/** Upgrade is immediate; it always leaves at least one defender. */
export function applyUpgrade(
  state: MatchState,
  owner: PlayerId,
  territoryId: string,
  kind: UpgradeKind = 'production'
): CommandResult {
  const plan = computeUpgradePlan(state, owner, territoryId, kind);
  if (!plan.ok) return { ok: false, reason: plan.reason, sent: 0 };

  const territory = state.territories[territoryId];
  territory.troops -= plan.cost;
  if (plan.kind === 'march') {
    territory.marchLevel = plan.nextLevel as 1 | 2 | 3;
  } else if (plan.kind === 'defense') {
    const previousCapacity = territory.shieldCapacity;
    const nextCapacity = SHIELD_CAPACITY[plan.nextLevel as 0 | 1 | 2];
    // The new capacity comes with its own shield troops; existing damage stays
    // damaged, so this is not a free repair of the current shield.
    const gain = Math.max(0, nextCapacity - previousCapacity);
    territory.defenseLevel = plan.nextLevel as 0 | 1 | 2;
    territory.shieldCapacity = nextCapacity;
    territory.shield = Math.min(nextCapacity, territory.shield + gain);
  } else {
    territory.productionLevel = plan.nextLevel as 1 | 2 | 3;
  }
  if (owner === 'player') state.stats.upgradesByPlayer += 1;
  pushEvent(state.events, {
    type: 'upgrade',
    tick: state.tick,
    targetId: territory.id,
    amount: plan.cost,
    owner: owner,
    level: plan.nextLevel as 1 | 2 | 3,
    kind: plan.kind,
  });
  return { ok: true, sent: 0 };
}
