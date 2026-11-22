/**
 * Frontier reachability and deterministic multi-edge army routing.
 *
 * Rule (v2): the source must reach an owned frontier through real same-owner
 * edges, then cross that frontier's real passable edge into the target. Direct
 * source-target edges are one-hop routes. Reinforcement follows the same path
 * rule, and an active truce excludes the other faction's targets.
 *
 * Routing is pure and deterministic: it never uses Math.random or wall clock
 * time and never depends on object key insertion order. A plan is computed once
 * at dispatch and frozen into the army.
 */
import { BRIDGE_TRAVEL_FACTOR } from '../config/balance';
import { isHostileAt } from './diplomacy';
import { armyRoutePoints, polylineLength, routeEndpointPoint } from './army-route';
import {
  travelTicksForEdge,
  travelTicksForRouteSegments,
} from './movement';
import type { RouteTravelSegment } from './movement';
import type {
  ArmyRouteBoundary,
  Edge,
  EdgeKind,
  MapPoint,
  MatchSnapshot,
  MatchState,
  OwnerId,
  PlannedMovement,
  MoveRouteInspection,
  PlayerId,
} from './types';

interface TerritoryLike {
  id: string;
  owner: OwnerId;
  center: [number, number];
  labelAnchor?: [number, number];
  marchLevel?: 1 | 2 | 3;
}

interface EdgeLike {
  id?: string;
  from: string;
  to: string;
  kind: EdgeKind;
  travelFactor: number;
}

/**
 * Structural view accepted by all reachability helpers. Both MatchState (record
 * territories) and MatchSnapshot (array territories) satisfy it.
 */
export interface ReachabilityView {
  territories: Record<string, TerritoryLike> | readonly TerritoryLike[];
  edges: readonly EdgeLike[];
  territoryOrder?: readonly string[];
  tick?: number;
  diplomacy?: {
    enabled: boolean;
    uses?: number;
    truces: readonly {
      a: PlayerId;
      b: PlayerId;
      startedTick: number;
      expiresTick: number;
      cooldownUntilTick: number;
      lastDecision?: 'accepted' | 'rejected';
    }[];
  };
  layout?: { boundaries?: readonly ArmyRouteBoundary[] } | null;
}

export interface OwnerReachability {
  owner: PlayerId;
  /** Every target connected to an owned territory (own targets included). */
  reachableTargets: string[];
  /** Reachable targets owned by someone else, in deterministic map order. */
  attackTargets: string[];
  canReach(targetId: string): boolean;
  plan(sourceId: string, targetId: string): PlannedMovement | null;
}

interface EdgeRef {
  edge: EdgeLike;
  otherId: string;
}

interface BfsEntry {
  parentId: string | null;
  edge: EdgeLike | null;
  depth: number;
}

interface Planner {
  order: string[];
  orderIndex: Record<string, number>;
  byId: Record<string, TerritoryLike>;
  adjacency: Record<string, EdgeRef[]>;
  boundaries: readonly ArmyRouteBoundary[] | undefined;
  tick: number;
  diplomacy: ReachabilityView['diplomacy'];
  frontierCache: Record<string, string[]>;
  bfsCache: Record<string, Record<string, BfsEntry>>;
  planCache: Record<string, PlannedMovement | null>;
}

function edgeId(edge: EdgeLike): string {
  return edge.id || edge.from + '-' + edge.to;
}

function hasActiveTruce(
  diplomacy: ReachabilityView['diplomacy'],
  tick: number,
  a: PlayerId,
  b: PlayerId
): boolean {
  if (!diplomacy || !diplomacy.enabled || a === b) return false;
  for (let i = 0; i < diplomacy.truces.length; i += 1) {
    const record = diplomacy.truces[i];
    if (record.expiresTick <= tick) continue;
    if ((record.a === a && record.b === b) || (record.a === b && record.b === a)) {
      return true;
    }
  }
  return false;
}

/**
 * Shared attack range (2.0.0): while a truce is active, the owner and the
 * partner field ONE traversable network. Territories of the partner may be
 * used as transit and as the attack frontier into a neutral or common enemy.
 * Dispatch SOURCES stay owner-only (an ally's garrison is never spent) and
 * the partner itself stays non-hostile (never attackable) — enforced by the
 * hostile-target gate in planInternal/frontierIds.
 */
