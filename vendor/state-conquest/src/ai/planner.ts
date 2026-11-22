import { AI_RATIO_CHOICES, AI_TUNING } from '../config/balance';
import {
  applyMove,
  applyUpgrade,
  computeMovePlan,
  computeUpgradePlan,
} from '../core/commands';
import { computeDispatch } from '../core/dispatch';
import { requiredAttackCost, resolveBattle } from '../core/combat';
import { travelTicksForEdge } from '../core/movement';
import { MARCH_SPEED_MULTIPLIER, SHIELD_CAPACITY } from '../config/balance';
import { effectiveProductionRate } from '../core/production';
import { isHostileAt } from '../core/diplomacy';
import type { Rng } from '../core/rng';
import type { MatchState, PlayerId, Territory, UpgradeKind } from '../core/types';
import type { AiDecision, AiDecisionOptions, CommandReceipt, PlannedCommand } from './types';
import { cloneMatchState } from './clone';
import { cachedReachability } from './routing-cache';
import type { OwnerReachability } from '../core/reachability';
import {
  enemyPressure,
  isEnemyOf,
  isFrontier,
  isHome,
  isInterior,
  predictedDefender,
  projectTargetArrival,
  remainingSeconds,
} from './evaluate';
import { forecastAssault } from './forecast';
import { endgameContext } from './endgame';
import type { EndgameContext } from './endgame';
import { contractionCommand } from './retreat';
import { adjacentEnemyThreats, createThreatModel, strongestAdjacentEnemyThreat } from './risk';
import type { AdjacentEnemyThreat, ThreatModel, ThreatModelCache } from './risk';

interface PartnerPlan {
  sourceId: string;
  ratio: number;
  sent: number;
}

interface AttackCandidate {
  sourceId: string;
  targetId: string;
  ratio: number;
  sent: number;
  score: number;
  arrivalTick: number;
}

interface CoordinatedCandidate {
  targetId: string;
  first: PartnerPlan;
  second: PartnerPlan;
  score: number;
}

function ownCount(state: MatchState, owner: PlayerId): number {
  let count = 0;
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    if (state.territories[state.territoryOrder[i]].owner === owner) count += 1;
  }
  return count;
}

/**
 * The two shallow skill levels share the legacy opening heuristics: an extra
 * troop margin before striking a defended enemy, and a score penalty on enemy
 * targets. `casual` is deliberately on this path (its own tuning only raises
 * the margin / guard), while easy keeps its exact frozen values.
 */
function usesLegacySimpleTuning(difficulty: MatchState['difficulty']): boolean {
  return difficulty === 'easy' || difficulty === 'casual';
}

/**
 * Smallest dispatch ratio whose floor(available*ratio) exceeds `required`
 * while leaving at least `guard` troops home. Null when impossible.
 */
function chooseRatio(
  available: number,
  required: number,
  guard: number
): { ratio: number; sent: number } | null {
  for (let i = 0; i < AI_RATIO_CHOICES.length; i += 1) {
    const ratio = AI_RATIO_CHOICES[i];
    const sent = Math.floor(available * ratio);
    if (sent > required && available - sent >= guard) return { ratio: ratio, sent: sent };
  }
  return null;
}

function targetValue(state: MatchState, owner: PlayerId, target: Territory): number {
  let value = target.scoreValue * 1.2;
  value += target.owner === 'neutral' ? 18 : 30;
  if (isHome(state, owner, target.id)) value += 55;
  if (target.owner !== 'neutral' && isHome(state, target.owner as PlayerId, target.id)) value += 25;
  value += (target.productionLevel - 1) * 8;
  if (target.terrain === 'mountain') value -= 6;
  else if (target.terrain === 'hill') value -= 3;
  return value;
}

function attackScore(
  state: MatchState,
  owner: PlayerId,
  source: Territory,
  target: Territory,
  sent: number,
  required: number,
  endgame: EndgameContext
): number {
  let score = targetValue(state, owner, target);
  score -= required * 0.18 + sent * 0.05;

  if (endgame.active) {
    // Score first, then territory count, then force: a capture that removes
    // points from the leader is worth roughly twice its face value, while a
    // low-value land grab that risks a held lead is worth nothing.
    if (endgame.posture === 'push') {
      score += target.scoreValue * (target.owner === 'neutral' ? 0.7 : 1.2);
      score -= sent * 0.03;
    } else if (endgame.posture === 'hold') {
      score -= 12;
      if (target.owner === 'neutral') score -= 8;
      if (target.scoreValue <= 4) score -= 10;
    } else {
      if (endgame.territoryGap < 0) score += 6;
      score += target.scoreValue * 0.3;
    }
  } else if (remainingSeconds(state) < 40) {
    score += target.scoreValue * 0.6;
  }

  const remaining = source.troops - sent;
  const pressure = enemyPressure(state, owner, source.id);
  if (pressure > remaining + 4) score -= 26;
  else if (pressure > remaining) score -= 12;

  const garrison = Math.min(target.capacity, Math.max(0, sent - required));
  score -= Math.max(0, sent - required - garrison) * 0.5;
  return score;
}

/**
 * Explicit "cannot hold what we take / cannot hold what we leave" test. The
 * captured target and the weakened source must BOTH be capturable by the enemy
 * before the final tick: a wave that lands after the timed match cannot change
 * the result.
 *
 * Both conditions use the real capture rule (`available > requiredAttackCost`)
 * on the troops that would actually hold the ground. The old 1.6x safety margin
 * is deliberately gone from this hard veto: it rejected provable captures (a
 * 3-troop counter beats a 2-troop garrison, yet 3 > 2 * 1.6 is false) and only
 * belongs in the confidence weighting (`TARGET_COUNTER_SCORE_PENALTY`).
 *
 * A shared counter source is NOT an exemption. One source may still fund both
 * attacks with two waves (its second dispatch comes from the garrison that
 * remains after the first), and a second weaker source may complete the other
 * attack. Only an allocation that genuinely cannot pay for both cancels the
 * veto, which keeps a normal attack alive when the enemy's single stack is too
 * small to lose troops twice.
 *
 * A stack that touches only ONE of the two can still lose us both: it captures
 * that territory first and uses the freshly captured ground as a staging area
 * against the other (see `enemyCanTransitBetween`). An adjacent-only
 * allocation check cannot see that follow-up wave.
 *
 * This is deliberately a hard veto. The older score penalty is gone: the hard
 * forecast already prices lost-to-counter, and a second static deduction both
 * double-counted it and suppressed expansion.
 */
const TARGET_COUNTER_MARGIN = 1.6;
/** Soft weight only: a comfortably retakeable target is worth less, never vetoed. */
const TARGET_COUNTER_SCORE_PENALTY = 4;

