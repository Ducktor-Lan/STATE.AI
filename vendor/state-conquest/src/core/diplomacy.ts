import {
  TRUCE_AI_OFFER_DURATION_TICKS,
  TRUCE_AI_OFFER_GLOBAL_COOLDOWN_TICKS,
  TRUCE_AI_OFFER_INITIAL_DELAY_TICKS,
  TRUCE_AI_OFFER_SCAN_INTERVAL_TICKS,
  TRUCE_COOLDOWN_TICKS as BALANCE_TRUCE_COOLDOWN_TICKS,
  TRUCE_DURATION_TICKS as BALANCE_TRUCE_DURATION_TICKS,
  TRUCE_PROPOSAL_COOLDOWN_TICKS as BALANCE_TRUCE_PROPOSAL_COOLDOWN_TICKS,
} from '../config/balance';
import { pushEvent } from './events';
import { isFactionAlive } from './score';
import type {
  DiplomacySnapshot,
  DiplomacyState,
  MatchState,
  PendingTruceOffer,
  PlayerId,
  TruceDecision,
  TruceDecider,
  TruceProposalResult,
  TruceRecord,
} from './types';

/** Re-export the balance values for core callers that use this module directly. */
export const TRUCE_DURATION_TICKS = BALANCE_TRUCE_DURATION_TICKS;
export const TRUCE_COOLDOWN_TICKS = BALANCE_TRUCE_COOLDOWN_TICKS;
export const TRUCE_PROPOSAL_COOLDOWN_TICKS = BALANCE_TRUCE_PROPOSAL_COOLDOWN_TICKS;
export {
  TRUCE_AI_OFFER_DURATION_TICKS,
  TRUCE_AI_OFFER_GLOBAL_COOLDOWN_TICKS,
  TRUCE_AI_OFFER_INITIAL_DELAY_TICKS,
  TRUCE_AI_OFFER_SCAN_INTERVAL_TICKS,
};

const OWNER_ORDER: PlayerId[] = ['player', 'ai1', 'ai2', 'ai3'];

function ownerIndex(owner: PlayerId): number {
  const index = OWNER_ORDER.indexOf(owner);
  return index < 0 ? OWNER_ORDER.length : index;
}

export function trucePair(a: PlayerId, b: PlayerId): { a: PlayerId; b: PlayerId } {
  return ownerIndex(a) <= ownerIndex(b) ? { a: a, b: b } : { a: b, b: a };
}

function samePair(record: TruceRecord, a: PlayerId, b: PlayerId): boolean {
  const normalized = trucePair(a, b);
  const actual = trucePair(record.a, record.b);
  return actual.a === normalized.a && actual.b === normalized.b;
}

function findRecord(
  state: MatchState,
  a: PlayerId,
  b: PlayerId
): TruceRecord | null {
  const diplomacy = state.diplomacy;
  if (!diplomacy) return null;
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    if (samePair(diplomacy.truces[i], a, b)) return diplomacy.truces[i];
  }
  return null;
}

function clonePendingOffer(offer: PendingTruceOffer): PendingTruceOffer {
  return {
    id: offer.id,
    from: offer.from,
    to: offer.to,
    createdTick: offer.createdTick,
    expiresTick: offer.expiresTick,
    reason: offer.reason,
    factors: Object.assign({}, offer.factors),
  };
}

function copyDecisionMetadata(copy: TruceRecord, record: TruceRecord): void {
  if (record.lastDecision !== undefined) copy.lastDecision = record.lastDecision;
  if (record.lastDecisionTick !== undefined) copy.lastDecisionTick = record.lastDecisionTick;
  if (record.lastDecisionReason !== undefined) copy.lastDecisionReason = record.lastDecisionReason;
  if (record.lastDecisionFactors) copy.lastDecisionFactors = Object.assign({}, record.lastDecisionFactors);
  if (record.lastDecisionKind !== undefined) copy.lastDecisionKind = record.lastDecisionKind;
  if (record.lastDecisionProposer !== undefined) copy.lastDecisionProposer = record.lastDecisionProposer;
  if (record.lastDecisionResponder !== undefined) copy.lastDecisionResponder = record.lastDecisionResponder;
  if (record.lastDecisionOutcome !== undefined) copy.lastDecisionOutcome = record.lastDecisionOutcome;
  if (record.pendingOffer) copy.pendingOffer = clonePendingOffer(record.pendingOffer);
}

