import type { MatchView } from '../ui/view-model';
import {
  chainSegments,
  isLegacyRectangleMap,
  pairKey,
  polygonBounds,
  polygonPointContacts,
  polylineLength,
  polylineMidpoint,
  segmentKey,
} from './geometry';
import type { Point, PointContact, Segment } from './geometry';
import { mapToScreen } from './viewport';
import type { Viewport } from './viewport';

export interface WorldBoundary {
  id: string;
  from: string;
  to: string;
  points: Point[];
  kind: 'open' | 'river' | 'ridge';
  passable: boolean;
  edgeId?: string;
  crossing?: Point;
  length: number;
  midpoint: Point;
}

export interface MapTopology {
  boundaries: WorldBoundary[];
  /** Outer coastline polylines derived from polygon edges not shared by two states. */
  coastline: Point[][];
  /** Longest shared arc midpoint per unordered territory pair. */
  pairMidpoints: Record<string, Point>;
  legacy: boolean;
}

export interface ScreenBoundary {
  id: string;
  from: string;
  to: string;
  points: Point[];
  kind: 'open' | 'river' | 'ridge';
  passable: boolean;
  edgeId?: string;
  crossing?: Point;
  midpoint: Point;
  length: number;
}

export interface ScreenTopology {
  boundaries: ScreenBoundary[];
  coastline: Point[][];
  pairMidpoints: Record<string, Point>;
  bridgePoints: Array<{ from: string; to: string; point: Point; kind: 'open' | 'river' | 'ridge' }>;
  legacy: boolean;
}

const SHARED_QUANTUM = 0.01;

/**
 * Render treatment for one shared border. Gameplay edges are the only source of
 * passability, so this never decides adjacency; it only picks the paint mode.
 */
export type BorderStroke = 'state' | 'blocked' | 'river' | 'ridge';

export function borderStroke(boundary: Pick<WorldBoundary, 'kind' | 'passable'>): BorderStroke {
  if (boundary.kind === 'river') return 'river';
  if (boundary.kind === 'ridge') return 'ridge';
  return boundary.passable ? 'state' : 'blocked';
}

/** True only for a real crossing on an edge-backed barrier arc. */
export function boundaryHasCrossing(boundary: Pick<WorldBoundary, 'passable' | 'crossing'>): boolean {
  return boundary.passable && boundary.crossing !== undefined;
}

function edgeKinds(view: MatchView): Record<string, 'land' | 'bridge'> {
  const out: Record<string, 'land' | 'bridge'> = {};
  for (let i = 0; i < view.edges.length; i += 1) {
    const edge = view.edges[i];
    out[pairKey(edge.from, edge.to)] = edge.kind;
  }
  return out;
}

function boundaryFromArcs(
  from: string,
  to: string,
  arcs: Point[][],
  edgeKind: 'land' | 'bridge' | undefined
): WorldBoundary[] {
  const passable = edgeKind !== undefined;
  const out: WorldBoundary[] = [];
  let longestIndex = -1;
  let longestLength = -1;
  for (let i = 0; i < arcs.length; i += 1) {
    const length = polylineLength(arcs[i]);
    if (length > longestLength) {
      longestLength = length;
      longestIndex = i;
    }
  }
  for (let i = 0; i < arcs.length; i += 1) {
    const points = arcs[i];
    if (points.length < 2) continue;
    const midpoint = polylineMidpoint(points);
    out.push({
      id: from + '-' + to + (i === 0 ? '' : '#' + (i + 1)),
      from: from,
      to: to,
      points: points,
      kind: 'open',
      passable: passable,
      length: polylineLength(points),
      midpoint: midpoint,
      crossing: edgeKind === 'bridge' && i === longestIndex ? midpoint : undefined,
    });
  }
  return out;
}

/**
 * Derives exact shared arcs from polygons when the map did not supply the
 * boundary metadata. Only coincident vertices/edges count; bbox proximity is
 * deliberately never used, so a legacy inset grid simply reports no shares.
 */