/**
 * Total troops a source would have left for a second wave after sending the
 * smallest first wave that captures. The reserve rule is the dispatch rule the
 * engine actually applies, so this is an executable allocation bound rather
 * than a raw subtraction. Sending any more than `firstCost + 1` can only reduce
 * the second wave, so the minimal first wave is the most favourable case.
 */
function canPayTwoWaves(
  troops: number,
  available: number,
  firstCost: number,
  secondCost: number
): boolean {
  if (available <= firstCost) return false;
  const firstSent = firstCost + 1;
  const secondAvailable = computeDispatch(troops - firstSent, 1).available;
  return secondAvailable > secondCost;
}

/**
 * Can the enemy coalition capture BOTH the source and the captured target
 * before the deadline? Each attack is funded by a real troop pool:
 *
 *  - two independent sources: each pays once from its own pool;
 *  - one source twice: the second wave is paid from what the first left.
 *
 * Distinct-source pairs are checked first because they are always feasible
 * when both pools are big enough. The same-source sequential case is checked in
 * both orders (source-first or target-first), since which attack is cheap
 * changes who can still afford the second.
 */
function enemyCanCaptureBoth(
  sourceThreats: AdjacentEnemyThreat[],
  sourceCost: number,
  targetThreats: AdjacentEnemyThreat[],
  targetCost: number
): boolean {
  for (let i = 0; i < sourceThreats.length; i += 1) {
    const sourceThreat = sourceThreats[i];
    if (sourceThreat.available <= sourceCost) continue;
    for (let j = 0; j < targetThreats.length; j += 1) {
      const targetThreat = targetThreats[j];
      if (targetThreat.available <= targetCost) continue;
      if (targetThreat.sourceId !== sourceThreat.sourceId) return true;
    }
  }
  for (let i = 0; i < sourceThreats.length; i += 1) {
    const sourceThreat = sourceThreats[i];
    for (let j = 0; j < targetThreats.length; j += 1) {
      const targetThreat = targetThreats[j];
      if (targetThreat.sourceId !== sourceThreat.sourceId) continue;
      // The same source is described once in each list with the same stocks.
      if (
        canPayTwoWaves(sourceThreat.troops, sourceThreat.available, sourceCost, targetCost) ||
        canPayTwoWaves(sourceThreat.troops, sourceThreat.available, targetCost, sourceCost)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Travel ticks of the direct edge between two territories, priced at march 1.
 * A captured territory has its march track reset by `resetCapturedTerritory`,
 * so the enemy's second leg always walks the edge at the base speed.
 */
function directEdgeTicks(state: MatchState, a: string, b: string): number | null {
  let best: number | null = null;
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    const linked =
      (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a);
    if (!linked) continue;
    const ticks = travelTicksForEdge(edge, 1);
    if (best === null || ticks < best) best = ticks;
  }
  return best;
}

/**
 * Can one adjacent enemy stack capture `first` and then, from that freshly
 * captured ground, capture the second territory? This is the one-hop transit
 * the pre-existing allocation check missed: a stack that only touches ONE of
 * our two territories can still lose us both by taking that one first and
 * attacking the other from it (the captured ground already touches the other,
 * because our own attack crossed that same edge).
 *
 * The enemy's best case is modelled, not a guessed dispatch ratio: the whole
 * dispatchable pool goes on the first leg (survivors never shrink as `sent`
 * grows), the real capture cost includes terrain and the shield, and the
 * garrison is capped by the captured territory's capacity exactly like
 * `resolveOneArmy` does. The second leg then pays the engine reserve rule
 * again. `secondArrivalTick` is the earliest tick that wave could land, so a
 * deadline miss can never veto a strike.
 */
function canTransitCapture(
  first: AdjacentEnemyThreat,
  firstDefense: number,
  firstTerrain: Territory['terrain'],
  firstCapacity: number,
  secondDefense: number,
  secondTerrain: Territory['terrain'],
  secondArrivalTick: number,
  deadlineTick: number
): boolean {
  if (secondArrivalTick > deadlineTick) return false;
  const firstCost = requiredAttackCost(firstDefense, firstTerrain);
  if (first.available <= firstCost) return false;
  const survivors = Math.min(firstCapacity, first.available - firstCost);
  const secondRequired = requiredAttackCost(secondDefense, secondTerrain);
  return computeDispatch(survivors, 1).available > secondRequired;
}

/**
 * Both transit orders between our source and target:
 *
 *  - Q -> source -> target: the enemy takes the weakened source first, then
 *    strikes the target once our own wave has captured it;
 *  - Q -> target -> source: the enemy recaptures our newly captured target,
 *    then uses it as a staging area against the source.
 *
 * Routing feasibility is the actual edge: the transit needs the two
 * territories to touch, and only then can the second leg be one hop.
 */
function enemyCanTransitBetween(
  state: MatchState,
  source: Territory,
  target: Territory,
  sourceDefense: number,
  targetDefense: number,
  travelTicks: number,
  sourceThreats: AdjacentEnemyThreat[],
  targetThreats: AdjacentEnemyThreat[]
): boolean {
  const hopTicks = directEdgeTicks(state, source.id, target.id);
  if (hopTicks === null) return false;
  const deadline = state.durationTicks;
  const ownArrivalTick = state.tick + travelTicks;

  for (let i = 0; i < sourceThreats.length; i += 1) {
    const first = sourceThreats[i];
    // The source can fall at its own arrival or at our arrival (whichever is
    // later); the second wave can only leave after both have resolved.
    const secondArrival = Math.max(first.arrivalTick, ownArrivalTick) + hopTicks;
    if (
      canTransitCapture(
        first,
        sourceDefense,
        source.terrain,
        source.capacity,
        targetDefense,
        target.terrain,
        secondArrival,
        deadline
      )
    ) {
      return true;
    }
  }

  for (let i = 0; i < targetThreats.length; i += 1) {
    const first = targetThreats[i];
    // The target is still enemy-owned here, so the recapture cannot dispatch
    // before our own wave lands. Its flight time is the threat's own edge.
    const secondArrival = ownArrivalTick + (first.arrivalTick - state.tick) + hopTicks;
    if (
      canTransitCapture(
        first,
        targetDefense,
        target.terrain,
        target.capacity,
        sourceDefense,
        source.terrain,
        secondArrival,
        deadline
      )
    ) {
      return true;
    }
  }
  return false;
}

function isSuicidalAttack(
  state: MatchState,
  owner: PlayerId,
  source: Territory,
  target: Territory,
  sent: number,
  required: number,
  travelTicks: number
): boolean {
  const postSource = source.troops - sent;
  const sourceDefense = postSource + source.shield;
  const deadline = state.durationTicks;
  const sourceCost = requiredAttackCost(sourceDefense, source.terrain);
  const survivors = Math.min(target.capacity, Math.max(0, sent - required));
  const targetCost = requiredAttackCost(survivors, target.terrain);

  const sourceThreats = adjacentEnemyThreats(state, owner, source.id, target.id, deadline);
  const targetThreats = adjacentEnemyThreats(state, owner, target.id, source.id, deadline);
  if (enemyCanCaptureBoth(sourceThreats, sourceCost, targetThreats, targetCost)) return true;
  return enemyCanTransitBetween(
    state,
    source,
    target,
    sourceDefense,
    survivors,
    travelTicks,
    sourceThreats,
    targetThreats
  );
}

function buildAttackCandidates(
  state: MatchState,
  owner: PlayerId,
  rng: Rng,
  topK: number,
  endgame: EndgameContext,
  excludeTargets?: ReadonlySet<string>
): AttackCandidate[] {
  const tuning = AI_TUNING[state.difficulty];
  const out: AttackCandidate[] = [];
  const expansionPhase = ownCount(state, owner) <= 3 && state.tick < state.durationTicks * 0.4;
  // One cached BFS/route context for this planning pass only. Rear sources can
  // reach every target that has an owned frontier, exactly like the validator.
  const reach = cachedReachability(state, owner);

  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const source = state.territories[state.territoryOrder[i]];
    if (source.owner !== owner) continue;
    const dispatch = computeDispatch(source.troops, 1);
    if (dispatch.available < 3) continue;

    for (let t = 0; t < reach.attackTargets.length; t += 1) {
      const targetId = reach.attackTargets[t];
      if (targetId === source.id) continue;
      // Exclude already-planned targets before scoring/Top-K/forecast. Filtering
      // after the cut would let six candidates for the same target consume the
      // whole second-round budget and hide every other legal target.
      if (excludeTargets && excludeTargets.has(targetId)) continue;
      const target = state.territories[targetId];
      if (!target || target.owner === owner) continue;
      // Holding a lead means not spending the last seconds on 1-4 point
      // neutral scraps that cannot change the timed outcome.
      if (
        endgame.active &&
        endgame.posture === 'hold' &&
        target.owner === 'neutral' &&
        target.scoreValue <= 4
      ) {
        continue;
      }
      const movement = reach.plan(source.id, targetId);
      if (!movement) continue;

      const travel = movement.travelTicks;
      const defenders = predictedDefender(target, travel, state) + target.shield;
      const required = requiredAttackCost(defenders, target.terrain);
      if (dispatch.available <= required) continue;

      if (
        usesLegacySimpleTuning(state.difficulty) &&
        target.owner !== 'neutral' &&
        dispatch.available < required + tuning.enemyAttackMargin
      ) {
        continue;
      }

      const pressure = enemyPressure(state, owner, source.id);
      // Guard against credible counter-pressure, not against neutral borders.
      // The old flat 25% guard on every frontier source locked the AI out of
      // expansion whenever all of its owned territory was a frontier (the
      // normal opening): no candidate could both exceed `required` and leave
      // 25% home. Neutrals never counter-attack, so only 1 troop must stay
      // behind; real enemy pressure keeps the larger guard.
      let guard = 0;
      if (isFrontier(state, source.id)) {
        guard =
          pressure >= source.troops
            ? Math.ceil(dispatch.available * 0.5)
            : pressure > 0
              ? Math.ceil(dispatch.available * tuning.guardShare)
              : 1;
      }
      guard = Math.min(guard, Math.max(0, dispatch.available - 1));
      // Protects a lead in the final window: keep a larger home guard instead
      // of exposing the frontier for marginal land.
      if (endgame.active && endgame.posture === 'hold' && pressure > 0) {
        guard = Math.max(guard, Math.ceil(dispatch.available * 0.35));
      }

      const choice = chooseRatio(dispatch.available, required, guard);
      if (!choice) continue;

      let score = attackScore(state, owner, source, target, choice.sent, required, endgame);
      // Double failure is a hard veto, independent of how valuable the target
      // looks. A high-value capture must not buy a way around the guard.
      if (
        tuning.suicideGuard &&
        isSuicidalAttack(state, owner, source, target, choice.sent, required, travel)
      ) {
        continue;
      }
      // Confidence weighting only: a target the enemy can retake with a
      // comfortable margin is worth less, but it is never vetoed for that
      // alone (a real capture is a real capture).
      if (tuning.suicideGuard) {
        const survivors = Math.min(target.capacity, Math.max(0, choice.sent - required));
        const counter = strongestAdjacentEnemyThreat(
          state,
          owner,
          target.id,
          source.id,
          state.durationTicks
        );
        if (
          counter !== null &&
          counter.available >
            requiredAttackCost(survivors, target.terrain) * TARGET_COUNTER_MARGIN
        ) {
          score -= TARGET_COUNTER_SCORE_PENALTY;
        }
      }
      if (expansionPhase && target.owner === 'neutral') score += 30;
      if (usesLegacySimpleTuning(state.difficulty) && target.owner !== 'neutral') score -= 12;
      score += rng.next() * tuning.jitter;

      out.push({
        sourceId: source.id,
        targetId: targetId,
        ratio: choice.ratio,
        sent: choice.sent,
        score: score,
        arrivalTick: state.tick + travel,
      });
    }
  }

  out.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (a.targetId !== b.targetId) return a.targetId < b.targetId ? -1 : 1;
    return a.sourceId < b.sourceId ? -1 : 1;
  });
  if (topK > 0 && out.length > topK) out.length = topK;

  // Hard: bounded short-horizon check on the surviving Top-K candidates. Each
  // one is replayed on a full state copy (with one predicted counter wave) so
  // "will this actually hold?" is measured, not assumed. A failed or invalid
  // replay is dropped, and the score floor is rechecked after every deduction.
  if (state.difficulty === 'hard' && tuning.simSteps > 0) {
    const kept: AttackCandidate[] = [];
    for (let i = 0; i < out.length; i += 1) {
      const candidate = out[i];
      const forecast = forecastAssault(
        state,
        owner,
        [{ sourceId: candidate.sourceId, targetId: candidate.targetId, ratio: candidate.ratio }],
        { counterWaves: tuning.counterWaves, tailTicks: 2 + tuning.simSteps * 2, includeCurrentTick: true }
      );
      // An order the validator rejects is not a candidate at all.
      if (!forecast.ok) continue;
      if (!forecast.captured) candidate.score -= 45;
      else candidate.score += Math.min(20, forecast.garrison) * 0.4;
      if (forecast.lostToCounter) candidate.score -= 16;
      if (
        candidate.score < tuning.attackFloor
      ) {
        continue;
      }
      kept.push(candidate);
    }
    out.length = 0;
    for (let i = 0; i < kept.length; i += 1) out.push(kept[i]);
    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.targetId !== b.targetId) return a.targetId < b.targetId ? -1 : 1;
      return a.sourceId < b.sourceId ? -1 : 1;
    });
  }
  return out;
}