export function createDiplomacy(enabled: boolean): DiplomacyState {
  return { enabled: enabled, uses: 0, truces: [] };
}

export function cloneDiplomacy(
  diplomacy: DiplomacyState | undefined
): DiplomacyState {
  if (!diplomacy) return createDiplomacy(false);
  const truces: TruceRecord[] = [];
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    const record = diplomacy.truces[i];
    const copy: TruceRecord = {
      a: record.a,
      b: record.b,
      startedTick: record.startedTick,
      expiresTick: record.expiresTick,
      cooldownUntilTick: record.cooldownUntilTick,
    };
    copyDecisionMetadata(copy, record);
    truces.push(copy);
  }
  const uses =
    typeof diplomacy.uses === 'number' && isFinite(diplomacy.uses) && diplomacy.uses >= 0
      ? Math.floor(diplomacy.uses)
      : 0;
  const cloned: DiplomacyState = { enabled: diplomacy.enabled, uses: uses, truces: truces };
  if (
    typeof diplomacy.aiOfferCooldownUntilTick === 'number' &&
    isFinite(diplomacy.aiOfferCooldownUntilTick)
  ) {
    cloned.aiOfferCooldownUntilTick = Math.floor(diplomacy.aiOfferCooldownUntilTick);
  }
  return cloned;
}

/** True only while an active truce covers this pair at the current tick. */
export function hasTruce(state: MatchState, a: PlayerId, b: PlayerId): boolean {
  if (a === b || !state.diplomacy || !state.diplomacy.enabled) return false;
  const record = findRecord(state, a, b);
  return !!record && record.expiresTick > state.tick;
}

/** Relation used by combat, reachability and AI. Neutral is never hostile. */
export function isHostile(
  state: MatchState,
  owner: PlayerId,
  other: string
): boolean {
  return isHostileAt(state.diplomacy, state.tick, owner, other);
}

export function isHostileAt(
  diplomacy: DiplomacyState | DiplomacySnapshot | undefined,
  tick: number,
  owner: PlayerId,
  other: string
): boolean {
  if (other === 'neutral' || other === owner) return false;
  if (other !== 'player' && other !== 'ai1' && other !== 'ai2' && other !== 'ai3') {
    return false;
  }
  if (!diplomacy || !diplomacy.enabled) return true;
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    const record = diplomacy.truces[i];
    if (samePair(record, owner, other as PlayerId) && record.expiresTick > tick) {
      return false;
    }
  }
  return true;
}

/**
 * True while `owner` holds ANY active truce. A faction may hold at most one,
 * so this doubles as the one-ally limit check for new proposals.
 */
export function hasActiveAlly(state: MatchState, owner: PlayerId): boolean {
  const diplomacy = state.diplomacy;
  if (!diplomacy || !diplomacy.enabled) return false;
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    const record = diplomacy.truces[i];
    if ((record.a === owner || record.b === owner) && record.expiresTick > state.tick) {
      return true;
    }
  }
  return false;
}

/** Alive factions among the seated roster (owns land or commands an army). */
function aliveOwnerCount(state: MatchState): number {
  let count = 0;
  for (let i = 0; i < state.activeOwners.length; i += 1) {
    if (isFactionAlive(state, state.activeOwners[i])) count += 1;
  }
  return count;
}

function removeRecord(state: MatchState, a: PlayerId, b: PlayerId): TruceRecord | null {
  if (!state.diplomacy) return null;
  for (let i = 0; i < state.diplomacy.truces.length; i += 1) {
    if (!samePair(state.diplomacy.truces[i], a, b)) continue;
    const removed = state.diplomacy.truces[i];
    state.diplomacy.truces.splice(i, 1);
    return removed;
  }
  return null;
}

