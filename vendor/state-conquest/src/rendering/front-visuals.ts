/**
 * v1.2.0 sustained front ("兵线") presentation.
 *
 * A front lane is a *persistent* supply route from an owned source territory
 * to a target territory. Unlike the one-shot army dot, it never disappears on
 * its own: the core keeps sending while the lane stays active. This module is
 * the whole presentation contract for that lane, so the integration layer only
 * has to hand over the raw snapshot field:
 *
 *   MatchSnapshot.fronts?: Array<{
 *     id, owner, sourceId, targetId, ratio, startTick, nextSendTick,
 *     totalSent, waves, engagement?: { failedWaves, ... }
 *   }>
 *
 * Design constraints (v1.2.0):
 *  - DOM-free and pure: normalize / geometry / copy are unit-testable without
 *    a canvas; only `drawFrontLanes` touches a 2D context.
 *  - Tolerant input: every optional field may be missing or malformed. A
 *    missing number renders as "unknown" (no number at all) instead of 0, so
 *    the overlay can never invent a ratio or a troop count.
 *  - Bounded: at most `MAX_FRONT_LANES` lanes are accepted, so a buggy or
 *    duplicated snapshot can never turn into an unbounded per-frame cost.
 *  - Honest state: `nextSendTick` is the EARLIEST tick a wave may leave (the
 *    core can be saving troops or at the in-flight cap), so it never produces
 *    a "sending" label or continuous motion. Direction is a static chevron +
 *    arrowhead; a wave is animated only when `totalSent` really grew between
 *    snapshots (`sendPulses`).
 *  - Distinct from the drag preview: the preview is a dashed cream/gold hint
 *    plus a charge ring and a chip near the finger. A front lane is a solid
 *    double stroke in the owner colour with a round source cap and a target
 *    arrowhead. Only an explicitly inactive lane turns grey with a stop bar.
 *  - Allocation-light per frame: lane geometry (screen polyline, cumulative
 *    lengths, direction) is built once per signature; the draw pass reuses one
 *    module-scope sample scratch and never builds arrays, strings or paths per
 *    lane per frame (the only strings are the cached pill labels).
 */
import { armyRoutePoints } from '../core/army-route';
import { mapToScreen } from './viewport';
import type { Viewport } from './viewport';
import type { Point } from './geometry';
import { ownerAccent, ownerStyle } from './owner-palette';
import type { OwnerAccent, OwnerPalette, OwnerStyle } from './owner-palette';

export const MAX_FRONT_LANES = 32;
/** At most this many lanes print a ratio/sent pill, longest lanes first. */
export const MAX_FRONT_LANE_PILLS = 4;
/**
 * Direction-chevron budget. Lanes beyond this index still draw their solid
 * stroke, cap and arrowhead, so the lane stays readable while a pathological
 * snapshot (32 lanes) cannot multiply per-frame stroke work.
 */
export const FRONT_LANE_ANIMATED_LIMIT = 12;
/**
 * Consecutive landed waves that dealt no real damage before the lane reads as
 * 受阻 (`FrontEngagement.failedWaves`, real core bookkeeping).
 */
export const FRONT_LANE_BLOCKED_FAILED_WAVES = 2;

/**
 * Display-only lane owner. `ai3` is accepted so the official 4-faction owner
 * set renders lanes too; today's AI planner never starts a line, and the
 * real-human lane permissions in `v120-fronts` are unchanged by this.
 */
export type FrontLaneOwner = 'player' | 'ai1' | 'ai2' | 'ai3';

/** Normalized, display-only lane. Numbers are null when the core omitted them. */
export interface FrontLaneView {
  id: string;
  owner: FrontLaneOwner;
  sourceId: string;
  targetId: string;
  /** 0..1 dispatch share, or null when the snapshot did not supply one. */
  ratio: number | null;
  startTick: number | null;
  nextSendTick: number | null;
  /** Cumulative troops really sent on this lane, or null when unknown. */
  totalSent: number | null;
  /** Waves dispatched so far (real core counter), or null when unknown. */
  waves: number | null;
  /** Consecutive landed waves that dealt no real damage, or null. */
  failedWaves: number | null;
  /** False only when the snapshot explicitly marks the lane inactive. */
  active: boolean;
}

