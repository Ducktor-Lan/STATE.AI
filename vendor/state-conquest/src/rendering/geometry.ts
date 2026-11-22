/**
 * Pure polygon helpers shared by the renderer and hit-testing.
 *
 * Coordinates are always map-space unless a name says otherwise. These helpers
 * never mutate the simulation and never infer passability; they only describe
 * the shape a map author supplied.
 */

export type Point = [number, number];
export type Polygon = Point[];

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface Segment {
  a: Point;
  b: Point;
}

export interface ClosestPoint {
  point: Point;
  distance: number;
}

function samePoint(a: Point, b: Point, epsilon: number): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon;
}

export function polygonBounds(polygon: Polygon): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const x = polygon[i][0];
    const y = polygon[i][1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
      centerX: 0,
      centerY: 0,
    };
  }
  return {
    minX: minX,
    minY: minY,
    maxX: maxX,
    maxY: maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

/** Absolute shoelace area in map units squared. */
export function polygonArea(polygon: Polygon): number {
  if (polygon.length < 3) return 0;
  let total = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    total += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
  }
  return Math.abs(total) / 2;
}

/** Area-weighted centroid, with a vertex-average fallback for degenerate rings. */
export function polygonCentroid(polygon: Polygon): Point {
  if (polygon.length === 0) return [0, 0];
  if (polygon.length < 3) return [polygon[0][0], polygon[0][1]];
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const cross = polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
    twiceArea += cross;
    cx += (polygon[j][0] + polygon[i][0]) * cross;
    cy += (polygon[j][1] + polygon[i][1]) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < polygon.length; i += 1) {
      sx += polygon[i][0];
      sy += polygon[i][1];
    }
    return [sx / polygon.length, sy / polygon.length];
  }
  const factor = 1 / (3 * twiceArea);
  return [cx * factor, cy * factor];
}

export function pointInPolygon(x: number, y: number, polygon: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) {
    return Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const x = ax + dx * t;
  const y = ay + dy * t;
  return Math.sqrt((px - x) * (px - x) + (py - y) * (py - y));
}

export function distanceToPolygonEdge(x: number, y: number, polygon: Polygon): number {
  if (polygon.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const d = distanceToSegment(x, y, polygon[j][0], polygon[j][1], polygon[i][0], polygon[i][1]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * A robust interior anchor: the point with the largest clearance from every
 * edge. A coarse grid plus local refinement is enough for 12-26 territories
 * and avoids the edge-hugging artefacts of a plain centroid on concave states.
 */
export function interiorPoint(polygon: Polygon, preferred?: Point): Point {
  const bounds = polygonBounds(polygon);
  if (polygon.length < 3) return [bounds.centerX, bounds.centerY];

  const candidates: Point[] = [];
  const centroid = polygonCentroid(polygon);
  candidates.push(centroid);
  candidates.push([bounds.centerX, bounds.centerY]);
  if (preferred) candidates.push(preferred);

  let best: Point | null = null;
  let bestClearance = -Infinity;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (!pointInPolygon(candidate[0], candidate[1], polygon)) continue;
    const clearance = distanceToPolygonEdge(candidate[0], candidate[1], polygon);
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = candidate;
    }
  }

  const span = Math.max(bounds.width, bounds.height);
  if (span <= 0) return [bounds.centerX, bounds.centerY];
  const longSide = Math.max(bounds.width, bounds.height);
  const shortSide = Math.max(1e-6, Math.min(bounds.width, bounds.height));
  const aspect = longSide / shortSide;
  const cols = aspect > 3 ? 30 : 20;
  const rows = cols;
  const cellW = bounds.width / cols;
  const cellH = bounds.height / rows;

  for (let row = 0; row < rows; row += 1) {
    const y = bounds.minY + (row + 0.5) * cellH;
    for (let col = 0; col < cols; col += 1) {
      const x = bounds.minX + (col + 0.5) * cellW;
      if (!pointInPolygon(x, y, polygon)) continue;
      const clearance = distanceToPolygonEdge(x, y, polygon);
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = [x, y];
      }
    }
  }

  if (!best) return centroid;

  // Local refinement: three halvings around the best cell centre.
  let stepX = cellW / 2;
  let stepY = cellH / 2;
  let anchor: Point = [best[0], best[1]];
  for (let level = 0; level < 4; level += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = anchor[0] + dx * stepX;
        const y = anchor[1] + dy * stepY;
        if (!pointInPolygon(x, y, polygon)) continue;
        const clearance = distanceToPolygonEdge(x, y, polygon);
        if (clearance > bestClearance) {
          bestClearance = clearance;
          best = [x, y];
        }
      }
    }
    anchor = [best[0], best[1]];
    stepX /= 2;
    stepY /= 2;
  }
  return best;
}

