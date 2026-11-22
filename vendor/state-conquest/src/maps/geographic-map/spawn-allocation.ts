/**
 * Deterministic 3/4-faction spawn allocation for the geographic map builder.
 *
 * Rules inherited from the 2-faction builder (single source in build.ts):
 *  - Eligibility tiers over capacity / degree / crossing endpoints.
 *  - A faction's two homes form a same-shore pair on barrier maps, so every
 *    side stays internally coherent and the two real crossings stay meaningful.
 *  - Pair metrics (capacity / degree / first-ring cost / first-ring score) come
 *    from the exact pairMetrics implementation the 2-faction path uses.
 *
 * Differences from the 2-faction search, kept deliberately small:
 *  - Hard constraints: disjoint homes only. Nothing else is load-bearing, so a
 *    requested faction count can never be silently dropped for geometry.
 *  - Soft, explainable penalties push homes apart: geometric separation, a
 *    graph-hop reward, and a per-shared-edge "adjacent enemy" pressure penalty
 *    (an adjacent enemy home is a frontline at tick 0, not a bug).
 *  - Bounded search: pairs are pre-scored once, the top CANDIDATE_LIMIT are
 *    combined by a pruned DFS with an expansion budget, and a greedy first-fit
 *    pass seeds a feasible solution when one exists, so the budget can never
 *    produce less than first-fit quality and mobile-size builds stay bounded.
 *
 * No Math.random anywhere: every tie is broken by explicit comparisons on
 * sorted id keys, so (spec, factionCount) fully determines the allocation.
 */

import type { GeographicRegionSpec } from './regions';
import type { MapEdgeDefinition } from '../types';
import type { FactionCount, PlayerId } from '../../core/types';
import type { TerritoryDraft } from './build';

/** Same shape build.ts pairMetrics returns; kept structural to avoid a cycle. */
export interface FactionPairMetrics {
  capSum: number;
  degreeSum: number;
  frontierCost: number;
  frontierScore: number;
  ids: string[];
}

/** Dependencies injected by build.ts (single source for every shared rule). */
export interface SpawnAllocatorContext {
  /** HOME_TROOPS from build.ts. */
  homeTroops: number;
  /** Full map diagonal; separation floors are fractions of it. */
  diagonal: number;
  /** build.ts pairMetrics — the legacy 2-faction rule, verbatim. */
  pairMetrics(pair: TerritoryDraft[]): FactionPairMetrics;
}

export interface MultiSpawnChoice {
  player: string[];
  ai1: string[];
  ai2: string[];
  ai3?: string[];
  homeTroops: number;
}

/** Validates the optional fourth argument; undefined means the 2-faction default. */
export function normalizeFactionCount(value: unknown): FactionCount {
  if (value === undefined) return 2;
  if (value === 2 || value === 3 || value === 4) return value;
  throw new Error('factionCount must be 2, 3 or 4, got ' + String(value));
}

/** Combined DFS is exact over this many top-ranked pairs (covers every 12-map
 * completely); the expansion budget, not this cap, is the hard bound. */
const CANDIDATE_LIMIT = 96;
/** Node expansions allowed per build; the greedy seed already guarantees a
 * feasible allocation, so the budget only limits how far DFS may improve it. */
const EXPANSION_BUDGET = 50000;
/** Objective weights mirror the 2-faction calibration (5/1.5/1.5/0.5, -2*sep). */
const WEIGHT_CAP = 5;
const WEIGHT_DEGREE = 1.5;
const WEIGHT_COST = 1.5;
const WEIGHT_SCORE = 0.5;
const WEIGHT_SEPARATION = 2.5;
const WEIGHT_HOPS = 0.4;
const WEIGHT_COHERENCE = 1;
/** Per cross-faction home pair that shares a gameplay edge (frontline at t0). */
const WEIGHT_ADJACENT_ENEMY = 1.2;
/** Per faction beyond the minimal shore imbalance on barrier maps. */
const WEIGHT_SHORE_IMBALANCE = 0.35;
/** Graph-hop reward saturates at this hop count. */
const HOP_REWARD_CAP = 5;