function deriveBoundaries(view: MatchView, edgeKindByPair: Record<string, 'land' | 'bridge'>): WorldBoundary[] {
  interface Owner {
    id: string;
    a: Point;
    b: Point;
  }
  const owners: Record<string, Owner[]> = {};
  for (let t = 0; t < view.territories.length; t += 1) {
    const territory = view.territories[t];
    const polygon = territory.polygon;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const key = segmentKey(polygon[j], polygon[i], SHARED_QUANTUM);
      if (!owners[key]) owners[key] = [];
      owners[key].push({ id: territory.id, a: polygon[j], b: polygon[i] });
    }
  }

  const pairSegments: Record<string, { from: string; to: string; segments: Segment[] }> = {};
  const keys = Object.keys(owners);
  for (let i = 0; i < keys.length; i += 1) {
    const list = owners[keys[i]];
    if (list.length < 2) continue;
    const first = list[0];
    for (let j = 1; j < list.length; j += 1) {
      const second = list[j];
      if (second.id === first.id) continue;
      const key = pairKey(first.id, second.id);
      if (!pairSegments[key]) {
        pairSegments[key] = {
          from: first.id < second.id ? first.id : second.id,
          to: first.id < second.id ? second.id : first.id,
          segments: [],
        };
      }
      pairSegments[key].segments.push({ a: first.a, b: first.b });
      break;
    }
  }

  const out: WorldBoundary[] = [];
  const pairKeys = Object.keys(pairSegments);
  for (let i = 0; i < pairKeys.length; i += 1) {
    const entry = pairSegments[pairKeys[i]];
    const arcs = chainSegments(entry.segments, SHARED_QUANTUM);
    const built = boundaryFromArcs(
      entry.from,
      entry.to,
      arcs,
      edgeKindByPair[pairKey(entry.from, entry.to)]
    );
    for (let b = 0; b < built.length; b += 1) out.push(built[b]);
  }
  return out;
}

function deriveCoastline(
  view: MatchView,
  boundaries: WorldBoundary[]
): Point[][] {
  if (boundaries.length === 0) return [];
  const shared: Record<string, boolean> = {};
  for (let b = 0; b < boundaries.length; b += 1) {
    const points = boundaries[b].points;
    for (let i = 1; i < points.length; i += 1) {
      shared[segmentKey(points[i - 1], points[i], SHARED_QUANTUM)] = true;
    }
  }

  const segments: Segment[] = [];
  for (let t = 0; t < view.territories.length; t += 1) {
    const polygon = view.territories[t].polygon;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const key = segmentKey(polygon[j], polygon[i], SHARED_QUANTUM);
      if (shared[key]) continue;
      segments.push({ a: polygon[j], b: polygon[i] });
    }
  }
  return chainSegments(segments, SHARED_QUANTUM);
}

export function buildMapTopology(view: MatchView): MapTopology {
  const edgeKindByPair = edgeKinds(view);
  let boundaries: WorldBoundary[] = [];
  if (view.boundaries && view.boundaries.length > 0) {
    for (let i = 0; i < view.boundaries.length; i += 1) {
      const boundary = view.boundaries[i];
      if (boundary.points.length < 2) continue;
      // Edges are the only traversal truth: map metadata may describe the
      // shared arc, but a missing edge still means impassable and a present
      // edge still means passable. Crossing anchors survive only on real edges.
      //
      // Data contract: the map validator rejects a passable river/ridge border
      // without a crossing. A missing anchor stays absent here and the renderer
      // does not invent a midpoint bridge/pass; absence of evidence must never
      // create a usable crossing.
      const edgeKind = edgeKindByPair[pairKey(boundary.from, boundary.to)];
      const passable = edgeKind !== undefined;
      boundaries.push({
        id: boundary.id || boundary.from + '-' + boundary.to,
        from: boundary.from,
        to: boundary.to,
        points: boundary.points,
        kind: boundary.kind,
        passable: passable,
        edgeId: boundary.edgeId,
        crossing: passable ? boundary.crossing : undefined,
        length:
          typeof boundary.length === 'number' && boundary.length > 0
            ? boundary.length
            : polylineLength(boundary.points),
        midpoint:
          boundary.midpoint && boundary.midpoint.length === 2
            ? boundary.midpoint
            : polylineMidpoint(boundary.points),
      });
    }
  } else {
    boundaries = deriveBoundaries(view, edgeKindByPair);
  }

  const pairMidpoints: Record<string, Point> = {};
  const bestLength: Record<string, number> = {};
  for (let i = 0; i < boundaries.length; i += 1) {
    const boundary = boundaries[i];
    const key = pairKey(boundary.from, boundary.to);
    if (!pairMidpoints[key] || boundary.length > (bestLength[key] || -1)) {
      pairMidpoints[key] = boundary.midpoint;
      bestLength[key] = boundary.length;
    }
  }

  const polygons: Array<Array<[number, number]>> = [];
  for (let i = 0; i < view.territories.length; i += 1) {
    polygons.push(view.territories[i].polygon);
  }
  const legacy = boundaries.length === 0 && isLegacyRectangleMap(polygons);

  return {
    boundaries: boundaries,
    coastline: deriveCoastline(view, boundaries),
    pairMidpoints: pairMidpoints,
    legacy: legacy,
  };
}