export function polylineLength(points: Polygon): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

export function pointAlongPolyline(points: Polygon, t: number): Point {
  if (points.length === 0) return [0, 0];
  if (points.length === 1) return [points[0][0], points[0][1]];
  const total = polylineLength(points);
  if (total <= 0) return [points[0][0], points[0][1]];
  let remaining = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const length = Math.sqrt(dx * dx + dy * dy);
    if (remaining <= length || i === points.length - 1) {
      const u = length <= 0 ? 0 : remaining / length;
      return [points[i - 1][0] + dx * u, points[i - 1][1] + dy * u];
    }
    remaining -= length;
  }
  return [points[points.length - 1][0], points[points.length - 1][1]];
}

export function polylineMidpoint(points: Polygon): Point {
  return pointAlongPolyline(points, 0.5);
}

/**
 * Splits a polyline around the point nearest to `point`, leaving an opening of
 * `gap` (in polyline units) centred on that projection. Used to cut a visible
 * bridge/pass opening into a river or ridge band; the two returned pieces keep
 * their original direction and never include the crossing point itself.
 */
export function splitPolylineAtPoint(points: Point[], point: Point, gap: number): Point[][] {
  if (points.length < 2) return points.length === 1 ? [points.slice()] : [];
  let total = 0;
  let bestDistance = Infinity;
  let bestAlong = 0;
  for (let i = 1; i < points.length; i += 1) {
    const ax = points[i - 1][0];
    const ay = points[i - 1][1];
    const dx = points[i][0] - ax;
    const dy = points[i][1] - ay;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length <= 0) continue;
    const t = Math.max(
      0,
      Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / (dx * dx + dy * dy))
    );
    const px = ax + dx * t;
    const py = ay + dy * t;
    const distance = Math.sqrt((point[0] - px) * (point[0] - px) + (point[1] - py) * (point[1] - py));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestAlong = total + t * length;
    }
    total += length;
  }
  if (!isFinite(bestDistance)) return [points.slice()];
  const opening = gap > 0 ? gap : 0;
  if (total <= opening) return [];
  const start = Math.max(0, bestAlong - opening / 2);
  const end = Math.min(total, bestAlong + opening / 2);
  if (end <= start) return [points.slice()];
  const pieces: Point[][] = [];
  const before = slicePolyline(points, 0, start);
  const after = slicePolyline(points, end, total);
  if (before.length >= 2) pieces.push(before);
  if (after.length >= 2) pieces.push(after);
  return pieces;
}

function slicePolyline(points: Point[], from: number, to: number): Point[] {
  if (to <= from) return [];
  const out: Point[] = [];
  let walked = 0;
  for (let i = 1; i < points.length; i += 1) {
    const ax = points[i - 1][0];
    const ay = points[i - 1][1];
    const dx = points[i][0] - ax;
    const dy = points[i][1] - ay;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length <= 0) continue;
    const segmentStart = walked;
    const segmentEnd = walked + length;
    walked = segmentEnd;
    if (segmentEnd <= from) continue;
    if (segmentStart >= to) break;
    const startT = Math.max(0, Math.min(1, (from - segmentStart) / length));
    const endT = Math.max(0, Math.min(1, (to - segmentStart) / length));
    if (out.length === 0) out.push([ax + dx * startT, ay + dy * startT]);
    if (endT > startT) out.push([ax + dx * endT, ay + dy * endT]);
  }
  return out;
}