interface TargetSources {
  sources: Array<{ id: string; available: number }>;
}

function sourcesByTarget(
  state: MatchState,
  owner: PlayerId,
  reach: OwnerReachability
): Record<string, TargetSources> {
  const out: Record<string, TargetSources> = {};
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const source = state.territories[state.territoryOrder[i]];
    if (source.owner !== owner) continue;
    const available = computeDispatch(source.troops, 1).available;
    if (available < 2) continue;
    for (let t = 0; t < reach.attackTargets.length; t += 1) {
      const targetId = reach.attackTargets[t];
      if (targetId === source.id) continue;
      if (!reach.plan(source.id, targetId)) continue;
      if (!out[targetId]) out[targetId] = { sources: [] };
      out[targetId].sources.push({ id: source.id, available: available });
    }
  }
  return out;
}

/**
 * Analytic two-wave combat estimate, using the real resolveBattle rule
 * (shield-first failure damage included). It prunes pairs before the (more
 * expensive) pure-copy forecast runs.
 */
function estimatePairCapture(
  defenders: number,
  terrain: Territory['terrain'],
  shield: number,
  firstSent: number,
  secondSent: number
): boolean {
  const first = resolveBattle(defenders, terrain, firstSent, shield);
  if (first.captured) return true;
  const left = first.defenderRemaining + (first.shieldRemaining || 0);
  const secondCost = requiredAttackCost(left, terrain);
  return secondSent > secondCost;
}

