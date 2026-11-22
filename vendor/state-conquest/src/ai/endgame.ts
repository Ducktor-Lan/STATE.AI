import {
  computeScores,
  computeTerritoryCounts,
  computeTotalForces,
} from '../core/score';
import type { MatchState, PlayerId } from '../core/types';
import { remainingSeconds } from './evaluate';

export type EndgamePosture = 'push' | 'hold' | 'even';

/**
 * Time-out outcome is scoreValue -> territory count -> total force. Inside the
 * final window the AI should optimise that tuple relative to the strongest
 * opponent, not the absolute number of territories it owns.
 */
export interface EndgameContext {
  active: boolean;
  secondsLeft: number;
  ourScore: number;
  opponentScore: number;
  scoreGap: number;
  ourTerritories: number;
  opponentTerritories: number;
  territoryGap: number;
  ourForce: number;
  opponentForce: number;
  forceGap: number;
  /** push = behind, hold = ahead, even = identical tuple. */
  posture: EndgamePosture;
}

function compareTuple(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

export function endgameContext(
  state: MatchState,
  owner: PlayerId,
  windowSeconds: number
): EndgameContext {
  const scores = computeScores(state);
  const counts = computeTerritoryCounts(state);
  const forces = computeTotalForces(state);
  // ai3 is optional in FactionTotals so legacy fixtures compile; the formal
  // compute functions always fill it, and 0 is its true inactive value.
  const ours = [scores[owner] ?? 0, counts[owner] ?? 0, forces[owner] ?? 0];

  let opponent = [0, 0, 0];
  let found = false;
  for (let i = 0; i < state.activeOwners.length; i += 1) {
    const other = state.activeOwners[i];
    if (other === owner) continue;
    const candidate = [scores[other] ?? 0, counts[other] ?? 0, forces[other] ?? 0];
    if (!found || compareTuple(candidate, opponent) > 0) {
      opponent = candidate;
      found = true;
    }
  }

  const verdict = found ? compareTuple(ours, opponent) : 1;
  return {
    active: windowSeconds > 0 && remainingSeconds(state) <= windowSeconds,
    secondsLeft: remainingSeconds(state),
    ourScore: ours[0],
    opponentScore: opponent[0],
    scoreGap: ours[0] - opponent[0],
    ourTerritories: ours[1],
    opponentTerritories: opponent[1],
    territoryGap: ours[1] - opponent[1],
    ourForce: ours[2],
    opponentForce: opponent[2],
    forceGap: ours[2] - opponent[2],
    posture: verdict > 0 ? 'hold' : verdict < 0 ? 'push' : 'even',
  };
}
