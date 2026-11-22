import { capacityForArea } from '../core/capacity';
import { DEFAULT_REFERENCE_AREA } from '../config/balance';
import type { OwnerId, PlayerId } from '../core/types';
import type { GameMapDefinition, MapValidationResult } from './types';

const PLAYER_IDS: PlayerId[] = ['player', 'ai1', 'ai2', 'ai3'];
const OWNER_IDS: OwnerId[] = ['player', 'ai1', 'ai2', 'ai3', 'neutral'];
const TERRAINS = ['plain', 'forest', 'hill', 'mountain'];
const EDGE_KINDS = ['land', 'bridge'];
const BOUNDARY_KINDS = ['open', 'river', 'ridge'];

function isFinitePoint(point: [number, number]): boolean {
  return (
    Array.isArray(point) &&
    point.length === 2 &&
    isFinite(point[0]) &&
    isFinite(point[1])
  );
}

function orientation(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number
): boolean {
  return (
    Math.min(ax, bx) - 1e-9 <= px &&
    px <= Math.max(ax, bx) + 1e-9 &&
    Math.min(ay, by) - 1e-9 <= py &&
    py <= Math.max(ay, by) + 1e-9
  );
}

function segmentsIntersect(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number]
): boolean {
  const o1 = orientation(a[0], a[1], b[0], b[1], c[0], c[1]);
  const o2 = orientation(a[0], a[1], b[0], b[1], d[0], d[1]);
  const o3 = orientation(c[0], c[1], d[0], d[1], a[0], a[1]);
  const o4 = orientation(c[0], c[1], d[0], d[1], b[0], b[1]);

  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
      ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }
  if (Math.abs(o1) <= 1e-9 && onSegment(a[0], a[1], b[0], b[1], c[0], c[1])) return true;
  if (Math.abs(o2) <= 1e-9 && onSegment(a[0], a[1], b[0], b[1], d[0], d[1])) return true;
  if (Math.abs(o3) <= 1e-9 && onSegment(c[0], c[1], d[0], d[1], a[0], a[1])) return true;
  if (Math.abs(o4) <= 1e-9 && onSegment(c[0], c[1], d[0], d[1], b[0], b[1])) return true;
  return false;
}

export function polygonArea(polygon: Array<[number, number]>): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const j = (i + 1) % polygon.length;
    sum += polygon[i][0] * polygon[j][1] - polygon[j][0] * polygon[i][1];
  }
  return sum / 2;
}

export function polygonSelfIntersects(polygon: Array<[number, number]>): boolean {
  const n = polygon.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    for (let j = i + 1; j < n; j += 1) {
      // Adjacent edges share an endpoint by design.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const c = polygon[j];
      const d = polygon[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

export function pointInPolygon(
  x: number,
  y: number,
  polygon: Array<[number, number]>
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function edgeKey(a: string, b: string): string {
  return a < b ? a + '|' + b : b + '|' + a;
}

function polylineLength(points: Array<[number, number]>): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

/**
 * A boundary segment is valid only when its full length is covered by
 * collinear, positive-length edges of BOTH polygons. Sampling near a ring is
 * not enough: at Four Corners a 0.001-long fake segment can stay within 0.001
 * of both rings while only one state actually owns that direction.
 *
 * Directions are normalized, so `COLLINEAR_TOL` is a sine/perp-distance
 * tolerance (1e-7), not a generous proximity radius. Shared vertices in the
 * generated data are identical, so real linear segments match exactly.
 */
const COLLINEAR_TOL = 1e-7;
const COVERAGE_EPS = 1e-7;

function segmentCoveredByRing(
  a: [number, number],
  b: [number, number],
  ring: Array<[number, number]>
): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length <= 1e-9) return true;
  const ux = dx / length;
  const uy = dy / length;

  const intervals: Array<[number, number]> = [];
  for (let i = 0; i < ring.length; i += 1) {
    const c = ring[i];
    const d = ring[(i + 1) % ring.length];
    const ex = d[0] - c[0];
    const ey = d[1] - c[1];
    const edgeLength = Math.sqrt(ex * ex + ey * ey);
    if (edgeLength <= 1e-12) continue;
    // Parallel (normalized sine) and on the same infinite line (perp distance).
    if (Math.abs(ux * ey - uy * ex) / edgeLength > COLLINEAR_TOL) continue;
    if (Math.abs(ux * (c[1] - a[1]) - uy * (c[0] - a[0])) > COLLINEAR_TOL) continue;
    const tc = (c[0] - a[0]) * ux + (c[1] - a[1]) * uy;
    const td = (d[0] - a[0]) * ux + (d[1] - a[1]) * uy;
    const lo = Math.max(0, Math.min(tc, td));
    const hi = Math.min(length, Math.max(tc, td));
    if (hi - lo > COVERAGE_EPS) intervals.push([lo, hi]);
  }
  if (intervals.length === 0) return false;
  intervals.sort(function (left, right) { return left[0] - right[0]; });
  let covered = 0;
  for (let i = 0; i < intervals.length; i += 1) {
    if (intervals[i][0] > covered + COVERAGE_EPS) return false;
    if (intervals[i][1] > covered) covered = intervals[i][1];
    if (covered >= length - COVERAGE_EPS) return true;
  }
  return false;
}

function boundaryOnPolygons(
  points: Array<[number, number]>,
  first: Array<[number, number]>,
  second: Array<[number, number]>
): boolean {
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!segmentCoveredByRing(a, b, first)) return false;
    if (!segmentCoveredByRing(a, b, second)) return false;
  }
  return true;
}