function planPairForTarget(
  state: MatchState,
  owner: PlayerId,
  targetId: string,
  sources: Array<{ id: string; available: number }>,
  rng: Rng,
  endgame: EndgameContext
): CoordinatedCandidate | null {
  const target = state.territories[targetId];
  if (!target) return null;
  if (sources.length < 2) return null;
  const predicted = predictedDefender(target, 8, state) + target.shield;
  const tuning = AI_TUNING[state.difficulty];
  let best: CoordinatedCandidate | null = null;

  for (let a = 0; a < sources.length; a += 1) {
    for (let b = 0; b < sources.length; b += 1) {
      if (a === b) continue;
      const first = sources[a];
      const second = sources[b];
      for (let r1 = 0; r1 < AI_RATIO_CHOICES.length; r1 += 1) {
        const ratio1 = AI_RATIO_CHOICES[r1];
        const firstSent = Math.floor(first.available * ratio1);
        if (firstSent < 2) continue;
        for (let r2 = 0; r2 < AI_RATIO_CHOICES.length; r2 += 1) {
          const ratio2 = AI_RATIO_CHOICES[r2];
          const secondSent = Math.floor(second.available * ratio2);
          if (secondSent < 2) continue;
          if (!estimatePairCapture(predicted, target.terrain, target.shield, firstSent, secondSent)) {
            continue;
          }

          let score =
            targetValue(state, owner, target) +
            Math.min(30, Math.max(0, firstSent + secondSent - predicted)) * 0.3 -
            (firstSent + secondSent) * 0.06 +
            rng.next() * tuning.jitter;
          if (endgame.active && endgame.posture === 'push') {
            score += target.scoreValue * (target.owner === 'neutral' ? 0.7 : 1.2);
          }
          if (!best || score > best.score) {
            best = {
              targetId: targetId,
              first: { sourceId: first.id, ratio: ratio1, sent: firstSent },
              second: { sourceId: second.id, ratio: ratio2, sent: secondSent },
              score: score,
            };
          }
        }
      }
    }
  }
  return best;
}

/**
 * Hard-only coordinated strike. The pair is verified on a full state copy with
 * the engine's own arrival/production order; a failed capture is discarded.
 */