function ensureDiplomacy(state: MatchState): DiplomacyState {
  if (!state.diplomacy) state.diplomacy = createDiplomacy(false);
  if (
    typeof state.diplomacy.uses !== 'number' ||
    !isFinite(state.diplomacy.uses) ||
    state.diplomacy.uses < 0
  ) {
    state.diplomacy.uses = 0;
  } else {
    state.diplomacy.uses = Math.floor(state.diplomacy.uses);
  }
  return state.diplomacy;
}

interface PendingOfferMatch {
  record: TruceRecord;
  offer: PendingTruceOffer;
}

function findPendingOffer(state: MatchState, offerId: string): PendingOfferMatch | null {
  const diplomacy = state.diplomacy;
  if (!diplomacy || typeof offerId !== 'string') return null;
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    const record = diplomacy.truces[i];
    if (record.pendingOffer && record.pendingOffer.id === offerId) {
      return { record: record, offer: record.pendingOffer };
    }
  }
  return null;
}

function clearPendingOffer(
  state: MatchState,
  record: TruceRecord,
  outcome: 'rejected' | 'expired' | 'invalidated'
): PendingTruceOffer | null {
  const offer = record.pendingOffer;
  if (!offer) return null;
  const diplomacy = ensureDiplomacy(state);
  record.lastDecision = outcome === 'rejected' ? 'rejected' : undefined;
  record.lastDecisionTick = state.tick;
  record.lastDecisionReason = offer.reason;
  record.lastDecisionFactors = Object.assign({}, offer.factors);
  record.lastDecisionKind = 'ai-offer';
  record.lastDecisionProposer = offer.from;
  record.lastDecisionResponder = offer.to;
  record.lastDecisionOutcome = outcome;
  delete record.pendingOffer;
  record.expiresTick = Math.min(record.expiresTick, state.tick);
  record.cooldownUntilTick = Math.max(
    record.cooldownUntilTick,
    state.tick + TRUCE_PROPOSAL_COOLDOWN_TICKS
  );
  diplomacy.aiOfferCooldownUntilTick = Math.max(
    diplomacy.aiOfferCooldownUntilTick || 0,
    state.tick + TRUCE_AI_OFFER_GLOBAL_COOLDOWN_TICKS
  );
  return offer;
}

function clearPendingOffersForOwner(state: MatchState, owner: PlayerId): void {
  const diplomacy = state.diplomacy;
  if (!diplomacy) return;
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    const record = diplomacy.truces[i];
    if (!record.pendingOffer) continue;
    if (record.pendingOffer.from !== owner && record.pendingOffer.to !== owner) continue;
    clearPendingOffer(state, record, 'invalidated');
  }
}

function offerId(from: PlayerId, to: PlayerId, createdTick: number): string {
  return 'ai-truce-' + from + '-' + to + '-' + String(createdTick);
}

/**
 * A truce stops active hostile supply lines immediately. Armies that were
 * already dispatched stay in flight with their frozen route; movement.ts
 * returns them on landing if the truce is still active.
 */
function cancelMutualFronts(state: MatchState, a: PlayerId, b: PlayerId): void {
  const fronts = state.fronts;
  if (!fronts || fronts.length === 0) return;
  const keep = [] as NonNullable<MatchState['fronts']>;
  for (let i = 0; i < fronts.length; i += 1) {
    const front = fronts[i];
    const target = state.territories[front.targetId];
    const mutual = !!target &&
      ((front.owner === a && target.owner === b) ||
        (front.owner === b && target.owner === a));
    if (!mutual) {
      keep.push(front);
      continue;
    }
    pushEvent(state.events, {
      type: 'front',
      tick: state.tick,
      targetId: front.targetId,
      amount: 0,
      owner: front.owner,
      frontAction: 'cancel',
      frontReason: 'truce',
      frontId: front.id,
    });
  }
  state.fronts = keep;
}