/**
 * Full map gate. Unknown endpoints, duplicate/self edges, invalid polygons,
 * bad spawns and unreachable islands all fail with a readable message.
 */
export function validateMap(map: GameMapDefinition): MapValidationResult {
  const errors: string[] = [];
  if (!map || typeof map !== 'object') {
    return { ok: false, errors: ['map is not an object'] };
  }
  if (!map.id) errors.push('map.id is required');
  if (!map.name) errors.push('map.name is required');
  if (!isFinite(map.width) || map.width <= 0) errors.push('map.width must be positive');
  if (!isFinite(map.height) || map.height <= 0) errors.push('map.height must be positive');
  if (!Array.isArray(map.supportedDurations) || map.supportedDurations.length === 0) {
    errors.push('map.supportedDurations must not be empty');
  }

  const ids: Record<string, boolean> = {};
  const ownersById: Record<string, OwnerId> = {};
  const polygonsById: Record<string, Array<[number, number]>> = {};
  for (let i = 0; i < map.territories.length; i += 1) {
    const territory = map.territories[i];
    const where = 'territory ' + (territory && territory.id ? territory.id : '#' + i);
    if (!territory.id) {
      errors.push(where + ': id is required');
      continue;
    }
    if (ids[territory.id]) errors.push('duplicate territory id ' + territory.id);
    ids[territory.id] = true;
    ownersById[territory.id] = territory.owner;
    if (Array.isArray(territory.polygon)) polygonsById[territory.id] = territory.polygon;

    if (OWNER_IDS.indexOf(territory.owner) < 0) errors.push(where + ': invalid owner');
    if (TERRAINS.indexOf(territory.terrain) < 0) errors.push(where + ': invalid terrain');
    if (!isFinite(territory.areaUnits) || territory.areaUnits <= 0) {
      errors.push(where + ': areaUnits must be positive');
    }
    if (!isFinite(territory.scoreValue) || territory.scoreValue < 0) {
      errors.push(where + ': scoreValue must be non-negative');
    }
    if (!isFinite(territory.initialTroops) || territory.initialTroops < 0 ||
        Math.floor(territory.initialTroops) !== territory.initialTroops) {
      errors.push(where + ': initialTroops must be a non-negative integer');
    } else {
      const capacity = capacityForArea(territory.areaUnits, map.referenceArea || DEFAULT_REFERENCE_AREA);
      if (territory.initialTroops > capacity) {
        errors.push(where + ': initialTroops exceeds capacity ' + capacity);
      }
      if (territory.owner !== 'neutral' && territory.initialTroops < 1) {
        errors.push(where + ': owned territory needs at least 1 initial troop');
      }
    }

    if (!Array.isArray(territory.polygon) || territory.polygon.length < 3) {
      errors.push(where + ': polygon needs at least 3 vertices');
    } else {
      let valid = true;
      for (let p = 0; p < territory.polygon.length; p += 1) {
        const point = territory.polygon[p];
        if (!isFinitePoint(point)) {
          errors.push(where + ': polygon vertex ' + p + ' is not finite');
          valid = false;
          continue;
        }
        if (point[0] < 0 || point[0] > map.width || point[1] < 0 || point[1] > map.height) {
          errors.push(where + ': polygon vertex ' + p + ' is outside map bounds');
        }
      }
      if (valid) {
        if (Math.abs(polygonArea(territory.polygon)) < 1e-6) {
          errors.push(where + ': polygon has zero area');
        }
        if (polygonSelfIntersects(territory.polygon)) {
          errors.push(where + ': polygon self-intersects');
        }
      }
    }

    if (!isFinitePoint(territory.center)) {
      errors.push(where + ': center is not finite');
    } else if (territory.center[0] < 0 || territory.center[0] > map.width ||
               territory.center[1] < 0 || territory.center[1] > map.height) {
      errors.push(where + ': center is outside map bounds');
    } else if (
      Array.isArray(territory.polygon) &&
      territory.polygon.length >= 3 &&
      !pointInPolygon(territory.center[0], territory.center[1], territory.polygon)
    ) {
      errors.push(where + ': center is outside its own polygon');
    }
  }

  const edgePairs: Record<string, boolean> = {};
  const edgeIds: Record<string, boolean> = {};
  const edgeById: Record<string, { from: string; to: string }> = {};
  for (let i = 0; i < map.edges.length; i += 1) {
    const edge = map.edges[i];
    const where = 'edge ' + (edge.id || '#' + i);
    if (!ids[edge.from]) errors.push(where + ': unknown from "' + edge.from + '"');
    if (!ids[edge.to]) errors.push(where + ': unknown to "' + edge.to + '"');
    if (edge.from === edge.to) errors.push(where + ': self edges are forbidden');
    if (EDGE_KINDS.indexOf(edge.kind) < 0) errors.push(where + ': invalid kind');
    if (edge.travelFactor !== undefined &&
        (!isFinite(edge.travelFactor) || edge.travelFactor <= 0)) {
      errors.push(where + ': travelFactor must be positive');
    }
    const pair = edgeKey(edge.from, edge.to);
    if (edgePairs[pair]) errors.push(where + ': duplicate edge ' + edge.from + ' - ' + edge.to);
    edgePairs[pair] = true;
    if (edge.id) {
      if (edgeIds[edge.id]) errors.push(where + ': duplicate edge id');
      edgeIds[edge.id] = true;
      edgeById[edge.id] = { from: edge.from, to: edge.to };
    }
  }

  // Geographic maps declare every shared border arc. Gameplay edges must be
  // backed by a real, positive-length passable arc; blocked arcs must not
  // create an edge. This is what prevents point-touch or guessed adjacency.
  const boundaries = map.layout && map.layout.boundaries;
  const geoMode = Array.isArray(boundaries);
  if (map.layout && map.layout.geography && !geoMode) {
    errors.push('layout.geography requires layout.boundaries');
  }
  if (geoMode) {
    const boundaryIds: Record<string, boolean> = {};
    const coveredEdges: Record<string, boolean> = {};
    const boundaryPairs: Record<string, { passable: boolean; blocked: boolean }> = {};
    for (let i = 0; i < boundaries.length; i += 1) {
      const boundary = boundaries[i];
      const where = 'boundary ' + (boundary.id || '#' + i);
      if (!boundary.id) errors.push(where + ': id is required');
      else {
        if (boundaryIds[boundary.id]) errors.push(where + ': duplicate boundary id');
        boundaryIds[boundary.id] = true;
      }
      if (!ids[boundary.from]) errors.push(where + ': unknown from "' + boundary.from + '"');
      if (!ids[boundary.to]) errors.push(where + ': unknown to "' + boundary.to + '"');
      if (boundary.from === boundary.to) errors.push(where + ': self boundary is forbidden');
      if (BOUNDARY_KINDS.indexOf(boundary.kind) < 0) errors.push(where + ': invalid kind');
      if (typeof boundary.passable !== 'boolean') errors.push(where + ': passable must be boolean');

      let positiveLength = false;
      let geometryValid = false;
      if (!Array.isArray(boundary.points) || boundary.points.length < 2) {
        errors.push(where + ': points needs at least 2 vertices');
      } else {
        let pointsValid = true;
        for (let p = 0; p < boundary.points.length; p += 1) {
          const point = boundary.points[p];
          if (!isFinitePoint(point)) {
            errors.push(where + ': point ' + p + ' is not finite');
            pointsValid = false;
            continue;
          }
          if (point[0] < 0 || point[0] > map.width ||
              point[1] < 0 || point[1] > map.height) {
            errors.push(where + ': point ' + p + ' is outside map bounds');
          }
        }
        if (pointsValid) {
          positiveLength = polylineLength(boundary.points) > 1e-6;
          if (!positiveLength) errors.push(where + ': zero-length shared border');
          const first = polygonsById[boundary.from];
          const second = polygonsById[boundary.to];
          if (first && second && boundary.from !== boundary.to) {
            geometryValid = boundaryOnPolygons(boundary.points, first, second);
            if (!geometryValid) {
              errors.push(where + ': shared border is not on both polygons');
            }
          }
        }
      }

      if (boundary.from !== boundary.to) {
        const pair = edgeKey(boundary.from, boundary.to);
        if (!boundaryPairs[pair]) boundaryPairs[pair] = { passable: false, blocked: false };
        if (boundary.passable) boundaryPairs[pair].passable = true;
        else boundaryPairs[pair].blocked = true;
      }

      if (boundary.passable) {
        if (!boundary.edgeId) {
          errors.push(where + ': passable boundary needs edgeId');
        } else {
          const edge = edgeById[boundary.edgeId];
          if (!edge) {
            errors.push(where + ': unknown edgeId "' + boundary.edgeId + '"');
          } else if (edgeKey(edge.from, edge.to) !== edgeKey(boundary.from, boundary.to)) {
            errors.push(where + ': edgeId endpoints do not match the boundary');
          } else if (positiveLength && geometryValid) {
            coveredEdges[boundary.edgeId] = true;
          }
        }
        if (boundary.crossing !== undefined) {
          if (!isFinitePoint(boundary.crossing)) {
            errors.push(where + ': crossing is not finite');
          } else if (boundary.crossing[0] < 0 || boundary.crossing[0] > map.width ||
                     boundary.crossing[1] < 0 || boundary.crossing[1] > map.height) {
            errors.push(where + ': crossing is outside map bounds');
          }
        }
      } else {
        if (boundary.edgeId) errors.push(where + ': blocked boundary must not reference an edge');
        if (boundary.kind === 'open') errors.push(where + ': open boundary cannot be blocked');
      }
    }

    for (const pair in boundaryPairs) {
      if (!Object.prototype.hasOwnProperty.call(boundaryPairs, pair)) continue;
      const state = boundaryPairs[pair];
      const label = pair.split('|').join(' - ');
      if (state.passable && state.blocked) {
        errors.push('border pair ' + label + ': passable and blocked arcs conflict');
      }
      if (state.blocked && edgePairs[pair]) {
        errors.push('border pair ' + label + ': blocked border must not have a gameplay edge');
      }
    }

    for (let i = 0; i < map.edges.length; i += 1) {
      const edge = map.edges[i];
      if (!edge.id) {
        errors.push('edge #' + i + ': geographic maps require edge ids');
      } else if (!coveredEdges[edge.id]) {
        errors.push('edge ' + edge.id + ': no passable shared boundary');
      }
    }

    const geography = map.layout && map.layout.geography;
    if (geography) {
      const groups = geography.groups;
      if (groups) {
        if (groups.length !== 2) errors.push('geography.groups must describe exactly two sides');
        const groupBy: Record<string, string> = {};
        for (let g = 0; g < groups.length; g += 1) {
          const group = groups[g];
          if (!group.id) errors.push('geography group #' + g + ': id is required');
          for (let t = 0; t < group.territoryIds.length; t += 1) {
            const id = group.territoryIds[t];
            if (!ids[id]) {
              errors.push('geography group ' + group.id + ': unknown territory "' + id + '"');
            } else if (groupBy[id] && groupBy[id] !== group.id) {
              errors.push('territory ' + id + ' is assigned to multiple geography groups');
            } else {
              groupBy[id] = group.id;
            }
          }
        }
        for (const id in ids) {
          if (!Object.prototype.hasOwnProperty.call(ids, id)) continue;
          if (!groupBy[id]) errors.push('territory ' + id + ' is not assigned to a geography group');
        }

        const crossEdges = [];
        for (let e = 0; e < map.edges.length; e += 1) {
          const edge = map.edges[e];
          if (!ids[edge.from] || !ids[edge.to] || edge.from === edge.to) continue;
          if (groupBy[edge.from] !== groupBy[edge.to]) crossEdges.push(edge);
        }
        const barrier = geography.barrier;
        if (!barrier) {
          if (crossEdges.length > 0) errors.push('cross-group edges require barrier metadata');
        } else {
          if (barrier.kind !== 'river' && barrier.kind !== 'ridge') {
            errors.push('geography.barrier.kind must be river or ridge');
          }
          if (EDGE_KINDS.indexOf(barrier.crossKind) < 0) {
            errors.push('geography.barrier.crossKind is invalid');
          }
          if (!isFinite(barrier.crossingCount) || barrier.crossingCount < 1 ||
              Math.floor(barrier.crossingCount) !== barrier.crossingCount) {
            errors.push('geography.barrier.crossingCount must be a positive integer');
          }
          if (crossEdges.length !== barrier.crossingCount) {
            errors.push(
              'geography.barrier.crossingCount is ' + barrier.crossingCount +
                ' but the map has ' + crossEdges.length + ' cross-group edges'
            );
          }
          for (let e = 0; e < crossEdges.length; e += 1) {
            const edge = crossEdges[e];
            const id = edge.id || '#';
            if (edge.kind !== barrier.crossKind) {
              errors.push('cross-group edge ' + id + ': kind must be ' + barrier.crossKind);
            }
            const paid = boundaries.filter(function (item) {
              return item.passable && item.edgeId === edge.id;
            });
            if (!paid.some(function (item) { return item.kind === barrier.kind; })) {
              errors.push('cross-group edge ' + id + ': needs a passable ' + barrier.kind + ' boundary');
            }
            if (!paid.some(function (item) { return item.crossing !== undefined; })) {
              errors.push('cross-group edge ' + id + ': needs a crossing marker');
            }
          }
          const markers = boundaries.filter(function (item) {
            return item.crossing !== undefined;
          });
          if (markers.length !== barrier.crossingCount) {
            errors.push(
              'geography.barrier has ' + markers.length + ' crossing markers, expected ' +
                barrier.crossingCount
            );
          }
          for (let b = 0; b < markers.length; b += 1) {
            const marker = markers[b];
            if (!groupBy[marker.from] || groupBy[marker.from] === groupBy[marker.to]) {
              errors.push('boundary ' + marker.id + ': crossing marker is not on a cross-group border');
            }
          }
          for (let b = 0; b < boundaries.length; b += 1) {
            const boundary = boundaries[b];
            if (boundary.passable) continue;
            if (groupBy[boundary.from] && groupBy[boundary.from] === groupBy[boundary.to]) {
              errors.push('boundary ' + boundary.id + ': blocked border is inside one group');
            }
            if (boundary.kind !== barrier.kind) {
              errors.push('boundary ' + boundary.id + ': blocked border kind must be ' + barrier.kind);
            }
          }
        }
      } else if (geography.barrier) {
        errors.push('geography.barrier requires geography.groups');
      }
    }
  }

  const spawns = map.spawnTerritories || {};
  const spawned: Record<string, boolean> = {};
  for (let i = 0; i < PLAYER_IDS.length; i += 1) {
    const owner = PLAYER_IDS[i];
    const list = spawns[owner];
    if (!list || list.length === 0) continue;
    for (let s = 0; s < list.length; s += 1) {
      const id = list[s];
      if (!ids[id]) {
        errors.push('spawn ' + owner + ': unknown territory "' + id + '"');
        continue;
      }
      if (spawned[id]) errors.push('territory spawned twice: ' + id);
      spawned[id] = true;
      if (ownersById[id] !== owner) {
        errors.push('spawn ' + owner + ': territory ' + id + ' is owned by ' + ownersById[id]);
      }
    }
  }
  if (!spawns.player || spawns.player.length === 0) {
    errors.push('spawnTerritories.player must contain at least one territory');
  }

  // Multi-faction maps (3+ active sides) must give every side the same number
  // of homes and the same home garrison; 2-faction maps keep their old shape.
  const activeSpawnLists: string[][] = [];
  for (let i = 0; i < PLAYER_IDS.length; i += 1) {
    const list = spawns[PLAYER_IDS[i]];
    if (list && list.length > 0) activeSpawnLists.push(list);
  }
  if (activeSpawnLists.length >= 3) {
    const homeCount = activeSpawnLists[0].length;
    for (let i = 1; i < activeSpawnLists.length; i += 1) {
      if (activeSpawnLists[i].length !== homeCount) {
        errors.push('multi-faction spawn lists must have equal home counts');
        break;
      }
    }
    let homeTroops = -1;
    for (let i = 0; i < map.territories.length; i += 1) {
      const territory = map.territories[i];
      if (territory.owner === 'neutral') continue;
      if (homeTroops < 0) homeTroops = territory.initialTroops;
      else if (territory.initialTroops !== homeTroops) {
        errors.push('multi-faction maps must give every home the same initial troops');
        break;
      }
    }
  }
  for (let i = 0; i < map.territories.length; i += 1) {
    const territory = map.territories[i];
    if (territory.owner !== 'neutral' && !spawned[territory.id]) {
      errors.push('non-neutral territory ' + territory.id + ' is not listed in spawnTerritories');
    }
  }

  // Every territory must be reachable from every declared spawn cluster.
  const adjacency: Record<string, string[]> = {};
  for (const id in ids) {
    if (Object.prototype.hasOwnProperty.call(ids, id)) adjacency[id] = [];
  }
  for (let i = 0; i < map.edges.length; i += 1) {
    const edge = map.edges[i];
    if (!ids[edge.from] || !ids[edge.to] || edge.from === edge.to) continue;
    adjacency[edge.from].push(edge.to);
    adjacency[edge.to].push(edge.from);
  }
  const starts: string[] = [];
  for (let i = 0; i < PLAYER_IDS.length; i += 1) {
    const list = spawns[PLAYER_IDS[i]];
    if (list) for (let s = 0; s < list.length; s += 1) {
      if (ids[list[s]]) starts.push(list[s]);
    }
  }
  for (let s = 0; s < starts.length; s += 1) {
    const seen: Record<string, boolean> = {};
    const queue: string[] = [starts[s]];
    seen[starts[s]] = true;
    while (queue.length) {
      const current = queue.shift() as string;
      const neighbors = adjacency[current] || [];
      for (let n = 0; n < neighbors.length; n += 1) {
        if (!seen[neighbors[n]]) {
          seen[neighbors[n]] = true;
          queue.push(neighbors[n]);
        }
      }
    }
    const total = Object.keys(ids).length;
    if (Object.keys(seen).length !== total) {
      errors.push('island detected: not all territories are reachable from ' + starts[s]);
      break;
    }
  }

  return { ok: errors.length === 0, errors: errors };
}