function coordinatedCandidate(
  state: MatchState,
  owner: PlayerId,
  rng: Rng,
  endgame: EndgameContext
): CoordinatedCandidate | null {
  const tuning = AI_TUNING[state.difficulty];
  if (tuning.coordination !== 'full') return null;
  if (state.tick < state.durationTicks * tuning.coordinationDelay) return null;
  if (state.durationTicks - state.tick < 300) return null;

  const reach = cachedReachability(state, owner);
  const byTarget = sourcesByTarget(state, owner, reach);
  const targetIds = Object.keys(byTarget);
  if (targetIds.length === 0) return null;

  // Fixed budget: only the most valuable targets are searched for pairs.
  targetIds.sort(function (a, b) {
    const va = targetValue(state, owner, state.territories[a]);
    const vb = targetValue(state, owner, state.territories[b]);
    if (vb !== va) return vb - va;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const limit = Math.min(6, targetIds.length);

  let best: CoordinatedCandidate | null = null;
  for (let t = 0; t < limit; t += 1) {
    const candidate = planPairForTarget(
      state,
      owner,
      targetIds[t],
      byTarget[targetIds[t]].sources,
      rng,
      endgame
    );
    if (!candidate) continue;
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (!best) return null;

  // Step 1: does the two-wave strike actually capture? Verified on a clone.
  const verified = forecastAssault(
    state,
    owner,
    [
      { sourceId: best.first.sourceId, targetId: best.targetId, ratio: best.first.ratio },
      { sourceId: best.second.sourceId, targetId: best.targetId, ratio: best.second.ratio },
    ],
    { counterWaves: 0, tailTicks: 2 + tuning.simSteps * 2, includeCurrentTick: true }
  );
  if (!verified.ok || !verified.captured) return null;

  // Step 2: counter-risk is measured, not assumed. A predicted counter-attack
  // lowers the value of the strike but does not veto it outright.
  if (tuning.counterWaves > 0) {
    const risky = forecastAssault(
      state,
      owner,
      [
        { sourceId: best.first.sourceId, targetId: best.targetId, ratio: best.first.ratio },
        { sourceId: best.second.sourceId, targetId: best.targetId, ratio: best.second.ratio },
      ],
      { counterWaves: tuning.counterWaves, tailTicks: 2 + tuning.simSteps * 2, includeCurrentTick: true }
    );
    if (risky.ok && risky.lostToCounter) best.score -= 18;
  }
  return best;
}

/**
 * Picks one upgrade across all three tracks. Every candidate is validated by
 * the same computeUpgradePlan used for human orders, so the AI never buys an
 * upgrade the player could not buy. Production prefers safe interior economy,
 * march prefers rear staging areas, defense prefers threatened frontier/homes.
 */
function upgradeCommand(
  state: MatchState,
  owner: PlayerId,
  rng: Rng,
  endgame: EndgameContext,
  existingThreat?: ThreatModel
): PlannedCommand | null {
  const tuning = AI_TUNING[state.difficulty];
  if (!tuning.upgrades) return null;
  const secondsLeft = remainingSeconds(state);
  if (secondsLeft < tuning.minUpgradeRemaining) return null;

  // Easy (riskModel=false, defenseRoi=false) never builds a threat model: the
  // legacy pressure path below must stay byte-for-byte equivalent.
  let threat: ThreatModel | null = null;
  if (tuning.riskModel || tuning.defenseRoi) {
    threat =
      existingThreat ||
      createThreatModel(state, owner, cachedReachability(state, owner), tuning.doomedRatio);
  }
  let best: Territory | null = null;
  let bestKind: UpgradeKind = 'production';
  let bestScore = -Infinity;
  const kinds: UpgradeKind[] = ['production', 'march', 'defense'];

  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    if (territory.owner !== owner) continue;
    const interior = isInterior(state, owner, territory.id);
    const frontier = isFrontier(state, territory.id);
    // risk.pressure and enemyPressure are the same quantity; the cheap edge
    // scan avoids measuring every territory through the threat model.
    const pressure = enemyPressure(state, owner, territory.id);
    const home = isHome(state, owner, territory.id);

    for (let k = 0; k < kinds.length; k += 1) {
      const kind = kinds[k];
      // Track compatibility first: production/march only exist on interior
      // ground, defence never does. This is the same gate as below, just before
      // the (more expensive) plan and risk work.
      if (kind === 'defense' ? interior : !interior) continue;
      const plan = computeUpgradePlan(state, owner, territory.id, kind);
      if (!plan.ok) continue;
      const cost = plan.cost;
      let score = -Infinity;
      // Only the defence track needs the threat model (and only with ROI on).
      const measurement =
        kind === 'defense' && tuning.defenseRoi && threat
          ? threat.risk(territory.id)
          : null;

      // Upgrades must not strip a garrison below its credible threat floor.
      // A safe frontier keeps a small expansion reserve instead of being pushed
      // to full capacity; defence may count the shield it buys.
      const post = territory.troops - cost;
      if (kind === 'defense') {
        const shieldGain =
          SHIELD_CAPACITY[plan.nextLevel as 0 | 1 | 2] -
          SHIELD_CAPACITY[plan.currentLevel as 0 | 1 | 2];
        if (tuning.defenseRoi) {
          if (!measurement) continue;
          const strongest = measurement.strongestEnemy;
          if (strongest <= 0) continue;
          // Real defence after paying: garrison loss + existing shield + the
          // shield this upgrade actually adds. Comparing only `post + gain`
          // threw away the existing shield and made 1->2 look 12 points weaker
          // than it is.
          const realDefenseAfter = post + territory.shield + shieldGain;
          if (requiredAttackCost(realDefenseAfter, territory.terrain) < strongest) continue;
          // A bare wall (0->1) converts troops into shield at unchanged total
          // defence, so it is only a home-front investment. A cannon (1->2)
          // adds damage on top; buy it where the front is actually under
          // threat (or at home), not on every quiet border.
          const isTower = plan.nextLevel === 2;
          const underThreat =
            measurement.requiredNow < measurement.strongestEnemy || measurement.risk >= 1;
          if (!isTower && !home) continue;
          if (isTower && !home && !underThreat) continue;
          if (realDefenseAfter < Math.ceil(measurement.defense * 0.5)) continue;
          // A front that is already lost does not get a tombstone wall. This
          // strict check is the expensive one, so it runs last.
          if (measurement.doomed) continue;
        } else {
          const reserve = pressure > 0 ? pressure + 3 : frontier ? 3 : 1;
          if (post + shieldGain < reserve) continue;
        }
      } else {
        const reserve = pressure > 0 ? pressure + 3 : frontier ? 3 : 1;
        if (post < reserve) continue;
      }

      if (kind === 'production') {
        // Effective rates: a casual solo AI handicap must also lower the
        // payback it expects from its own production upgrade.
        const from = effectiveProductionRate(plan.currentLevel as 1 | 2 | 3, state, owner);
        const to = effectiveProductionRate(plan.nextLevel as 1 | 2 | 3, state, owner);
        const paybackSeconds = cost / Math.max(0.01, to - from);
        if (secondsLeft < paybackSeconds * tuning.upgradePayback + tuning.minUpgradeRemaining) {
          continue;
        }
        // Economy only behind a real own-territory buffer. Under the v0.4
        // any-frontier rule a border territory is always a valid enemy target,
        // so spending 10-20 troops there starved expansion in the opening.
        if (!interior) continue;
        score = -cost * 0.25 + territory.troops * 0.2;
        if (interior) score += 12;
        if (plan.currentLevel === 1) score += 4;
        score -= pressure * 0.4;
      } else if (kind === 'march') {
        if (secondsLeft < tuning.minUpgradeRemaining + 20) continue;
        // March is a rear/support investment. Under the new rule every border
        // territory can be attacked from any owned enemy frontier, so only a
        // fully surrounded interior staging area is a safe place to spend
        // troops on speed.
        if (!interior) continue;
        const gain =
          MARCH_SPEED_MULTIPLIER[plan.nextLevel as 1 | 2 | 3] -
          MARCH_SPEED_MULTIPLIER[plan.currentLevel as 1 | 2 | 3];
        score = 8 + gain * 22 - cost * 0.15;
        if (interior) score += 10;
        score -= pressure * 0.3;
      } else {
        if (secondsLeft < tuning.minUpgradeRemaining + 10) continue;
        if (interior) continue;
        // A wall/cannon is only worth buying against a credible enemy. Being a
        // home territory is not pressure by itself: the opening map has no
        // adjacent enemy, and the old home bonus drained 20-32 troops into
        // peacetime defence while expansion was starved.
        if (tuning.defenseRoi) {
          if (!measurement || measurement.strongestEnemy <= 0) continue;
        } else if (pressure <= 0) {
          // Legacy gate: easy only buys defence where enemy pressure exists.
          continue;
        }
        if (!frontier && !home) continue;
        score = 6 + Math.min(30, pressure) * 0.8 - cost * 0.2;
        if (home) score += 18;
        if (plan.currentLevel === 0) score += 6;
        if (plan.nextLevel === 2) score += SHIELD_CAPACITY[2] * 0.2;
        if (tuning.defenseRoi && measurement) {
          // Threatened fronts outrank safe rear economy: a wall/tower protects
          // the garrison that actually holds the line.
          if (measurement.risk >= 1) score += 12;
          if (measurement.strongestEnemy > measurement.requiredNow) score += 8;
          if (measurement.projectedDefense < measurement.strongestEnemy) score += 6;
          if (endgame.active && endgame.posture === 'hold') score += 6;
        }
      }

      score += rng.next() * tuning.jitter;
      if (score > bestScore) {
        bestScore = score;
        best = territory;
        bestKind = kind;
      }
    }
  }
  if (!best) return null;
  return {
    type: 'upgrade',
    owner: owner,
    sourceId: best.id,
    targetId: best.id,
    ratio: 0,
    sent: 0,
    score: bestScore,
    reason: bestKind,
    kind: bestKind,
  };
}

function mostThreatenedFrontier(
  state: MatchState,
  owner: PlayerId,
  threat: ThreatModel
): { territory: Territory; risk: number } | null {
  const tuning = AI_TUNING[state.difficulty];
  if (!tuning.riskModel) {
    let legacyBest: { territory: Territory; risk: number } | null = null;
    for (let i = 0; i < state.territoryOrder.length; i += 1) {
      const territory = state.territories[state.territoryOrder[i]];
      if (territory.owner !== owner || !isFrontier(state, territory.id)) continue;
      const pressure = enemyPressure(state, owner, territory.id);
      const risk = pressure > 0 ? pressure / Math.max(1, territory.troops) : 0;
      if (risk <= 0) continue;
      if (!legacyBest || risk > legacyBest.risk) {
        legacyBest = { territory: territory, risk: risk };
      }
    }
    return legacyBest;
  }

  // Rank all fronts first (cheap), then run the expensive doom check only on
  // the candidates that can actually win, in descending risk order.
  const ranked: Array<{ territory: Territory; risk: number; order: number }> = [];
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    if (territory.owner !== owner) continue;
    if (!isFrontier(state, territory.id)) {
      // A currently protected border can still have a hostile wave scheduled
      // after its truce expires. That committed wave needs the same defence
      // planning as an ordinary live frontier.
      const hostileInbound = state.armies.some(function (army) {
        return army.targetId === territory.id &&
          isHostileAt(state.diplomacy, Math.max(state.tick, army.arrivalTick), owner, army.owner);
      });
      if (!hostileInbound) continue;
    }
    const measurement = threat.risk(territory.id);
    if (measurement.risk <= 0) continue;
    ranked.push({ territory: territory, risk: measurement.risk, order: i });
  }
  ranked.sort(function (a, b) {
    if (b.risk !== a.risk) return b.risk - a.risk;
    return a.order - b.order;
  });
  for (let i = 0; i < ranked.length; i += 1) {
    // A doomed front cannot be saved by feeding it; its troops are handled by
    // strategic contraction instead.
    if (threat.risk(ranked[i].territory.id).doomed) continue;
    return { territory: ranked[i].territory, risk: ranked[i].risk };
  }
  return null;
}

/**
 * Legacy reinforcement (pre-risk-model): pick the threatened front by raw
 * pressure and send 70% of the best source's spare. Kept as the exact gated
 * fallback for riskModel=false just like mostThreatenedFrontier.
 */
function legacyReinforceCommand(
  state: MatchState,
  owner: PlayerId,
  reach: OwnerReachability,
  threat: ThreatModel
): PlannedCommand | null {
  const threatened = mostThreatenedFrontier(state, owner, threat);
  if (!threatened || threatened.risk < 1.25) return null;
  const target = threatened.territory;

  let bestSource: Territory | null = null;
  let bestSend = 0;
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const candidate = state.territories[state.territoryOrder[i]];
    if (candidate.owner !== owner) continue;
    if (candidate.id === target.id) continue;
    if (!reach.plan(candidate.id, target.id)) continue;
    const available = computeDispatch(candidate.troops, 1).available;
    const spare = isInterior(state, owner, candidate.id)
      ? available
      : candidate.troops - target.troops - 8;
    if (spare < 5) continue;
    const send = Math.floor(spare * 0.7);
    if (send > bestSend) {
      bestSend = send;
      bestSource = candidate;
    }
  }
  if (!bestSource) return null;

  const available = computeDispatch(bestSource.troops, 1).available;
  let ratio = Math.min(1, bestSend / Math.max(1, available));
  ratio = Math.max(0.2, Math.round(ratio * 100) / 100);
  const plan = computeMovePlan(state, owner, bestSource.id, target.id, ratio);
  if (!plan.ok) return null;
  return {
    type: 'move',
    owner: owner,
    sourceId: bestSource.id,
    targetId: target.id,
    ratio: ratio,
    sent: plan.dispatch.sent,
    score: threatened.risk * 10,
    reason: 'reinforce',
  };
}

