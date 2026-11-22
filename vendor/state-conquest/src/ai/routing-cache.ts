import { createOwnerReachability } from '../core/reachability';
import type { OwnerReachability } from '../core/reachability';
import type { ArmyRouteBoundary, EdgeKind, MatchState, OwnerId, PlayerId } from '../core/types';

/**
 * Per-owner routing cache keyed by the only inputs that can change a route:
 * the static map, ownership and march levels. Troop counts do not affect a
 * frozen route, so consecutive decision passes on the same board share the
 * expensive BFS/polyline work instead of rebuilding it every seven ticks.
 *
 * Determinism rule: a cache entry never holds a reference into the caller's
 * mutable working copy. It is computed over an immutable snapshot taken when
 * the entry is created. The planner applies a march upgrade to its work clone
 * mid-pass, so the same territory object can change `marchLevel` after a route
 * context exists; a lazy `plan()` that later read that object would compute a
 * march-2 route and store it under the march-1 key, poisoning every later pass
 * that hits the key. The snapshot makes key and routes agree forever.
 *
 * Pure and deterministic: the key is derived from state, entries are evicted
 * in insertion order (LRU on hit), and nothing reads a clock or randomness.
 */
const CACHE_LIMIT = 8;
const cache = new Map<string, OwnerReachability>();
// `layout` (boundary arcs) is shared by reference through cloneMatchState, so
// its identity is a cheap, collision-free part of the route key.
const layoutIds = new WeakMap<object, number>();
let nextLayoutId = 1;

/** Minimal territory shape read by the reachability planner. */
interface RouteTerritory {
  id: string;
  owner: OwnerId;
  center: [number, number];
  labelAnchor?: [number, number];
  marchLevel?: 1 | 2 | 3;
}

/** Minimal edge shape read by the reachability planner. */
interface RouteEdge {
  id?: string;
  from: string;
  to: string;
  kind: EdgeKind;
  travelFactor: number;
}

/**
 * Structural view accepted by createOwnerReachability. It intentionally carries
 * only routing inputs, so later troop/level changes in the live state cannot
 * leak into a cached route.
 */
interface RouteSnapshot {
  territories: Record<string, RouteTerritory>;
  edges: RouteEdge[];
  territoryOrder: string[];
  layout: { boundaries?: readonly ArmyRouteBoundary[] } | null;
  tick: number;
  diplomacy?: {
    enabled: boolean;
    uses?: number;
    truces: Array<{
      a: PlayerId;
      b: PlayerId;
      startedTick: number;
      expiresTick: number;
      cooldownUntilTick: number;
    }>;
  };
}

function layoutKey(state: MatchState): number {
  const layout = state.layout;
  if (!layout) return 0;
  const existing = layoutIds.get(layout as object);
  if (existing !== undefined) return existing;
  const assigned = nextLayoutId;
  nextLayoutId += 1;
  layoutIds.set(layout as object, assigned);
  return assigned;
}

function copyBoundary(source: ArmyRouteBoundary): ArmyRouteBoundary {
  const boundary: ArmyRouteBoundary = {
    from: source.from,
    to: source.to,
  };
  if (source.passable !== undefined) boundary.passable = source.passable;
  if (source.crossing) boundary.crossing = [source.crossing[0], source.crossing[1]];
  if (source.midpoint) boundary.midpoint = [source.midpoint[0], source.midpoint[1]];
  if (source.length !== undefined) boundary.length = source.length;
  return boundary;
}

/**
 * Independent copy of every input the route planner reads. Ownership, march
 * levels, geometry and boundary arcs are snapshotted; nothing here is shared
 * with the mutable match/working state (layout itself is identified only by
 * the key).
 */