/**
 * Lane presentation state. Only real snapshot facts are used:
 *  - `active`: the line exists in the core snapshot (stopped lines are removed
 *    from the array, so this is the normal state).
 *  - `blocked`: `FrontEngagement.failedWaves >= 2`, i.e. several landed waves
 *    in a row dealt no real damage. The line may still dispatch, so this never
 *    suppresses drawing or a real send pulse.
 *  - `stalled`: only when an integration explicitly marks the lane inactive
 *    (`active:false`); the real core removes stopped lines instead.
 *
 * Deliberately no `sending` state: `nextSendTick` is the EARLIEST tick a wave
 * may leave (the core can still be saving troops or at the in-flight cap), so
 * it is not proof that a dispatch happened. A wave is only shown as it really
 * leaves: the renderer detects a real `totalSent` increase and plays a pulse.
 */
export type FrontLanePhase = 'active' | 'blocked' | 'stalled';

/** Minimal territory endpoint; the map cache already holds these fields. */
export interface FrontLaneEndpoint {
  id: string;
  center: [number, number];
  labelAnchor?: [number, number];
}

export interface FrontLaneBoundaryHint {
  from: string;
  to: string;
  passable?: boolean;
  crossing?: [number, number];
  midpoint?: [number, number];
  length?: number;
}

/** Screen-space lane, ready to draw. Built once per geometry signature. */
export interface FrontLaneScreen {
  id: string;
  owner: FrontLaneOwner;
  sourceId: string;
  targetId: string;
  /** Trimmed screen polyline (label chips are kept clear at both ends). */
  points: Point[];
  /** Cumulative screen distance per point; `total` is the whole polyline. */
  cumulative: number[];
  total: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** Unit direction at the target end. */
  dirX: number;
  dirY: number;
  /** Midpoint of the trimmed lane, used for the ratio pill. */
  midX: number;
  midY: number;
  phase: FrontLanePhase;
  ratio: number | null;
  totalSent: number | null;
  waves: number | null;
  failedWaves: number | null;
  /** Cached pill copy (never rebuilt during a frame). */
  pill: string;
  /** 0 = the longest lane; only `< MAX_FRONT_LANE_PILLS` draw a pill. */
  pillRank: number;
  /** Screen length, exported for tests/diagnostics. */
  length: number;
}

export interface FrontLanePillBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How long a detected real dispatch stays visible, in rAF milliseconds. */
export const FRONT_LANE_SEND_PULSE_MS = 650;

/**
 * One real dispatch cue: `startedAt` is on the renderer clock (performance
 * timestamps). The renderer creates it only when `totalSent` actually grew
 * between two snapshots, never from `nextSendTick`.
 */
export interface FrontLaneSendPulse {
  id: string;
  startedAt: number;
}

