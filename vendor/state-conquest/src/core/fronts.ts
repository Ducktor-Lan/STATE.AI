/**
 * Continuous supply lines ("持续兵线").
 *
 * One drag starts a line; the engine then dispatches ordinary armies from the
 * source to the target on a fixed cadence until the line is stopped, the source
 * is lost, the route disappears or a truce protects the target. A captured
 * target keeps receiving waves as reinforcements.
 *
 * Correctness rules that the rest of the codebase depends on:
 *  - At most one line per (owner, sourceId). A second drag on the same target
 *    stops it; a drag to another target replaces the target in place, so waves
 *    already in flight keep their frozen target/route (and are never re-routed).
 *  - Troop accounting has no side channel: every wave is a real `Army` created
 *    by `createArmy`, and the source pays exactly once.
 *  - The siege battle (`resolveFrontBattle`) uses the ordinary capture gate and
 *    defender floor, and reports real losses. Attrition persists only in the
 *    target's actual defence; no attack power is stored between waves.
 *  - `FrontEngagement` is pure bookkeeping for the HUD and the watchdogs. It
 *    never feeds damage back into a fight. It is keyed by target identity, so a
 *    stale wave (dispatched before the line was re-targeted) can never write
 *    into the new target's record.
 *  - Cancelling a line never changes paid troops: its waves resolve as ordinary
 *    arrivals, including reinforcement or truce refunds, with no line record.
 */
import {
  CONTINUOUS_MAX_WAVES_IN_FLIGHT,
  CONTINUOUS_MIN_BATCH,
  CONTINUOUS_SEND_INTERVAL_TICKS,
} from '../config/balance';
import type {
  Army,
  ContinuousFront,
  ContinuousFrontSnapshot,
  FrontCommandResult,
  FrontEngagement,
  MatchState,
  MoveReason,
  OwnerId,
  PlayerId,
  PlannedMovement,
  Territory,
} from './types';
import { resolveFrontBattle } from './combat';
import { computeDispatch } from './dispatch';
import { pushEvent } from './events';
import { createArmy, markNeutralDamaged, resetCapturedTerritory } from './movement';
import { planMoveRoute } from './reachability';
import { markProgress } from './stalemate';
import { isHostile } from './diplomacy';

/** Shared balance constants are re-exported for core and API callers. */
export {
  CONTINUOUS_MAX_WAVES_IN_FLIGHT,
  CONTINUOUS_MIN_BATCH,
  CONTINUOUS_SEND_INTERVAL_TICKS,
};

function nextFrontIdOf(state: MatchState): number {
  if (typeof state.nextFrontId !== 'number' || !isFinite(state.nextFrontId)) {
    state.nextFrontId = 1;
  }
  return state.nextFrontId;
}

function frontsOf(state: MatchState): ContinuousFront[] {
  if (!state.fronts) state.fronts = [];
  return state.fronts;
}

/** Line owned by `owner` on `sourceId`, if any. */
export function frontForSource(
  state: MatchState,
  owner: PlayerId,
  sourceId: string
): ContinuousFront | null {
  const fronts = state.fronts;
  if (!fronts) return null;
  for (let i = 0; i < fronts.length; i += 1) {
    const front = fronts[i];
    if (front.owner === owner && front.sourceId === sourceId) return front;
  }
  return null;
}

export function frontById(state: MatchState, frontId: number): ContinuousFront | null {
  const fronts = state.fronts;
  if (!fronts) return null;
  for (let i = 0; i < fronts.length; i += 1) {
    if (fronts[i].id === frontId) return fronts[i];
  }
  return null;
}

export function frontsForOwner(state: MatchState, owner: PlayerId): ContinuousFront[] {
  const out: ContinuousFront[] = [];
  const fronts = state.fronts;
  if (!fronts) return out;
  for (let i = 0; i < fronts.length; i += 1) {
    if (fronts[i].owner === owner) out.push(fronts[i]);
  }
  return out;
}