function isTransitOwner(planner: Planner, owner: PlayerId, cellOwner: string): boolean {
  if (cellOwner === owner) return true;
  if (cellOwner !== 'player' && cellOwner !== 'ai1' && cellOwner !== 'ai2' && cellOwner !== 'ai3') {
    return false;
  }
  return hasActiveTruce(planner.diplomacy, planner.tick, owner, cellOwner as PlayerId);
}

function safeEdge(edge: EdgeLike): Edge {
  const factor =
    isFinite(edge.travelFactor) && edge.travelFactor > 0 ? edge.travelFactor : 1;
  return {
    id: edgeId(edge),
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    travelFactor: factor,
  };
}

function territoryList(view: ReachabilityView): TerritoryLike[] {
  if (Array.isArray(view.territories)) {
    return view.territories as TerritoryLike[];
  }
  const record = view.territories as Record<string, TerritoryLike>;
  const out: TerritoryLike[] = [];
  if (view.territoryOrder && view.territoryOrder.length > 0) {
    for (let i = 0; i < view.territoryOrder.length; i += 1) {
      const territory = record[view.territoryOrder[i]];
      if (territory) out.push(territory);
    }
    return out;
  }
  const keys = Object.keys(record);
  for (let i = 0; i < keys.length; i += 1) {
    if (record[keys[i]]) out.push(record[keys[i]]);
  }
  return out;
}

function edgeHasPlayableBoundary(
  boundaries: readonly { from: string; to: string; passable?: boolean }[] | undefined,
  edge: { from: string; to: string }
): boolean {
  if (!boundaries || boundaries.length === 0) return true;
  const key = edge.from < edge.to
    ? edge.from + '\u0000' + edge.to
    : edge.to + '\u0000' + edge.from;
  let found = false;
  for (let i = 0; i < boundaries.length; i += 1) {
    const boundary = boundaries[i];
    const boundaryKey = boundary.from < boundary.to
      ? boundary.from + '\u0000' + boundary.to
      : boundary.to + '\u0000' + boundary.from;
    if (boundaryKey !== key) continue;
    found = true;
    // A boundary without an explicit passable flag is legacy geometry. Only a
    // declared blocked arc can invalidate an otherwise declared gameplay edge.
    if (boundary.passable !== false) return true;
  }
  return !found;
}

/**
 * Single source of truth for real crossability: a declared boundary arc with
 * `passable: false` vetoes an otherwise playable edge; boundaries without an
 * explicit flag are legacy geometry and stay playable. Reachability, the AI
 * threat/pressure model and the diplomacy scoring all read crossings through
 * this helper, so there is exactly one passability rule to maintain.
 */
export function isEdgePassable(
  boundaries: readonly { from: string; to: string; passable?: boolean }[] | undefined | null,
  edge: { from: string; to: string }
): boolean {
  return edgeHasPlayableBoundary(boundaries === null ? undefined : boundaries, edge);
}

/** Boundaries of a state/snapshot layout, or undefined when there are none. */
export function layoutBoundaries(
  layout: { boundaries?: readonly { from: string; to: string; passable?: boolean }[] } | null | undefined
): readonly { from: string; to: string; passable?: boolean }[] | undefined {
  return layout ? layout.boundaries : undefined;
}

function makePlanner(view: ReachabilityView, ignoreBlocks: boolean = false): Planner {
  const order: string[] = [];
  const orderIndex: Record<string, number> = {};
  const byId: Record<string, TerritoryLike> = {};
  const list = territoryList(view);
  for (let i = 0; i < list.length; i += 1) {
    const territory = list[i];
    order.push(territory.id);
    orderIndex[territory.id] = i;
    byId[territory.id] = territory;
  }

  const boundaries = view.layout ? view.layout.boundaries : undefined;
  const adjacency: Record<string, EdgeRef[]> = {};
  for (let i = 0; i < order.length; i += 1) adjacency[order[i]] = [];
  for (let i = 0; i < view.edges.length; i += 1) {
    const edge = view.edges[i];
    if (!byId[edge.from] || !byId[edge.to] || edge.from === edge.to) continue;
    if (!ignoreBlocks && !edgeHasPlayableBoundary(boundaries, edge)) continue;
    adjacency[edge.from].push({ edge: edge, otherId: edge.to });
    adjacency[edge.to].push({ edge: edge, otherId: edge.from });
  }

  return {
    order: order,
    orderIndex: orderIndex,
    byId: byId,
    adjacency: adjacency,
    boundaries: boundaries,
    tick: typeof view.tick === 'number' ? view.tick : 0,
    diplomacy: view.diplomacy,
    frontierCache: {},
    bfsCache: {},
    planCache: {},
  };
}

