import { AI_RATIO_CHOICES } from '../config/balance';
import { computeDispatch } from '../core/dispatch';
import type { OwnerReachability } from '../core/reachability';
import type { MatchState, PlayerId } from '../core/types';
import { isFrontier, isInterior, projectTargetArrival } from './evaluate';
import type { ThreatModel } from './risk';
import type { PlannedCommand } from './types';

interface RetreatTarget {
  id: string;
  ratio: number;
  sent: number;
  score: number;
}

/**
 * Strategic contraction. A doomed frontier is going to fall whether or not it
 * receives more troops; the old planner still poured reinforcement into it.
 * Instead, pull part of its garrison into a living territory (the frontier
 * rule allows a move to any owned target connected to ours).
 *
 * Returns at most one command: the most valuable evacuation across all doomed
 * fronts. Pure and deterministic.
 */
export function contractionCommand(
  state: MatchState,
  owner: PlayerId,
  threat: ThreatModel,
  reach: OwnerReachability,
  minTroops: number
): PlannedCommand | null {
  let bestSourceId = '';
  let bestTarget: RetreatTarget | null = null;
  let bestUrgency = -Infinity;

  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const source = state.territories[state.territoryOrder[i]];
    if (source.owner !== owner) continue;
    const available = computeDispatch(source.troops, 1).available;
    if (available < minTroops) continue;
    const risk = threat.risk(source.id);
    // Contract only when nothing can land in time and the flood is genuinely
    // overwhelming; otherwise the slot is better spent holding or attacking.
    // These cheap gates run before the lazy strict doom check.
    if (risk.risk < 2 || risk.timelyReinforcement > 0) continue;
    if (!risk.doomed) continue;
    // Only isolated edge territories are contracted: a front with two or more
    // owned neighbours is part of the line and abandoning it opens a hole.
    if (ownedNeighbors(state, owner, source.id) !== 1) continue;
    // Retreating from a two-territory position just collapses the last front.
    if (ownedTerritories(state, owner) < 3) continue;

    const target = bestRetreatTarget(state, owner, source.id, available, threat, reach);
    if (!target) continue;
    // Prefer the front in most immediate danger, then the larger save.
    const urgency = risk.risk * 10 + available * 0.1;
    if (urgency > bestUrgency) {
      bestUrgency = urgency;
      bestSourceId = source.id;
      bestTarget = target;
    }
  }

  if (!bestTarget) return null;
  return {
    type: 'move',
    owner: owner,
    sourceId: bestSourceId,
    targetId: bestTarget.id,
    ratio: bestTarget.ratio,
    sent: bestTarget.sent,
    score: bestTarget.score,
    reason: 'retreat',
  };
}

function bestRetreatTarget(
  state: MatchState,
  owner: PlayerId,
  sourceId: string,
  available: number,
  threat: ThreatModel,
  reach: OwnerReachability
): RetreatTarget | null {
  let best: RetreatTarget | null = null;
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const target = state.territories[state.territoryOrder[i]];
    if (target.owner !== owner || target.id === sourceId) continue;
    const targetRisk = threat.risk(target.id);
    if (targetRisk.risk >= 1.25 || targetRisk.doomed) continue;
    const movement = reach.plan(sourceId, target.id);
    if (!movement) continue;
    const projection = projectTargetArrival(
      state,
      owner,
      target.id,
      state.tick + movement.travelTicks,
      state.nextArmyId
    );
    if (!projection || projection.ownerAtArrival !== owner) continue;
    // Capacity is evaluated at the actual landing tick. Existing friendly
    // waves and production can consume today's visible room before a retreat
    // arrives, so a full target is never a valid overflow sink.
    const space = projection.spaceAtArrival;
    if (space < 1) continue;

    // Save at most half the garrison: if the doom estimate is wrong the front
    // still has a chance to hold, and the saved half is a real reserve.
    const saveCap = Math.min(space, Math.ceil(available * 0.5));
    let ratio = 0;
    let sent = 0;
    for (let r = AI_RATIO_CHOICES.length - 1; r >= 0; r -= 1) {
      const candidateRatio = AI_RATIO_CHOICES[r];
      const candidateSent = Math.floor(available * candidateRatio);
      if (candidateSent > 0 && candidateSent <= saveCap) {
        ratio = candidateRatio;
        sent = candidateSent;
        break;
      }
    }
    if (sent <= 0) continue;

    let score = 20 + target.scoreValue * 0.4 + Math.min(40, space) * 0.25;
    if (isInterior(state, owner, target.id)) score += 24;
    else if (isFrontier(state, target.id)) score += 6;
    score -= targetRisk.risk * 18;
    score -= movement.travelTicks * 0.15;
    if (!best || score > best.score) {
      best = { id: target.id, ratio: ratio, sent: sent, score: score };
    }
  }
  return best;
}

function ownedNeighbors(state: MatchState, owner: PlayerId, territoryId: string): number {
  let count = 0;
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    let neighborId = '';
    if (edge.from === territoryId) neighborId = edge.to;
    else if (edge.to === territoryId) neighborId = edge.from;
    else continue;
    const neighbor = state.territories[neighborId];
    if (neighbor && neighbor.owner === owner) count += 1;
  }
  return count;
}

function ownedTerritories(state: MatchState, owner: PlayerId): number {
  let count = 0;
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    if (state.territories[state.territoryOrder[i]].owner === owner) count += 1;
  }
  return count;
}
