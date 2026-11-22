import {
  BRIDGE_TRAVEL_FACTOR,
  FIXED_DT_SECONDS,
  MARCH_SPEED_MULTIPLIER,
  MAX_TRAVEL_SECONDS,
  MIN_TRAVEL_SECONDS,
  TRAVEL_BASE_SECONDS,
} from '../config/balance';
import { resolveBattle } from './combat';
import { cancelFrontsForSource, resolveFrontWave } from './fronts';
import { pushEvent } from './events';
import { markProgress } from './stalemate';
import { isHostile } from './diplomacy';
import type {
  Army,
  Edge,
  MatchState,
  OwnerId,
  PlayerId,
  MarchLevel,
  PlannedMovement,
} from './types';

export function marchSpeedMultiplier(level: MarchLevel | undefined): number {
  if (level === 2) return MARCH_SPEED_MULTIPLIER[2];
  if (level === 3) return MARCH_SPEED_MULTIPLIER[3];
  return MARCH_SPEED_MULTIPLIER[1];
}

/**
 * Travel time uses the source's march level at dispatch time. Callers freeze
 * the returned ticks into arrivalTick; later upgrades or ownership changes do
 * not alter an army already in flight.
 */
export function travelTicksForEdge(edge: Edge, marchLevel: MarchLevel = 1): number {
  const bridgeFactor = edge.kind === 'bridge' ? BRIDGE_TRAVEL_FACTOR : 1;
  const factor = isFinite(edge.travelFactor) && edge.travelFactor > 0 ? edge.travelFactor : 1;
  const raw = TRAVEL_BASE_SECONDS * factor * bridgeFactor;
  const clamped = Math.max(MIN_TRAVEL_SECONDS, Math.min(MAX_TRAVEL_SECONDS, raw));
  const baseTicks = Math.max(1, Math.ceil(clamped / FIXED_DT_SECONDS));
  const speed = marchSpeedMultiplier(marchLevel);
  return Math.max(1, Math.ceil(baseTicks / speed));
}

/**
 * One really-traversed segment of a multi-edge route. `distance` is the actual
 * polyline swept for that edge (crossing bends included); `straight` is the
 * straight anchor-to-anchor distance of that same edge. Their ratio corrects a
 * short/long diagonal segment while `travelFactor`/`bridgeFactor` stay attached
 * only to the edge actually walked.
 */
export interface RouteTravelSegment {
  distance: number;
  straight: number;
  travelFactor: number;
  bridgeFactor: number;
}

/**
 * Travel ticks for a frozen multi-edge route. Each real segment is normalized
 * by its own anchor span and summed, so arrival time grows with the actual
 * total route length and with the number of hops instead of being divided away
 * by the total source->target straight distance. The legacy MIN/MAX clamp is
 * applied once to the sum, then the 0.1 s step and source march multiplier are
 * reused unchanged.
 *
 * Direct single-edge movement continues to use travelTicksForEdge unchanged.
 */
export function travelTicksForRouteSegments(
  segments: readonly RouteTravelSegment[],
  marchLevel: MarchLevel = 1
): number {
  let raw = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!isFinite(segment.distance) || segment.distance <= 0) continue;
    const straight =
      isFinite(segment.straight) && segment.straight > 1e-6 ? segment.straight : 1e-6;
    const travel =
      isFinite(segment.travelFactor) && segment.travelFactor > 0
        ? segment.travelFactor
        : 1;
    const bridge =
      isFinite(segment.bridgeFactor) && segment.bridgeFactor > 0
        ? segment.bridgeFactor
        : 1;
    raw += TRAVEL_BASE_SECONDS * (segment.distance / straight) * travel * bridge;
  }
  if (!(raw > 0)) raw = TRAVEL_BASE_SECONDS;
  const clamped = Math.max(MIN_TRAVEL_SECONDS, Math.min(MAX_TRAVEL_SECONDS, raw));
  const baseTicks = Math.max(1, Math.ceil(clamped / FIXED_DT_SECONDS));
  const speed = marchSpeedMultiplier(marchLevel);
  return Math.max(1, Math.ceil(baseTicks / speed));
}

export function createArmy(
  state: MatchState,
  owner: PlayerId,
  sourceId: string,
  targetId: string,
  troops: number,
  movement: PlannedMovement
): Army {
  const routePoints = movement.routePoints.map(function (point) {
    return [point[0], point[1]] as [number, number];
  });
  const army: Army = {
    id: state.nextArmyId,
    owner: owner,
    sourceId: sourceId,
    targetId: targetId,
    troops: troops,
    startTick: state.tick,
    arrivalTick: state.tick + movement.travelTicks,
    routePoints: routePoints,
  };
  state.nextArmyId += 1;
  return army;
}

/** Shared ownership-transfer reset (army capture and betrayal share it). */
export function resetCapturedTerritory(
  target: MatchState['territories'][string],
  owner: OwnerId,
  troops: number
): void {
  target.owner = owner;
  target.troops = troops;
  target.productionLevel = 1;
  target.productionRemainder = 0;
  target.marchLevel = 1;
  target.defenseLevel = 0;
  target.shield = 0;
  target.shieldCapacity = 0;
  target.cannonReadyTick = 0;
  target.neutralRecoveryTarget = 0;
  target.neutralRecoveryRemainder = 0;
  target.lastDamagedTick = -1;
}

/** Shared neutral damage bookkeeping (failed attacks and disasters). */
export function markNeutralDamaged(target: MatchState['territories'][string], tick: number): void {
  if (target.owner !== 'neutral') return;
  target.lastDamagedTick = tick;
  target.neutralRecoveryTarget = target.initialTroops;
  target.neutralRecoveryRemainder = 0;
}