function copyEngagement(source: FrontEngagement): FrontEngagement {
  return {
    targetId: source.targetId,
    targetOwner: source.targetOwner,
    waves: source.waves,
    troopsArrived: source.troopsArrived,
    damageDealt: source.damageDealt,
    shieldDamage: source.shieldDamage,
    troopDamage: source.troopDamage,
    lastDefence: source.lastDefence,
    lastWaveTick: source.lastWaveTick,
    lastProgressTick: source.lastProgressTick,
    failedWaves: source.failedWaves,
  };
}

export function toFrontSnapshots(state: MatchState): ContinuousFrontSnapshot[] {
  const out: ContinuousFrontSnapshot[] = [];
  const fronts = state.fronts;
  if (!fronts) return out;
  for (let i = 0; i < fronts.length; i += 1) {
    const front = fronts[i];
    out.push({
      id: front.id,
      owner: front.owner,
      sourceId: front.sourceId,
      targetId: front.targetId,
      ratio: front.ratio,
      startTick: front.startTick,
      nextSendTick: front.nextSendTick,
      totalSent: front.totalSent,
      waves: front.waves,
      engagement: front.engagement ? copyEngagement(front.engagement) : undefined,
    });
  }
  return out;
}

/** Full deep copy of the line list (clone / forecast isolation). */
export function cloneFronts(fronts: ContinuousFront[] | undefined): ContinuousFront[] {
  const out: ContinuousFront[] = [];
  if (!fronts) return out;
  for (let i = 0; i < fronts.length; i += 1) {
    const front = fronts[i];
    out.push({
      id: front.id,
      owner: front.owner,
      sourceId: front.sourceId,
      targetId: front.targetId,
      ratio: front.ratio,
      startTick: front.startTick,
      nextSendTick: front.nextSendTick,
      totalSent: front.totalSent,
      waves: front.waves,
      engagement: front.engagement ? copyEngagement(front.engagement) : undefined,
    });
  }
  return out;
}

type FrontEventAction = 'start' | 'replace' | 'stop' | 'send' | 'cancel' | 'capture';
type FrontEventReason =
  | 'manual'
  | 'source-lost'
  | 'route-invalid'
  | 'exhausted'
  | 'not-playing'
  | 'truce';

function pushFrontEvent(
  state: MatchState,
  front: ContinuousFront,
  action: FrontEventAction,
  amount: number,
  reason?: FrontEventReason
): void {
  pushEvent(state.events, {
    type: 'front',
    tick: state.tick,
    targetId: front.targetId,
    amount: amount,
    owner: front.owner,
    frontAction: action,
    frontReason: reason,
    frontId: front.id,
  });
}

function dropFront(state: MatchState, front: ContinuousFront): void {
  const fronts = state.fronts;
  if (!fronts) return;
  const index = fronts.indexOf(front);
  if (index >= 0) fronts.splice(index, 1);
}

function cancelFront(
  state: MatchState,
  front: ContinuousFront,
  reason: FrontEventReason,
  action: 'stop' | 'cancel' = 'cancel'
): void {
  dropFront(state, front);
  pushFrontEvent(state, front, action, 0, reason);
}

/* ------------------------------------------------------------------ */
/* Command boundary                                                    */
/* ------------------------------------------------------------------ */

export interface FrontPlanResult {
  ok: boolean;
  reason?: MoveReason;
  dispatch: ReturnType<typeof computeDispatch>;
  movement?: PlannedMovement;
}

/**
 * Validates a start/replace command. Pure: nothing is spent here. Troop
 * availability is deliberately NOT required — a line may start while the source
 * is still saving up and simply waits for its first wave.
 */