export interface PointContact {
  /** Normalised (lexicographically ordered) territory ids. */
  a: string;
  b: string;
  point: Point;
}

export interface PolygonEntry {
  id: string;
  polygon: Polygon;
}

function pushUnique(list: string[], value: string): void {
  if (list.indexOf(value) < 0) list.push(value);
}

/**
 * Finds territory pairs whose polygons meet at isolated vertices only. Pairs
 * sharing any edge segment are excluded (they have a real shared border), as
 * are pairs listed in `excludedPairs` (the caller passes gameplay edges and
 * declared borders). A vertex touch is therefore never reported as adjacency.
 *
 * Known limitation: the shared-segment test uses whole-segment keys, so a
 * T-junction or partial collinear overlap that is not spelled as identical
 * whole edges could be misclassified as a vertex contact. The renderer only
 * consumes this together with validated metadata/edges, which excludes every
 * declared border, and the built-in maps have no such false positive. Partial
 * collinear geometry is deliberately not expanded here; revisit only when a
 * map with that shape actually needs point-contact treatment.
 */
export function polygonPointContacts(
  entries: ReadonlyArray<PolygonEntry>,
  excludedPairs?: Record<string, boolean>,
  epsilon?: number
): PointContact[] {
  const quantum = epsilon && epsilon > 0 ? epsilon : 0.01;
  const ownersAt: Record<string, string[]> = {};
  const ownersOnSegment: Record<string, string[]> = {};

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const polygon = entry.polygon;
    for (let p = 0; p < polygon.length; p += 1) {
      const key = Math.round(polygon[p][0] / quantum) + ',' + Math.round(polygon[p][1] / quantum);
      if (!ownersAt[key]) ownersAt[key] = [];
      pushUnique(ownersAt[key], entry.id);
    }
    for (let p = 0, j = polygon.length - 1; p < polygon.length; j = p, p += 1) {
      if (polygon[j][0] === polygon[p][0] && polygon[j][1] === polygon[p][1]) continue;
      const key = segmentKey(polygon[j], polygon[p], quantum);
      if (!ownersOnSegment[key]) ownersOnSegment[key] = [];
      pushUnique(ownersOnSegment[key], entry.id);
    }
  }

  const sharesSegment: Record<string, boolean> = {};
  const segmentKeys = Object.keys(ownersOnSegment);
  for (let i = 0; i < segmentKeys.length; i += 1) {
    const ids = ownersOnSegment[segmentKeys[i]];
    for (let a = 0; a < ids.length; a += 1) {
      for (let b = a + 1; b < ids.length; b += 1) {
        sharesSegment[pairKey(ids[a], ids[b])] = true;
      }
    }
  }

  const out: PointContact[] = [];
  const seen: Record<string, boolean> = {};
  const vertexKeys = Object.keys(ownersAt);
  for (let i = 0; i < vertexKeys.length; i += 1) {
    const ids = ownersAt[vertexKeys[i]];
    if (ids.length < 2) continue;
    const parts = vertexKeys[i].split(',');
    const point: Point = [Number(parts[0]) * quantum, Number(parts[1]) * quantum];
    for (let a = 0; a < ids.length; a += 1) {
      for (let b = a + 1; b < ids.length; b += 1) {
        const key = pairKey(ids[a], ids[b]);
        const contactKey = key + '@' + vertexKeys[i];
        if (seen[contactKey]) continue;
        if (sharesSegment[key]) continue;
        if (excludedPairs && excludedPairs[key]) continue;
        seen[contactKey] = true;
        out.push({
          a: ids[a] < ids[b] ? ids[a] : ids[b],
          b: ids[a] < ids[b] ? ids[b] : ids[a],
          point: point,
        });
      }
    }
  }
  return out;
}