/**
 * At an allied landing, refund the surviving paid troops once: source if still
 * owned, otherwise the first home in territoryOrder. Overflow is discarded;
 * an owner with no territory loses the wave. No new army or route is created.
 */
function returnArmyToOwner(state: MatchState, army: Army): void {
  let destination: MatchState['territories'][string] | null = null;
  const source = state.territories[army.sourceId];
  if (source && source.owner === army.owner) destination = source;
  if (!destination) {
    for (let i = 0; i < state.territoryOrder.length; i += 1) {
      const candidate = state.territories[state.territoryOrder[i]];
      if (candidate.owner === army.owner) {
        destination = candidate;
        break;
      }
    }
  }
  if (!destination) return;
  const before = destination.troops;
  destination.troops = Math.min(destination.capacity, destination.troops + army.troops);
  if (destination.troops >= destination.capacity) destination.productionRemainder = 0;
  const overflow = before + army.troops - destination.troops;
  if (overflow > 0) {
    pushEvent(state.events, {
      type: 'overflow',
      tick: state.tick,
      targetId: destination.id,
      amount: overflow,
      owner: army.owner,
    });
  }
}

function resolveOneArmy(state: MatchState, army: Army): void {
  const target = state.territories[army.targetId];
  if (!target) return;

  // Continuous-line waves keep the sustained-siege rule (no last-stand floor)
  // while their line still targets this territory; a wave whose line was
  // stopped or re-targeted still lands (it was paid for) but records nothing,
  // and a wave whose target became friendly falls through to reinforcement.
  if (army.frontId !== undefined) {
    if (resolveFrontWave(state, army)) return;
  }

  if (
    target.owner !== army.owner &&
    target.owner !== 'neutral' &&
    !isHostile(state, army.owner, target.owner)
  ) {
    // A truce may be created while a wave is already in flight. The route stays
    // frozen, but the landing cannot damage an ally; return the paid troops to
    // the source when possible, otherwise to the first surviving home.
    returnArmyToOwner(state, army);
    return;
  }

  if (target.owner === army.owner) {
    // Reinforcement. Overflow is discarded by the capacity rule; a full
    // garrison must not keep progress toward a troop the cap forbids.
    const before = target.troops;
    target.troops = Math.min(target.capacity, target.troops + army.troops);
    if (target.troops >= target.capacity) target.productionRemainder = 0;
    const lost = before + army.troops - target.troops;
    if (lost > 0) {
      pushEvent(state.events, {
        type: 'overflow',
        tick: state.tick,
        targetId: target.id,
        amount: lost,
        owner: army.owner,
      });
    }
    return;
  }

  const battle = resolveBattle(
    target.troops + target.shield,
    target.terrain,
    army.troops,
    target.shield
  );
  if (battle.captured) {
    // Read the real pre-transfer state before the shared reset wipes it; the
    // capture event feeds renderers that collapse the defences that really fell.
    const previousDefenseLevel = target.defenseLevel;
    const previousOwner = target.owner;
    const garrison = Math.min(target.capacity, battle.survivors);
    resetCapturedTerritory(target, army.owner as OwnerId, garrison);
    // The territory really changed hands: lines starting here are cancelled at
    // that exact moment (a recapture in the same tick must not revive them).
    // Lines whose TARGET is this territory are untouched — they may keep
    // feeding it as reinforcements.
    cancelFrontsForSource(state, target.id);
    markProgress(state);
    if (army.owner === 'player') state.stats.capturesByPlayer += 1;
    pushEvent(state.events, {
      type: 'capture',
      tick: state.tick,
      targetId: target.id,
      amount: target.troops,
      owner: army.owner,
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
        owner: army.owner,
      });
    }
  } else {
    const beforeShield = target.shield;
    const beforeTroops = target.troops;
    target.troops = battle.defenderRemaining;
    target.shield = battle.shieldRemaining === undefined ? 0 : battle.shieldRemaining;
    markNeutralDamaged(target, state.tick);
    // Real defence feedback for ordinary single-shot attacks too: the UI gets
    // the same shape the continuous siege emits, with losses derived from the
    // actual before/after values (never from the raw formula). A neutral target
    // legitimately has no owner.
    const shieldLoss = Math.max(0, beforeShield - target.shield);
    const troopLoss = Math.max(0, beforeTroops - target.troops);
    const totalLoss = shieldLoss + troopLoss;
    if (totalLoss > 0) {
      markProgress(state);
      pushEvent(state.events, {
        type: 'defend',
        tick: state.tick,
        targetId: target.id,
        amount: totalLoss,
        owner: target.owner === 'neutral' ? undefined : (target.owner as PlayerId),
        targetArmyId: army.id,
        shieldLoss: shieldLoss,
        troopLoss: troopLoss,
      });
    }
  }
}

/**
 * Resolves every army whose arrivalTick is due. Order is arrivalTick ASC then
 * armyId ASC, independent of array insertion or rendering order.
 */
export function resolveArrivals(state: MatchState): void {
  const due: Army[] = [];
  const remaining: Army[] = [];
  for (let i = 0; i < state.armies.length; i += 1) {
    const army = state.armies[i];
    if (army.arrivalTick <= state.tick) due.push(army);
    else remaining.push(army);
  }
  due.sort(function (a, b) {
    if (a.arrivalTick !== b.arrivalTick) return a.arrivalTick - b.arrivalTick;
    return a.id - b.id;
  });
  for (let i = 0; i < due.length; i += 1) {
    resolveOneArmy(state, due[i]);
  }
  state.armies = remaining;
}