function reinforceCommand(
  state: MatchState,
  owner: PlayerId,
  reach: OwnerReachability,
  threat: ThreatModel
): PlannedCommand | null {
  const tuning = AI_TUNING[state.difficulty];
  if (!tuning.reinforce) return null;
  if (!tuning.riskModel) {
    return legacyReinforceCommand(state, owner, reach, threat);
  }

  const threatened = mostThreatenedFrontier(state, owner, threat);
  if (!threatened || threatened.risk < 1) return null;
  const target = threatened.territory;
  const info = threat.risk(target.id);
  // Close the measurable gap instead of sending a blind 70% of every spare.
  const gap = info.crediblePressure - info.projectedDefense;
  if (gap <= 0) return null;
  // A source that cannot land before the first credible wave is normally a
  // troop sink. An already committed enemy wave is the deliberate exception:
  // it may open real capacity before the help lands, so evaluate that case per
  // source below instead of rejecting the whole front here.
  const needed = Math.max(3, Math.ceil(gap) + 3);

  let bestSource: Territory | null = null;
  let bestSend = 0;
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const candidate = state.territories[state.territoryOrder[i]];
    if (candidate.owner !== owner) continue;
    if (candidate.id === target.id) continue;
    // Reinforcement follows the same frontier rule: the target must touch an
    // owned territory, but the source may sit anywhere in an owned component
    // (or bridge a disconnected component) exactly like an attack order.
    const movement = reach.plan(candidate.id, target.id);
    if (!movement) continue;
    const arrivalTick = state.tick + movement.travelTicks;
    if (arrivalTick > state.durationTicks) continue;
    const projection = projectTargetArrival(
      state,
      owner,
      target.id,
      arrivalTick,
      state.nextArmyId
    );
    if (!projection) continue;
    // A real hostile wave that has already landed is represented only by the
    // projection. A hypothetical or later threat may decide whether a source
    // is timely, but it can never manufacture landing space for a full target.
    // A candidate that arrives before the first credible wave is valid when it
    // has real room now; a candidate after an uncommitted earlier wave is too
    // late unless the projection proves a real enemy landed first.
    if (
      info.crediblePressure > 0 &&
      !projection.enemyBefore &&
      info.enemyArrivalTick < arrivalTick
    ) {
      continue;
    }
    const available = computeDispatch(candidate.troops, 1).available;
    if (available < 1) continue;
    // Projected space includes production and every existing friendly wave. A
    // full target is an emergency destination only when an actual hostile wave
    // has opened room (or captured the target before this order lands).
    if (projection.ownerAtArrival === owner && projection.spaceAtArrival <= 0) continue;
    const spaceAtArrival = projection.spaceAtArrival;
    const sourceInfo = threat.risk(candidate.id);

    // Never strip one live front to feed another. A front that still holds
    // comfortably may send half its spare; an already-losing front only sends
    // what is surplus to its own credible attackers.
    let spare = available;
    if (!isInterior(state, owner, candidate.id) && sourceInfo.crediblePressure > 0) {
      spare =
        sourceInfo.risk < 1.25
          ? Math.floor(available * 0.5)
          : Math.max(0, candidate.troops - Math.ceil(sourceInfo.crediblePressure) - 2);
    }
    if (spare < 1) continue;
    // Only pay for the strict doom check on sources that would actually send.
    if (sourceInfo.doomed) continue;
    let send = Math.min(spare, needed);
    if (projection.ownerAtArrival === owner) {
      // This cap applies even when the enemy arrives first: only the room it
      // really creates can accept the reinforcement without overflow.
      send = Math.min(send, spaceAtArrival);
    }
    if (send < 1) continue;
    if (send > bestSend) {
      bestSend = send;
      bestSource = candidate;
    }
  }
  if (!bestSource) return null;

  const available = computeDispatch(bestSource.troops, 1).available;
  // Reinforcement is capacity-bound, so use the exact ratio needed for the
  // measured gap instead of rounding up to the next coarse attack ratio.
  const ratio = Math.max(0.01, Math.min(1, bestSend / Math.max(1, available)));
  const plan = computeMovePlan(state, owner, bestSource.id, target.id, ratio);
  if (!plan.ok || plan.dispatch.sent <= 0) return null;
  return {
    type: 'move',
    owner: owner,
    sourceId: bestSource.id,
    targetId: target.id,
    ratio: ratio,
    sent: plan.dispatch.sent,
    score: threatened.risk * 10,
    reason: 'reinforce',
  };
}