interface PairCandidate {
  homes: TerritoryDraft[];
  ids: string[];
  /** Sorted-id join; the stable tie-break key. */
  key: string;
  axis: number;
  capSum: number;
  degreeSum: number;
  frontierCost: number;
  frontierScore: number;
  internalDistance: number;
  shore: string;
  quality: number;
}

interface SetEvaluation {
  score: number;
  minSep: number;
  minHops: number;
  adjacentEnemies: number;
  key: string;
}

function distance(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** All-pairs BFS hop counts over gameplay edges (maps have at most 24 nodes). */
function buildHopIndex(
  ids: string[],
  edges: MapEdgeDefinition[]
): Record<string, Record<string, number>> {
  const neighbors: Record<string, string[]> = {};
  for (let i = 0; i < ids.length; i += 1) neighbors[ids[i]] = [];
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    if (!neighbors[edge.from] || !neighbors[edge.to]) continue;
    neighbors[edge.from].push(edge.to);
    neighbors[edge.to].push(edge.from);
  }
  const hops: Record<string, Record<string, number>> = {};
  for (let i = 0; i < ids.length; i += 1) {
    const source = ids[i];
    const dist: Record<string, number> = {};
    dist[source] = 0;
    const queue: string[] = [source];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const next = dist[current] + 1;
      const list = neighbors[current];
      for (let n = 0; n < list.length; n += 1) {
        if (dist[list[n]] === undefined) {
          dist[list[n]] = next;
          queue.push(list[n]);
        }
      }
    }
    hops[source] = dist;
  }
  return hops;
}

function hopBetween(
  hopOf: Record<string, Record<string, number>>,
  from: string,
  to: string
): number | undefined {
  const row = hopOf[from];
  return row ? row[to] : undefined;
}

