/** Deterministic, receiver-side interests. A proposal never changes the board here. */
import {
  TICKS_PER_SECOND,
  TRUCE_ACCEPT_SCORE,
  TRUCE_DOMINANCE_RATIO,
  TRUCE_PRODUCTION_HORIZON_SECONDS,
  TRUCE_ROUTE_DISCOUNT_SECONDS,
  TRUCE_UNDERDOG_RATIO,
  TRUCE_VALUE_POWER_WEIGHT,
  TRUCE_W_COMMON_ENEMY,
  TRUCE_W_FRONT_RELIEF,
  TRUCE_W_OUTGUNNED,
  TRUCE_W_SHARED_TARGET,
  TRUCE_W_UNDERDOG,
  TRUCE_WIN_MARGIN,
} from '../config/balance';
import { createOwnerReachability } from '../core/reachability';
import type { OwnerReachability } from '../core/reachability';
import { effectiveProductionRate } from '../core/production';
import { requiredAttackCost } from '../core/combat';
import { isHostile, trucePair } from '../core/diplomacy';
import { isFactionAlive } from '../core/score';
import type {
  MatchState,
  PlayerId,
  TruceDecision,
  TruceDecisionFactors,
  TruceProposalReason,
} from '../core/types';

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function strength(state: MatchState, owner: PlayerId): { power: number; production: number } {
  let power = 0;
  let production = 0;
  const horizon = Math.min(
    TRUCE_PRODUCTION_HORIZON_SECONDS,
    Math.max(0, (state.durationTicks - state.tick) / TICKS_PER_SECOND)
  );
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    if (territory.owner !== owner) continue;
    power += territory.troops + territory.scoreValue * TRUCE_VALUE_POWER_WEIGHT;
    production += effectiveProductionRate(territory.productionLevel, state, owner);
  }
  for (let i = 0; i < state.armies.length; i += 1) {
    if (state.armies[i].owner === owner) power += state.armies[i].troops;
  }
  // Production is economic potential, not a claim that full garrisons keep growing.
  return { power: power + production * horizon, production: production };
}

/** Each threatening source is counted once, discounted by its shortest real route. */
function pressure(
  state: MatchState,
  from: PlayerId,
  to: PlayerId,
  reach: OwnerReachability
): { total: number; incoming: number } {
  if (!isHostile(state, from, to)) return { total: 0, incoming: 0 };
  let total = 0;
  let incoming = 0;
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const source = state.territories[state.territoryOrder[i]];
    if (source.owner !== from) continue;
    let nearest = Infinity;
    for (let t = 0; t < reach.attackTargets.length; t += 1) {
      const targetId = reach.attackTargets[t];
      if (state.territories[targetId].owner !== to) continue;
      const route = reach.plan(source.id, targetId);
      if (route && route.travelTicks < nearest) nearest = route.travelTicks;
    }
    if (nearest !== Infinity) {
      total += source.troops / (1 + nearest / (TICKS_PER_SECOND * TRUCE_ROUTE_DISCOUNT_SECONDS));
    }
  }
  for (let i = 0; i < state.armies.length; i += 1) {
    const army = state.armies[i];
    const target = state.territories[army.targetId];
    if (army.owner === from && target && target.owner === to) incoming += army.troops;
  }
  return { total: total + incoming, incoming: incoming };
}

/** Only targets reached from a real own source through the proposed ally add value. */
function opportunity(state: MatchState, self: PlayerId, other: PlayerId): { count: number; value: number } {
  const before = createOwnerReachability(state, self);
  const diplomacy = state.diplomacy;
  const normalized = trucePair(self, other);
  const proposed = Object.assign({}, state, {
    diplomacy: {
      enabled: true,
      uses: diplomacy ? diplomacy.uses : 0,
      truces: (diplomacy ? diplomacy.truces : []).concat([{
        a: normalized.a, b: normalized.b, startedTick: state.tick,
        expiresTick: state.tick + 1, cooldownUntilTick: state.tick + 1,
      }]),
    },
  }) as MatchState;
  const after = createOwnerReachability(proposed, self);
  let count = 0;
  let value = 0;
  for (let t = 0; t < after.attackTargets.length; t += 1) {
    const targetId = after.attackTargets[t];
    let alreadyReachable = false;
    let bestValue = 0;
    for (let i = 0; i < state.territoryOrder.length; i += 1) {
      const source = state.territories[state.territoryOrder[i]];
      if (source.owner !== self) continue;
      if (before.plan(source.id, targetId)) alreadyReachable = true;
      const route = after.plan(source.id, targetId);
      if (!route || !route.transitOwners || route.transitOwners.indexOf(other) < 0) continue;
      const target = state.territories[targetId];
      const cost = requiredAttackCost(target.troops + target.shield, target.terrain) + 1;
      const landValue = target.scoreValue / 10 +
        effectiveProductionRate(target.productionLevel, state, self) / 2;
      const travelDiscount = 1 + route.travelTicks / (TICKS_PER_SECOND * TRUCE_ROUTE_DISCOUNT_SECONDS);
      const defenceDiscount = 1 + cost / Math.max(1, source.troops);
      bestValue = Math.max(bestValue, TRUCE_W_SHARED_TARGET * landValue / travelDiscount / defenceDiscount);
    }
    if (!alreadyReachable && bestValue > 0) {
      count += 1;
      value += bestValue;
    }
  }
  return { count: count, value: value };
}