export function computeFrontPlan(
  state: MatchState,
  owner: PlayerId,
  sourceId: string,
  targetId: string,
  ratio: number
): FrontPlanResult {
  const source = state.territories[sourceId];
  const dispatch = computeDispatch(
    source ? source.troops : 0,
    typeof ratio === 'number' && isFinite(ratio) ? ratio : 0
  );
  if (state.status !== 'playing' || state.tick >= state.durationTicks) {
    return { ok: false, reason: 'not_playing', dispatch: dispatch };
  }
  if (state.activeOwners.indexOf(owner) < 0) {
    return { ok: false, reason: 'invalid', dispatch: dispatch };
  }
  if (typeof ratio !== 'number' || !isFinite(ratio) || ratio < 0 || ratio > 1) {
    return { ok: false, reason: 'invalid', dispatch: dispatch };
  }
  if (!source || !state.territories[targetId]) {
    return { ok: false, reason: 'invalid', dispatch: dispatch };
  }
  if (sourceId === targetId) {
    return { ok: false, reason: 'self', dispatch: dispatch };
  }
  if (source.owner !== owner) {
    return { ok: false, reason: 'not_own', dispatch: dispatch };
  }
  const target = state.territories[targetId];
  if (
    target &&
    target.owner !== owner &&
    target.owner !== 'neutral' &&
    !isHostile(state, owner, target.owner)
  ) {
    return { ok: false, reason: 'truce', dispatch: dispatch };
  }
  const movement = planMoveRoute(state, owner, sourceId, targetId);
  if (!movement) {
    return { ok: false, reason: 'not_adjacent', dispatch: dispatch };
  }
  return { ok: true, dispatch: dispatch, movement: movement };
}

/**
 * Start or re-target a line.
 *
 *  - Same target as the current line: STOP it (the documented "drag onto the
 *    same target again" gesture).
 *  - Different target: replace in place. The line keeps its id, and waves
 *    already in flight keep their frozen target and route, so nothing already
 *    paid for is lost, re-routed or double counted.
 */
export function startFront(
  state: MatchState,
  owner: PlayerId,
  sourceId: string,
  targetId: string,
  ratio: number
): FrontCommandResult {
  const existing = frontForSource(state, owner, sourceId);
  if (existing && existing.targetId === targetId) {
    dropFront(state, existing);
    pushFrontEvent(state, existing, 'stop', 0, 'manual');
    return { ok: true, action: 'stop', frontId: existing.id };
  }

  const plan = computeFrontPlan(state, owner, sourceId, targetId, ratio);
  if (!plan.ok) {
    return {
      ok: false,
      action: existing ? 'replace' : 'start',
      reason: plan.reason,
    };
  }

  if (existing) {
    existing.targetId = targetId;
    existing.ratio = ratio;
    existing.nextSendTick = state.tick;
    // The old engagement belongs to the old target: dropping it is what stops
    // any stale-wave bookkeeping from leaking into the new siege.
    existing.engagement = undefined;
    pushFrontEvent(state, existing, 'replace', 0);
    return { ok: true, action: 'replace', frontId: existing.id };
  }

  const id = nextFrontIdOf(state);
  state.nextFrontId = id + 1;
  const front: ContinuousFront = {
    id: id,
    owner: owner,
    sourceId: sourceId,
    targetId: targetId,
    ratio: ratio,
    startTick: state.tick,
    nextSendTick: state.tick,
    totalSent: 0,
    waves: 0,
  };
  frontsOf(state).push(front);
  pushFrontEvent(state, front, 'start', 0);
  return { ok: true, action: 'start', frontId: front.id };
}

/** Manual stop. An unknown source returns false without touching anything. */
export function stopFront(state: MatchState, owner: PlayerId, sourceId: string): boolean {
  const front = frontForSource(state, owner, sourceId);
  if (!front) return false;
  dropFront(state, front);
  pushFrontEvent(state, front, 'stop', 0, 'manual');
  return true;
}

/** Removes every line of an owner (used when a faction is eliminated). */
export function clearFrontsForOwner(state: MatchState, owner: PlayerId): void {
  const fronts = state.fronts;
  if (!fronts) return;
  const keep: ContinuousFront[] = [];
  for (let i = 0; i < fronts.length; i += 1) {
    if (fronts[i].owner === owner) {
      pushFrontEvent(state, fronts[i], 'cancel', 0, 'source-lost');
    } else {
      keep.push(fronts[i]);
    }
  }
  state.fronts = keep;
}