/**
 * Player-to-faction truce/alliance proposal. The request is validated against
 * the legality rules first; only a legal request reaches the injected decider
 * (the AI interest evaluation). Core never decides by itself and never
 * mutates state for a refused request except the anti-spam cooldown record of
 * an AI rejection.
 *
 * Rules (2.0.0 proposal feature):
 *  - at least three alive factions are required to establish a truce;
 *  - a faction holds at most ONE active truce (one ally), on both sides;
 *  - an active truce can never be refreshed by re-proposing;
 *  - a rejection leaves a cooldown-only record (re-proposing is blocked);
 *  - an accepted truce cancels the pair's mutual supply lines immediately.
 */
export function proposeTruce(
  state: MatchState,
  owner: PlayerId,
  target: PlayerId,
  decide: TruceDecider
): TruceProposalResult {
  if (
    (state.status !== 'playing' && state.status !== 'paused')
  ) {
    return { ok: false, accepted: false, reason: 'not-playing' };
  }
  const diplomacy = state.diplomacy;
  if (!diplomacy || !diplomacy.enabled) {
    return { ok: false, accepted: false, reason: 'disabled' };
  }
  if (owner === target) return { ok: false, accepted: false, reason: 'self' };
  if (state.activeOwners.indexOf(owner) < 0) {
    return { ok: false, accepted: false, reason: 'invalid' };
  }
  if (state.activeOwners.indexOf(target) < 0) {
    return { ok: false, accepted: false, reason: 'unknown-target' };
  }
  if (!isFactionAlive(state, target)) {
    return { ok: false, accepted: false, reason: 'target-dead' };
  }
  if (aliveOwnerCount(state) < 3) {
    return { ok: false, accepted: false, reason: 'too-few-alive' };
  }
  const existing = findRecord(state, owner, target);
  if (existing) {
    if (existing.expiresTick > state.tick) {
      return { ok: false, accepted: false, reason: 'already-allied' };
    }
    if (existing.cooldownUntilTick > state.tick) {
      return { ok: false, accepted: false, reason: 'cooldown' };
    }
  }
  if (hasActiveAlly(state, owner) || hasActiveAlly(state, target)) {
    return { ok: false, accepted: false, reason: 'ally-limit' };
  }

  const decision = decide(state, owner, target);
  const normalized = trucePair(owner, target);
  if (decision.accept) {
    if (existing) removeRecord(state, owner, target);
    const expiresTick = state.tick + TRUCE_DURATION_TICKS;
    diplomacy.truces.push({
      a: normalized.a,
      b: normalized.b,
      startedTick: state.tick,
      expiresTick: expiresTick,
      cooldownUntilTick: state.tick + TRUCE_DURATION_TICKS + TRUCE_COOLDOWN_TICKS,
      lastDecision: 'accepted',
      lastDecisionTick: state.tick,
      lastDecisionReason: decision.reason,
      lastDecisionFactors: decision.factors ? Object.assign({}, decision.factors) : undefined,
      lastDecisionKind: 'player-proposal',
      lastDecisionProposer: owner,
      lastDecisionResponder: target,
      lastDecisionOutcome: 'accepted',
    });
    cancelMutualFronts(state, owner, target);
    clearPendingOffersForOwner(state, owner);
    clearPendingOffersForOwner(state, target);
    ensureDiplomacy(state).uses += 1;
    return {
      ok: true,
      accepted: true,
      reason: decision.reason,
      score: decision.score,
      factors: decision.factors ? Object.assign({}, decision.factors) : undefined,
      expiresTick: expiresTick,
    };
  }
  // Rejection: replace any stale record with a cooldown-only record so the
  // same pair cannot be re-proposed until the cooldown elapses. The record is
  // inactive (expiresTick <= tick), so relations stay fully hostile.
  if (existing) removeRecord(state, owner, target);
  diplomacy.truces.push({
    a: normalized.a,
    b: normalized.b,
    startedTick: state.tick,
    expiresTick: state.tick,
    cooldownUntilTick: state.tick + TRUCE_PROPOSAL_COOLDOWN_TICKS,
    lastDecision: 'rejected',
    lastDecisionTick: state.tick,
    lastDecisionReason: decision.reason,
    lastDecisionFactors: decision.factors ? Object.assign({}, decision.factors) : undefined,
    lastDecisionKind: 'player-proposal',
    lastDecisionProposer: owner,
    lastDecisionResponder: target,
    lastDecisionOutcome: 'rejected',
  });
  return {
    ok: true,
    accepted: false,
    reason: decision.reason,
    score: decision.score,
    factors: decision.factors ? Object.assign({}, decision.factors) : undefined,
  };
}