function findDirectEdge(planner: Planner, a: string, b: string): EdgeLike | null {
  const refs = planner.adjacency[a];
  if (!refs) return null;
  for (let i = 0; i < refs.length; i += 1) {
    if (refs[i].otherId === b) return refs[i].edge;
  }
  return null;
}

/**
 * Territories that hold a real edge into `targetId` and may stage the attack:
 * owned territories plus, while a truce is active, the partner's territories
 * (the shared network). Stable order.
 */
function frontierIds(planner: Planner, owner: PlayerId, targetId: string): string[] {
  const cached = planner.frontierCache[targetId];
  if (cached) return cached;
  const out: string[] = [];
  const seen: Record<string, boolean> = {};
  const target = planner.byId[targetId];
  if (
    target &&
    target.owner !== owner &&
    target.owner !== 'neutral' &&
    !isHostileAt(planner.diplomacy, planner.tick, owner, target.owner)
  ) {
    return (planner.frontierCache[targetId] = out);
  }
  const refs = planner.adjacency[targetId] || [];
  for (let i = 0; i < refs.length; i += 1) {
    const otherId = refs[i].otherId;
    if (otherId === targetId) continue;
    if (seen[otherId]) continue;
    const other = planner.byId[otherId];
    if (!other || !isTransitOwner(planner, owner, other.owner)) continue;
    seen[otherId] = true;
    out.push(otherId);
  }
  return (planner.frontierCache[targetId] = out);
}

/**
 * Deterministic BFS through the owner's shared network (owned territories
 * plus an active truce partner's territories). Neighbor order comes from
 * state.edges order, so equal-depth ties have a stable first-discovery path.
 * `targetId` is never expanded, so a route cannot pass through its destination.
 */
function bfsOwnTerritories(
  planner: Planner,
  owner: PlayerId,
  sourceId: string,
  targetId: string
): Record<string, BfsEntry> {
  const cacheKey = sourceId + '\u0000' + targetId;
  const cached = planner.bfsCache[cacheKey];
  if (cached) return cached;
  const out: Record<string, BfsEntry> = {};
  out[sourceId] = { parentId: null, edge: null, depth: 0 };
  const queue: string[] = [sourceId];
  let head = 0;
  while (head < queue.length) {
    const currentId = queue[head];
    head += 1;
    if (currentId === targetId) continue;
    const refs = planner.adjacency[currentId] || [];
    for (let i = 0; i < refs.length; i += 1) {
      const nextId = refs[i].otherId;
      if (nextId === targetId) continue;
      if (out[nextId]) continue;
      const next = planner.byId[nextId];
      if (!next || !isTransitOwner(planner, owner, next.owner)) continue;
      out[nextId] = {
        parentId: currentId,
        edge: refs[i].edge,
        depth: out[currentId].depth + 1,
      };
      queue.push(nextId);
    }
  }
  return (planner.bfsCache[cacheKey] = out);
}

function samePoint(a: MapPoint, b: MapPoint): boolean {
  return Math.abs(a[0] - b[0]) <= 1e-9 && Math.abs(a[1] - b[1]) <= 1e-9;
}

function appendPoint(out: MapPoint[], point: MapPoint): void {
  const copy: MapPoint = [point[0], point[1]];
  if (out.length === 0 || !samePoint(out[out.length - 1], copy)) out.push(copy);
}

function appendSegment(
  out: MapPoint[],
  from: TerritoryLike,
  to: TerritoryLike,
  boundaries: readonly ArmyRouteBoundary[] | undefined
): void {
  const segment = armyRoutePoints(from, to, boundaries);
  for (let i = 1; i < segment.length; i += 1) appendPoint(out, segment[i]);
}