/**
 * Cancels every line that STARTS at `sourceId`.
 *
 * Called the moment ownership of that territory really changes (an army
 * capture, a continuous wave capture or a betrayal), not at the end of the
 * tick. That is what makes "source lost => line cancelled" hold even when the
 * territory is captured and recaptured inside the same tick: the old owner's
 * line dies with the first transfer and a recapture cannot revive it. Waves
 * already in flight are untouched.
 */
export function cancelFrontsForSource(
  state: MatchState,
  sourceId: string,
  reason: FrontDoomReason = 'source-lost'
): void {
  const fronts = state.fronts;
  if (!fronts || fronts.length === 0) return;
  const keep: ContinuousFront[] = [];
  for (let i = 0; i < fronts.length; i += 1) {
    const front = fronts[i];
    if (front.sourceId === sourceId) {
      pushFrontEvent(state, front, 'cancel', 0, reason);
    } else {
      keep.push(front);
    }
  }
  state.fronts = keep;
}

/**
 * Teardown after a truce between `a` and `b` ended (deliberate break, natural
 * expiry, elimination or endgame dissolution). Cancels:
 *  - lines targeting the former partner's territory (mutual hostility returns),
 *  - lines owned by either side that NO LONGER have a legal route — this is
 *    what kills lines that borrowed the partner's frontier to reach a third
 *    party or a neutral through the shared network.
 * Waves already in flight are never touched: they keep their frozen route and
 * resolve as ordinary arrivals (including the allied-landing refund).
 */
