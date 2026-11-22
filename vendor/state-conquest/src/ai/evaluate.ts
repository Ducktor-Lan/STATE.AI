import { computeDispatch } from '../core/dispatch';
import { requiredAttackCost, resolveBattle, terrainDefensePct } from '../core/combat';
import { FIXED_DT_SECONDS } from '../config/balance';
import { productionRate, effectiveProductionRate } from '../core/production';
import { isEdgePassable, layoutBoundaries, planMoveRoute } from '../core/reachability';
import { isHostile as diplomacyIsHostile, isHostileAt } from '../core/diplomacy';
import type { OwnerReachability } from '../core/reachability';
import type { MatchState, OwnerId, PlayerId, Territory } from '../core/types';

export function isEnemyOf(
  owner: PlayerId,
  other: string,
  state?: MatchState
): boolean {
  if (state) return diplomacyIsHostile(state, owner, other);
  return other !== owner && other !== 'neutral';
}

export function isFrontier(state: MatchState, territoryId: string): boolean {
  const territory = state.territories[territoryId];
  if (!territory) return false;
  const boundaries = layoutBoundaries(state.layout);
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    if (!isEdgePassable(boundaries, edge)) continue;
    let neighborId = '';
    if (edge.from === territoryId) neighborId = edge.to;
    else if (edge.to === territoryId) neighborId = edge.from;
    else continue;
    const neighbor = state.territories[neighborId];
    if (
      neighbor.owner !== territory.owner &&
      (neighbor.owner === 'neutral' || isEnemyOf(territory.owner as PlayerId, neighbor.owner, state))
    ) {
      return true;
    }
  }
  return false;
}

