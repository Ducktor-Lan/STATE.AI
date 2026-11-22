/**
 * Shared army route geometry. This module is intentionally DOM-free: the
 * renderer, the cannon simulation and the AI forecast all use exactly these
 * functions so a shell drawn on screen and a swept cannon segment can never
 * disagree about where an army is.
 *
 * All points are MAP coordinates. Callers that draw on screen transform each
 * point with their own viewport.
 */
import type {
  ArmyRouteBoundary,
  ArmyRouteEndpoint,
  MapPoint,
} from './types';

function isPoint(value: unknown): value is MapPoint {
  if (!Array.isArray(value) || value.length < 2) return false;
  return isFinite(value[0]) && isFinite(value[1]);
}

/** Route endpoint: the label anchor when present, otherwise the center. */
export function routeEndpointPoint(endpoint: ArmyRouteEndpoint): MapPoint {
  if (endpoint && isPoint(endpoint.labelAnchor)) {
    return [endpoint.labelAnchor[0], endpoint.labelAnchor[1]];
  }
  if (endpoint && isPoint(endpoint.center)) {
    return [endpoint.center[0], endpoint.center[1]];
  }
  return [0, 0];
}

function pairKey(a: string, b: string): string {
  return a < b ? a + '\u0000' + b : b + '\u0000' + a;
}

/**
 * Crossing/midpoint for one connected pair. A real passable bridge/pass anchor
 * wins (longest arc, matching the map decor rule); otherwise the longest shared
 * arc midpoint; otherwise null (straight line).
 */
export function routeCrossing(
  source: ArmyRouteEndpoint,
  target: ArmyRouteEndpoint,
  boundaries?: readonly ArmyRouteBoundary[] | null
): MapPoint | null {
  if (!boundaries || boundaries.length === 0) return null;
  const key = pairKey(source.id, target.id);

  let crossing: MapPoint | null = null;
  let crossingLength = -1;
  let midpoint: MapPoint | null = null;
  let midpointLength = -1;
  for (let i = 0; i < boundaries.length; i += 1) {
    const boundary = boundaries[i];
    if (pairKey(boundary.from, boundary.to) !== key) continue;
    const length =
      typeof boundary.length === 'number' && isFinite(boundary.length)
        ? boundary.length
        : 0;
    if (boundary.passable && isPoint(boundary.crossing) && length > crossingLength) {
      crossing = [boundary.crossing[0], boundary.crossing[1]];
      crossingLength = length;
    }
    if (isPoint(boundary.midpoint) && length > midpointLength) {
      midpoint = [boundary.midpoint[0], boundary.midpoint[1]];
      midpointLength = length;
    }
  }
  return crossing || midpoint;
}

/** True when a frozen route array is structurally usable for rendering. */
export function isValidRoutePoints(value: unknown): value is MapPoint[] {
  if (!Array.isArray(value) || value.length < 2) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!isPoint(value[i])) return false;
  }
  return true;
}

function cloneRoutePoints(value: readonly MapPoint[]): MapPoint[] {
  const out: MapPoint[] = [];
  for (let i = 0; i < value.length; i += 1) out.push([value[i][0], value[i][1]]);
  return out;
}

/**
 * Source -> crossing -> target in map coordinates. When a frozen route is
 * supplied (an already dispatched army), it wins over every live map input so
 * ownership changes, upgrades or later boundary edits cannot move the army.
 * The same endpoints are used regardless of ownership.
 */
export function armyRoutePoints(
  source: ArmyRouteEndpoint,
  target: ArmyRouteEndpoint,
  boundaries?: readonly ArmyRouteBoundary[] | null,
  frozenRoute?: readonly MapPoint[] | null
): MapPoint[] {
  if (isValidRoutePoints(frozenRoute)) return cloneRoutePoints(frozenRoute);
  const from = routeEndpointPoint(source);
  const to = routeEndpointPoint(target);
  const crossing = routeCrossing(source, target, boundaries);
  if (!crossing) return [from, to];
  return [from, crossing, to];
}

export function polylineLength(points: MapPoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return length;
}

/**
 * Length-interpolated point at `progress` (0..1) across the route. progress is
 * clamped, so fractional ticks beyond the flight simply pin the endpoints.
 */