function moveCommand(owner: PlayerId, sourceId: string, targetId: string, ratio: number, sent: number, score: number, reason: string): PlannedCommand {
  return {
    type: 'move',
    owner: owner,
    sourceId: sourceId,
    targetId: targetId,
    ratio: ratio,
    sent: sent,
    score: score,
    reason: reason,
  };
}

/**
 * Builds the decision batch for one owner. Pure: it never mutates the live
 * state. Later commands in the same batch are planned on a working clone that
 * already contains the earlier commands, so two orders from one source can
 * never spend the same troops twice, and every `sent` is the real value.
 *
 * Coordination budget: a two-source strike is emitted as TWO move commands
 * (`coordinated: true` on the second), so hard never exceeds maxCommands.
 */
export function planAiCommands(
  state: MatchState,
  owner: PlayerId,
  rng: Rng,
  options?: AiDecisionOptions
): AiDecision {
  const tuning = AI_TUNING[state.difficulty];
  const maxCommands = options && options.maxCommands !== undefined
    ? options.maxCommands
    : tuning.maxCommands;
  const work = cloneMatchState(state);
  const endgame = endgameContext(work, owner, tuning.endgameSeconds);
  const commands: PlannedCommand[] = [];
  let candidateCount = 0;
  // March upgrades change the source's frozen travel time, so cached routes
  // stop being valid. Ownership never changes inside one pass.
  let reachStale = false;

  function record(command: PlannedCommand): boolean {
    if (commands.length >= maxCommands) return false;
    if (command.type === 'upgrade') {
      const result = applyUpgrade(work, owner, command.sourceId, command.kind);
      if (!result.ok) return false;
      if (command.kind === 'march') reachStale = true;
      commands.push(command);
      return true;
    }
    const destination = work.territories[command.targetId];
    let ratio = command.ratio;
    let plan = computeMovePlan(work, owner, command.sourceId, command.targetId, ratio);
    if (!plan.ok) return false;
    if (
      destination &&
      destination.owner === owner &&
      (command.reason === 'reinforce' || command.reason === 'retreat')
    ) {
      const movement = plan.movement;
      if (!movement) return false;
      const projection = projectTargetArrival(
        work,
        owner,
        destination.id,
        work.tick + movement.travelTicks,
        work.nextArmyId
      );
      if (!projection) return false;
      if (projection.ownerAtArrival === owner && projection.spaceAtArrival <= 0) {
        // A previous command in this same batch may already occupy the only
        // remaining space. Do not create a paid army that the landing phase will
        // discard.
        return false;
      }
      if (
        projection.ownerAtArrival === owner &&
        plan.dispatch.sent > projection.spaceAtArrival
      ) {
        const available = plan.dispatch.available;
        ratio = Math.min(ratio, projection.spaceAtArrival / Math.max(1, available));
        plan = computeMovePlan(work, owner, command.sourceId, command.targetId, ratio);
        if (!plan.ok || plan.dispatch.sent <= 0 || plan.dispatch.sent > projection.spaceAtArrival) {
          return false;
        }
      }
    }
    const result = applyMove(work, owner, command.sourceId, command.targetId, ratio);
    if (!result.ok) return false;
    commands.push({
      type: 'move',
      owner: owner,
      sourceId: command.sourceId,
      targetId: command.targetId,
      ratio: ratio,
      sent: result.sent,
      score: command.score,
      reason: command.reason,
      coordinated: command.coordinated,
    });
    return true;
  }

  // Use the existing per-pass budget for expansion: hard has two command slots,
  // and spending the second on an upgrade while a second legal attack exists
  // was the main reason it issued ~10 moves/game versus greedy's ~67. After each
  // accepted order the working clone already has the troops removed, so the
  // next candidate is rebuilt and validated against that updated clone; stale
  // ratio/sent values from the first pass can never double-spend a source.
  const plannedTargets = new Set<string>();
  while (commands.length < maxCommands) {
    const candidates = buildAttackCandidates(
      work,
      owner,
      rng,
      tuning.topK,
      endgame,
      plannedTargets
    );
    if (candidates.length > candidateCount) candidateCount = candidates.length;
    if (candidates.length === 0) break;
    const candidate = candidates[0];
    const accepted = record(
      moveCommand(
        owner,
        candidate.sourceId,
        candidate.targetId,
        candidate.ratio,
        candidate.sent,
        candidate.score,
        'attack'
      )
    );
    if (!accepted) break;
    // Deliberate two-source strikes stay on the coordination path; independent
    // orders never pile onto the same target by accident.
    plannedTargets.add(candidate.targetId);
  }

  // Hard: a target that no single source can crack may fall to two sources.
  // It costs two command slots, so only schedule it when both still fit. The
  // pair was forecast on `work`, which already includes any earlier command.
  if (
    tuning.coordination === 'full' &&
    commands.length + 2 <= maxCommands
  ) {
    const pair = coordinatedCandidate(work, owner, rng, endgame);
    if (pair) {
      const firstOk = record(
        moveCommand(owner, pair.first.sourceId, pair.targetId, pair.first.ratio, pair.first.sent, pair.score, 'coordinated:1/2')
      );
      if (firstOk) {
        const second = moveCommand(owner, pair.second.sourceId, pair.targetId, pair.second.ratio, pair.second.sent, pair.score, 'coordinated:2/2');
        second.coordinated = true;
        record(second);
      }
    }
  }

  // Threat, contraction, defence and defence-reinforcement only use the
  // remaining slots. The model is built lazily here, after the attack loop, so
  // a pass whose slots are both spent on attacks never pays for it. Easy has
  // none of the flags and follows the legacy path exactly.
  // No enemy contact means no legal attack: a target is only reachable when it
  // touches an enemy-owned territory (or an enemy army is already inbound).
  // Skipping the model is then behaviour-identical and cheap. Adjacency, not
  // available troops, is the test: a 1-troop neighbour can still host a rear
  // stack's attack under the v0.4 frontier rule.
  let anyPressure = false;
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    const from = state.territories[edge.from];
    const to = state.territories[edge.to];
    if (!from || !to) continue;
    if (
      (from.owner === owner && isEnemyOf(owner, to.owner, work)) ||
      (to.owner === owner && isEnemyOf(owner, from.owner, work))
    ) {
      anyPressure = true;
      break;
    }
  }
  if (!anyPressure) {
    for (let i = 0; i < state.armies.length; i += 1) {
      const army = state.armies[i];
      const target = state.territories[army.targetId];
      if (
        target &&
        target.owner === owner &&
        isHostileAt(work.diplomacy, Math.max(work.tick, army.arrivalTick), owner, army.owner)
      ) {
        anyPressure = true;
        break;
      }
    }
  }
  const needsThreat =
    anyPressure &&
    (tuning.reinforce || tuning.retreat || tuning.riskModel || tuning.defenseRoi);
  // Enemy routing is ownership-only and therefore valid for the whole pass.
  const threatCache: ThreatModelCache = {};
  let ownReach: OwnerReachability | null = null;
  let threat: ThreatModel | null = null;

  function ensureThreat(): boolean {
    if (!needsThreat) return false;
    if (threat) return true;
    if (!ownReach || reachStale) ownReach = cachedReachability(work, owner);
    threat = createThreatModel(work, owner, ownReach, tuning.doomedRatio, threatCache);
    return true;
  }
  function dropThreat(): void {
    threat = null;
  }

  // Strategic contraction: pull the garrison out of a doomed edge territory
  // instead of letting it die in place. The troops move to the best living
  // territory (usually an interior staging area or a healthy front).
  if (tuning.retreat && commands.length < maxCommands && ensureThreat()) {
    const retreat = contractionCommand(work, owner, threat!, ownReach!, tuning.retreatMinTroops);
    if (retreat && record(retreat)) dropThreat();
  }

  // Threat-first reinforcement: a frontier that can still be saved gets a
  // slot before peaceful upgrades.
  if (tuning.reinforce && commands.length < maxCommands && ensureThreat()) {
    const threatened = mostThreatenedFrontier(work, owner, threat!);
    if (threatened && threatened.risk >= 1.2) {
      const reinforce = reinforceCommand(work, owner, ownReach!, threat!);
      if (reinforce && record(reinforce)) dropThreat();
    }
  }

  if (commands.length < maxCommands) {
    const upgrade = upgradeCommand(work, owner, rng, endgame, threat || undefined);
    if (upgrade && record(upgrade)) dropThreat();
  }
  if (commands.length < maxCommands && tuning.reinforce && ensureThreat()) {
    const reinforce = reinforceCommand(work, owner, ownReach!, threat!);
    if (reinforce) record(reinforce);
  }

  return {
    owner: owner,
    tick: state.tick,
    difficulty: state.difficulty,
    commands: commands.slice(0, maxCommands),
    receipts: [],
    candidateCount: candidateCount,
  };
}