export function closestPointOnPolygon(x: number, y: number, polygon: Polygon): ClosestPoint {
  let best: Point = [x, y];
  let bestDistance = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const ax = polygon[j][0];
    const ay = polygon[j][1];
    const bx = polygon[i][0];
    const by = polygon[i][1];
    const dx = bx - ax;
    const dy = by - ay;
    let t = 0;
    if (dx !== 0 || dy !== 0) {
      t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    }
    const px = ax + dx * t;
    const py = ay + dy * t;
    const distance = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [px, py];
    }
  }
  return { point: best, distance: bestDistance };
}

export function segmentKey(a: Point, b: Point, quantum: number): string {
  const q = quantum > 0 ? quantum : 0.01;
  const ax = Math.round(a[0] / q);
  const ay = Math.round(a[1] / q);
  const bx = Math.round(b[0] / q);
  const by = Math.round(b[1] / q);
  if (ax < bx || (ax === bx && ay <= by)) {
    return ax + ',' + ay + '|' + bx + ',' + by;
  }
  return bx + ',' + by + '|' + ax + ',' + ay;
}

export function pairKey(a: string, b: string): string {
  return a < b ? a + '|' + b : b + '|' + a;
}

/**
 * Chains a bag of undirected segments into polylines. Shared arcs arrive in
 * arbitrary order and may be split at every vertex, so drawing each segment
 * separately would produce visible caps on every joint.
 */
export function chainSegments(segments: Segment[], epsilon: number): Polygon[] {
  const quantum = epsilon > 0 ? epsilon : 0.01;
  const remaining: Segment[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (!samePoint(segments[i].a, segments[i].b, quantum * 0.5)) remaining.push(segments[i]);
  }

  const keyOf = function (point: Point): string {
    return Math.round(point[0] / quantum) + ',' + Math.round(point[1] / quantum);
  };
  const buckets: Record<string, number[]> = {};
  for (let i = 0; i < remaining.length; i += 1) {
    const keys = [keyOf(remaining[i].a), keyOf(remaining[i].b)];
    for (let k = 0; k < keys.length; k += 1) {
      if (!buckets[keys[k]]) buckets[keys[k]] = [];
      buckets[keys[k]].push(i);
    }
  }

  const used: Record<number, boolean> = {};
  const lines: Polygon[] = [];

  function otherEnd(segment: Segment, point: Point): Point {
    return samePoint(segment.a, point, quantum) ? segment.b : segment.a;
  }

  function grow(points: Polygon, forward: boolean): void {
    let cursor = forward ? points[points.length - 1] : points[0];
    while (true) {
      const ids = buckets[keyOf(cursor)] || [];
      let found = -1;
      for (let i = 0; i < ids.length; i += 1) {
        if (!used[ids[i]]) {
          found = ids[i];
          break;
        }
      }
      if (found < 0) return;
      const segment = remaining[found];
      if (!samePoint(segment.a, cursor, quantum) && !samePoint(segment.b, cursor, quantum)) {
        return;
      }
      used[found] = true;
      const next = otherEnd(segment, cursor);
      if (forward) points.push(next);
      else points.unshift(next);
      cursor = next;
    }
  }

  for (let i = 0; i < remaining.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    const points: Polygon = [remaining[i].a, remaining[i].b];
    grow(points, true);
    grow(points, false);
    if (points.length >= 2) lines.push(points);
  }
  return lines;
}

export function isAxisAlignedRectangle(polygon: Polygon): boolean {
  if (polygon.length !== 4) return false;
  for (let i = 0; i < 4; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % 4];
    if (Math.abs(a[0] - b[0]) > 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) return false;
  }
  return true;
}

export function isLegacyRectangleMap(polygons: Polygon[]): boolean {
  if (polygons.length === 0) return false;
  for (let i = 0; i < polygons.length; i += 1) {
    if (!isAxisAlignedRectangle(polygons[i])) return false;
  }
  return true;
}

/** True when any segment of the rectangle lies on the given axis-aligned edge. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