function chainFor(
  planner: Planner,
  sourceId: string,
  frontierId: string,
  bfs: Record<string, BfsEntry>
): { edges: EdgeLike[]; ids: string[] } {
  const edges: EdgeLike[] = [];
  const ids: string[] = [];
  let currentId = frontierId;
  while (currentId !== sourceId) {
    const entry = bfs[currentId];
    if (!entry || !entry.parentId || !entry.edge) return { edges: [], ids: [] };
    edges.unshift(entry.edge);
    ids.unshift(edgeId(entry.edge));
    currentId = entry.parentId;
  }
  return { edges: edges, ids: ids };
}

function buildRoutePoints(
  planner: Planner,
  source: TerritoryLike,
  target: TerritoryLike,
  frontier: TerritoryLike,
  chainEdges: EdgeLike[]
): MapPoint[] {
  const points: MapPoint[] = [];
  appendPoint(points, routeEndpointPoint(source));
  let current = source;
  for (let i = 0; i < chainEdges.length; i += 1) {
    const edge = chainEdges[i];
    const nextId = edge.from === current.id ? edge.to : edge.from;
    const next = planner.byId[nextId];
    if (!next) break;
    appendSegment(points, current, next, planner.boundaries);
    current = next;
  }
  // The chain ends at the frontier; make sure its anchor is included even when
  // a boundary midpoint made the last segment end elsewhere.
  appendPoint(points, routeEndpointPoint(frontier));

  const finalSegment = armyRoutePoints(frontier, target, planner.boundaries);
  for (let i = 1; i < finalSegment.length; i += 1) appendPoint(points, finalSegment[i]);
  if (points.length < 2) appendPoint(points, routeEndpointPoint(target));
  return points;
}

function directMovement(
  planner: Planner,
  source: TerritoryLike,
  target: TerritoryLike,
  edge: EdgeLike
): PlannedMovement {
  const routePoints = armyRoutePoints(source, target, planner.boundaries);
  const cleaned: MapPoint[] = [];
  for (let i = 0; i < routePoints.length; i += 1) appendPoint(cleaned, routePoints[i]);
  const marchLevel = source.marchLevel ? source.marchLevel : 1;
  const safe = safeEdge(edge);
  return {
    sourceId: source.id,
    targetId: target.id,
    direct: true,
    frontierId: source.id,
    edgeIds: [safe.id],
    territoryIds: [source.id, target.id],
    transitOwners: [],
    routePoints: cleaned,
    distance: polylineLength(cleaned),
    travelTicks: travelTicksForEdge(safe, marchLevel),
    travelFactor: safe.travelFactor,
    bridgeFactor: safe.kind === 'bridge' ? BRIDGE_TRAVEL_FACTOR : 1,
  };
}