/**
 * Fixed-cadence proactive AI diplomacy. The injected decider is the existing
 * receiver-side evaluator: calling it as (player, ai) scores the AI's own
 * interest in the proposed cooperation. No random draw or wall clock is used.
 * Returns true only when a new pending invitation was created.
 */
export function scanAiTruceOffers(
  state: MatchState,
  decide: TruceDecider
): boolean {
  const diplomacy = state.diplomacy;
  if (
    state.status !== 'playing' ||
    !diplomacy ||
    !diplomacy.enabled ||
    state.mode === 'versus' ||
    state.tick < TRUCE_AI_OFFER_INITIAL_DELAY_TICKS ||
    (state.tick - TRUCE_AI_OFFER_INITIAL_DELAY_TICKS) % TRUCE_AI_OFFER_SCAN_INTERVAL_TICKS !== 0
  ) {
    return false;
  }
  if (
    typeof diplomacy.aiOfferCooldownUntilTick === 'number' &&
    diplomacy.aiOfferCooldownUntilTick > state.tick
  ) {
    return false;
  }
  if (aliveOwnerCount(state) < 3 || !isFactionAlive(state, 'player') || hasActiveAlly(state, 'player')) {
    return false;
  }
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    if (diplomacy.truces[i].pendingOffer) return false;
  }

  let bestOwner: PlayerId | null = null;
  let bestDecision: TruceDecision | null = null;
  // activeOwners is the canonical seat order. Strict `>` preserves it as the
  // deterministic tie-breaker when two candidates have the same score.
  for (let i = 0; i < state.activeOwners.length; i += 1) {
    const owner = state.activeOwners[i];
    if (owner === 'player' || !isFactionAlive(state, owner)) continue;
    if (hasActiveAlly(state, owner)) continue;
    const existing = findRecord(state, owner, 'player');
    if (
      existing &&
      (existing.expiresTick > state.tick || existing.cooldownUntilTick > state.tick)
    ) {
      continue;
    }
    const decision = decide(state, 'player', owner);
    if (!decision.accept || !decision.factors) continue;
    if (!bestDecision || decision.score > bestDecision.score) {
      bestOwner = owner;
      bestDecision = decision;
    }
  }
  if (!bestOwner || !bestDecision || !bestDecision.factors) return false;

  const existing = findRecord(state, bestOwner, 'player');
  if (existing) removeRecord(state, bestOwner, 'player');
  const normalized = trucePair(bestOwner, 'player');
  const expiresTick = state.tick + TRUCE_AI_OFFER_DURATION_TICKS;
  diplomacy.truces.push({
    a: normalized.a,
    b: normalized.b,
    startedTick: state.tick,
    // Pending offers are deliberately never active relations.
    expiresTick: state.tick,
    cooldownUntilTick: expiresTick,
    pendingOffer: {
      id: offerId(bestOwner, 'player', state.tick),
      from: bestOwner,
      to: 'player',
      createdTick: state.tick,
      expiresTick: expiresTick,
      reason: bestDecision.reason,
      factors: Object.assign({}, bestDecision.factors),
    },
  });
  return true;
}