export function pointAlongRoute(points: MapPoint[], progress: number): MapPoint {
  if (points.length === 0) return [0, 0];
  if (points.length === 1) return [points[0][0], points[0][1]];
  const clamped = isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  let total = 0;
  const segmentLengths: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const length = Math.sqrt(dx * dx + dy * dy);
    segmentLengths.push(length);
    total += length;
  }
  if (total <= 0) return [points[0][0], points[0][1]];

  let remaining = total * clamped;
  for (let i = 0; i < segmentLengths.length; i += 1) {
    const length = segmentLengths[i];
    if (remaining <= length || i === segmentLengths.length - 1) {
      const t = length > 0 ? Math.min(1, remaining / length) : 0;
      const a = points[i];
      const b = points[i + 1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= length;
  }
  const last = points[points.length - 1];
  return [last[0], last[1]];
}

/**
 * Army position at an arbitrary (possibly fractional) tick. Uses the frozen
 * startTick/arrivalTick, never the current march level or owner.
 */
export function armyPositionAt(
  army: { startTick: number; arrivalTick: number; routePoints?: readonly MapPoint[] },
  source: ArmyRouteEndpoint,
  target: ArmyRouteEndpoint,
  boundaries: readonly ArmyRouteBoundary[] | null | undefined,
  tick: number
): MapPoint {
  const duration = Math.max(1, army.arrivalTick - army.startTick);
  const progress = (tick - army.startTick) / duration;
  return pointAlongRoute(
    armyRoutePoints(source, target, boundaries, army.routePoints),
    progress
  );
}

export function distanceSquared(a: MapPoint, b: MapPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return dx * dx + dy * dy;
}

function routeCumulative(points: MapPoint[]): { total: number; cuts: number[] } {
  const cuts: number[] = [0];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
    cuts.push(total);
  }
  return { total: total, cuts: cuts };
}

/**
 * Route segments actually swept between two (possibly fractional) ticks.
 * Splitting at route vertices matters when an army crosses a shared-border
 * bend: the straight chord between two tick positions can miss (or falsely
 * enter) a cannon circle that the real source -> crossing -> target path does
 * not. Segment count is at most route vertices - 1.
 */
export function armyRouteSegmentsBetweenTicks(
  army: { startTick: number; arrivalTick: number; routePoints?: readonly MapPoint[] },
  source: ArmyRouteEndpoint,
  target: ArmyRouteEndpoint,
  boundaries: readonly ArmyRouteBoundary[] | null | undefined,
  fromTick: number,
  toTick: number
): Array<[MapPoint, MapPoint]> {
  const route = armyRoutePoints(source, target, boundaries, army.routePoints);
  const duration = Math.max(1, army.arrivalTick - army.startTick);
  const start = Math.max(0, Math.min(1, (fromTick - army.startTick) / duration));
  const end = Math.max(0, Math.min(1, (toTick - army.startTick) / duration));
  if (end <= start) {
    const point = pointAlongRoute(route, start);
    return [[point, point]];
  }
  const { total, cuts } = routeCumulative(route);
  if (total <= 0) {
    const point = pointAlongRoute(route, start);
    return [[point, point]];
  }

  const first = pointAlongRoute(route, start);
  const last = pointAlongRoute(route, end);
  const out: Array<[MapPoint, MapPoint]> = [];
  let previous = first;
  for (let i = 1; i < route.length - 1; i += 1) {
    const fraction = cuts[i] / total;
    if (fraction > start && fraction < end) {
      const vertex: MapPoint = [route[i][0], route[i][1]];
      out.push([previous, vertex]);
      previous = vertex;
    }
  }
  out.push([previous, last]);
  return out;
}

/** Closest point on segment [a,b] to p (map coordinates). */
export function closestPointOnSegment(a: MapPoint, b: MapPoint, p: MapPoint): MapPoint {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0) return [a[0], a[1]];
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + dx * t, a[1] + dy * t];
}

/** True when the swept segment enters the circle (segment, not just endpoints). */
export function segmentWithinRange(
  from: MapPoint,
  to: MapPoint,
  center: MapPoint,
  range: number
): boolean {
  if (!(range > 0)) return false;
  const closest = closestPointOnSegment(from, to, center);
  return distanceSquared(closest, center) <= range * range;
}

/** First/nearest point where the swept segment meets the circle. */
export function segmentImpactPoint(
  from: MapPoint,
  to: MapPoint,
  center: MapPoint,
  range: number
): MapPoint {
  return closestPointOnSegment(from, to, center);
}