function executeCommand(
  state: MatchState,
  owner: PlayerId,
  command: PlannedCommand
): CommandReceipt {
  if (command.type === 'upgrade') {
    const result = applyUpgrade(state, owner, command.sourceId, command.kind);
    return {
      command: command,
      accepted: result.ok,
      reason: result.ok ? undefined : result.reason,
    };
  }
  // Recompute against the live state: the receipt must report what actually
  // left the source, never the planned estimate.
  const plan = computeMovePlan(state, owner, command.sourceId, command.targetId, command.ratio);
  const sent = plan.dispatch.sent;
  const result = applyMove(state, owner, command.sourceId, command.targetId, command.ratio);
  return {
    command: {
      type: 'move',
      owner: owner,
      sourceId: command.sourceId,
      targetId: command.targetId,
      ratio: command.ratio,
      sent: result.ok ? result.sent : sent,
      score: command.score,
      reason: command.reason,
      coordinated: command.coordinated,
    },
    accepted: result.ok,
    reason: result.ok ? undefined : result.reason,
  };
}

/**
 * One decision pass for a single actor, applied through the unified validators.
 * Used by the engine (ai1/ai2), the benchmark harness for any playerId, and
 * tests. `force` bypasses only the cadence/wait dice, never validation.
 */
export function runAiForOwner(
  state: MatchState,
  owner: PlayerId,
  rng: Rng,
  options?: AiDecisionOptions
): AiDecision {
  const tuning = AI_TUNING[state.difficulty];
  const force = !!(options && options.force);
  const empty: AiDecision = {
    owner: owner,
    tick: state.tick,
    difficulty: state.difficulty,
    commands: [],
    receipts: [],
    candidateCount: 0,
  };
  if (state.status !== 'playing' && !force) return empty;
  if (state.tick <= 0 && !force) return empty;
  if (!force) {
    const offset = Math.max(0, state.activeOwners.indexOf(owner)) * 3;
    if ((state.tick + offset) % tuning.decisionTicks !== 0) return empty;
    if (rng.chance(tuning.waitChance)) return empty;
  }

  const decision = planAiCommands(state, owner, rng, options);
  const receipts: CommandReceipt[] = [];
  const executed: PlannedCommand[] = [];
  for (let i = 0; i < decision.commands.length; i += 1) {
    const receipt = executeCommand(state, owner, decision.commands[i]);
    receipts.push(receipt);
    if (receipt.accepted) executed.push(receipt.command);
  }
  return {
    owner: owner,
    tick: state.tick,
    difficulty: state.difficulty,
    commands: executed,
    receipts: receipts,
    candidateCount: decision.candidateCount,
  };
}

/**
 * Runs every non-player owner for this tick with the built-in cadence. All
 * commands pass the unified validators and atomic apply functions.
 */
export function runAi(
  state: MatchState,
  rng: Rng,
  options?: { actors?: PlayerId[] }
): void {
  if (state.status !== 'playing') return;
  if (state.tick <= 0) return;
  const actors = options && options.actors ? options.actors : state.activeOwners;
  for (let i = 0; i < actors.length; i += 1) {
    if (actors[i] === 'player') continue;
    runAiForOwner(state, actors[i], rng);
    if (state.status !== 'playing') return;
  }
}