export interface FrontLaneDrawScene {
  ctx: CanvasRenderingContext2D;
  lanes: readonly FrontLaneScreen[];
  /** Palette owned by the renderer/match; omitted callers use legacy blue. */
  palette?: OwnerPalette;
  /** rAF timestamp used only for the send pulse. */
  now: number;
  reducedMotion: boolean;
  viewWidth: number;
  viewHeight: number;
  /** Optional label boxes (source/target chips) a pill must not cover. */
  labelBoxes?: readonly FrontLanePillBox[];
  /**
   * Real dispatches detected by the caller (a `totalSent` increase). Bounded
   * by MAX_FRONT_LANES; a lane without an entry simply shows no pulse.
   */
  sendPulses?: readonly FrontLaneSendPulse[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

function isOwner(value: unknown): value is FrontLaneOwner {
  return value === 'player' || value === 'ai1' || value === 'ai2' || value === 'ai3';
}

function optionalCount(value: unknown): number | null {
  if (!isFiniteNumber(value) || value < 0) return null;
  return Math.floor(value);
}

function optionalTick(value: unknown): number | null {
  if (!isFiniteNumber(value) || value < 0) return null;
  return Math.floor(value);
}

function optionalRatio(value: unknown): number | null {
  if (!isFiniteNumber(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Bounded, defensive normalization of the raw snapshot array. Unknown owners,
 * self-loops and entries without both endpoints are dropped; duplicates (same
 * id, or same owner+source+target when no id is supplied) keep the first.
 */
export function normalizeFrontLanes(value: unknown): FrontLaneView[] {
  if (!Array.isArray(value)) return [];
  const out: FrontLaneView[] = [];
  const seen: Record<string, true> = {};
  for (let i = 0; i < value.length && out.length < MAX_FRONT_LANES; i += 1) {
    const raw = value[i];
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const owner = record.owner;
    const sourceId = record.sourceId;
    const targetId = record.targetId;
    if (!isOwner(owner)) continue;
    if (typeof sourceId !== 'string' || sourceId.length === 0) continue;
    if (typeof targetId !== 'string' || targetId.length === 0) continue;
    if (sourceId === targetId) continue;
    const rawId =
      typeof record.id === 'string' || isFiniteNumber(record.id)
        ? String(record.id)
        : owner + '|' + sourceId + '>' + targetId;
    const key = rawId;
    if (seen[key] === true) continue;
    seen[key] = true;
    // `engagement` is the real core bookkeeping; only its failed-wave counter
    // is shown, and only when it is a real number.
    const engagement =
      record.engagement && typeof record.engagement === 'object'
        ? (record.engagement as Record<string, unknown>)
        : null;
    out.push({
      id: rawId,
      owner: owner,
      sourceId: sourceId,
      targetId: targetId,
      ratio: optionalRatio(record.ratio),
      startTick: optionalTick(record.startTick),
      nextSendTick: optionalTick(record.nextSendTick),
      totalSent: optionalCount(record.totalSent),
      waves: optionalCount(record.waves),
      failedWaves: engagement ? optionalCount(engagement.failedWaves) : null,
      // `active` is the documented flag; `paused` is accepted as the same
      // statement so an integration typo cannot silently animate a stopped
      // lane. Anything else means the lane is live.
      active: record.active !== false && record.paused !== true,
    });
  }
  return out;
}

/**
 * Lane presentation state. `tick`/`nextSendTick` are accepted for API
 * compatibility but never decide a "sending" state: `nextSendTick` is the
 * earliest tick a wave MAY leave, not proof that one did, so dispatch is shown
 * only from a real `totalSent` increase (see `FrontLaneDrawScene.sendPulses`).
 */
export interface FrontLanePhaseInput {
  active: boolean;
  failedWaves?: number | null;
  /** Accepted for compatibility; deliberately ignored (see the note above). */
  nextSendTick?: number | null;
}

export function frontLanePhaseAt(
  lane: FrontLanePhaseInput,
  tick?: number | null
): FrontLanePhase {
  void tick;
  if (!lane.active) return 'stalled';
  if (
    lane.failedWaves !== null &&
    lane.failedWaves !== undefined &&
    lane.failedWaves >= FRONT_LANE_BLOCKED_FAILED_WAVES
  ) {
    return 'blocked';
  }
  return 'active';
}

/**
 * Player-facing pill copy. Only real values appear; when no number is known
 * the label stays generic instead of printing a fake 0. There is deliberately
 * no "sending"/"waiting" wording, because the snapshot does not prove either.
 */
export function frontLanePillText(
  lane: Pick<FrontLaneView, 'ratio' | 'totalSent' | 'active' | 'failedWaves'>,
  tick?: number | null
): string {
  const phase = frontLanePhaseAt(lane, tick);
  if (phase === 'stalled') return '兵线 · 停滞';
  const parts: string[] = [];
  if (lane.ratio !== null) parts.push(Math.round(lane.ratio * 100) + '%');
  if (lane.totalSent !== null) parts.push('已派 ' + lane.totalSent);
  if (phase === 'blocked') parts.push('受阻');
  if (parts.length === 0) return '兵线';
  return '兵线 ' + parts.join(' · ');
}

function polylineCumulative(points: readonly Point[]): { cumulative: number[]; total: number } {
  const cumulative: number[] = [0];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
    cumulative.push(total);
  }
  return { cumulative: cumulative, total: total };
}

/** Writes the point at fraction `t` (0..1) of the polyline into `out`. */
function samplePolyline(
  points: readonly Point[],
  cumulative: readonly number[],
  total: number,
  t: number,
  out: { x: number; y: number }
): void {
  if (points.length === 0) {
    out.x = 0;
    out.y = 0;
    return;
  }
  if (points.length === 1 || total <= 0) {
    out.x = points[0][0];
    out.y = points[0][1];
    return;
  }
  const clamped = isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  const target = total * clamped;
  for (let i = 1; i < points.length; i += 1) {
    const segment = cumulative[i] - cumulative[i - 1];
    if (target <= cumulative[i] || i === points.length - 1) {
      const local = segment > 0 ? Math.min(1, Math.max(0, (target - cumulative[i - 1]) / segment)) : 0;
      out.x = points[i - 1][0] + (points[i][0] - points[i - 1][0]) * local;
      out.y = points[i - 1][1] + (points[i][1] - points[i - 1][1]) * local;
      return;
    }
  }
  const last = points[points.length - 1];
  out.x = last[0];
  out.y = last[1];
}

/**
 * Cuts `lead`/`trail` screen pixels off a polyline so lane ends stay clear of
 * the source/target chips. Returns null when the lane is too short to show a
 * meaningful double stroke; callers then skip the lane entirely.
 */
function trimPolyline(
  points: readonly Point[],
  lead: number,
  trail: number
): { points: Point[]; cumulative: number[]; total: number } | null {
  const { cumulative, total } = polylineCumulative(points);
  if (total <= lead + trail + 10) return null;
  const startT = lead / total;
  const endT = 1 - trail / total;
  const startOut = { x: 0, y: 0 };
  const endOut = { x: 0, y: 0 };
  samplePolyline(points, cumulative, total, startT, startOut);
  samplePolyline(points, cumulative, total, endT, endOut);
  const trimmed: Point[] = [[startOut.x, startOut.y]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const fraction = cumulative[i] / total;
    if (fraction > startT + 1e-4 && fraction < endT - 1e-4) {
      trimmed.push([points[i][0], points[i][1]]);
    }
  }
  trimmed.push([endOut.x, endOut.y]);
  const recomputed = polylineCumulative(trimmed);
  if (recomputed.total <= 1) return null;
  return {
    points: trimmed,
    cumulative: recomputed.cumulative,
    total: recomputed.total,
  };
}

function endpointMap(
  endpoints: readonly FrontLaneEndpoint[]
): Record<string, FrontLaneEndpoint> {
  const out: Record<string, FrontLaneEndpoint> = {};
  for (let i = 0; i < endpoints.length; i += 1) out[endpoints[i].id] = endpoints[i];
  return out;
}

/**
 * Projects every drawable lane into screen space. Endpoints come from the
 * renderer's map cache (or any structural list) and the route uses the same
 * `armyRoutePoints` helper as armies and cannons, so a lane and its armies
 * can never disagree about the border crossing.
 */
export function frontLanesToScreen(
  viewport: Viewport,
  lanes: readonly FrontLaneView[],
  endpoints: readonly FrontLaneEndpoint[],
  boundaries?: readonly FrontLaneBoundaryHint[] | null,
  tick: number | null = null
): FrontLaneScreen[] {
  if (lanes.length === 0) return [];
  const byId = endpointMap(endpoints);
  const out: FrontLaneScreen[] = [];
  for (let i = 0; i < lanes.length; i += 1) {
    const lane = lanes[i];
    const source = byId[lane.sourceId];
    const target = byId[lane.targetId];
    if (!source || !target) continue;
    const mapRoute = armyRoutePoints(source, target, boundaries, null);
    const screen: Point[] = [];
    for (let p = 0; p < mapRoute.length; p += 1) {
      const projected = mapToScreen(viewport, mapRoute[p][0], mapRoute[p][1]);
      screen.push([projected[0], projected[1]]);
    }
    const trimmed = trimPolyline(screen, 14, 18);
    if (!trimmed) continue;
    const points = trimmed.points;
    const last = points[points.length - 1];
    const previous = points[points.length - 2];
    let dirX = last[0] - previous[0];
    let dirY = last[1] - previous[1];
    const dirLength = Math.sqrt(dirX * dirX + dirY * dirY);
    if (dirLength <= 1e-6) {
      dirX = target.center[0] - source.center[0];
      dirY = target.center[1] - source.center[1];
      const fallback = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
      dirX /= fallback;
      dirY /= fallback;
    } else {
      dirX /= dirLength;
      dirY /= dirLength;
    }
    const mid = { x: 0, y: 0 };
    samplePolyline(points, trimmed.cumulative, trimmed.total, 0.5, mid);
    out.push({
      id: lane.id,
      owner: lane.owner,
      sourceId: lane.sourceId,
      targetId: lane.targetId,
      points: points,
      cumulative: trimmed.cumulative,
      total: trimmed.total,
      startX: points[0][0],
      startY: points[0][1],
      endX: last[0],
      endY: last[1],
      dirX: dirX,
      dirY: dirY,
      midX: mid.x,
      midY: mid.y,
      phase: frontLanePhaseAt(lane, tick),
      ratio: lane.ratio,
      totalSent: lane.totalSent,
      waves: lane.waves,
      failedWaves: lane.failedWaves,
      pill: frontLanePillText(lane, tick),
      pillRank: 0,
      length: trimmed.total,
    });
  }

  // Rank by screen length without re-sorting every frame: only the long lanes
  // carry a pill, and the ranking is part of the cached geometry.
  const order: number[] = [];
  for (let i = 0; i < out.length; i += 1) order.push(i);
  order.sort(function (a, b) {
    return out[b].length - out[a].length;
  });
  for (let rank = 0; rank < order.length; rank += 1) out[order[rank]].pillRank = rank;
  return out;
}

/**
 * Cache key: only geometry-affecting fields plus the viewport identity and the
 * per-lane phase. Simulation ticks are deliberately absent, because a lane that
 * is merely waiting never rebuilds its screen geometry; a real dispatch changes
 * `totalSent` (and therefore the key).
 */
export function frontLaneSignature(
  lanes: readonly FrontLaneView[],
  viewportKey: string
): string {
  let key = viewportKey + '|' + lanes.length;
  for (let i = 0; i < lanes.length; i += 1) {
    const lane = lanes[i];
    const phase = frontLanePhaseAt(lane);
    key +=
      '|' +
      lane.id +
      ',' +
      lane.owner +
      ',' +
      lane.sourceId +
      '>' +
      lane.targetId +
      ',' +
      (phase === 'stalled' ? 's' : phase === 'blocked' ? 'b' : 'a') +
      ',' +
      (lane.ratio === null ? 'x' : String(Math.round(lane.ratio * 1000))) +
      ',' +
      (lane.totalSent === null ? 'x' : String(lane.totalSent));
  }
  return key;
}

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

const CREAM = '#FBF5E9';
const NAVY = '#172B44';
const STALL = '#8E8577';
/** Amber used by a lane whose waves keep landing without real damage. */
const BLOCKED = '#A8762A';
const TAU = Math.PI * 2;

/** One reused sample slot: the draw pass never allocates a point per lane. */
const SAMPLE = { x: 0, y: 0 };
const SAMPLE_B = { x: 0, y: 0 };

function font(weight: string, size: number): string {
  return weight + ' ' + Math.round(size * 10) / 10 + 'px ' + FONT_STACK;
}

function clampValue(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
  stroke?: string,
  strokeWidth?: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth || 1;
    ctx.stroke();
  }
}

/** Screen-space pill placement (exported so layout is testable without canvas). */
export function placeFrontLanePill(
  lane: Pick<FrontLaneScreen, 'midX' | 'midY' | 'dirX' | 'dirY'>,
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
  obstacles?: readonly FrontLanePillBox[]
): FrontLanePillBox {
  const safeWidth = Math.max(1, viewWidth);
  const safeHeight = Math.max(1, viewHeight);
  const pillWidth = Math.min(Math.max(1, width), Math.max(24, safeWidth - 8));
  // Offset perpendicular to the lane so the pill never sits on the stroke.
  const normalX = -lane.dirY;
  const normalY = lane.dirX;
  let x = lane.midX + normalX * 12 - pillWidth / 2;
  let y = lane.midY + normalY * 12 - height / 2;
  x = clampValue(x, 4, Math.max(4, safeWidth - pillWidth - 4));
  y = clampValue(y, 4, Math.max(4, safeHeight - height - 4));
  if (obstacles && obstacles.length > 0) {
    let box: FrontLanePillBox = { x: x, y: y, width: pillWidth, height: height };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let blocked = false;
      for (let i = 0; i < obstacles.length; i += 1) {
        const other = obstacles[i];
        if (
          box.x < other.x + other.width + 3 &&
          box.x + box.width + 3 > other.x &&
          box.y < other.y + other.height + 3 &&
          box.y + box.height + 3 > other.y
        ) {
          blocked = true;
          break;
        }
      }
      if (!blocked) break;
      // Flip to the other side of the lane once; then give up (pill hidden).
      const flippedY = lane.midY - normalY * 12 - height / 2;
      y = clampValue(flippedY, 4, Math.max(4, safeHeight - height - 4));
      box = { x: x, y: y, width: pillWidth, height: height };
    }
  }
  return { x: x, y: y, width: pillWidth, height: height };
}

function polylinePath(ctx: CanvasRenderingContext2D, lane: FrontLaneScreen): void {
  ctx.beginPath();
  ctx.moveTo(lane.points[0][0], lane.points[0][1]);
  for (let i = 1; i < lane.points.length; i += 1) {
    ctx.lineTo(lane.points[i][0], lane.points[i][1]);
  }
}

function drawChevron(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dx: number,
  dy: number,
  size: number,
  color: string,
  alpha: number,
  lineWidth: number
): void {
  const nx = -dy;
  const ny = dx;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(x - dx * size * 0.7 + nx * size, y - dy * size * 0.7 + ny * size);
  ctx.lineTo(x + dx * size * 0.75, y + dy * size * 0.75);
  ctx.lineTo(x - dx * size * 0.7 - nx * size, y - dy * size * 0.7 - ny * size);
  ctx.stroke();
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  lane: FrontLaneScreen,
  accent: OwnerAccent
): void {
  const nx = -lane.dirY;
  const ny = lane.dirX;
  const tipX = lane.endX + lane.dirX * 3.4;
  const tipY = lane.endY + lane.dirY * 3.4;
  const baseX = lane.endX - lane.dirX * 5.2;
  const baseY = lane.endY - lane.dirY * 5.2;
  ctx.globalAlpha = 0.96;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX + nx * 4.1, baseY + ny * 4.1);
  ctx.lineTo(baseX - nx * 4.1, baseY - ny * 4.1);
  ctx.closePath();
  ctx.fillStyle = accent.ink;
  ctx.fill();
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function drawStalledBar(
  ctx: CanvasRenderingContext2D,
  lane: FrontLaneScreen,
  accent: OwnerAccent
): void {
  const normalX = -lane.dirY;
  const normalY = lane.dirX;
  const half = 4.2;
  ctx.globalAlpha = 0.92;
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 4.4;
  ctx.beginPath();
  ctx.moveTo(lane.midX + normalX * half, lane.midY + normalY * half);
  ctx.lineTo(lane.midX - normalX * half, lane.midY - normalY * half);
  ctx.stroke();
  ctx.strokeStyle = accent.deep;
  ctx.lineWidth = 2.1;
  ctx.stroke();
}

function drawOneLane(
  scene: FrontLaneDrawScene,
  lane: FrontLaneScreen,
  index: number
): void {
  const ctx = scene.ctx;
  const accent: OwnerAccent = ownerAccent(lane.owner, scene.palette);
  const style: OwnerStyle = ownerStyle(lane.owner, scene.palette);
  const stalled = lane.phase === 'stalled';
  // A blocked lane may still be dispatching (failed waves only mean no damage
  // landed), so it keeps the normal stroke and direction marks; the amber tint
  // and the pill's "受阻" are the whole distinction. It never suppresses the
  // real send pulse below.
  const blocked = lane.phase === 'blocked';
  const alpha = stalled ? 0.5 : 0.92;
  const ink = stalled ? STALL : blocked ? BLOCKED : accent.ink;
  // Chevrons are a static direction cue: the line exists, but the snapshot does
  // not prove a wave is leaving right now. Only a real totalSent increase plays
  // the travelling pulse.
  const withChevrons = !stalled && index < FRONT_LANE_ANIMATED_LIMIT;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Cream bed keeps the lane legible over every owner fill and water.
  polylinePath(ctx, lane);
  ctx.globalAlpha = stalled ? 0.34 : 0.5;
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = stalled ? 4.2 : 5.4;
  ctx.stroke();

  polylinePath(ctx, lane);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = ink;
  ctx.lineWidth = stalled ? 1.8 : 2.4;
  ctx.stroke();

  if (stalled) {
    drawStalledBar(ctx, lane, accent);
    ctx.restore();
    return;
  }

  for (let i = 0; withChevrons && i < 3; i += 1) {
    const t = 0.22 + i * 0.25;
    samplePolyline(lane.points, lane.cumulative, lane.total, t, SAMPLE);
    samplePolyline(lane.points, lane.cumulative, lane.total, Math.min(1, t + 0.03), SAMPLE_B);
    let dx = SAMPLE_B.x - SAMPLE.x;
    let dy = SAMPLE_B.y - SAMPLE.y;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= length;
    dy /= length;
    drawChevron(ctx, SAMPLE.x, SAMPLE.y, dx, dy, 4.4, CREAM, 0.6, 3.2);
    drawChevron(ctx, SAMPLE.x, SAMPLE.y, dx, dy, 4.4, style.badge, 0.7, 1.7);
  }

  drawSendPulse(scene, lane, style, accent);

  // Source cap: a round anchor in the owner colour.
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.arc(lane.startX, lane.startY, 3.4, 0, TAU);
  ctx.fillStyle = style.badge;
  ctx.fill();
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 1.3;
  ctx.stroke();

  drawArrowHead(ctx, lane, accent);
  ctx.restore();
}

/**
 * A wave really left (`totalSent` grew). A short bright marker travels toward
 * the target; with reduced motion the same marker is simply parked mid-lane for
 * the pulse window. No pulse, no motion.
 */
function drawSendPulse(
  scene: FrontLaneDrawScene,
  lane: FrontLaneScreen,
  style: OwnerStyle,
  accent: OwnerAccent
): void {
  const pulses = scene.sendPulses;
  if (!pulses || pulses.length === 0) return;
  let startedAt: number | null = null;
  for (let i = 0; i < pulses.length; i += 1) {
    if (pulses[i].id === lane.id) {
      startedAt = pulses[i].startedAt;
      break;
    }
  }
  if (startedAt === null) return;
  const age = scene.now - startedAt;
  if (!(age >= 0) || age >= FRONT_LANE_SEND_PULSE_MS) return;
  const progress = age / FRONT_LANE_SEND_PULSE_MS;
  const t = scene.reducedMotion ? 0.5 : 0.18 + progress * 0.72;
  samplePolyline(lane.points, lane.cumulative, lane.total, t, SAMPLE);
  samplePolyline(lane.points, lane.cumulative, lane.total, Math.min(1, t + 0.03), SAMPLE_B);
  let dx = SAMPLE_B.x - SAMPLE.x;
  let dy = SAMPLE_B.y - SAMPLE.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  dx /= length;
  dy /= length;
  const fade = scene.reducedMotion ? 0.9 : Math.sin(Math.min(1, progress) * Math.PI) * 0.9 + 0.1;
  const ctx = scene.ctx;
  ctx.globalAlpha = Math.max(0, Math.min(1, fade));
  ctx.beginPath();
  ctx.arc(SAMPLE.x, SAMPLE.y, 2.6, 0, TAU);
  ctx.fillStyle = accent.soft;
  ctx.fill();
  ctx.strokeStyle = style.badge;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  drawChevron(ctx, SAMPLE.x, SAMPLE.y, dx, dy, 5.2, CREAM, 0.9, 3.6);
  drawChevron(ctx, SAMPLE.x, SAMPLE.y, dx, dy, 5.2, style.badge, 0.95, 1.9);
}

function drawPill(
  scene: FrontLaneDrawScene,
  lane: FrontLaneScreen
): void {
  if (lane.pillRank >= MAX_FRONT_LANE_PILLS) return;
  if (lane.length < 88) return;
  const ctx = scene.ctx;
  const accent = ownerAccent(lane.owner, scene.palette);
  ctx.save();
  ctx.font = font('700', 9);
  const textWidth = ctx.measureText(lane.pill).width;
  const width = textWidth + 16;
  const height = 16;
  // Source/target labels of this lane are the only obstacles that matter.
  const box = placeFrontLanePill(
    lane,
    width,
    height,
    scene.viewWidth,
    scene.viewHeight,
    scene.labelBoxes
  );
  roundedRect(
    ctx,
    box.x,
    box.y,
    box.width,
    box.height,
    8,
    'rgba(251, 245, 233, 0.95)',
    'rgba(23, 43, 68, 0.18)',
    1
  );
  roundedRect(ctx, box.x, box.y, 3, box.height, 1.5, accent.ink);
  ctx.fillStyle = lane.phase === 'stalled' ? '#6F6758' : NAVY;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(lane.pill, box.x + 8, box.y + box.height / 2 + 0.5);
  ctx.restore();
}

/**
 * Draws every lane, then the bounded pills. Callers own the cached geometry
 * (`frontLanesToScreen`) and the reduced-motion preference.
 */
export function drawFrontLanes(scene: FrontLaneDrawScene): void {
  const lanes = scene.lanes;
  if (lanes.length === 0) return;
  for (let i = 0; i < lanes.length; i += 1) drawOneLane(scene, lanes[i], i);
  for (let i = 0; i < lanes.length; i += 1) drawPill(scene, lanes[i]);
}

/** Diagnostic summary used by tests and the renderer's dev accessors. */
export interface FrontLaneSummary {
  id: string;
  owner: FrontLaneOwner;
  sourceId: string;
  targetId: string;
  phase: FrontLanePhase;
  ratio: number | null;
  totalSent: number | null;
  waves: number | null;
  failedWaves: number | null;
  pill: string;
  length: number;
}

export function frontLaneSummary(lanes: readonly FrontLaneScreen[]): FrontLaneSummary[] {
  const out: FrontLaneSummary[] = [];
  for (let i = 0; i < lanes.length; i += 1) {
    const lane = lanes[i];
    out.push({
      id: lane.id,
      owner: lane.owner,
      sourceId: lane.sourceId,
      targetId: lane.targetId,
      phase: lane.phase,
      ratio: lane.ratio,
      totalSent: lane.totalSent,
      waves: lane.waves,
      failedWaves: lane.failedWaves,
      pill: lane.pill,
      length: Math.round(lane.length * 10) / 10,
    });
  }
  return out;
}