function anchorDistance(planner: Planner, a: string, b: string): number {
  const from = planner.byId[a];
  const to = planner.byId[b];
  if (!from || !to) return 0;
  const pa = routeEndpointPoint(from);
  const pb = routeEndpointPoint(to);
  const dx = pb[0] - pa[0];
  const dy = pb[1] - pa[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function routedMovement(
  planner: Planner,
  source: TerritoryLike,
  target: TerritoryLike,
  frontierId: string,
  targetEdge: EdgeLike,
  bfs: Record<string, BfsEntry>
): PlannedMovement {
  const frontier = planner.byId[frontierId];
  const chain = chainFor(planner, source.id, frontierId, bfs);
  const routePoints = buildRoutePoints(
    planner,
    source,
    target,
    frontier,
    chain.edges
  );

  let weightTotal = 0;
  let travelSum = 0;
  let bridgeSum = 0;
  const segments: RouteTravelSegment[] = [];
  let currentId = source.id;

  for (let i = 0; i < chain.edges.length; i += 1) {
    const edge = chain.edges[i];
    const nextId = edge.from === currentId ? edge.to : edge.from;
    const from = planner.byId[currentId];
    const to = planner.byId[nextId];
    const segmentDistance =
      from && to
        ? polylineLength(armyRoutePoints(from, to, planner.boundaries))
        : 0;
    const straight = anchorDistance(planner, currentId, nextId);
    const travel =
      isFinite(edge.travelFactor) && edge.travelFactor > 0 ? edge.travelFactor : 1;
    const bridge = edge.kind === 'bridge' ? BRIDGE_TRAVEL_FACTOR : 1;
    segments.push({
      distance: segmentDistance,
      straight: straight,
      travelFactor: travel,
      bridgeFactor: bridge,
    });
    weightTotal += straight;
    travelSum += straight * travel;
    bridgeSum += straight * bridge;
    currentId = nextId;
  }

  const finalWeight = anchorDistance(planner, frontierId, target.id);
  const finalTravel =
    isFinite(targetEdge.travelFactor) && targetEdge.travelFactor > 0
      ? targetEdge.travelFactor
      : 1;
  const finalBridge = targetEdge.kind === 'bridge' ? BRIDGE_TRAVEL_FACTOR : 1;
  const finalSegmentDistance =
    planner.byId[frontierId]
      ? polylineLength(
          armyRoutePoints(planner.byId[frontierId], target, planner.boundaries)
        )
      : finalWeight;
  segments.push({
    distance: finalSegmentDistance,
    straight: finalWeight,
    travelFactor: finalTravel,
    bridgeFactor: finalBridge,
  });
  weightTotal += finalWeight;
  travelSum += finalWeight * finalTravel;
  bridgeSum += finalWeight * finalBridge;

  const travelFactor = weightTotal > 0 ? travelSum / weightTotal : finalTravel;
  const bridgeFactor = weightTotal > 0 ? bridgeSum / weightTotal : finalBridge;
  const distance = polylineLength(routePoints);
  const marchLevel = source.marchLevel ? source.marchLevel : 1;

  const territoryIds = [source.id];
  const transitOwners: PlayerId[] = [];
  let routeId = source.id;
  for (let i = 0; i < chain.edges.length; i += 1) {
    const edge = chain.edges[i];
    routeId = edge.from === routeId ? edge.to : edge.from;
    territoryIds.push(routeId);
    const transitOwner = planner.byId[routeId].owner;
    if (transitOwner !== source.owner && transitOwner !== 'neutral' && transitOwners.indexOf(transitOwner) < 0) {
      transitOwners.push(transitOwner);
    }
  }
  territoryIds.push(target.id);

  return {
    sourceId: source.id,
    targetId: target.id,
    direct: false,
    frontierId: frontierId,
    edgeIds: chain.ids.concat([edgeId(targetEdge)]),
    territoryIds: territoryIds,
    transitOwners: transitOwners,
    routePoints: routePoints,
    distance: distance,
    travelTicks: travelTicksForRouteSegments(segments, marchLevel),
    travelFactor: travelFactor,
    bridgeFactor: bridgeFactor,
  };
}

function planInternal(
  planner: Planner,
  owner: PlayerId,
  sourceId: string,
  targetId: string
): PlannedMovement | null {
  const cacheKey = sourceId + '\u0000' + targetId;
  if (Object.prototype.hasOwnProperty.call(planner.planCache, cacheKey)) {
    return planner.planCache[cacheKey];
  }
  const source = planner.byId[sourceId];
  const target = planner.byId[targetId];
  let plan: PlannedMovement | null = null;

  if (source && target && sourceId !== targetId && source.owner === owner) {
    if (
      target.owner !== owner &&
      target.owner !== 'neutral' &&
      !isHostileAt(planner.diplomacy, planner.tick, owner, target.owner)
    ) {
      planner.planCache[cacheKey] = null;
      return null;
    }
    const direct = findDirectEdge(planner, sourceId, targetId);
    if (direct) {
      plan = directMovement(planner, source, target, direct);
    } else {
      const frontiers = frontierIds(planner, owner, targetId);
      if (frontiers.length > 0) {
        const bfs = bfsOwnTerritories(planner, owner, sourceId, targetId);
        let bestId: string | null = null;
        let bestLength = Infinity;
        let bestOrder = Infinity;

        // A source must reach the chosen frontier through a real same-owner
        // component. The old v0.4 disconnected fallback drew a straight line
        // from a rear island to the frontier, which made an otherwise symmetric
        // rule look like an AI-only cross-border shortcut.
        for (let i = 0; i < frontiers.length; i += 1) {
          const frontierId = frontiers[i];
          const entry = bfs[frontierId];
          const hasPath = !!entry && entry.depth > 0;
          if (!hasPath) continue;

          const frontier = planner.byId[frontierId];
          const targetEdge = findDirectEdge(planner, frontierId, targetId);
          if (!frontier || !targetEdge) continue;
          const chain = chainFor(planner, sourceId, frontierId, bfs);
          const route = buildRoutePoints(
            planner,
            source,
            target,
            frontier,
            chain.edges
          );
          const length = polylineLength(route);
          const order = planner.orderIndex[frontierId];
          if (
            length < bestLength - 1e-9 ||
            (Math.abs(length - bestLength) <= 1e-9 && order < bestOrder)
          ) {
            bestId = frontierId;
            bestLength = length;
            bestOrder = order;
          }
        }

        if (bestId !== null) {
          const targetEdge = findDirectEdge(planner, bestId, targetId);
          if (targetEdge) {
            plan = routedMovement(planner, source, target, bestId, targetEdge, bfs);
          }
        }
      }
    }
  }

  planner.planCache[cacheKey] = plan;
  return plan;
}

/**
 * Public single-call route planner. Returns null exactly when the move is not
 * legal under the frontier rule (including unknown territories, source==
 * target, non-hostile targets and unreachable targets); troop availability is
 * checked separately by the command validator. The source must be owned by
 * `owner`; the route may transit an active truce partner's territories.
 */
export function planMoveRoute(
  view: MatchState | MatchSnapshot,
  owner: PlayerId,
  sourceId: string,
  targetId: string
): PlannedMovement | null {
  const planner = makePlanner(view as ReachabilityView);
  return planInternal(planner, owner, sourceId, targetId);
}

/** Failure diagnosis is preview-only; legal commands and AI use the same fast planner. */
export function inspectMoveRoute(
  view: MatchState | MatchSnapshot,
  owner: PlayerId,
  sourceId: string,
  targetId: string
): MoveRouteInspection {
  const raw = view as ReachabilityView;
  const planner = makePlanner(raw);
  const source = planner.byId[sourceId];
  const target = planner.byId[targetId];
  if (!source || !target) return { ok: false, reason: 'invalid' };
  if (sourceId === targetId) return { ok: false, reason: 'self' };
  if (source.owner !== owner) return { ok: false, reason: 'source-not-owned' };
  if (target.owner !== owner && target.owner !== 'neutral' &&
      !isHostileAt(planner.diplomacy, planner.tick, owner, target.owner)) {
    return { ok: false, reason: 'ally-target' };
  }
  const movement = planInternal(planner, owner, sourceId, targetId);
  if (movement) return { ok: true, movement: movement };

  // A boundary is the cause only if removing its veto makes THIS source's
  // entire route legal. Merely seeing a river near the target proves nothing.
  const withoutBlocks = makePlanner(raw, true);
  const blockedRoute = planInternal(withoutBlocks, owner, sourceId, targetId);
  if (blockedRoute) {
    const blockedEdgeIds: string[] = [];
    for (let i = 0; i < raw.edges.length; i += 1) {
      const edge = raw.edges[i];
      if (blockedRoute.edgeIds.indexOf(edgeId(edge)) >= 0 &&
          !edgeHasPlayableBoundary(planner.boundaries, edge)) blockedEdgeIds.push(edgeId(edge));
    }
    return { ok: false, reason: 'blocked-boundary', blockedEdgeIds: blockedEdgeIds };
  }
  // Name an expired alliance only when restoring that recorded pair would
  // actually restore this path. No guessed alliance or fabricated connection.
  if (raw.diplomacy && raw.diplomacy.enabled) {
    for (let i = 0; i < raw.diplomacy.truces.length; i += 1) {
      const record = raw.diplomacy.truces[i];
      if (record.expiresTick > planner.tick || (record.a !== owner && record.b !== owner)) continue;
      if (record.lastDecision === 'rejected' ||
          (record.lastDecision === undefined && record.startedTick === record.expiresTick)) continue;
      const partner = record.a === owner ? record.b : record.a;
      if (target.owner === partner) continue;
      const restored = Object.assign({}, raw, {
        diplomacy: {
          enabled: true,
          truces: raw.diplomacy.truces.concat([Object.assign({}, record, { expiresTick: planner.tick + 1 })]),
        },
      });
      if (planInternal(makePlanner(restored), owner, sourceId, targetId)) {
        return { ok: false, reason: 'truce-ended' };
      }
    }
  }
  return {
    ok: false,
    reason: frontierIds(planner, owner, targetId).length > 0 ? 'disconnected' : 'no-frontier',
  };
}

/** True when the target touches a real own or active allied frontier. */
export function canOwnerReachTarget(
  view: MatchState | MatchSnapshot,
  owner: PlayerId,
  targetId: string
): boolean {
  const planner = makePlanner(view as ReachabilityView);
  const target = planner.byId[targetId];
  if (!target) return false;
  return frontierIds(planner, owner, targetId).length > 0;
}

/** All reachable targets (own targets included), deterministic map order. */
export function ownerReachableTargets(
  view: MatchState | MatchSnapshot,
  owner: PlayerId
): string[] {
  return createOwnerReachability(view, owner).reachableTargets;
}

/** Reachable targets from one specific source, in deterministic map order. */
export function sourceReachableTargets(
  view: MatchState | MatchSnapshot,
  owner: PlayerId,
  sourceId: string
): string[] {
  return sourceReachability(view, owner, sourceId).targetIds;
}

export interface SourceReachability {
  targetIds: string[];
  alliedFrontierIds: string[];
}

/** Both target and transit highlights come from the same source-specific plans. */
export function sourceReachability(
  view: MatchState | MatchSnapshot,
  owner: PlayerId,
  sourceId: string
): SourceReachability {
  const reach = createOwnerReachability(view, owner);
  const planner = makePlanner(view as ReachabilityView);
  const result: SourceReachability = { targetIds: [], alliedFrontierIds: [] };
  for (let i = 0; i < reach.reachableTargets.length; i += 1) {
    const targetId = reach.reachableTargets[i];
    if (targetId === sourceId) continue;
    const route = reach.plan(sourceId, targetId);
    if (!route) continue;
    result.targetIds.push(targetId);
    if (planner.byId[route.frontierId].owner !== owner &&
        result.alliedFrontierIds.indexOf(route.frontierId) < 0) {
      result.alliedFrontierIds.push(route.frontierId);
    }
  }
  return result;
}

/** Reachable non-own targets that can be attacked, deterministic map order. */
export function ownerAttackTargets(
  view: MatchState | MatchSnapshot,
  owner: PlayerId
): string[] {
  return createOwnerReachability(view, owner).attackTargets;
}

/**
 * Per-planning-pass cache. Create one per AI decision pass, never store it on
 * the game state or reuse it across ticks: ownership changes invalidate it.
 */
export function createOwnerReachability(
  view: MatchState | MatchSnapshot,
  owner: PlayerId
): OwnerReachability {
  const planner = makePlanner(view as ReachabilityView);
  const reachableTargets: string[] = [];
  const attackTargets: string[] = [];
  for (let i = 0; i < planner.order.length; i += 1) {
    const targetId = planner.order[i];
    if (frontierIds(planner, owner, targetId).length === 0) continue;
    reachableTargets.push(targetId);
    const target = planner.byId[targetId];
    // Neutrals stay attackable; a truce partner (never hostile) is never
    // listed even if a shared-network frontier touches it.
    if (
      target.owner !== owner &&
      (target.owner === 'neutral' ||
        isHostileAt(planner.diplomacy, planner.tick, owner, target.owner as PlayerId))
    ) {
      attackTargets.push(targetId);
    }
  }
  return {
    owner: owner,
    reachableTargets: reachableTargets,
    attackTargets: attackTargets,
    canReach: function (targetId: string): boolean {
      return frontierIds(planner, owner, targetId).length > 0;
    },
    plan: function (sourceId: string, targetId: string): PlannedMovement | null {
      return planInternal(planner, owner, sourceId, targetId);
    },
  };
}