export function evaluateTruceProposal(state: MatchState, self: PlayerId, other: PlayerId): TruceDecision {
  const mine = strength(state, self);
  const proposer = strength(state, other);
  const myReach = createOwnerReachability(state, self);
  const otherReach = createOwnerReachability(state, other);
  let maxThirdPower = 0;
  let thirdPressure = 0;
  let incomingThreat = 0;
  let commonThreats = 0;
  for (let i = 0; i < state.activeOwners.length; i += 1) {
    const third = state.activeOwners[i];
    if (third === self || third === other || !isFactionAlive(state, third)) continue;
    const reach = createOwnerReachability(state, third);
    const againstMe = pressure(state, third, self, reach);
    const againstProposer = pressure(state, third, other, reach);
    if (againstMe.total <= 0 && againstProposer.total <= 0) continue;
    maxThirdPower = Math.max(maxThirdPower, strength(state, third).power);
    thirdPressure += againstMe.total;
    incomingThreat += againstMe.incoming;
    if (againstMe.total > 0 && againstProposer.total > 0) commonThreats += 1;
  }
  const shared = opportunity(state, self, other);
  const opposed = pressure(state, other, self, otherReach).total;
  const myFront = pressure(state, self, other, myReach).total;
  const factors: TruceDecisionFactors = {
    selfPower: rounded(mine.power),
    proposerPower: rounded(proposer.power),
    strongestThirdPower: rounded(maxThirdPower),
    selfProduction: rounded(mine.production),
    proposerProduction: rounded(proposer.production),
    incomingThreat: rounded(incomingThreat),
    commonThreats: commonThreats,
    sharedTargets: shared.count,
    sharedOpportunity: rounded(shared.value),
    threatRelief: rounded(
      (commonThreats > 0 ? TRUCE_W_COMMON_ENEMY : 0) +
      (maxThirdPower > mine.power && thirdPressure > 0 ? TRUCE_W_OUTGUNNED : 0) +
      Math.min(TRUCE_W_OUTGUNNED, TRUCE_W_OUTGUNNED * thirdPressure / Math.max(1, mine.power))
    ),
    borderRelief: rounded(TRUCE_W_FRONT_RELIEF * Math.min(1, (opposed + myFront) / Math.max(1, mine.power))),
    underdog: mine.power < proposer.power * TRUCE_UNDERDOG_RATIO ? TRUCE_W_UNDERDOG : 0,
  };
  const contributions: Array<{ reason: TruceProposalReason; value: number }> = [
    { reason: 'accept-common-threat', value: factors.threatRelief },
    { reason: 'accept-opportunity', value: factors.sharedOpportunity },
    { reason: 'accept-front-relief', value: factors.borderRelief },
    { reason: 'accept-underdog', value: factors.underdog },
  ];
  let score = 0;
  let best = contributions[0];
  for (let i = 0; i < contributions.length; i += 1) {
    score += contributions[i].value;
    if (contributions[i].value > best.value) best = contributions[i];
  }
  score = rounded(score);
  const urgentThreat = thirdPressure > mine.power * 0.25 || incomingThreat > 0;
  const dominantProposer = proposer.power > mine.power * TRUCE_DOMINANCE_RATIO &&
    maxThirdPower <= mine.power && !urgentThreat && commonThreats === 0;
  const alreadyWinning = mine.power > (proposer.power + maxThirdPower) * TRUCE_WIN_MARGIN &&
    !urgentThreat && commonThreats === 0;
  const reason: TruceProposalReason = alreadyWinning ? 'reject-winning' : dominantProposer
    ? 'reject-dominant' : score >= TRUCE_ACCEPT_SCORE ? best.reason : 'reject-no-benefit';
  return {
    accept: !alreadyWinning && !dominantProposer && score >= TRUCE_ACCEPT_SCORE,
    reason: reason,
    score: score,
    factors: factors,
  };
}