export function isInterior(state: MatchState, owner: PlayerId, territoryId: string): boolean {
  const territory = state.territories[territoryId];
  if (!territory || territory.owner !== owner) return false;
  const boundaries = layoutBoundaries(state.layout);
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    if (!isEdgePassable(boundaries, edge)) continue;
    let neighborId = '';
    if (edge.from === territoryId) neighborId = edge.to;
    else if (edge.to === territoryId) neighborId = edge.from;
    else continue;
    const neighbor = state.territories[neighborId];
    if (
      neighbor.owner !== owner &&
      (neighbor.owner === 'neutral' || isEnemyOf(owner, neighbor.owner, state))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Heuristic pressure from adjacent enemy garrisons plus enemy armies already
 * heading for this territory. Neutral troops never attack, and a declared
 * blocked arc can never carry pressure — the same crossability rule the route
 * planner applies.
 */
export function enemyPressure(state: MatchState, owner: PlayerId, territoryId: string): number {
  let pressure = 0;
  const boundaries = layoutBoundaries(state.layout);
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    if (!isEdgePassable(boundaries, edge)) continue;
    let neighborId = '';
    if (edge.from === territoryId) neighborId = edge.to;
    else if (edge.to === territoryId) neighborId = edge.from;
    else continue;
    const neighbor = state.territories[neighborId];
    if (!isEnemyOf(owner, neighbor.owner, state)) continue;
    pressure += computeDispatch(neighbor.troops, 1).available;
  }
  for (let i = 0; i < state.armies.length; i += 1) {
    const army = state.armies[i];
    const relationTick = Math.max(state.tick, army.arrivalTick);
    if (
      army.targetId === territoryId &&
      isHostileAt(state.diplomacy, relationTick, owner, army.owner)
    ) {
      pressure += army.troops;
    }
  }
  return pressure;
}

export function effectiveDefense(territory: Territory): number {
  return Math.floor(
    ((territory.troops + territory.shield) * (100 + terrainDefensePct(territory.terrain))) / 100
  );
}

/**
 * Defender strength when an army lands: garrisons keep producing for the whole
 * flight, capped by capacity. Neutral territories never grow. When `state` is
 * supplied, the owner's effective rate is used, so a casual AI handicap is
 * reflected in the planner's own arrival forecast.
 */
export function predictedDefender(
  target: Territory,
  travelTicks: number,
  state?: MatchState
): number {
  if (target.owner === 'neutral') return target.troops;
  const rate = state
    ? effectiveProductionRate(target.productionLevel, state, target.owner)
    : productionRate(target.productionLevel);
  const grown = target.troops + (rate * Math.max(0, travelTicks)) / 10;
  return Math.min(target.capacity, Math.floor(grown));
}

export interface TargetArrivalProjection {
  /** Territory owner after all existing waves before the hypothetical order. */
  ownerAtArrival: OwnerId;
  /** Garrison immediately before the hypothetical order lands. */
  troopsAtArrival: number;
  /** Shield immediately before the hypothetical order lands. */
  shieldAtArrival: number;
  /** Capacity still available to an own reinforcement at that instant. */
  spaceAtArrival: number;
  /** A hostile existing wave lands before the hypothetical order. */
  enemyBefore: boolean;
  /** Earliest hostile existing wave that lands before the order. */
  enemyArrivalTick: number;
}

interface TargetProjectionState {
  owner: OwnerId;
  troops: number;
  shield: number;
  productionLevel: 1 | 2 | 3;
  productionRemainder: number;
}

interface TargetProjectionEvent {
  armyId: number;
  owner: PlayerId;
  troops: number;
  arrivalTick: number;
}

function projectionIsHostile(
  state: MatchState,
  owner: OwnerId,
  other: PlayerId,
  tick: number
): boolean {
  if (owner === 'neutral') return true;
  return isHostileAt(state.diplomacy, tick, owner as PlayerId, other);
}

function produceProjectionTick(
  state: MatchState,
  target: Territory,
  projected: TargetProjectionState
): void {
  if (projected.owner === 'neutral') return;
  if (projected.troops >= target.capacity) {
    projected.productionRemainder = 0;
    return;
  }
  const rate = effectiveProductionRate(projected.productionLevel, state, projected.owner);
  const gain = rate * FIXED_DT_SECONDS + projected.productionRemainder;
  const whole = Math.max(0, Math.floor(gain));
  projected.troops = Math.min(target.capacity, projected.troops + whole);
  projected.productionRemainder =
    projected.troops >= target.capacity ? 0 : Math.max(0, gain - whole);
}

function applyProjectionEvent(
  state: MatchState,
  target: Territory,
  projected: TargetProjectionState,
  event: TargetProjectionEvent,
  eventTick: number,
  originalOwner: PlayerId
): boolean {
  if (projected.owner === event.owner) {
    projected.troops = Math.min(target.capacity, projected.troops + event.troops);
    if (projected.troops >= target.capacity) projected.productionRemainder = 0;
    return false;
  }
  if (!projectionIsHostile(state, projected.owner, event.owner, eventTick)) return false;

  const enemyBefore = projected.owner === originalOwner;
  const battle = resolveBattle(
    projected.troops + projected.shield,
    target.terrain,
    event.troops,
    projected.shield
  );
  if (battle.captured) {
    projected.owner = event.owner;
    projected.troops = Math.min(target.capacity, battle.survivors);
    projected.shield = 0;
    projected.productionLevel = 1;
    projected.productionRemainder = 0;
  } else {
    projected.troops = battle.defenderRemaining;
    projected.shield = battle.shieldRemaining === undefined ? 0 : battle.shieldRemaining;
  }
  return enemyBefore;
}

/**
 * Projects the target immediately before a hypothetical army with
 * `candidateArmyId` lands. It mirrors the engine's order: due armies first,
 * then production; same-tick armies are ordered by army id. The hypothetical
 * army is deliberately excluded, so callers can cap its dispatch by the real
 * space left after all existing traffic and production.
 */
export function projectTargetArrival(
  state: MatchState,
  owner: PlayerId,
  targetId: string,
  arrivalTick: number,
  candidateArmyId: number = state.nextArmyId
): TargetArrivalProjection | null {
  const target = state.territories[targetId];
  if (!target) return null;
  const horizon = Math.max(state.tick, Math.floor(arrivalTick));
  const events: TargetProjectionEvent[] = [];
  for (let i = 0; i < state.armies.length; i += 1) {
    const army = state.armies[i];
    if (army.targetId !== targetId) continue;
    if (army.arrivalTick > horizon) continue;
    if (army.arrivalTick === horizon && army.id >= candidateArmyId) continue;
    events.push({
      armyId: army.id,
      owner: army.owner,
      troops: army.troops,
      arrivalTick: army.arrivalTick,
    });
  }
  events.sort(function (a, b) {
    if (a.arrivalTick !== b.arrivalTick) return a.arrivalTick - b.arrivalTick;
    return a.armyId - b.armyId;
  });

  const projected: TargetProjectionState = {
    owner: target.owner,
    troops: Math.max(0, Math.floor(target.troops)),
    shield: Math.max(0, Math.floor(target.shield)),
    productionLevel: target.productionLevel,
    productionRemainder:
      isFinite(target.productionRemainder) && target.productionRemainder > 0
        ? target.productionRemainder
        : 0,
  };
  let eventIndex = 0;
  let enemyBefore = false;
  let enemyArrivalTick = Infinity;

  for (let tick = state.tick; tick <= horizon; tick += 1) {
    while (eventIndex < events.length) {
      const event = events[eventIndex];
      const dueTick = event.arrivalTick <= state.tick ? state.tick : event.arrivalTick;
      if (dueTick !== tick) break;
      const hostile = applyProjectionEvent(
        state,
        target,
        projected,
        event,
        tick,
        owner
      );
      if (hostile) {
        enemyBefore = true;
        if (event.arrivalTick < enemyArrivalTick) enemyArrivalTick = event.arrivalTick;
      }
      eventIndex += 1;
    }
    // A candidate arriving at `horizon` lands before that tick's production.
    if (tick < horizon) produceProjectionTick(state, target, projected);
  }

  return {
    ownerAtArrival: projected.owner,
    troopsAtArrival: projected.troops,
    shieldAtArrival: projected.shield,
    spaceAtArrival:
      projected.owner === owner
        ? Math.max(0, target.capacity - projected.troops)
        : 0,
    enemyBefore: enemyBefore,
    enemyArrivalTick: enemyArrivalTick,
  };
}

export function requiredForArrival(
  state: MatchState,
  targetId: string,
  extraTicks: number = 0
): number {
  const target = state.territories[targetId];
  const travel = extraTicks;
  const defenders = predictedDefender(target, travel, state) + target.shield;
  return requiredAttackCost(defenders, target.terrain);
}

/**
 * Real travel ticks through the unified route planner. Pass a per-pass
 * `OwnerReachability` to reuse its cached BFS/route work across candidates.
 */
export function travelTicks(
  state: MatchState,
  sourceId: string,
  targetId: string,
  reach?: OwnerReachability
): number {
  const source = state.territories[sourceId];
  if (!source) return 999;
  const movement = reach
    ? reach.plan(sourceId, targetId)
    : planMoveRoute(state, source.owner as PlayerId, sourceId, targetId);
  return movement ? movement.travelTicks : 999;
}

export function minRatioToExceed(
  available: number,
  required: number,
  ratios: number[]
): number | null {
  for (let i = 0; i < ratios.length; i += 1) {
    const ratio = ratios[i];
    if (Math.floor(available * ratio) > required) return ratio;
  }
  return null;
}

export function maxRatioToExceed(
  available: number,
  required: number,
  ratios: number[]
): number | null {
  let best: number | null = null;
  for (let i = 0; i < ratios.length; i += 1) {
    const ratio = ratios[i];
    if (Math.floor(available * ratio) > required) best = ratio;
  }
  return best;
}

export function ownerTerritories(state: MatchState, owner: PlayerId): Territory[] {
  const out: Territory[] = [];
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    if (territory.owner === owner) out.push(territory);
  }
  return out;
}

export function remainingSeconds(state: MatchState): number {
  return Math.max(0, state.durationTicks - state.tick) / 10;
}

export function isHome(state: MatchState, owner: PlayerId, territoryId: string): boolean {
  const list = state.spawnTerritories[owner];
  return !!list && list.indexOf(territoryId) >= 0;
}