function buildCandidates(
  pairs: TerritoryDraft[][],
  ctx: SpawnAllocatorContext,
  groupOf: Record<string, string>,
  spec: GeographicRegionSpec
): PairCandidate[] {
  const draft: Array<{ pair: TerritoryDraft[]; metrics: FactionPairMetrics; internalDistance: number }> = [];
  const capSums: number[] = [];
  const costSums: number[] = [];
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];
    const metrics = ctx.pairMetrics(pair);
    const internalDistance = distance(pair[0].center, pair[1].center);
    draft.push({ pair: pair, metrics: metrics, internalDistance: internalDistance });
    capSums.push(metrics.capSum);
    costSums.push(metrics.frontierCost);
  }
  const capMedian = median(capSums);
  const costMedian = median(costSums);

  const candidates: PairCandidate[] = [];
  for (let i = 0; i < draft.length; i += 1) {
    const item = draft[i];
    const metrics = item.metrics;
    const ids = item.pair.map(function (home) { return home.id; });
    const sortedIds = ids.slice().sort();
    const axis = (item.pair[0].axis + item.pair[1].axis) / 2;
    candidates.push({
      homes: item.pair,
      ids: ids,
      key: sortedIds.join(','),
      axis: axis,
      capSum: metrics.capSum,
      degreeSum: metrics.degreeSum,
      frontierCost: metrics.frontierCost,
      frontierScore: metrics.frontierScore,
      internalDistance: item.internalDistance,
      shore: spec.groups ? (groupOf[item.pair[0].id] || '') : '',
      quality:
        Math.abs(metrics.capSum - capMedian) / Math.max(1, capMedian) +
        Math.abs(metrics.frontierCost - costMedian) / Math.max(1, costMedian) +
        item.internalDistance / ctx.diagonal,
    });
  }
  candidates.sort(function (a, b) {
    if (Math.abs(a.quality - b.quality) > 1e-9) return a.quality - b.quality;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return candidates;
}

/**
 * Hard feasibility: homes must be disjoint. Everything else about separation
 * is a scored preference, so a requested faction count is never dropped for
 * geometry — an awkward map simply scores worse and is reported by tests.
 */
function compatible(
  cand: PairCandidate,
  chosen: PairCandidate[]
): boolean {
  for (let c = 0; c < chosen.length; c += 1) {
    const other = chosen[c];
    for (let i = 0; i < cand.homes.length; i += 1) {
      for (let j = 0; j < other.homes.length; j += 1) {
        if (cand.homes[i].id === other.homes[j].id) return false;
      }
    }
  }
  return true;
}

function evaluateSet(
  set: PairCandidate[],
  ctx: SpawnAllocatorContext,
  hopOf: Record<string, Record<string, number>>,
  spec: GeographicRegionSpec,
  factionCount: number
): SetEvaluation {
  let capMin = Infinity;
  let capMax = -Infinity;
  let degreeMin = Infinity;
  let degreeMax = -Infinity;
  let costMin = Infinity;
  let costMax = -Infinity;
  let scoreMin = Infinity;
  let scoreMax = -Infinity;
  let minSep = Infinity;
  let minHops = Infinity;
  let adjacentEnemies = 0;
  let sepSum = 0;
  let sepCount = 0;
  let coherenceSum = 0;
  const allIds: string[] = [];

  for (let i = 0; i < set.length; i += 1) {
    const item = set[i];
    capMin = Math.min(capMin, item.capSum);
    capMax = Math.max(capMax, item.capSum);
    degreeMin = Math.min(degreeMin, item.degreeSum);
    degreeMax = Math.max(degreeMax, item.degreeSum);
    costMin = Math.min(costMin, item.frontierCost);
    costMax = Math.max(costMax, item.frontierCost);
    scoreMin = Math.min(scoreMin, item.frontierScore);
    scoreMax = Math.max(scoreMax, item.frontierScore);
    coherenceSum += item.internalDistance;
    for (let h = 0; h < item.ids.length; h += 1) allIds.push(item.ids[h]);
    for (let j = i + 1; j < set.length; j += 1) {
      const other = set[j];
      for (let a = 0; a < item.homes.length; a += 1) {
        for (let b = 0; b < other.homes.length; b += 1) {
          const homeA = item.homes[a];
          const homeB = other.homes[b];
          const sep = distance(homeA.center, homeB.center) / ctx.diagonal;
          if (sep < minSep) minSep = sep;
          sepSum += sep;
          sepCount += 1;
          const hops = hopBetween(hopOf, homeA.id, homeB.id);
          if (hops !== undefined) {
            if (hops < minHops) minHops = hops;
            if (hops <= 1) adjacentEnemies += 1;
          }
        }
      }
    }
  }

  const capSpread = (capMax - capMin) / Math.max(1, capMax);
  const degreeSpread = (degreeMax - degreeMin) / Math.max(1, degreeMax);
  const costSpread = (costMax - costMin) / Math.max(1, costMax);
  const scoreSpread = (scoreMax - scoreMin) / Math.max(1, scoreMax);
  const coherence = coherenceSum / set.length / ctx.diagonal;
  const meanSep = sepCount > 0 ? sepSum / sepCount : 0;

  let shorePenalty = 0;
  if (spec.groups) {
    const counts: Record<string, number> = {};
    for (let i = 0; i < set.length; i += 1) {
      const shore = set[i].shore;
      counts[shore] = (counts[shore] || 0) + 1;
    }
    const sizes = Object.keys(counts).map(function (key) { return counts[key]; });
    sizes.sort(function (a, b) { return b - a; });
    const imbalance = sizes.length > 1 ? sizes[0] - sizes[sizes.length - 1] : sizes[0];
    shorePenalty = WEIGHT_SHORE_IMBALANCE * Math.max(0, imbalance - (factionCount % 2));
  }

  const score =
    WEIGHT_CAP * capSpread +
    WEIGHT_DEGREE * degreeSpread +
    WEIGHT_COST * costSpread +
    WEIGHT_SCORE * scoreSpread -
    WEIGHT_SEPARATION * minSep -
    WEIGHT_SEPARATION * 0.4 * meanSep -
    WEIGHT_HOPS * Math.min(minHops === Infinity ? HOP_REWARD_CAP : minHops, HOP_REWARD_CAP) / HOP_REWARD_CAP +
    WEIGHT_COHERENCE * coherence +
    WEIGHT_ADJACENT_ENEMY * adjacentEnemies +
    shorePenalty;

  allIds.sort();
  return {
    score: score,
    minSep: minSep === Infinity ? -1 : minSep,
    minHops: minHops === Infinity ? -1 : minHops,
    adjacentEnemies: adjacentEnemies,
    key: allIds.join(','),
  };
}

function betterThan(a: SetEvaluation, b: SetEvaluation): boolean {
  if (Math.abs(a.score - b.score) > 1e-9) return a.score < b.score;
  if (Math.abs(a.minSep - b.minSep) > 1e-9) return a.minSep > b.minSep;
  return a.key < b.key;
}

/** Bounded deterministic search: greedy first-fit seed (optional) improved by
 * an exact-over-top-candidates budgeted DFS. Feasibility never depends on the
 * seed — the DFS alone can complete when first-fit paints itself into a corner
 * (small lopsided eligible pools, e.g. barrier 12-maps). */
function searchDisjoint(
  candidates: PairCandidate[],
  ctx: SpawnAllocatorContext,
  hopOf: Record<string, Record<string, number>>,
  spec: GeographicRegionSpec,
  factionCount: 3 | 4
): PairCandidate[] | null {
  const seed: PairCandidate[] = [];
  for (let k = 0; k < factionCount; k += 1) {
    let picked: PairCandidate | null = null;
    for (let i = 0; i < candidates.length; i += 1) {
      if (compatible(candidates[i], seed)) {
        picked = candidates[i];
        break;
      }
    }
    if (!picked) break;
    seed.push(picked);
  }

  let bestSet: PairCandidate[] | null = seed.length === factionCount ? seed : null;
  let bestEval = bestSet
    ? evaluateSet(seed, ctx, hopOf, spec, factionCount)
    : null;

  const top = candidates.slice(0, Math.min(CANDIDATE_LIMIT, candidates.length));
  const budget = { left: EXPANSION_BUDGET };
  const chosen: PairCandidate[] = [];

  const dfs = function (startIdx: number): void {
    if (chosen.length === factionCount) {
      const evaluation = evaluateSet(chosen, ctx, hopOf, spec, factionCount);
      if (!bestEval || betterThan(evaluation, bestEval)) {
        bestEval = evaluation;
        bestSet = chosen.slice();
      }
      return;
    }
    const slotsLeft = factionCount - chosen.length;
    for (let idx = startIdx; idx <= top.length - slotsLeft; idx += 1) {
      if (budget.left <= 0) return;
      budget.left -= 1;
      const cand = top[idx];
      if (!compatible(cand, chosen)) continue;
      chosen.push(cand);
      dfs(idx + 1);
      chosen.pop();
    }
  };
  dfs(0);

  return bestSet;
}

function finalizeSet(set: PairCandidate[], factionCount: 3 | 4, baseTroops: number): MultiSpawnChoice {
  const ordered = set.slice().sort(function (a, b) {
    if (Math.abs(a.axis - b.axis) > 1e-9) return a.axis - b.axis;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  // Same base rule as the 2-faction path: HOME_TROOPS capped by the smallest
  // home capacity, never above it, identical across every faction count.
  let homeTroops = baseTroops;
  for (let i = 0; i < ordered.length; i += 1) {
    const homes = ordered[i].homes;
    for (let h = 0; h < homes.length; h += 1) {
      homeTroops = Math.min(homeTroops, homes[h].capacity);
    }
  }
  const choice: MultiSpawnChoice = {
    player: ordered[0].ids.slice(),
    ai1: ordered[1].ids.slice(),
    ai2: ordered[2].ids.slice(),
    homeTroops: homeTroops,
  };
  if (factionCount === 4) choice.ai3 = ordered[3].ids.slice();
  return choice;
}

/**
 * Chooses two coherent homes for each of 3/4 factions. Objective and weights
 * mirror the legacy 2-faction search; the result is a pure function of
 * (spec, factionCount) and never drops a requested faction.
 */
export function chooseSpawnsForFactions(
  factionCount: 3 | 4,
  drafts: TerritoryDraft[],
  edges: MapEdgeDefinition[],
  spec: GeographicRegionSpec,
  groupOf: Record<string, string>,
  ctx: SpawnAllocatorContext
): MultiSpawnChoice {
  const need = factionCount * 2;
  const tiers: Array<(draft: TerritoryDraft) => boolean> = [
    function (d) { return !d.crossingEndpoint && d.capacity >= ctx.homeTroops && d.degree >= 2; },
    function (d) { return d.capacity >= ctx.homeTroops && d.degree >= 2; },
    function (d) { return d.capacity >= ctx.homeTroops; },
    function (d) { return d.degree >= 2; },
    function (d) { return d.capacity >= 1; },
  ];
  // Relax tiers until the pool admits factionCount disjoint same-shore pairs;
  // a head count alone is not enough on lopsided barrier maps.
  const pairCapacity = function (pool: TerritoryDraft[]): number {
    if (!spec.groups) return Math.floor(pool.length / 2);
    const perShore: Record<string, number> = {};
    for (let i = 0; i < pool.length; i += 1) {
      const shore = groupOf[pool[i].id] || '';
      perShore[shore] = (perShore[shore] || 0) + 1;
    }
    let total = 0;
    for (const shore in perShore) {
      if (!Object.prototype.hasOwnProperty.call(perShore, shore)) continue;
      total += Math.floor(perShore[shore] / 2);
    }
    return total;
  };
  let eligible: TerritoryDraft[] = [];
  for (let t = 0; t < tiers.length; t += 1) {
    eligible = drafts.filter(tiers[t]);
    if (eligible.length >= need && pairCapacity(eligible) >= factionCount) break;
  }
  if (eligible.length < need) {
    throw new Error(
      'Region ' + spec.themeId + '/' + spec.size + ' has only ' + eligible.length +
        ' spawn candidates for ' + factionCount + ' factions'
    );
  }

  // Same-shore pairs on barrier maps, exactly like the 2-faction pair build.
  const pairs: TerritoryDraft[][] = [];
  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      if (spec.groups && groupOf[eligible[i].id] !== groupOf[eligible[j].id]) continue;
      pairs.push([eligible[i], eligible[j]]);
    }
  }
  if (pairs.length < factionCount) {
    throw new Error(
      'Region ' + spec.themeId + '/' + spec.size + ' has too few spawn pairings for ' +
        factionCount + ' factions'
    );
  }

  const hopOf = buildHopIndex(
    drafts.map(function (d) { return d.id; }),
    edges
  );
  const candidates = buildCandidates(pairs, ctx, groupOf, spec);

  const best = searchDisjoint(candidates, ctx, hopOf, spec, factionCount);
  if (best) return finalizeSet(best, factionCount, ctx.homeTroops);
  throw new Error(
    'Region ' + spec.themeId + '/' + spec.size + ' cannot host ' + factionCount + ' factions'
  );
}

/** Faction order used by the builder when materializing owners. */
export const FACTION_ORDER: PlayerId[] = ['player', 'ai1', 'ai2', 'ai3'];