/** Accepts one still-valid AI invitation after rechecking every legality gate. */
export function acceptTruceOffer(
  state: MatchState,
  offerIdValue: string
): TruceProposalResult {
  if (state.status !== 'playing' && state.status !== 'paused') {
    return { ok: false, accepted: false, reason: 'not-playing' };
  }
  if (!state.diplomacy || !state.diplomacy.enabled) {
    return { ok: false, accepted: false, reason: 'disabled' };
  }
  const match = findPendingOffer(state, offerIdValue);
  if (!match) return { ok: false, accepted: false, reason: 'offer-not-found' };
  const record = match.record;
  const offer = match.offer;
  if (offer.expiresTick <= state.tick) {
    clearPendingOffer(state, record, 'expired');
    return {
      ok: false,
      accepted: false,
      reason: 'offer-expired',
      factors: Object.assign({}, offer.factors),
    };
  }
  if (
    !samePair(record, offer.from, offer.to) ||
    offer.to !== 'player' ||
    state.activeOwners.indexOf(offer.from) < 0 ||
    state.activeOwners.indexOf(offer.to) < 0 ||
    !isFactionAlive(state, offer.from) ||
    !isFactionAlive(state, offer.to) ||
    aliveOwnerCount(state) < 3 ||
    hasActiveAlly(state, offer.from) ||
    hasActiveAlly(state, offer.to)
  ) {
    clearPendingOffer(state, record, 'invalidated');
    return {
      ok: false,
      accepted: false,
      reason: 'offer-invalidated',
      factors: Object.assign({}, offer.factors),
    };
  }

  removeRecord(state, offer.from, offer.to);
  const normalized = trucePair(offer.from, offer.to);
  const expiresTick = state.tick + TRUCE_DURATION_TICKS;
  const diplomacy = ensureDiplomacy(state);
  diplomacy.truces.push({
    a: normalized.a,
    b: normalized.b,
    startedTick: state.tick,
    expiresTick: expiresTick,
    cooldownUntilTick: state.tick + TRUCE_DURATION_TICKS + TRUCE_COOLDOWN_TICKS,
    lastDecision: 'accepted',
    lastDecisionTick: state.tick,
    lastDecisionReason: offer.reason,
    lastDecisionFactors: Object.assign({}, offer.factors),
    lastDecisionKind: 'ai-offer',
    lastDecisionProposer: offer.from,
    lastDecisionResponder: offer.to,
    lastDecisionOutcome: 'accepted',
  });
  cancelMutualFronts(state, offer.from, offer.to);
  clearPendingOffersForOwner(state, offer.from);
  clearPendingOffersForOwner(state, offer.to);
  diplomacy.uses += 1;
  return {
    ok: true,
    accepted: true,
    reason: offer.reason,
    factors: Object.assign({}, offer.factors),
    expiresTick: expiresTick,
  };
}

/** Rejects one still-valid AI invitation and starts pair/global anti-spam cooldowns. */
export function rejectTruceOffer(state: MatchState, offerIdValue: string): boolean {
  if (
    (state.status !== 'playing' && state.status !== 'paused') ||
    !state.diplomacy ||
    !state.diplomacy.enabled
  ) {
    return false;
  }
  const match = findPendingOffer(state, offerIdValue);
  if (!match || match.offer.to !== 'player') return false;
  if (match.offer.expiresTick <= state.tick) {
    clearPendingOffer(state, match.record, 'expired');
    return false;
  }
  clearPendingOffer(state, match.record, 'rejected');
  return true;
}

/** Invalidates every pending invitation when the match ends. */
export function invalidatePendingAiOffers(state: MatchState): void {
  const diplomacy = state.diplomacy;
  if (!diplomacy) return;
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    if (diplomacy.truces[i].pendingOffer) {
      clearPendingOffer(state, diplomacy.truces[i], 'invalidated');
    }
  }
}

/** Deliberately ends a truce and leaves a cooldown record behind. */
export function breakTruce(
  state: MatchState,
  owner: PlayerId,
  target: PlayerId
): boolean {
  if (
    (state.status !== 'playing' && state.status !== 'paused') ||
    !state.diplomacy ||
    !state.diplomacy.enabled ||
    owner === target ||
    state.activeOwners.indexOf(owner) < 0 ||
    state.activeOwners.indexOf(target) < 0
  ) {
    return false;
  }
  const record = findRecord(state, owner, target);
  if (!record || record.expiresTick <= state.tick) return false;
  record.expiresTick = state.tick;
  record.cooldownUntilTick = state.tick + TRUCE_COOLDOWN_TICKS;
  // The pair turns hostile immediately: tear down lines that target each
  // other right here. Lines that merely TRANSITED the partner lose their
  // legal route and are re-validated by the engine's front pass (and by the
  // engine wrapper's immediate sweep).
  cancelMutualFronts(state, owner, target);
  const diplomacy = ensureDiplomacy(state);
  diplomacy.uses += 1;
  return true;
}