function routeSnapshot(state: MatchState): RouteSnapshot {
  const territories: Record<string, RouteTerritory> = {};
  const territoryOrder: string[] = [];
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const id = state.territoryOrder[i];
    const source = state.territories[id];
    if (!source) continue;
    const copy: RouteTerritory = {
      id: source.id,
      owner: source.owner,
      center: [source.center[0], source.center[1]],
      marchLevel: source.marchLevel,
    };
    if (source.labelAnchor) {
      copy.labelAnchor = [source.labelAnchor[0], source.labelAnchor[1]];
    }
    territories[id] = copy;
    territoryOrder.push(id);
  }

  const edges: RouteEdge[] = [];
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    const copy: RouteEdge = {
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      travelFactor: edge.travelFactor,
    };
    if (edge.id !== undefined) copy.id = edge.id;
    edges.push(copy);
  }

  const layout = state.layout;
  let boundaries: ArmyRouteBoundary[] | undefined;
  if (layout && layout.boundaries) {
    boundaries = [];
    for (let i = 0; i < layout.boundaries.length; i += 1) {
      boundaries.push(copyBoundary(layout.boundaries[i]));
    }
  }
  const diplomacy = state.diplomacy;
  const truces: Array<{
    a: PlayerId;
    b: PlayerId;
    startedTick: number;
    expiresTick: number;
    cooldownUntilTick: number;
  }> = [];
  if (diplomacy && Array.isArray(diplomacy.truces)) {
    for (let i = 0; i < diplomacy.truces.length; i += 1) {
      const truce = diplomacy.truces[i];
      truces.push({
        a: truce.a,
        b: truce.b,
        startedTick: truce.startedTick,
        expiresTick: truce.expiresTick,
        cooldownUntilTick: truce.cooldownUntilTick,
      });
    }
  }
  return {
    territories: territories,
    edges: edges,
    territoryOrder: territoryOrder,
    layout: layout ? { boundaries: boundaries } : null,
    tick: state.tick,
    diplomacy: diplomacy
      ? {
          enabled: diplomacy.enabled,
          uses:
            typeof diplomacy.uses === 'number' && isFinite(diplomacy.uses)
              ? Math.floor(diplomacy.uses)
              : 0,
          truces: truces,
        }
      : undefined,
  };
}

function routeKey(state: MatchState, owner: PlayerId): string {
  // Include the actual geometry and order, not only mapId: fixture/test maps
  // can reuse ids, and edge/territory order is a BFS tie-breaker.
  let key =
    (state.mapId || '') +
    '|' +
    owner +
    '|' +
    state.mapWidth +
    'x' +
    state.mapHeight +
    '|L' +
    layoutKey(state) +
    '|T' +
    state.tick +
    '|D' +
    (state.diplomacy && state.diplomacy.enabled ? '1' : '0') +
    '|U' +
    (state.diplomacy && typeof state.diplomacy.uses === 'number'
      ? Math.floor(state.diplomacy.uses)
      : 0) +
    '|';
  if (state.diplomacy && Array.isArray(state.diplomacy.truces)) {
    for (let i = 0; i < state.diplomacy.truces.length; i += 1) {
      const truce = state.diplomacy.truces[i];
      key +=
        'R' +
        truce.a +
        ',' +
        truce.b +
        ',' +
        truce.startedTick +
        ',' +
        truce.expiresTick +
        ',' +
        truce.cooldownUntilTick +
        // Proposal bookkeeping: a rejection record replaces an expired
        // one without changing relations, so key on the decision too.
        ',' +
        (truce.lastDecision ? truce.lastDecision.charAt(0) : '-') +
        ',' +
        (typeof truce.lastDecisionTick === 'number' ? truce.lastDecisionTick : -1) +
        ';';
    }
  }
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    key +=
      i +
      ':' +
      territory.id +
      ',' +
      territory.owner +
      ',' +
      territory.marchLevel +
      ',' +
      (territory.center ? territory.center[0] + ',' + territory.center[1] : '') +
      ',' +
      (territory.labelAnchor
        ? territory.labelAnchor[0] + ',' + territory.labelAnchor[1]
        : '') +
      ';';
  }
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    key +=
      i +
      ':' +
      edge.from +
      '>' +
      edge.to +
      ',' +
      edge.kind +
      ',' +
      edge.travelFactor +
      ';';
  }
  return key;
}

export function cachedReachability(
  state: MatchState,
  owner: PlayerId
): OwnerReachability {
  const key = routeKey(state, owner);
  const found = cache.get(key);
  if (found) {
    cache.delete(key);
    cache.set(key, found);
    return found;
  }
  // Build the value from a frozen copy of the routing inputs, never from the
  // caller's mutable object. The planner reads this snapshot lazily after the
  // pass may have upgraded march levels, and must still see the key's levels.
  const reach = createOwnerReachability(
    routeSnapshot(state) as unknown as MatchState,
    owner
  );
  cache.set(key, reach);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return reach;
}

/** Test hook: drop every cached route (behaviour never depends on this). */
export function clearRoutingCache(): void {
  cache.clear();
}
