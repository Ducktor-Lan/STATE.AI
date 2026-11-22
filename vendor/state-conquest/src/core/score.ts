import type {
  FactionTotals,
  MatchResult,
  MatchState,
  PlayerId,
} from './types';

const FACTION_KEYS: PlayerId[] = ['player', 'ai1', 'ai2', 'ai3'];

function countTerritoriesFor(state: MatchState, owner: PlayerId): number {
  let count = 0;
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    if (state.territories[state.territoryOrder[i]].owner === owner) count += 1;
  }
  return count;
}

function scoreFor(state: MatchState, owner: PlayerId): number {
  let score = 0;
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    if (territory.owner === owner) score += territory.scoreValue;
  }
  return score;
}

function totalForceFor(state: MatchState, owner: PlayerId): number {
  let force = 0;
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    if (territory.owner === owner) force += territory.troops;
  }
  for (let i = 0; i < state.armies.length; i += 1) {
    if (state.armies[i].owner === owner) force += state.armies[i].troops;
  }
  return force;
}

export function computeScores(state: MatchState): FactionTotals {
  return {
    player: scoreFor(state, 'player'),
    ai1: scoreFor(state, 'ai1'),
    ai2: scoreFor(state, 'ai2'),
    // Always filled: an unseated/inactive faction owns nothing, so this is 0.
    ai3: scoreFor(state, 'ai3'),
  };
}

export function computeTerritoryCounts(state: MatchState): FactionTotals {
  return {
    player: countTerritoriesFor(state, 'player'),
    ai1: countTerritoriesFor(state, 'ai1'),
    ai2: countTerritoriesFor(state, 'ai2'),
    ai3: countTerritoriesFor(state, 'ai3'),
  };
}

export function computeTotalForces(state: MatchState): FactionTotals {
  return {
    player: totalForceFor(state, 'player'),
    ai1: totalForceFor(state, 'ai1'),
    ai2: totalForceFor(state, 'ai2'),
    ai3: totalForceFor(state, 'ai3'),
  };
}

/** Alive = owns at least one territory OR still has an army in flight. */
export function isFactionAlive(state: MatchState, owner: PlayerId): boolean {
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    if (state.territories[state.territoryOrder[i]].owner === owner) return true;
  }
  for (let i = 0; i < state.armies.length; i += 1) {
    if (state.armies[i].owner === owner) return true;
  }
  return false;
}

export function opponentOwners(state: MatchState): PlayerId[] {
  const out: PlayerId[] = [];
  for (let i = 0; i < state.activeOwners.length; i += 1) {
    if (state.activeOwners[i] !== 'player') out.push(state.activeOwners[i]);
  }
  return out;
}

/**
 * Early elimination check. Neutral territories never count as a surviving
 * faction; an army in flight keeps its owner alive until it lands.
 */
export function evaluateEarlyEnd(state: MatchState): MatchResult | null {
  const playerAlive = isFactionAlive(state, 'player');
  const opponents = opponentOwners(state);
  let anyAiAlive = false;
  for (let i = 0; i < opponents.length; i += 1) {
    if (isFactionAlive(state, opponents[i])) {
      anyAiAlive = true;
      break;
    }
  }

  if (!playerAlive && !anyAiAlive) return 'draw';
  if (!playerAlive) return 'lose';
  if (!anyAiAlive) return 'win';
  return null;
}

type DecisionTuple = [number, number, number];

function tupleFor(state: MatchState, owner: PlayerId): DecisionTuple {
  return [scoreFor(state, owner), countTerritoriesFor(state, owner), totalForceFor(state, owner)];
}

function compareTuples(a: DecisionTuple, b: DecisionTuple): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

/**
 * Time-out rule: scoreValue -> territory count -> garrison + in-flight troops
 * -> draw. The player wins only when strictly ahead of every opponent.
 */
export function decideTimedOutcome(state: MatchState): MatchResult {
  const playerTuple = tupleFor(state, 'player');
  const opponents = opponentOwners(state);
  if (opponents.length === 0) return 'win';

  let best: DecisionTuple | null = null;
  for (let i = 0; i < opponents.length; i += 1) {
    const candidate = tupleFor(state, opponents[i]);
    if (best === null || compareTuples(candidate, best) > 0) best = candidate;
  }
  if (best === null) return 'win';
  const verdict = compareTuples(playerTuple, best);
  if (verdict > 0) return 'win';
  if (verdict === 0) return 'draw';
  return 'lose';
}

export function updateMaxTerritories(state: MatchState): void {
  const count = countTerritoriesFor(state, 'player');
  if (count > state.stats.maxTerritoriesByPlayer) {
    state.stats.maxTerritoriesByPlayer = count;
  }
}

export function factionKeys(): PlayerId[] {
  return FACTION_KEYS.slice();
}