export function cancelFrontsForEndedTruce(
  state: MatchState,
  a: PlayerId,
  b: PlayerId
): void {
  const fronts = state.fronts;
  if (!fronts || fronts.length === 0) return;
  const doomed: Array<{ front: ContinuousFront; reason: FrontDoomReason }> = [];
  for (let i = 0; i < fronts.length; i += 1) {
    const front = fronts[i];
    if (front.owner !== a && front.owner !== b) continue;
    const target = state.territories[front.targetId];
    const partner = front.owner === a ? b : a;
    if (target && target.owner === partner) {
      doomed.push({ front: front, reason: 'truce' });
      continue;
    }
    // The route was legal under the alliance; without it the shared network
    // collapses back to the owner's own component.
    if (!planMoveRoute(state, front.owner, front.sourceId, front.targetId)) {
      doomed.push({ front: front, reason: 'route-invalid' });
    }
  }
  for (let i = 0; i < doomed.length; i += 1) {
    if (state.fronts && state.fronts.indexOf(doomed[i].front) >= 0) {
      cancelFront(state, doomed[i].front, doomed[i].reason);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Wave resolution                                                     */
/* ------------------------------------------------------------------ */

function newEngagement(front: ContinuousFront, target: Territory): FrontEngagement {
  const defence = target.troops + target.shield;
  return {
    targetId: front.targetId,
    targetOwner: target.owner,
    waves: 0,
    troopsArrived: 0,
    damageDealt: 0,
    shieldDamage: 0,
    troopDamage: 0,
    lastDefence: defence,
    lastWaveTick: front.startTick,
    lastProgressTick: front.startTick,
    failedWaves: 0,
  };
}

/** Reuses the record only when it describes THIS target under THIS owner. */
function engagementFor(
  front: ContinuousFront,
  target: Territory,
  targetId: string
): FrontEngagement {
  const current = front.engagement;
  if (
    current &&
    current.targetId === targetId &&
    current.targetOwner === target.owner
  ) {
    return current;
  }
  const next = newEngagement(front, target);
  next.targetId = targetId;
  return next;
}

/**
 * Applies one wave with the siege rule. Returns the real integer losses so the
 * caller can record them; the defender is mutated exactly once.
 */
function applySiegeWave(
  state: MatchState,
  army: Army,
  target: Territory
): {
  captured: boolean;
  shieldLoss: number;
  troopLoss: number;
  realLoss: number;
  survivors: number;
} {
  const battle = resolveFrontBattle(
    target.troops + target.shield,
    target.terrain,
    army.troops,
    target.shield
  );
  const before = target.troops + target.shield;

  if (battle.captured) {
    // Read the real pre-transfer state before the shared reset wipes it; the
    // capture event feeds renderers that collapse the defences that really fell.
    const previousDefenseLevel = target.defenseLevel;
    const previousOwner = target.owner;
    const garrison = Math.min(target.capacity, battle.survivors);
    resetCapturedTerritory(target, army.owner as OwnerId, garrison);
    // Ownership really changed: any line STARTING here dies now, so a same-tick
    // recapture cannot revive it.
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
    return {
      captured: true,
      shieldLoss: battle.shieldLoss,
      troopLoss: battle.troopLoss,
      realLoss: Math.max(0, before),
      survivors: battle.survivors,
    };
  }

  target.troops = battle.defenderRemaining;
  target.shield = battle.shieldRemaining;
  if (target.owner === 'neutral') markNeutralDamaged(target, state.tick);
  const after = target.troops + target.shield;
  const realLoss = Math.max(0, before - after);
  if (realLoss > 0) markProgress(state);
  pushEvent(state.events, {
    type: 'defend',
    tick: state.tick,
    targetId: target.id,
    amount: realLoss,
    owner: target.owner === 'neutral' ? undefined : (target.owner as PlayerId),
    targetArmyId: army.id,
    shieldLoss: battle.shieldLoss,
    troopLoss: battle.troopLoss,
    siege: true,
  });
  return {
    captured: false,
    shieldLoss: battle.shieldLoss,
    troopLoss: battle.troopLoss,
    realLoss: realLoss,
    survivors: 0,
  };
}

/**
 * Resolves one landed line wave. Called by `resolveArrivals` for armies that
 * carry a `frontId`. Returns true when the arrival was handled here.
 *
 * A wave is "sponsored" only while its line still exists AND still targets the
 * same territory. An orphaned wave (line stopped, cancelled, or re-targeted)
 * falls through to the ordinary movement resolver and writes no bookkeeping.
 */
export function resolveFrontWave(state: MatchState, army: Army): boolean {
  if (army.frontId === undefined) return false;
  const target = state.territories[army.targetId];
  if (!target) return false;

  if (
    target.owner !== army.owner &&
    target.owner !== 'neutral' &&
    !isHostile(state, army.owner, target.owner)
  ) {
    // The outer movement resolver returns this truce landing to its owner.
    return false;
  }

  // Friendly ground: an ordinary reinforcement. The line stays alive to keep
  // feeding it, and the siege record is dropped because there is nothing
  // hostile left to accumulate.
  if (target.owner === army.owner) {
    const front = frontById(state, army.frontId);
    if (front && front.targetId === army.targetId) front.engagement = undefined;
    return false;
  }

  const front = frontById(state, army.frontId);
  const sponsored = !!front && front.targetId === army.targetId;

  if (!sponsored) {
    // Orphaned wave: its line was stopped, cancelled or re-targeted. It was
    // already paid for and is already in the air, so it still lands. It writes
    // no bookkeeping (so it cannot feed or pollute any engagement record), and
    // it is resolved by the ORDINARY single-attack rule so a stopped line can
    // never behave differently from the single-shot order it effectively
    // became.
    return false;
  }

  const engagement = engagementFor(front as ContinuousFront, target, army.targetId);
  const outcome = applySiegeWave(state, army, target);

  engagement.waves += 1;
  engagement.troopsArrived += army.troops;
  engagement.damageDealt += outcome.shieldLoss + outcome.troopLoss;
  engagement.shieldDamage += outcome.shieldLoss;
  engagement.troopDamage += outcome.troopLoss;
  engagement.lastWaveTick = state.tick;

  if (outcome.captured) {
    engagement.lastDefence = 0;
    engagement.lastProgressTick = state.tick;
    engagement.failedWaves = 0;
    // The line is KEPT and flips to reinforcement duty: the player asked for a
    // continuous flow to this territory, and taking it does not cancel that
    // intent (the documented "目标变友方转增援"). Dropping the siege record is
    // correct — there is nothing hostile left to accumulate — but the line
    // itself stays until the player stops it.
    (front as ContinuousFront).engagement = undefined;
    pushFrontEvent(state, front as ContinuousFront, 'capture', army.troops);
    return true;
  }

  engagement.lastDefence = target.troops + target.shield;
  if (outcome.realLoss > 0) {
    engagement.lastProgressTick = state.tick;
    engagement.failedWaves = 0;
  } else {
    engagement.failedWaves += 1;
  }
  (front as ContinuousFront).engagement = engagement;
  return true;
}

/* ------------------------------------------------------------------ */
/* Engine phase                                                        */
/* ------------------------------------------------------------------ */

type FrontDoomReason = FrontEventReason;

/** How many waves of this line are still in the air. */
function wavesInFlight(state: MatchState, frontId: number): number {
  let count = 0;
  for (let i = 0; i < state.armies.length; i += 1) {
    if (state.armies[i].frontId === frontId) count += 1;
  }
  return count;
}

/**
 * Dispatches due waves and cancels dead lines. Runs once per tick, after
 * production (so a line can spend this tick's fresh troops) and before the
 * end-of-tick checks (so a fatal source loss is observed immediately).
 */
export function resolveContinuousFronts(state: MatchState): void {
  const fronts = state.fronts;
  if (!fronts || fronts.length === 0) return;
  if (state.status !== 'playing') return;

  const doomed: Array<{ front: ContinuousFront; reason: FrontDoomReason }> = [];
  const running: ContinuousFront[] = fronts.slice();

  for (let i = 0; i < running.length; i += 1) {
    const front = running[i];
    const source = state.territories[front.sourceId];
    const target = state.territories[front.targetId];
    if (!source || source.owner !== front.owner) {
      doomed.push({ front: front, reason: 'source-lost' });
      continue;
    }
    if (!target) {
      doomed.push({ front: front, reason: 'route-invalid' });
      continue;
    }
    if (
      target.owner !== front.owner &&
      target.owner !== 'neutral' &&
      !isHostile(state, front.owner, target.owner)
    ) {
      doomed.push({ front: front, reason: 'truce' });
      continue;
    }
    // Every future wave, including a reinforcement, still needs a real path
    // from this source. A disconnected line is cancelled even while waiting.
    const movement = planMoveRoute(state, front.owner, front.sourceId, front.targetId);
    if (!movement) {
      doomed.push({ front: front, reason: 'route-invalid' });
      continue;
    }

    if (state.tick < front.nextSendTick) continue;

    const dispatch = computeDispatch(source.troops, front.ratio);
    // Not enough troops yet: wait. `nextSendTick` stays put so the HUD can show
    // why the line is quiet ("资源不足等待").
    if (dispatch.sent < CONTINUOUS_MIN_BATCH) continue;

    // Concurrency budget: wait for a free slot instead of cancelling. This is
    // what keeps the simulation bounded without ever stopping a valid line.
    if (wavesInFlight(state, front.id) >= CONTINUOUS_MAX_WAVES_IN_FLIGHT) continue;

    const sent = dispatch.sent;
    source.troops -= sent;
    const army = createArmy(state, front.owner, front.sourceId, front.targetId, sent, movement);
    army.frontId = front.id;
    state.armies.push(army);

    front.waves += 1;
    front.totalSent += sent;
    front.nextSendTick = state.tick + CONTINUOUS_SEND_INTERVAL_TICKS;
    if (front.owner === 'player') state.stats.troopsSentByPlayer += sent;
    if (target.owner !== front.owner) {
      front.engagement = engagementFor(front, target, front.targetId);
    }
    pushFrontEvent(state, front, 'send', sent);
  }

  for (let i = 0; i < doomed.length; i += 1) {
    const front = doomed[i].front;
    if (state.fronts && state.fronts.indexOf(front) >= 0) {
      cancelFront(state, front, doomed[i].reason);
    }
  }
}