export interface EndedTrucePair {
  a: PlayerId;
  b: PlayerId;
}

/**
 * Per-tick diplomacy maintenance. Runs after the record cleanup and enforces
 * the two automatic dissolution rules:
 *  - a member faction was eliminated;
 *  - fewer than three factions remain alive (the endgame is one-on-one).
 * Ending a truce keeps the cooldown/uses bookkeeping consistent with a
 * deliberate break, cancels the pair's mutual supply lines, and reports the
 * pair so the caller can re-validate borrowed-frontier lines.
 */
export function maintainDiplomacy(state: MatchState): EndedTrucePair[] {
  const diplomacy = state.diplomacy;
  if (!diplomacy || !diplomacy.enabled) return [];
  const ended: EndedTrucePair[] = [];
  const alive = aliveOwnerCount(state);
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    const record = diplomacy.truces[i];
    if (record.pendingOffer) {
      const offer = record.pendingOffer;
      const expired = offer.expiresTick <= state.tick;
      const invalidated =
        state.status === 'ended' ||
        alive <= 2 ||
        !isFactionAlive(state, offer.from) ||
        !isFactionAlive(state, offer.to) ||
        hasActiveAlly(state, offer.from) ||
        hasActiveAlly(state, offer.to);
      if (expired || invalidated) {
        clearPendingOffer(state, record, expired ? 'expired' : 'invalidated');
      }
    }
    if (record.expiresTick <= state.tick) continue;
    const memberDead =
      !isFactionAlive(state, record.a) || !isFactionAlive(state, record.b);
    const tooFewAlive = alive <= 2;
    if (memberDead || tooFewAlive) {
      record.expiresTick = state.tick;
      record.cooldownUntilTick = state.tick + TRUCE_COOLDOWN_TICKS;
      cancelMutualFronts(state, record.a, record.b);
      ended.push({ a: record.a, b: record.b });
    }
  }
  return ended;
}

/** Removes records after both the active period and cooldown have elapsed. */
export function expireTruces(state: MatchState): void {
  const diplomacy = state.diplomacy;
  if (!diplomacy) return;
  const keep: TruceRecord[] = [];
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    const record = diplomacy.truces[i];
    if (record.pendingOffer && record.pendingOffer.expiresTick <= state.tick) {
      clearPendingOffer(state, record, 'expired');
    }
    if (record.cooldownUntilTick > state.tick) keep.push(record);
  }
  diplomacy.truces = keep;
}

export function toDiplomacySnapshot(state: MatchState): DiplomacySnapshot {
  const diplomacy = state.diplomacy || createDiplomacy(false);
  const truces: TruceRecord[] = [];
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    const record = diplomacy.truces[i];
    // Keep an expired truce while its cooldown is visible to the UI. The UI
    // uses expiresTick to distinguish active protection from cooldown, and
    // lastDecision to show why the last proposal was accepted or refused.
    if (record.cooldownUntilTick <= state.tick) continue;
    const copy: TruceRecord = {
      a: record.a,
      b: record.b,
      startedTick: record.startedTick,
      expiresTick: record.expiresTick,
      cooldownUntilTick: record.cooldownUntilTick,
    };
    copyDecisionMetadata(copy, record);
    truces.push(copy);
  }
  const uses =
    typeof diplomacy.uses === 'number' && isFinite(diplomacy.uses) && diplomacy.uses >= 0
      ? Math.floor(diplomacy.uses)
      : 0;
  const snapshot: DiplomacySnapshot = { enabled: diplomacy.enabled, uses: uses, truces: truces };
  if (diplomacy.aiOfferCooldownUntilTick !== undefined) {
    snapshot.aiOfferCooldownUntilTick = diplomacy.aiOfferCooldownUntilTick;
  }
  return snapshot;
}