export function mapTopologyToScreen(
  viewport: Viewport,
  topology: MapTopology,
  view?: MatchView
): ScreenTopology {
  const boundaries: ScreenBoundary[] = [];
  const pairMidpoints: Record<string, Point> = {};

  for (let i = 0; i < topology.boundaries.length; i += 1) {
    const boundary = topology.boundaries[i];
    const points: Point[] = [];
    for (let p = 0; p < boundary.points.length; p += 1) {
      points.push(mapToScreen(viewport, boundary.points[p][0], boundary.points[p][1]));
    }
    const midpoint = mapToScreen(
      viewport,
      boundary.midpoint[0],
      boundary.midpoint[1]
    );
    boundaries.push({
      id: boundary.id,
      from: boundary.from,
      to: boundary.to,
      points: points,
      kind: boundary.kind,
      passable: boundary.passable,
      edgeId: boundary.edgeId,
      crossing: boundary.crossing
        ? mapToScreen(viewport, boundary.crossing[0], boundary.crossing[1])
        : undefined,
      midpoint: midpoint,
      length: boundary.length * viewport.scale,
    });
  }

  const keys = Object.keys(topology.pairMidpoints);
  for (let i = 0; i < keys.length; i += 1) {
    const point = topology.pairMidpoints[keys[i]];
    pairMidpoints[keys[i]] = mapToScreen(viewport, point[0], point[1]);
  }

  const coastline: Point[][] = [];
  for (let i = 0; i < topology.coastline.length; i += 1) {
    const line: Point[] = [];
    for (let p = 0; p < topology.coastline[i].length; p += 1) {
      line.push(
        mapToScreen(
          viewport,
          topology.coastline[i][p][0],
          topology.coastline[i][p][1]
        )
      );
    }
    if (line.length >= 2) coastline.push(line);
  }

  const bridgePoints: Array<{ from: string; to: string; point: Point; kind: 'open' | 'river' | 'ridge' }> = [];
  const seenEdges: Record<string, boolean> = {};
  for (let b = 0; b < boundaries.length; b += 1) {
    const boundary = boundaries[b];
    if (!boundaryHasCrossing(boundary) || !boundary.crossing) continue;
    const key = pairKey(boundary.from, boundary.to);
    if (seenEdges[key]) continue;
    // One marker per territory pair; only the edge-backed arc carries the
    // crossing, so a blocked river/ridge can never invent a bridge/pass.
    seenEdges[key] = true;
    bridgePoints.push({
      from: boundary.from,
      to: boundary.to,
      point: boundary.crossing,
      kind: boundary.kind,
    });
  }

  return {
    boundaries: boundaries,
    coastline: coastline,
    pairMidpoints: pairMidpoints,
    bridgePoints: bridgePoints,
    legacy: topology.legacy,
  };
}

/**
 * World-space point contacts are a property of the map arrangement (polygons,
 * declared borders and gameplay edges), not of the camera. A renderer caches
 * this per mapKey and re-projects the same array on zoom/pan; separate panes
 * each hold their own cache instead of sharing one global Map.
 */
export interface PointContactCache {
  mapKey: string;
  contacts: PointContact[];
}

export function resolvePointContacts(
  cache: PointContactCache | null,
  mapKey: string,
  view: MatchView
): PointContactCache {
  if (cache && cache.mapKey === mapKey) return cache;
  const excluded: Record<string, boolean> = {};
  for (let i = 0; i < view.edges.length; i += 1) {
    excluded[pairKey(view.edges[i].from, view.edges[i].to)] = true;
  }
  if (view.boundaries) {
    for (let i = 0; i < view.boundaries.length; i += 1) {
      excluded[pairKey(view.boundaries[i].from, view.boundaries[i].to)] = true;
    }
  }
  return {
    mapKey: mapKey,
    contacts: polygonPointContacts(view.territories, excluded),
  };
}

export function projectPointContacts(
  viewport: Viewport,
  contacts: ReadonlyArray<PointContact>
): Point[] {
  const out: Point[] = [];
  const seen: Record<string, boolean> = {};
  for (let i = 0; i < contacts.length; i += 1) {
    const screen = mapToScreen(viewport, contacts[i].point[0], contacts[i].point[1]);
    const key = Math.round(screen[0] * 2) + ',' + Math.round(screen[1] * 2);
    if (seen[key]) continue;
    seen[key] = true;
    out.push(screen);
  }
  return out;
}

export interface BarrierHintBoundary {
  from: string;
  to: string;
  kind: 'open' | 'river' | 'ridge';
  passable: boolean;
}

export interface BarrierHintInput<T extends BarrierHintBoundary> {
  /** The real preview reason; only not_adjacent can be explained by terrain. */
  reason: string | null | undefined;
  sourceOwner: string | null | undefined;
  targetId: string;
  edges: ReadonlyArray<{ from: string; to: string }>;
  territories: Readonly<Record<string, { owner: string }>>;
  boundaries: ReadonlyArray<T>;
}

/**
 * Pure gate for the drag rejection hint. Returns the blocked river/ridge arcs
 * between the target and the acting owner only when:
 *  - the preview actually rejected with not_adjacent, and
 *  - no gameplay edge gives the target a frontier adjacent to that owner.
 *
 * Source adjacency is never consulted, and visuals never make an edge. An
 * empty result means the caller must keep the generic "not connected" text.
 */
export function barrierBlockedBoundaries<T extends BarrierHintBoundary>(
  input: BarrierHintInput<T>
): T[] {
  if (input.reason !== 'not_adjacent') return [];
  const owner = input.sourceOwner;
  if (!owner || owner === 'neutral') return [];
  const targetId = input.targetId;
  for (let i = 0; i < input.edges.length; i += 1) {
    const edge = input.edges[i];
    let otherId = '';
    if (edge.from === targetId) otherId = edge.to;
    else if (edge.to === targetId) otherId = edge.from;
    if (!otherId) continue;
    const other = input.territories[otherId];
    if (other && other.owner === owner) return [];
  }

  const out: T[] = [];
  for (let i = 0; i < input.boundaries.length; i += 1) {
    const boundary = input.boundaries[i];
    if (boundary.passable || boundary.kind === 'open') continue;
    let otherId = '';
    if (boundary.from === targetId) otherId = boundary.to;
    else if (boundary.to === targetId) otherId = boundary.from;
    if (!otherId) continue;
    const other = input.territories[otherId];
    if (other && other.owner === owner) out.push(boundary);
  }
  return out;
}

/** Debug/selection helper: world-space bounds of one territory. */
export function territoryBounds(territory: MatchView['territories'][number]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const bounds = polygonBounds(territory.polygon);
  return {
    minX: bounds.minX,
    maxX: bounds.maxX,
    minY: bounds.minY,
    maxY: bounds.maxY,
  };
}
