import { armyPositionAt } from '../game-api';
import type { GestureState } from '../input/gesture-controller';
import { reasonText, forecastText, formatPercent } from '../ui/format';
import { playerHasActiveAlly } from '../ui/diplomacy-view';
import { routeFailureText, routePassageText } from '../ui/route-feedback';
import type { MatchView, OwnerId, TerritoryView } from '../ui/view-model';
import {
  barrierBlockedBoundaries,
  buildMapTopology,
  boundaryHasCrossing,
  borderStroke,
  mapTopologyToScreen,
  projectPointContacts,
  resolvePointContacts,
} from './map-decor';
import type { MapTopology, PointContactCache, ScreenBoundary, ScreenTopology } from './map-decor';
import {
  clamp,
  distanceToSegment,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  splitPolylineAtPoint,
} from './geometry';
import type { Point } from './geometry';
import { territoryLabelLayouts } from './label-layout';
import type { LabelBox, TerritoryLabelLayout } from './label-layout';
import { EffectQueue } from './effects';
import type { BetrayalEffect, DisasterEffect, DisasterStrikeInput } from './effects';
import { createOwnerPalette, ownerStyle } from './owner-palette';
import type { OwnerPalette, OwnerStyle } from './owner-palette';
import type { PlayerColorId } from '../ui/player-colors';
import {
  FRONT_LANE_SEND_PULSE_MS,
  MAX_FRONT_LANES,
  drawFrontLanes,
  frontLaneSignature,
  frontLanesToScreen,
  frontLaneSummary as summarizeFrontLanes,
  normalizeFrontLanes,
} from './front-visuals';
import type {
  FrontLaneScreen,
  FrontLaneSendPulse,
  FrontLaneSummary,
  FrontLaneView,
} from './front-visuals';
import {
  CANNON_EFFECT_MS,
  CANNON_MAX_EFFECTS,
  DefenseCollapseQueue,
  DefenseEffectQueue,
  defenseImpactPoint,
  drawDefenseCollapse,
  drawDefenseEffect,
  drawDefenseFort,
  drawShieldBadge,
  normalizeCannonReceipt,
  normalizeDefenseCollapse,
  normalizeDefenseReceipt,
  planDefenseFort,
  receiptOffScreen,
} from './defense-visuals';
import type { DefenseEffect, DefenseImpact, FortLayout } from './defense-visuals';
import {
  BETRAYAL_CONVERT_END_MS,
  BETRAYAL_LOCK_END_MS,
  drawBetrayalEffect,
} from './betrayal-effects';
import type { BetrayalGeometry } from './betrayal-effects';
import {
  applyCamera,
  clampDpr,
  computeViewport,
  mapToScreen,
  panCamera,
  viewportSignature,
  zoomCameraAt,
} from './viewport';
import type { CameraState, Viewport } from './viewport';

export interface CanvasRendererOptions {
  /** Initial player swatch; omitted keeps the legacy blue default. */
  playerColorId?: PlayerColorId | string | null;
}

export interface RenderInput {
  view: MatchView;
  /** Primary slot (latest press); kept for solo and single-slot callers. */
  gesture: GestureState;
  /** Every non-idle slot (versus has one per finger); falls back to `gesture`. */
  gestures?: readonly GestureState[];
  selectedId: string | null;
  /** ownerReachableTargets(view, owner); computed by the adapter per revision. */
  reachableIds?: readonly string[];
  /** Transit/frontier highlights; these territories are not valid destinations. */
  alliedFrontierIds?: readonly string[];
  /** Per-owner reachable sets, so each versus finger highlights its own side. */
  reachableByOwner?: Partial<Record<OwnerId, readonly string[]>>;
  alpha: number;
  /**
   * Raw continuous lines. When omitted, `view.fronts` (the real v1.2.0
   * `MatchView.fronts` mirror) is used automatically, so an integration that
   * does nothing at all still renders live lanes. Passing an explicit array
   * (including an empty one) overrides the view field.
   */
  fronts?: readonly unknown[];
  /**
   * Accepted for integration compatibility but deliberately unused: a tick can
   * never prove that a wave left (`nextSendTick` is only the earliest allowed
   * tick), so the lane renders static direction and pulse only on a real
   * `totalSent` increase.
   */
  frontTick?: number | null;
}

/** What the last frame actually painted per live pointer (dev diagnostics). */
export interface RenderGestureSummary {
  owner: string;
  phase: string;
  sourceId: string | null;
  targetId: string | null;
  targetOk: boolean;
  ratio: number;
}

interface Floater {
  id: number;
  territoryId: string;
  text: string;
  tone: 'good' | 'bad' | 'info';
  startedAt: number;
}

/** Short red outline on the origin cell when a versus drag is refused. */
interface RejectFlash {
  territoryId: string;
  startedAt: number;
}

const REJECT_FLASH_MS = 550;

interface Decor {
  kind: 'tree' | 'hill' | 'mountain' | 'dot';
  x: number;
  y: number;
  size: number;
}

interface CachedTerritory {
  id: string;
  path: Path2D;
  polygon: Point[];
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  /** Core labelAnchor || center in screen pixels (never the fitted chip). */
  routeX: number;
  routeY: number;
  label: TerritoryLabelLayout | null;
  decor: Decor[];
  /** Cached screen-space fort for defenseLevel 1/2. */
  defense: FortLayout | null;
  /** Level backing `defense`; refreshTerritories rebuilds it on change. */
  defenseLevel: number;
  area: number;
}

interface CannonShot {
  id: number;
  mapId: string;
  /** Firing tower territory (event.targetId), or null for legacy callers. */
  towerId: string | null;
  from: Point;
  to: Point;
  amount: number;
  startedAt: number;
}

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

const CREAM = '#F6EFE2';
const CREAM_SOFT = '#FBF5E9';
const PAPER = '#EDE4D1';
const WATER = '#DCE7E4';
const NAVY = '#172B44';
const GOLD = '#EDB64E';
const LEGAL = '#2F8068';
const INVALID = '#D2553F';
const MAP_PADDING = 14;
const TAU = Math.PI * 2;

// Palette lives in ./owner-palette so the v1.2.0 front-line and defense
// overlays share the exact map colours. Values are unchanged.
/**
 * Every non-idle slot to paint. Callers that predate multi-touch only pass the
 * primary gesture, which keeps the solo frame byte-for-byte identical.
 */
export function activeRenderGestures(input: {
  gesture: GestureState;
  gestures?: readonly GestureState[];
}): GestureState[] {
  const all = input.gestures && input.gestures.length > 0 ? input.gestures : [input.gesture];
  const out: GestureState[] = [];
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].phase !== 'idle') out.push(all[i]);
  }
  return out;
}

/**
 * Static selection ring/chips are per-pane state, not global input state. In
 * versus a red finger must not erase blue's resting selection; in solo the
 * original "any live finger hides the ring" rule is kept byte-for-byte.
 * Reachable chips come from the selected owner's own set, never the other
 * pane's.
 */
export function selectionHighlight(
  selectedOwner: OwnerId | null,
  gestures: readonly GestureState[],
  reachableIds: readonly string[],
  reachableByOwner: Partial<Record<OwnerId, readonly string[]>>,
  versus: boolean
): { draw: boolean; reachable: readonly string[] } {
  if (!versus) {
    return { draw: gestures.length === 0, reachable: reachableIds };
  }
  let ownerActive = false;
  for (let i = 0; i < gestures.length; i += 1) {
    if (selectedOwner !== null && gestures[i].owner === selectedOwner) {
      ownerActive = true;
      break;
    }
  }
  let reachable: readonly string[] = [];
  if (selectedOwner !== null) {
    const own = reachableByOwner[selectedOwner];
    if (own) reachable = own;
    else if (selectedOwner === 'player') reachable = reachableIds;
  }
  return { draw: !ownerActive, reachable: reachable };
}

/** The pressed side's style; an unbound legacy pointer behaves as player. */
function gestureStyle(gesture: GestureState, palette: OwnerPalette): OwnerStyle {
  return ownerStyle(gesture.owner || 'player', palette);
}

function font(weight: string, size: number): string {
  return weight + ' ' + Math.round(size * 10) / 10 + 'px ' + FONT_STACK;
}

/**
 * Effect palette and the one font used by rising damage numbers. Kept at
 * module scope so the per-frame draw path never concatenates rgba strings or
 * rebuilds a font descriptor.
 */
const DISASTER_CORE = '#FFF1D6';
const DISASTER_RING = '#E27A60';
const DISASTER_EDGE = '#8E392B';
const DISASTER_LABEL = '#9C3A28';
const EFFECT_LABEL_FONT = font('800', 11);

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash >>> 0;
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
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
  roundedRectPath(ctx, x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth || 1;
    ctx.stroke();
  }
}

function buildPath(points: Point[]): Path2D | null {
  if (points.length < 2) return null;
  const path = new Path2D();
  path.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) path.lineTo(points[i][0], points[i][1]);
  return path;
}

export class CanvasRenderer {
  private readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private palette: OwnerPalette;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private layoutWidth = 0;
  private layoutHeight = 0;
  private layoutDirty = true;
  private resizeObserver: ResizeObserver | null = null;
  private camera: CameraState = { zoom: 1, panX: 0, panY: 0 };
  private baseViewport: Viewport | null = null;
  private viewport: Viewport | null = null;
  private viewportKey = '';
  private cache: Record<string, CachedTerritory> = {};
  private order: string[] = [];
  private byId: Record<string, TerritoryView> = {};
  private viewTerritories: TerritoryView[] = [];
  private previousOwners: Record<string, OwnerId> = {};
  private flashUntil: Record<string, number> = {};
  private background: HTMLCanvasElement | null = null;
  private backgroundKey = '';
  private lastMapId = '';
  private mapKey = '';
  private floaters: Floater[] = [];
  private floaterSeq = 0;
  private rejectFlashes: RejectFlash[] = [];
  private lastGestureSummary: RenderGestureSummary[] = [];
  private topology: MapTopology | null = null;
  private topologyMapKey = '';
  private screenTopology: ScreenTopology | null = null;
  private pointContactCache: PointContactCache | null = null;
  private pointContacts: Point[] = [];
  private viewEdges: ReadonlyArray<{ id?: string; from: string; to: string }> = [];
  private landPath: Path2D | null = null;
  private coastPath: Path2D | null = null;
  private sharedPath: Path2D | null = null;
  private labels: Record<string, TerritoryLabelLayout> = {};
  private cannonShots: CannonShot[] = [];
  private cannonShotSeq = 0;
  /** Map id of the latest frame; raw cannon events carry no map id. */
  private viewMapId = '';
  /** Reused aim result so the per-fort cannon lookup allocates nothing. */
  private readonly cannonAimScratch = { angle: -0.42, recoil: 0, flash: 0 };
  private reducedMotion: boolean | null = null;
  private readonly effects = new EffectQueue();
  private readonly defenseEffects = new DefenseEffectQueue();
  /**
   * Capture collapses are a separate, bounded queue: the vanished fort is
   * rebuilt from the event's real `previousDefenseLevel`, never from the
   * current (already zeroed) map state.
   */
  private readonly defenseCollapseEffects = new DefenseCollapseQueue();
  /** Pre-capture fort layouts, rebuilt when the viewport or the level changes. */
  private collapseForts: Record<
    string,
    { level: 1 | 2; viewport: string; fort: FortLayout | null }
  > = {};
  /** Wall-clock stamp of a real pause, so a frozen collapse resumes as frozen. */
  private collapsePausedAt: number | null = null;
  /** True while `collapseForts` holds entries, so the empty pass clears it once. */
  private collapseFortsUsed = false;
  /** Copy perspective for defense receipts (versus panes differ). */
  private viewerOwner: OwnerId = 'player';
  /** True while the player has an active truce partner (route-rule copy). */
  private allyRouteHint = false;
  /** Cached front-lane geometry; rebuilt only when the signature changes. */
  private frontLanes: FrontLaneScreen[] = [];
  private frontLaneKey = '';
  /** Last raw fronts array and its normalized form (avoids per-frame alloc). */
  private frontRawSource: readonly unknown[] | null = null;
  private frontRawLanes: ReturnType<typeof normalizeFrontLanes> = [];
  /** Viewport the cached signature was built for. */
  private frontKeyViewport = '';
  /** Previous real `totalSent` per lane, used to detect an actual dispatch. */
  private frontPrevSent: Record<string, number> = {};
  /** Bounded real-dispatch pulses (one per lane, aged out). */
  private readonly frontPulses: FrontLaneSendPulse[] = [];
  /** Scratch arrays reused by the per-frame front pass (no per-frame alloc). */
  private readonly frontEndpointScratch: Array<{
    id: string;
    center: [number, number];
    labelAnchor?: [number, number];
  }> = [];
  private readonly frontLabelBoxScratch: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];

  constructor(canvas: HTMLCanvasElement, options?: CanvasRendererOptions) {
    this.canvas = canvas;
    this.palette = createOwnerPalette(options ? options.playerColorId : undefined);
    this.ctx = canvas.getContext('2d');
    // Canvas CSS size changes (orientation, visual viewport, panel height)
    // invalidate the cached layout read; the render loop itself never forces
    // one per frame.
    if (typeof ResizeObserver !== 'undefined') {
      const self = this;
      this.resizeObserver = new ResizeObserver(function () {
        self.layoutDirty = true;
      });
      this.resizeObserver.observe(canvas);
    }
  }

  /**
   * Sets this renderer's player swatch without touching any other renderer or
   * the legacy default palette. The next frame uses the new immutable palette.
   */
  setPlayerColor(colorId: PlayerColorId | string | null | undefined): void {
    this.palette = createOwnerPalette(colorId);
  }

  /** Called on window/orientation resize when no observer is available. */
  invalidateLayout(): void {
    this.layoutDirty = true;
  }

  addFloater(territoryId: string, text: string, tone: 'good' | 'bad' | 'info'): void {
    this.floaterSeq += 1;
    this.floaters.push({
      id: this.floaterSeq,
      territoryId: territoryId,
      text: text,
      tone: tone,
      startedAt: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    });
    if (this.floaters.length > 8) this.floaters.shift();
  }

  /**
   * Refused drag in local versus: a short red outline on the origin cell. No
   * toast and no floater text — the other player must not be interrupted.
   */
  flashReject(territoryId: string | null): void {
    if (!territoryId) return;
    this.rejectFlashes.push({
      territoryId: territoryId,
      startedAt: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    });
    if (this.rejectFlashes.length > 6) this.rejectFlashes.shift();
  }

  /** Diagnostic snapshot of the slots painted by the latest frame. */
  gestureRenderSummary(): readonly RenderGestureSummary[] {
    return this.lastGestureSummary;
  }

  /** Live refused-drag flashes (smoke asserts the per-side feedback exists). */
  rejectFlashCount(): number {
    return this.rejectFlashes.length;
  }

  /**
   * Disaster strike: one short effect at the deterministic epicenter plus a
   * red flash / rising "-N" for every cell that actually lost troops.
   */
  playDisaster(strike: DisasterStrikeInput): void {
    this.effects.enqueueDisaster({
      startedAt: this.effectNow(),
      x: strike.x,
      y: strike.y,
      seed: strike.seed,
      affected: strike.affected,
    });
  }

  /**
   * Betrayal ("策反") presentation. Every campaign number is copied from the
   * core receipt or the before/after snapshots; optional fields let old
   * callers keep type-checking while the copy hides anything unknown.
   */
  playBetrayal(input: {
    targetId: string;
    targetName?: string;
    previousOwner: OwnerId | null;
    beforeTroops?: number;
    beforeShield?: number;
    captured: boolean;
    removed: number;
    survivors: number;
    afterOwner?: OwnerId | null;
    afterTroops?: number;
    afterShield?: number;
    seed: number;
  }): BetrayalEffect {
    return this.effects.enqueueBetrayal({
      startedAt: this.effectNow(),
      targetId: input.targetId,
      targetName: input.targetName,
      previousOwner: input.previousOwner,
      beforeTroops: input.beforeTroops,
      beforeShield: input.beforeShield,
      captured: input.captured,
      removed: input.removed,
      survivors: input.survivors,
      afterOwner: input.afterOwner,
      afterTroops: input.afterTroops,
      afterShield: input.afterShield,
      seed: input.seed,
    });
  }

  /**
   * v1.2.0 defensive receipt (受击 / 护盾吸收 / 击退 / 失守).
   *
   * Accepts a *raw* core event object. `normalizeDefenseReceipt` returns null
   * for anything that is not a `defend`/`capture` receipt, in which case this
   * method returns false and nothing is played — the renderer never invents a
   * hit. Callers can therefore forward every drained event here unconditionally
   * and check the boolean only if they care.
   *
   * `options.includeCaptures` defaults to true (the required 失守 visual). Pass
   * false when the existing capture floater already announces the loss and the
   * extra chip would double up on the same cell.
   *
   * `viewerOwner` defaults to the pane owner set through `setViewerOwner`
   * ('player' when never set), so a versus red pane can read the same receipts
   * from its own side without changing the call site.
   */
  playDefenseReceipt(
    payload: unknown,
    viewerOwner?: OwnerId,
    options?: { includeCaptures?: boolean }
  ): boolean {
    const receipt = normalizeDefenseReceipt(payload);
    if (!receipt) return false;
    if (receipt.kind === 'fall') {
      // A real capture supersedes an earlier defended wave for the SAME cell:
      // a "击退/守住" chip must not play next to the real 失守 prompt. Other
      // cells are untouched, and a defend arriving after this capture is
      // enqueued normally (order is preserved).
      this.defenseEffects.removeFor(receipt.territoryId);
    }
    if (receipt.kind === 'fall' && options && options.includeCaptures === false) {
      // Recognized but deliberately not re-announced: report true so callers
      // can tell "this was a real capture" from "this was not a receipt".
      return true;
    }
    const viewer = viewerOwner || this.viewerOwner;
    this.defenseEffects.enqueue(receipt, this.effectNow(), viewer);
    return true;
  }

  /**
   * v1.2.0 capture collapse (城墙/炮台坍塌). Accepts the raw core `capture`
   * event and plays the pre-capture fort falling apart, then leaves nothing
   * behind; the map icon itself is already gone because the core zeroed the
   * defense level.
   *
   * Only the event's real `previousDefenseLevel` (exactly 1 or 2) can start
   * this. A missing/0 level, a non-capture event or a malformed payload
   * returns false and paints nothing, so an undefended capture, a shield of 0
   * or a stale cache can never fake a collapse. `previousOwner` only colours
   * the vanishing pennant; when absent the neutral accent is used.
   */
  playDefenseCollapse(payload: unknown): boolean {
    const receipt = normalizeDefenseCollapse(payload);
    if (!receipt) return false;
    this.defenseCollapseEffects.enqueue(receipt, this.effectNow());
    return true;
  }

  /**
   * Live collapse effects (diagnostics; bounded by the queue cap). Pass `now`
   * on the frame clock to prune first, so an entry that already finished on an
   * earlier frame can never make the shell wait for it.
   */
  defenseCollapseCount(now?: number): number {
    if (typeof now === 'number' && isFinite(now) && this.collapsePausedAt === null) {
      this.defenseCollapseEffects.prune(now);
    }
    return this.defenseCollapseEffects.size();
  }

  /**
   * Drops pending collapse animations. Callers use this on a same-map restart
   * together with `clearDefenseEffects`; the next capture starts fresh.
   */
  clearDefenseCollapses(): void {
    this.defenseCollapseEffects.clear();
    this.collapseForts = {};
    this.collapseFortsUsed = false;
    this.collapsePausedAt = null;
  }

  /**
   * Freezes a live collapse while no frame is drawn (pause, hidden tab). The
   * queue is wall-clock based, so the shell must tell the renderer when the
   * clock stopped; `resumeDefenseCollapses` then discards exactly that gap so
   * the debris continues from where it was instead of jumping to the end.
   */
  pauseDefenseCollapses(): void {
    if (this.collapsePausedAt === null) this.collapsePausedAt = this.effectNow();
  }

  /** See `pauseDefenseCollapses`; a no-op when nothing was paused. */
  resumeDefenseCollapses(): void {
    const pausedAt = this.collapsePausedAt;
    if (pausedAt === null) return;
    this.collapsePausedAt = null;
    const gap = this.effectNow() - pausedAt;
    if (gap > 0) this.defenseCollapseEffects.shift(gap);
  }

  /**
   * Drops the pending defense receipt for ONE territory (a real capture event
   * for it arrived later in the same drained batch). Scoped to that cell so a
   * neighbour's chip is never cleared by an unrelated capture.
   */
  invalidateDefense(territoryId: string): number {
    return this.defenseEffects.removeFor(territoryId);
  }

  /**
   * Perspective used by defense copy when the caller does not pass one. Set it
   * once per pane ('player' for the blue pane, 'ai1' for the rotated versus
   * red pane); it changes wording only, never the hit data.
   */
  setViewerOwner(owner: OwnerId): void {
    this.viewerOwner = owner;
  }

  /** Live defense receipts (diagnostics/smoke; bounded by the queue cap). */
  defenseEffectCount(): number {
    return this.defenseEffects.size();
  }

  /**
   * Drops every queued defense receipt and collapse. The shell can call this
   * on a same-map restart so a 1.4 s chip / collapse from the previous match
   * never bleeds into the new one. Transient lanes/disaster/betrayal state is
   * untouched; use `resetMatch()` for a full transient reset.
   */
  clearDefenseEffects(): void {
    this.defenseEffects.clear();
    this.clearDefenseCollapses();
  }

  /**
   * Full transient-visual reset for a new match, including a same-map restart
   * (which the map-key change cannot detect). Clears effects, defense receipts
   * and capture collapses, front lanes/pulses, floaters, refused-drag flashes,
   * cannon shots, owner tracking (so no fake capture flash on the first new
   * frame) and the camera.
   */
  resetMatch(): void {
    this.effects.clear();
    this.defenseEffects.clear();
    this.defenseCollapseEffects.clear();
    this.collapseForts = {};
    this.collapseFortsUsed = false;
    this.collapsePausedAt = null;
    this.clearFrontLanes();
    this.floaters = [];
    this.rejectFlashes = [];
    this.cannonShots = [];
    this.previousOwners = {};
    this.flashUntil = {};
    this.lastGestureSummary = [];
    this.camera = { zoom: 1, panX: 0, panY: 0 };
    this.viewportKey = '';
    this.viewMapId = '';
  }

  /** Live real-dispatch pulses (diagnostics; bounded by MAX_FRONT_LANES). */
  frontSendPulseCount(now?: number): number {
    const stamp = typeof now === 'number' && isFinite(now) ? now : this.effectNow();
    let count = 0;
    for (let i = 0; i < this.frontPulses.length; i += 1) {
      const age = stamp - this.frontPulses[i].startedAt;
      if (age >= 0 && age < FRONT_LANE_SEND_PULSE_MS) count += 1;
    }
    return count;
  }

  /** Screen-space front lanes built by the latest frame (diagnostics). */
  frontLaneSummary(): readonly FrontLaneSummary[] {
    return summarizeFrontLanes(this.frontLanes);
  }

  /** How many lanes the latest frame actually drew. */
  frontLaneCount(): number {
    return this.frontLanes.length;
  }

  /** Cached once: a presentation-only preference, never read per frame. */
  private prefersReducedMotion(): boolean {
    if (this.reducedMotion === null) {
      this.reducedMotion =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
          : false;
    }
    return this.reducedMotion;
  }

  /** Effect clock shares the rAF timeline used by draw(). */
  private effectNow(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * Short-lived visual for one core cannon event. Coordinates are map-space
   * (tower anchor -> impact), so zoom/pan cannot desync the shot from the
   * shared army route. Damage is copied from the event; never derived here.
   *
   * Kept for callers that only have the coordinates. `playCannonEvent` is the
   * preferred entry point because it also keeps the firing tower id, which is
   * what lets the cached turret turn toward the real impact.
   */
  addCannonShot(from: [number, number], to: [number, number], amount: number, mapId: string): void {
    this.cannonShotSeq += 1;
    this.cannonShots.push({
      id: this.cannonShotSeq,
      mapId: mapId,
      towerId: null,
      from: [from[0], from[1]],
      to: [to[0], to[1]],
      amount: amount,
      startedAt: this.effectNow(),
    });
    if (this.cannonShots.length > CANNON_MAX_EFFECTS) this.cannonShots.shift();
  }

  /**
   * Raw core cannon receipt. `targetId` is the firing tower and `to` is the
   * real impact point; `amount` is the real damage. Unknown payloads are
   * refused so a rendering integration can forward every drained event.
   */
  playCannonEvent(payload: unknown, mapId?: string): boolean {
    const receipt = normalizeCannonReceipt(payload);
    if (!receipt) return false;
    this.cannonShotSeq += 1;
    this.cannonShots.push({
      id: this.cannonShotSeq,
      mapId: mapId || this.viewMapId,
      towerId: receipt.towerId,
      from: [receipt.fromX, receipt.fromY],
      to: [receipt.toX, receipt.toY],
      amount: receipt.amount,
      startedAt: this.effectNow(),
    });
    if (this.cannonShots.length > CANNON_MAX_EFFECTS) this.cannonShots.shift();
    return true;
  }

  /** Live cannon receipts (diagnostics; bounded by CANNON_MAX_EFFECTS). */
  cannonEffectCount(): number {
    return this.cannonShots.length;
  }

  /**
   * Cached fort rectangle for one territory, or null when the territory has no
   * defense level or its fort lies entirely outside the current viewport.
   * Read-only diagnostics: smoke/tests assert that pan cannot pin a fort to
   * the canvas edge and that a visible fort follows its real anchor.
   */
  defenseFortSnapshot(
    territoryId: string
  ): { x: number; y: number; width: number; height: number; towerX: number | null } | null {
    const cached = this.cache[territoryId];
    const fort = cached ? cached.defense : null;
    if (!fort) return null;
    return {
      x: fort.x,
      y: fort.y,
      width: fort.width,
      height: fort.height,
      towerX: fort.tower ? fort.tower.x : null,
    };
  }

  getViewport(view: MatchView): Viewport {
    return this.sync(view);
  }

  getCamera(): CameraState {
    return { zoom: this.camera.zoom, panX: this.camera.panX, panY: this.camera.panY };
  }

  zoomBy(factor: number, focusX?: number, focusY?: number): void {
    if (!this.baseViewport) return;
    const fx = typeof focusX === 'number' ? focusX : this.cssWidth / 2;
    const fy = typeof focusY === 'number' ? focusY : this.cssHeight / 2;
    this.camera = zoomCameraAt(this.baseViewport, this.camera, factor, fx, fy);
    this.viewportKey = '';
  }

  resetCamera(): void {
    this.camera = { zoom: 1, panX: 0, panY: 0 };
    this.viewportKey = '';
  }

  panBy(dx: number, dy: number): void {
    if (!this.baseViewport) return;
    this.camera = panCamera(this.baseViewport, this.camera, dx, dy);
    this.viewportKey = '';
  }

  draw(input: RenderInput, now: number): void {
    const view = input.view;
    // A frozen collapse is only legitimate while the match really sits on the
    // pause card. Any other frame (`playing`, and crucially `ended` while the
    // shell holds the settlement for this very animation) releases the freeze,
    // so a pause-then-end path can never leave the queue unpruned forever.
    if (this.collapsePausedAt !== null && view.status !== 'paused') {
      this.resumeDefenseCollapses();
    }
    // Route-rule context for the barrier copy: refreshed from the real
    // snapshot every frame, so it freezes on pause and clears on un-ally.
    this.allyRouteHint = playerHasActiveAlly(view);
    this.viewTerritories = view.territories;
    const viewport = this.sync(view);
    const ctx = this.ctx;
    if (!ctx) return;

    this.refreshTerritories(view);
    this.detectCaptures(view, now);
    this.viewMapId = view.mapId;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.background) {
      ctx.drawImage(this.background, 0, 0);
    } else {
      ctx.fillStyle = WATER;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (this.topology && this.topology.legacy) {
      ctx.fillStyle = CREAM;
      ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    }

    this.drawLand(ctx);
    this.drawTerritoryFills(ctx, view, now);
    this.drawFieldEffects(ctx, now);
    this.drawBorders(ctx);
    this.drawBarriers(ctx);
    this.drawPointContacts(ctx);
    this.drawBridges(ctx);
    // Debris of a captured fort lies UNDER the living defense layer: a new
    // owner's same-tick upgrade must never be covered by the old building.
    this.drawDefenseCollapses(ctx, now);
    this.drawDefense(ctx, view, now);
    this.drawShieldBadges(ctx, view);
    this.drawFrontLanesPass(ctx, input, view, now);
    this.drawCannonRange(ctx, view, input.selectedId);
    const gestures = activeRenderGestures(input);
    this.publishGestureSummary(gestures);
    this.drawHighlights(
      ctx,
      gestures,
      input.selectedId,
      input.reachableIds || [],
      input.reachableByOwner || {},
      input.alliedFrontierIds || [],
      view.mode === 'versus',
      now
    );
    this.drawRejectFlashes(ctx, now);
    this.drawArmies(ctx, view, input.alpha);
    this.drawLabels(ctx, view, input.selectedId);
    this.drawCannonShots(ctx, view, now);
    this.drawFloaters(ctx, now);
    this.drawDefenseOverlays(ctx, now);
    this.drawOverlayEffects(ctx, now);
    this.drawStatusWash(ctx, view);

    void viewport;
  }

  destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    // Centralised transient reset: queues, lanes/pulses, owner tracking and
    // camera. A reused renderer instance (or a double destroy) must never keep
    // a previous match's receipts or fabricate a send pulse from a stale
    // totalSent baseline. `resetMatch` touches no canvas/DOM state.
    this.resetMatch();
    this.background = null;
    this.cache = {};
    this.order = [];
    this.byId = {};
    this.labels = {};
    this.topology = null;
    this.topologyMapKey = '';
    this.screenTopology = null;
    this.pointContactCache = null;
    this.pointContacts = [];
    this.viewEdges = [];
    this.landPath = null;
    this.coastPath = null;
    this.sharedPath = null;
  }

  private sync(view: MatchView): Viewport {
    if (this.layoutDirty || this.layoutWidth <= 0 || this.layoutHeight <= 0) {
      this.layoutWidth = this.canvas.clientWidth;
      this.layoutHeight = this.canvas.clientHeight;
      this.layoutDirty = false;
    }
    const width = this.layoutWidth;
    const height = this.layoutHeight;
    const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const dpr = clampDpr(rawDpr);

    if (width > 0 && height > 0) {
      if (width !== this.cssWidth || height !== this.cssHeight || dpr !== this.dpr) {
        this.cssWidth = width;
        this.cssHeight = height;
        this.dpr = dpr;
        this.canvas.width = Math.max(1, Math.round(width * dpr));
        this.canvas.height = Math.max(1, Math.round(height * dpr));
        this.backgroundKey = '';
        this.viewportKey = '';
      }
    }

    if (this.cssWidth <= 0 || this.cssHeight <= 0) {
      if (this.viewport) return this.viewport;
      return computeViewport(1, 1, view.mapWidth, view.mapHeight, MAP_PADDING);
    }

    if (!this.background || this.backgroundKey !== this.cssWidth + 'x' + this.cssHeight + '@' + this.dpr) {
      this.rebuildBackground();
    }

    const mapKey =
      view.mapId +
      '|' +
      view.mapWidth +
      'x' +
      view.mapHeight +
      '|' +
      view.territories.length;
    if (mapKey !== this.mapKey) {
      const previousMapKey = this.mapKey;
      this.mapKey = mapKey;
      this.camera = { zoom: 1, panX: 0, panY: 0 };
      this.viewportKey = '';
      this.cannonShots = [];
      this.floaters = [];
      this.flashUntil = {};
      // A freshly constructed renderer initialises mapKey from ''. An effect
      // may already be queued before its first frame (demo replay does this),
      // so only a real old-map -> new-map change clears effects.
      if (previousMapKey !== '') {
        this.effects.clear();
        this.defenseEffects.clear();
        this.defenseCollapseEffects.clear();
        this.collapseForts = {};
        this.collapseFortsUsed = false;
        this.collapsePausedAt = null;
        this.clearFrontLanes();
      }
    }

    const base = computeViewport(
      this.cssWidth,
      this.cssHeight,
      view.mapWidth,
      view.mapHeight,
      MAP_PADDING
    );
    this.baseViewport = base;
    const next = applyCamera(base, this.camera);
    this.camera = {
      zoom: next.zoom || 1,
      panX: next.panX || 0,
      panY: next.panY || 0,
    };
    const nextKey = viewportSignature(next);
    this.viewport = next;

    if (nextKey !== this.viewportKey) {
      this.viewportKey = nextKey;
      this.rebuildMapCache(view, next);
    }
    return next;
  }

  private refreshTerritories(view: MatchView): void {
    this.viewEdges = view.edges;
    if (this.order.length !== view.territories.length) {
      if (this.viewport) this.rebuildMapCache(view, this.viewport);
      return;
    }
    let missing = false;
    const next: Record<string, TerritoryView> = {};
    for (let i = 0; i < view.territories.length; i += 1) {
      const territory = view.territories[i];
      next[territory.id] = territory;
      const cached = this.cache[territory.id];
      if (!cached) {
        missing = true;
      } else if (cached.defenseLevel !== territory.defenseLevel) {
        // Defense decor is level-dependent but viewport-stable, so rebuild
        // just that territory's fort. A full map rebuild here would
        // regenerate every path on each troop change.
        cached.defenseLevel = territory.defenseLevel;
        cached.defense = this.buildDefense(
          territory,
          cached.polygon,
          { x: cached.x, y: cached.y, width: cached.width, height: cached.height },
          cached.label,
          cached.routeX,
          cached.routeY
        );
      }
    }
    if (missing) {
      if (this.viewport) this.rebuildMapCache(view, this.viewport);
      return;
    }
    this.byId = next;
  }

  private rebuildMapCache(view: MatchView, viewport: Viewport): void {
    this.cache = {};
    this.order = [];
    this.byId = {};
    // Collapse layouts are derived from the screen geometry just rebuilt.
    this.collapseForts = {};
    this.collapseFortsUsed = false;
    if (this.topologyMapKey !== this.mapKey || !this.topology) {
      this.topology = buildMapTopology(view);
      this.topologyMapKey = this.mapKey;
    }
    this.screenTopology = mapTopologyToScreen(viewport, this.topology, view);
    this.landPath = new Path2D();
    this.coastPath = null;
    this.sharedPath = null;

    this.labels = territoryLabelLayouts(viewport, view.territories, view.mapId);

    for (let i = 0; i < view.territories.length; i += 1) {
      const territory = view.territories[i];
      this.byId[territory.id] = territory;
      const points: Point[] = [];
      const path = new Path2D();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let p = 0; p < territory.polygon.length; p += 1) {
        const point = mapToScreen(viewport, territory.polygon[p][0], territory.polygon[p][1]);
        points.push(point);
        if (p === 0) path.moveTo(point[0], point[1]);
        else path.lineTo(point[0], point[1]);
        minX = Math.min(minX, point[0]);
        minY = Math.min(minY, point[1]);
        maxX = Math.max(maxX, point[0]);
        maxY = Math.max(maxY, point[1]);
      }
      path.closePath();
      if (!isFinite(minX)) continue;

      const bounds = {
        minX: minX,
        minY: minY,
        maxX: maxX,
        maxY: maxY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
      };
      const label = this.labels[territory.id] || null;
      const anchorX = label ? label.screenAnchor[0] : (minX + maxX) / 2;
      const anchorY = label ? label.screenAnchor[1] : (minY + maxY) / 2;
      // Army routes use the core endpoint rule (labelAnchor || center), not
      // the fitted chip position.
      const routePoint = mapToScreen(
        viewport,
        territory.labelAnchor ? territory.labelAnchor[0] : territory.center[0],
        territory.labelAnchor ? territory.labelAnchor[1] : territory.center[1]
      );

      this.cache[territory.id] = {
        id: territory.id,
        path: path,
        polygon: points,
        x: minX,
        y: minY,
        width: bounds.width,
        height: bounds.height,
        anchorX: anchorX,
        anchorY: anchorY,
        routeX: routePoint[0],
        routeY: routePoint[1],
        label: label,
        decor: this.buildDecor(territory, points, anchorX, anchorY, label),
        defense: this.buildDefense(
          territory,
          points,
          { x: minX, y: minY, width: bounds.width, height: bounds.height },
          label,
          routePoint[0],
          routePoint[1]
        ),
        defenseLevel: territory.defenseLevel,
        area: polygonArea(territory.polygon),
      };
      this.order.push(territory.id);
      this.landPath.addPath(path);
    }

    this.buildStaticPaths();
    // World contacts depend only on the map arrangement. Cache them by mapKey;
    // zoom/pan rebuilds this screen projection without touching the geometry.
    this.pointContactCache = resolvePointContacts(this.pointContactCache, this.mapKey, view);
    this.pointContacts = projectPointContacts(viewport, this.pointContactCache.contacts);
    this.lastMapId = view.mapId;
  }

  private buildStaticPaths(): void {
    if (!this.screenTopology) return;
    if (!this.screenTopology.legacy) {
      const coast = new Path2D();
      for (let i = 0; i < this.screenTopology.coastline.length; i += 1) {
        const path = buildPath(this.screenTopology.coastline[i]);
        if (path) coast.addPath(path);
      }
      this.coastPath = coast;

      // Only passable land borders are ordinary state lines. Blocked borders,
      // rivers and ridges get their own high-contrast treatment below, so they
      // must never ride the shared hairline that reads as "walk straight over".
      const shared = new Path2D();
      for (let i = 0; i < this.screenTopology.boundaries.length; i += 1) {
        const boundary = this.screenTopology.boundaries[i];
        if (borderStroke(boundary) !== 'state') continue;
        const path = buildPath(boundary.points);
        if (path) shared.addPath(path);
      }
      this.sharedPath = shared;
    }
  }

  private buildDecor(
    territory: TerritoryView,
    polygon: Point[],
    anchorX: number,
    anchorY: number,
    label: TerritoryLabelLayout | null
  ): Decor[] {
    const bounds = polygonBounds(polygon);
    const seed = hashString(territory.id + territory.terrain);
    const minDimension = Math.min(bounds.width, bounds.height);
    const size = clamp(minDimension * 0.055, 2.4, 6);
    const radius = Math.max(6, minDimension * 0.26);
    const count = territory.terrain === 'plain' ? 3 : 4;
    const decor: Decor[] = [];
    if (minDimension < 14) return decor;

    for (let i = 0; i < count; i += 1) {
      const angle = ((seed >> (i * 5)) % 360) * (Math.PI / 180) + i * 1.7;
      const spread = 0.45 + (((seed >> (i * 3)) % 100) / 100) * 0.55;
      const x = anchorX + Math.cos(angle) * radius * spread;
      const y = anchorY + Math.sin(angle) * radius * spread;
      if (!pointInPolygon(x, y, polygon)) continue;
      if (label && label.inside && boxContains(label.box, x, y, 6)) continue;
      let kind: Decor['kind'] = 'dot';
      if (territory.terrain === 'forest') kind = 'tree';
      else if (territory.terrain === 'hill') kind = 'hill';
      else if (territory.terrain === 'mountain') kind = 'mountain';
      decor.push({
        kind: kind,
        x: x,
        y: y,
        size: kind === 'mountain' ? size * 1.4 : kind === 'hill' ? size * 1.8 : size,
      });
    }
    return decor;
  }

  /**
   * Builds the fort layout in screen space (so zoom and small cells are
   * handled by clamping), clear of the real label box and offset from the
   * army route endpoint. Called only when the territory is rebuilt or its
   * defense level changes.
   */
  private buildDefense(
    territory: TerritoryView,
    polygon: Point[],
    bounds: { x: number; y: number; width: number; height: number },
    label: TerritoryLabelLayout | null,
    routeX: number,
    routeY: number
  ): FortLayout | null {
    return this.planDefenseAtLevel(
      territory.defenseLevel,
      polygon,
      bounds,
      label,
      routeX,
      routeY
    );
  }

  /**
   * Same plan for an explicit level. The capture collapse uses it with the
   * event's REAL previous level, so the vanished fort is rebuilt from the
   * event rather than from the already-zeroed map state.
   */
  private planDefenseAtLevel(
    level: number,
    polygon: Point[],
    bounds: { x: number; y: number; width: number; height: number },
    label: TerritoryLabelLayout | null,
    routeX: number,
    routeY: number
  ): FortLayout | null {
    return planDefenseFort({
      level: level,
      bounds: bounds,
      anchorX: routeX,
      anchorY: routeY,
      labelBox: label ? label.box : null,
      labelInside: label ? label.inside : false,
      polygon: polygon,
      viewWidth: this.cssWidth,
      viewHeight: this.cssHeight,
    });
  }

  private detectCaptures(view: MatchView, now: number): void {
    if (this.lastMapId !== view.mapId) {
      this.previousOwners = {};
      this.flashUntil = {};
      this.lastMapId = view.mapId;
    }
    for (let i = 0; i < view.territories.length; i += 1) {
      const territory = view.territories[i];
      const previous = this.previousOwners[territory.id];
      if (previous && previous !== territory.owner && view.status === 'playing') {
        this.flashUntil[territory.id] = now + 620;
      }
      this.previousOwners[territory.id] = territory.owner;
    }
  }

  private drawLand(ctx: CanvasRenderingContext2D): void {
    if (!this.landPath || !this.screenTopology || this.screenTopology.legacy) return;
    ctx.save();
    ctx.translate(0, 2.5);
    ctx.fillStyle = 'rgba(18, 38, 52, 0.14)';
    ctx.fill(this.landPath);
    ctx.restore();
    ctx.fillStyle = PAPER;
    ctx.fill(this.landPath);
  }

  private drawTerritoryFills(
    ctx: CanvasRenderingContext2D,
    view: MatchView,
    now: number
  ): void {
    for (let i = 0; i < this.order.length; i += 1) {
      const id = this.order[i];
      const cached = this.cache[id];
      const territory = this.byId[id];
      if (!cached || !territory) continue;
      const style = ownerStyle(territory.owner, this.palette);

      ctx.fillStyle = style.fill;
      ctx.fill(cached.path);

      ctx.save();
      ctx.clip(cached.path);
      const ink =
        territory.owner === 'neutral'
          ? 'rgba(42, 52, 58, 0.22)'
          : 'rgba(255, 248, 234, 0.30)';
      for (let d = 0; d < cached.decor.length; d += 1) {
        this.drawDecor(ctx, cached.decor[d], ink);
      }
      const flashUntil = this.flashUntil[id];
      if (flashUntil && flashUntil > now) {
        const alpha = clamp((flashUntil - now) / 620, 0, 1);
        ctx.fillStyle = 'rgba(255, 249, 236, ' + (alpha * 0.58).toFixed(3) + ')';
        ctx.fillRect(cached.x - 2, cached.y - 2, cached.width + 4, cached.height + 4);
      }
      ctx.restore();
    }
  }

  private drawDecor(ctx: CanvasRenderingContext2D, decor: Decor, ink: string): void {
    const size = decor.size;
    if (decor.kind === 'tree') {
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.moveTo(decor.x, decor.y - size * 1.4);
      ctx.lineTo(decor.x + size * 0.8, decor.y);
      ctx.lineTo(decor.x - size * 0.8, decor.y);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(decor.x, decor.y - size * 2.1);
      ctx.lineTo(decor.x + size * 0.6, decor.y - size * 0.7);
      ctx.lineTo(decor.x - size * 0.6, decor.y - size * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(decor.x - size * 0.1, decor.y, size * 0.2, size * 0.55);
    } else if (decor.kind === 'hill') {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(decor.x, decor.y, size, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(decor.x, decor.y, size * 1.5, Math.PI * 0.2, Math.PI * 0.8);
      ctx.stroke();
    } else if (decor.kind === 'mountain') {
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.moveTo(decor.x, decor.y - size * 1.1);
      ctx.lineTo(decor.x + size, decor.y + size * 0.55);
      ctx.lineTo(decor.x - size, decor.y + size * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 248, 234, 0.42)';
      ctx.beginPath();
      ctx.moveTo(decor.x, decor.y - size * 1.1);
      ctx.lineTo(decor.x + size * 0.32, decor.y - size * 0.52);
      ctx.lineTo(decor.x - size * 0.32, decor.y - size * 0.52);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(decor.x, decor.y, size * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawBorders(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (!this.screenTopology || this.screenTopology.legacy) {
      for (let i = 0; i < this.order.length; i += 1) {
        const cached = this.cache[this.order[i]];
        if (!cached) continue;
        ctx.strokeStyle = 'rgba(251, 245, 233, 0.9)';
        ctx.lineWidth = 3;
        ctx.stroke(cached.path);
        ctx.strokeStyle = 'rgba(23, 43, 68, 0.38)';
        ctx.lineWidth = 0.9;
        ctx.stroke(cached.path);
      }
      ctx.restore();
      return;
    }

    if (this.coastPath) {
      ctx.strokeStyle = 'rgba(251, 245, 233, 0.92)';
      ctx.lineWidth = 3.4;
      ctx.stroke(this.coastPath);
      ctx.strokeStyle = 'rgba(23, 43, 68, 0.55)';
      ctx.lineWidth = 1.1;
      ctx.stroke(this.coastPath);
    }
    if (this.sharedPath) {
      ctx.strokeStyle = 'rgba(251, 245, 233, 0.82)';
      ctx.lineWidth = 2.2;
      ctx.stroke(this.sharedPath);
      ctx.strokeStyle = 'rgba(23, 43, 68, 0.48)';
      ctx.lineWidth = 1;
      ctx.stroke(this.sharedPath);
    }
    ctx.restore();
  }

  private drawBarriers(ctx: CanvasRenderingContext2D): void {
    const topology = this.screenTopology;
    if (!topology) return;
    const gap = this.crossingGap();
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (let i = 0; i < topology.boundaries.length; i += 1) {
      const boundary = topology.boundaries[i];
      const stroke = borderStroke(boundary);
      if (stroke === 'state') continue;
      const width = this.barrierWidth(stroke);
      let pieces: Point[][];
      if (boundaryHasCrossing(boundary) && boundary.crossing) {
        // Only real edges with a declared crossing get the opening; blocked
        // arcs keep one continuous band so the isolation stays unmistakable.
        pieces = splitPolylineAtPoint(boundary.points, boundary.crossing, gap);
      } else {
        pieces = [boundary.points];
      }
      for (let p = 0; p < pieces.length; p += 1) {
        this.paintBarrierPiece(ctx, pieces[p], stroke, width);
      }
    }
    ctx.restore();
  }

  private barrierWidth(stroke: 'blocked' | 'river' | 'ridge'): number {
    const scale = this.viewport ? this.viewport.scale : 1;
    if (stroke === 'river') return clamp(scale * 8.5, 5, 9.5);
    if (stroke === 'ridge') return clamp(scale * 7.5, 4.6, 8.5);
    return clamp(scale * 4.4, 3.2, 5.6);
  }

  /** Screen-space opening cut around a bridge/pass anchor. */
  private crossingGap(): number {
    return clamp((this.viewport ? this.viewport.scale : 1) * 22, 12, 20);
  }

  private paintBarrierPiece(
    ctx: CanvasRenderingContext2D,
    points: Point[],
    stroke: 'blocked' | 'river' | 'ridge',
    width: number
  ): void {
    const path = buildPath(points);
    if (!path) return;
    ctx.setLineDash([]);

    if (stroke === 'blocked') {
      // Isolated but not a named terrain barrier: a dashed dark line on a
      // solid cream bed. Still clearly not the thin passable state border.
      ctx.strokeStyle = 'rgba(251, 245, 233, 0.92)';
      ctx.lineWidth = width + 2;
      ctx.stroke(path);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(72, 64, 54, 0.92)';
      ctx.lineWidth = 1.8;
      ctx.stroke(path);
      ctx.setLineDash([]);
      return;
    }

    if (stroke === 'river') {
      ctx.strokeStyle = 'rgba(251, 245, 233, 0.95)';
      ctx.lineWidth = width + 2.6;
      ctx.stroke(path);
      ctx.strokeStyle = '#38617A';
      ctx.lineWidth = width;
      ctx.stroke(path);
      ctx.strokeStyle = 'rgba(224, 242, 240, 0.72)';
      ctx.lineWidth = Math.max(1, width * 0.28);
      ctx.stroke(path);
      return;
    }

    ctx.strokeStyle = 'rgba(251, 245, 233, 0.95)';
    ctx.lineWidth = width + 2.2;
    ctx.stroke(path);
    ctx.strokeStyle = '#4B3F30';
    ctx.lineWidth = width;
    ctx.stroke(path);
    ctx.strokeStyle = 'rgba(148, 132, 104, 0.7)';
    ctx.lineWidth = Math.max(1, width * 0.22);
    ctx.stroke(path);
    this.drawRidgeTeeth(ctx, points, width * 1.15);
  }

  private drawRidgeTeeth(
    ctx: CanvasRenderingContext2D,
    points: Point[],
    size: number
  ): void {
    const total = points.length;
    if (total < 2) return;
    const length = polylineScreenLength(points);
    if (length < 8) return;
    const step = Math.max(10, size * 2.6);
    ctx.fillStyle = 'rgba(56, 46, 33, 0.9)';
    let travelled = 0;
    for (let s = 0; s < total - 1; s += 1) {
      const ax = points[s][0];
      const ay = points[s][1];
      const bx = points[s + 1][0];
      const by = points[s + 1][1];
      const dx = bx - ax;
      const dy = by - ay;
      const segment = Math.sqrt(dx * dx + dy * dy);
      if (segment <= 0) continue;
      const tx = dx / segment;
      const ty = dy / segment;
      const nx = -ty;
      const ny = tx;
      let local = travelled === 0 ? step * 0.5 : step - (travelled % step);
      while (local < segment) {
        const t = local / segment;
        const x = ax + dx * t;
        const y = ay + dy * t;
        // Teeth straddle the band, so the ridge reads as a range on both banks
        // instead of a one-sided saw that vanishes when the arc runs vertical.
        for (let side = -1; side <= 1; side += 2) {
          const apexX = x + nx * size * 0.78 * side;
          const apexY = y + ny * size * 0.78 * side;
          const baseX = x - nx * size * 0.12 * side;
          const baseY = y - ny * size * 0.12 * side;
          const half = size * 0.46;
          ctx.beginPath();
          ctx.moveTo(apexX, apexY);
          ctx.lineTo(baseX + tx * half, baseY + ty * half);
          ctx.lineTo(baseX - tx * half, baseY - ty * half);
          ctx.closePath();
          ctx.fill();
        }
        local += step;
      }
      travelled += segment;
    }
  }

  /**
   * Cream notch at a vertex-only contact (e.g. Four Corners). Shared borders
   * are never cut: only pairs with no edge, no declared border and no shared
   * segment reach this list.
   */
  private drawPointContacts(ctx: CanvasRenderingContext2D): void {
    if (this.pointContacts.length === 0) return;
    const scale = this.viewport ? this.viewport.scale : 1;
    const radius = clamp(scale * 17, 4.5, 7);
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < this.pointContacts.length; i += 1) {
      const x = this.pointContacts[i][0];
      const y = this.pointContacts[i][1];
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, TAU);
      ctx.fillStyle = CREAM;
      ctx.fill();
      const d = radius * 0.58;
      ctx.beginPath();
      ctx.moveTo(x - d, y - d);
      ctx.lineTo(x + d, y + d);
      ctx.moveTo(x + d, y - d);
      ctx.lineTo(x - d, y + d);
      ctx.strokeStyle = 'rgba(23, 43, 68, 0.58)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawBridges(ctx: CanvasRenderingContext2D): void {
    const topology = this.screenTopology;
    if (!topology) return;
    const gap = this.crossingGap();
    for (let i = 0; i < topology.bridgePoints.length; i += 1) {
      const bridge = topology.bridgePoints[i];
      const tangent = this.boundaryTangent(bridge.point, topology);
      const nx = -tangent[1];
      const ny = tangent[0];
      const x = bridge.point[0];
      const y = bridge.point[1];
      ctx.save();
      ctx.lineCap = 'round';
      if (bridge.kind === 'ridge') {
        // A pass gate sits in the ridge opening; keep the cream deck so the
        // opening never reads as a missing border or an ordinary state line.
        const radius = clamp(gap * 0.32, 4.4, 6.5);
        const half = Math.max(radius + 2.4, gap * 0.5 - 1);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(251, 245, 233, 0.98)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(23, 43, 68, 0.72)';
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - tangent[0] * half, y - tangent[1] * half);
        ctx.lineTo(x + tangent[0] * half, y + tangent[1] * half);
        ctx.strokeStyle = 'rgba(23, 43, 68, 0.55)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      } else {
        const half = gap * 0.5 + 2.8;
        ctx.strokeStyle = 'rgba(23, 43, 68, 0.68)';
        ctx.lineWidth = 6.6;
        ctx.beginPath();
        ctx.moveTo(x - nx * half, y - ny * half);
        ctx.lineTo(x + nx * half, y + ny * half);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(251, 245, 233, 0.98)';
        ctx.lineWidth = 4.2;
        ctx.beginPath();
        ctx.moveTo(x - nx * half, y - ny * half);
        ctx.lineTo(x + nx * half, y + ny * half);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(23, 43, 68, 0.52)';
        ctx.lineWidth = 1.1;
        for (let p = -4; p <= 4; p += 4) {
          ctx.beginPath();
          ctx.moveTo(x - nx * half + nx * p - tangent[0] * 3.2, y - ny * half + ny * p - tangent[1] * 3.2);
          ctx.lineTo(x + nx * half + nx * p + tangent[0] * 3.2, y + ny * half + ny * p + tangent[1] * 3.2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  private boundaryTangent(point: Point, topology: ScreenTopology): Point {
    let bestDistance = Infinity;
    let tangent: Point = [1, 0];
    for (let i = 0; i < topology.boundaries.length; i += 1) {
      const points = topology.boundaries[i].points;
      for (let p = 1; p < points.length; p += 1) {
        const d = distanceToSegment(
          point[0],
          point[1],
          points[p - 1][0],
          points[p - 1][1],
          points[p][0],
          points[p][1]
        );
        if (d < bestDistance) {
          bestDistance = d;
          const dx = points[p][0] - points[p - 1][0];
          const dy = points[p][1] - points[p - 1][1];
          const length = Math.sqrt(dx * dx + dy * dy) || 1;
          tangent = [dx / length, dy / length];
        }
      }
    }
    return tangent;
  }

  private drawDefense(
    ctx: CanvasRenderingContext2D,
    view: MatchView,
    now: number
  ): void {
    for (let i = 0; i < this.order.length; i += 1) {
      const id = this.order[i];
      const cached = this.cache[id];
      const territory = this.byId[id];
      if (!cached || !territory || !cached.defense) continue;
      // A live REAL cannon receipt for this tower turns the barrel and adds
      // recoil/flash. Otherwise the cached rest angle is used.
      const aim = this.cannonAimFor(id, now);
      drawDefenseFort(ctx, cached.defense, territory.owner, aim, this.palette);
    }
    void view;
  }

  /**
   * Capture collapses, painted just below the living defense layer. Each
   * effect's pre-capture layout is re-planned from the territory's own cached
   * screen geometry whenever the viewport changes, so debris pans/zooms with
   * its cell; a fully off-screen cell yields no layout (never an edge-pinned
   * ruin). A new owner's same-tick fort is drawn afterwards and therefore
   * always covers the old fragments.
   */
  private drawDefenseCollapses(ctx: CanvasRenderingContext2D, now: number): void {
    // While the shell reports a frozen session (pause card, hidden tab) the
    // pass paints the frame it froze on, so a stray redraw neither expires the
    // effect nor advances the fall. `resumeDefenseCollapses` discards the gap.
    const clock = this.collapsePausedAt !== null ? this.collapsePausedAt : now;
    const reduced = this.prefersReducedMotion();
    const active = this.defenseCollapseEffects.active(clock);
    if (active.length === 0) {
      // Every collapse has finished: drop the cached pre-capture layouts so a
      // long match cannot accumulate per-territory entries.
      if (this.collapseFortsUsed) {
        this.collapseForts = {};
        this.collapseFortsUsed = false;
      }
      return;
    }
    for (let i = 0; i < active.length; i += 1) {
      const effect = active[i];
      // `age` uses the pass clock: frozen while paused, so the debris is
      // painted exactly where it stopped.
      const age = clock - effect.receivedAt;
      // A frame clock can sit a millisecond before the enqueue clock; keep the
      // effect queued and start it on the next frame.
      if (!(age >= 0)) continue;
      const receipt = effect.receipt;
      const cached = this.cache[receipt.territoryId];
      if (!cached) continue;
      let entry = this.collapseForts[receipt.territoryId];
      if (
        !entry ||
        entry.level !== receipt.previousDefenseLevel ||
        entry.viewport !== this.viewportKey
      ) {
        entry = {
          level: receipt.previousDefenseLevel,
          viewport: this.viewportKey,
          fort: this.planDefenseAtLevel(
            receipt.previousDefenseLevel,
            cached.polygon,
            { x: cached.x, y: cached.y, width: cached.width, height: cached.height },
            cached.label,
            cached.routeX,
            cached.routeY
          ),
        };
        this.collapseForts[receipt.territoryId] = entry;
        this.collapseFortsUsed = true;
      }
      const fort = entry.fort;
      if (!fort) continue;
      const current = this.byId[receipt.territoryId];
      drawDefenseCollapse({
        ctx: ctx,
        effect: effect,
        palette: this.palette,
        age: age,
        fort: fort,
        // The intact jolt is only truthful while the icon is really gone.
        standing: !current || current.defenseLevel <= 0,
        reducedMotion: reduced,
      });
    }
  }

  /**
   * Reused aim probe for one tower. The barrel points at the real map-space
   * impact of the newest live cannon receipt for that tower; camera/pan is
   * applied here each frame, so a moved viewport never leaves a stale angle.
   */
  private cannonAimFor(
    towerId: string,
    now: number
  ): { angle: number; recoil: number; flash: number } | null {
    const viewport = this.viewport;
    const cached = this.cache[towerId];
    const tower = cached && cached.defense ? cached.defense.tower : null;
    if (!viewport || !tower) return null;
    let chosen: CannonShot | null = null;
    for (let i = 0; i < this.cannonShots.length; i += 1) {
      const shot = this.cannonShots[i];
      if (shot.towerId !== towerId) continue;
      if (shot.mapId !== this.viewMapId) continue;
      const age = now - shot.startedAt;
      if (age < 0 || age > CANNON_EFFECT_MS) continue;
      if (chosen === null || shot.startedAt >= chosen.startedAt) chosen = shot;
    }
    if (!chosen) return null;
    const age = now - chosen.startedAt;
    const targetX = viewport.offsetX + chosen.to[0] * viewport.scale;
    const targetY = viewport.offsetY + chosen.to[1] * viewport.scale;
    const aim = this.cannonAimScratch;
    aim.angle = Math.atan2(targetY - tower.y, targetX - tower.x);
    if (this.prefersReducedMotion()) {
      aim.recoil = 0;
      aim.flash = 0;
    } else {
      aim.recoil = age < 170 ? clamp(1 - age / 170, 0, 1) : 0;
      aim.flash = age < 150 ? clamp(1 - age / 150, 0, 1) : 0;
    }
    return aim;
  }

  /**
   * Static shield-state marker for any territory with `shield > 0`. The core
   * only grants shield through the defense track, so a shielded cell always
   * has a cached fort; when that fort is `null` the cell is off-screen (or has
   * no defense level at all) and the marker is skipped rather than drawn at a
   * bbox corner where it would misrepresent a different place.
   */
  private drawShieldBadges(ctx: CanvasRenderingContext2D, view: MatchView): void {
    for (let i = 0; i < view.territories.length; i += 1) {
      const territory = view.territories[i];
      if (!(territory.shield > 0)) continue;
      const cached = this.cache[territory.id];
      if (!cached || !cached.defense) continue;
      const capacity =
        territory.shieldCapacity > 0 ? territory.shieldCapacity : territory.shield;
      const fraction = capacity > 0 ? territory.shield / capacity : 1;
      drawShieldBadge(
        ctx,
        cached.defense.shield.x,
        cached.defense.shield.y,
        cached.defense.shield.radius,
        fraction,
        territory.owner,
        this.palette
      );
    }
  }

  /**
   * Front lanes sit below the drag/selection language on purpose: the preview
   * is a dashed hint with a charge ring and a chip under the finger, while a
   * front is a solid owner-coloured double stroke that exists whether or not
   * anyone is touching the screen.
   *
   * `input.fronts` is normalized here and geometry is cached by signature, so
   * the per-frame work is a string compare plus the draw pass.
   */
  private drawFrontLanesPass(
    ctx: CanvasRenderingContext2D,
    input: RenderInput,
    view: MatchView,
    now: number
  ): void {
    const viewport = this.viewport;
    if (!viewport) return;
    // `input.fronts` wins when supplied; otherwise the real view field is used,
    // so the lanes appear without any extra integration step.
    const raw =
      input.fronts !== undefined
        ? input.fronts
        : (view.fronts as readonly unknown[] | undefined);
    if (!raw || raw.length === 0) {
      this.clearFrontLanes();
      return;
    }
    // Normalization allocates, so it only runs when the caller hands over a
    // different array instance (the adapter caches one snapshot per revision).
    const normalizedFresh = raw !== this.frontRawSource;
    if (normalizedFresh) {
      this.frontRawSource = raw;
      this.frontRawLanes = normalizeFrontLanes(raw);
    }
    const lanes = this.frontRawLanes;
    if (lanes.length === 0) {
      this.clearFrontLanes();
      return;
    }
    // A real dispatch is only visible as a growth of `totalSent`. The tick is
    // accepted by RenderInput for compatibility but never implies a send.
    const sameInputs =
      !normalizedFresh && this.viewportKey === this.frontKeyViewport;
    const signature = sameInputs
      ? this.frontLaneKey
      : frontLaneSignature(lanes, this.viewportKey);
    if (!sameInputs) {
      this.frontKeyViewport = this.viewportKey;
      this.detectFrontSendPulses(lanes, now);
    }
    if (signature !== this.frontLaneKey) {
      // Endpoints and label boxes are rebuilt only on a real signature change.
      const endpoints = this.frontEndpointScratch;
      endpoints.length = 0;
      for (let i = 0; i < view.territories.length; i += 1) {
        const territory = view.territories[i];
        endpoints.push({
          id: territory.id,
          center: [territory.center[0], territory.center[1]],
          labelAnchor: territory.labelAnchor
            ? [territory.labelAnchor[0], territory.labelAnchor[1]]
            : undefined,
        });
      }
      this.frontLanes = frontLanesToScreen(
        viewport,
        lanes,
        endpoints,
        view.boundaries
      );
      const boxes = this.frontLabelBoxScratch;
      boxes.length = 0;
      for (let i = 0; i < this.frontLanes.length; i += 1) {
        const lane = this.frontLanes[i];
        const source = this.cache[lane.sourceId];
        const target = this.cache[lane.targetId];
        if (source && source.label) boxes.push(source.label.box);
        if (target && target.label) boxes.push(target.label.box);
      }
      this.frontLaneKey = signature;
    }
    if (this.frontLanes.length === 0) return;
    drawFrontLanes({
      ctx: ctx,
      lanes: this.frontLanes,
      palette: this.palette,
      now: now,
      reducedMotion: this.prefersReducedMotion(),
      viewWidth: this.cssWidth,
      viewHeight: this.cssHeight,
      labelBoxes: this.frontLabelBoxScratch,
      sendPulses: this.frontPulses.length > 0 ? this.frontPulses : undefined,
    });
  }

  /**
   * Detects a real dispatch by comparing `totalSent` with the previous
   * snapshot. The pulse list is bounded by MAX_FRONT_LANES (one per lane) and
   * ages out; an absent baseline (first frame after a map load/restart) emits
   * no pulse rather than a burst of fake ones.
   */
  private detectFrontSendPulses(
    lanes: readonly FrontLaneView[],
    now: number
  ): void {
    const previous = this.frontPrevSent;
    const next: Record<string, number> = {};
    const pulses = this.frontPulses;
    for (let i = 0; i < lanes.length; i += 1) {
      const lane = lanes[i];
      if (lane.totalSent === null) continue;
      next[lane.id] = lane.totalSent;
      const before = previous[lane.id];
      if (before === undefined || lane.totalSent <= before) continue;
      let replaced = false;
      for (let p = 0; p < pulses.length; p += 1) {
        if (pulses[p].id === lane.id) {
          pulses[p].startedAt = now;
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        if (pulses.length >= MAX_FRONT_LANES) pulses.shift();
        pulses.push({ id: lane.id, startedAt: now });
      }
    }
    this.frontPrevSent = next;
    let write = 0;
    for (let read = 0; read < pulses.length; read += 1) {
      const age = now - pulses[read].startedAt;
      if (age < FRONT_LANE_SEND_PULSE_MS) {
        pulses[write] = pulses[read];
        write += 1;
      }
    }
    pulses.length = write;
  }

  /** Drops cached lane geometry, pulses and the raw-array memo. */
  private clearFrontLanes(): void {
    this.frontLanes.length = 0;
    this.frontLaneKey = '';
    this.frontRawSource = null;
    this.frontRawLanes.length = 0;
    this.frontKeyViewport = '';
    this.frontPrevSent = {};
    this.frontPulses.length = 0;
    this.frontEndpointScratch.length = 0;
    this.frontLabelBoxScratch.length = 0;
  }

  /**
   * Defense receipts play above armies/labels but below the disaster/betrayal
   * overlays, so a global event always wins the top layer.
   */
  private drawDefenseOverlays(ctx: CanvasRenderingContext2D, now: number): void {
    const active = this.defenseEffects.active(now);
    if (active.length === 0) return;
    for (let i = 0; i < active.length; i += 1) {
      const effect = active[i];
      const age = now - effect.receivedAt;
      if (age < 0) continue;
      const cached = this.cache[effect.receipt.territoryId];
      if (!cached) continue;
      const bounds = {
        x: cached.x,
        y: cached.y,
        width: cached.width,
        height: cached.height,
      };
      // A cell entirely outside the viewport draws nothing: no ring, sparks or
      // chip clamped to an edge. A partly visible cell keeps a readable chip.
      if (receiptOffScreen(bounds, this.cssWidth, this.cssHeight)) continue;
      const impact = this.defenseImpactFor(effect, cached);
      const fort = cached.defense;
      drawDefenseEffect({
        ctx: ctx,
        effect: effect,
        palette: this.palette,
        age: age,
        impact: impact,
        bounds: bounds,
        fort: fort
          ? { x: fort.x, y: fort.y, width: fort.width, height: fort.height }
          : null,
        viewWidth: this.cssWidth,
        viewHeight: this.cssHeight,
        reducedMotion: this.prefersReducedMotion(),
        partialOnScreen: true,
      });
    }
  }

  /**
   * Impact point on the attacked border. The attacker anchor is taken from the
   * receipt's own source territory when the event carries one, otherwise the
   * territory centre is used (never a guessed direction). When the territory
   * has a cached fort the hit lands on the building itself, so the stone
   * feedback and the shield bubble wrap the real structure.
   */
  private defenseImpactFor(effect: DefenseEffect, cached: CachedTerritory): DefenseImpact {
    const receipt = effect.receipt;
    const attackerId = receipt.attackerSourceId;
    const attacker = attackerId ? this.cache[attackerId] : null;
    const fort = cached.defense;
    const anchorX = fort ? fort.x + fort.width / 2 : cached.routeX;
    const anchorY = fort ? fort.y + fort.height / 2 : cached.routeY;
    const bounds = fort
      ? { x: fort.x, y: fort.y, width: fort.width, height: fort.height }
      : { x: cached.x, y: cached.y, width: cached.width, height: cached.height };
    return defenseImpactPoint(
      bounds,
      anchorX,
      anchorY,
      attacker ? attacker.routeX : null,
      attacker ? attacker.routeY : null
    );
  }

  private drawCannonRange(
    ctx: CanvasRenderingContext2D,
    view: MatchView,
    selectedId: string | null
  ): void {
    if (!selectedId || !this.viewport) return;
    const territory = this.byId[selectedId];
    const cached = this.cache[selectedId];
    if (!territory || !cached) return;
    if (territory.defenseLevel < 2 || !(territory.cannonRange > 0)) return;
    const radius = territory.cannonRange * this.viewport.scale;
    if (!(radius > 0)) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cached.routeX, cached.routeY, radius, 0, Math.PI * 2);
    ctx.setLineDash([5, 6]);
    ctx.strokeStyle = 'rgba(237, 182, 78, 0.78)';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(cached.routeX, cached.routeY, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(237, 182, 78, 0.9)';
    ctx.fill();
    ctx.restore();
    void view;
  }

  /**
   * Real cannon presentation. The firing tower was already turned by
   * `drawDefense` (same event, same frame); this pass adds the muzzle flash,
   * the projectile, the impact burst and the event's real damage number.
   *
   * `reducedMotion` keeps a static tracer + impact flare instead of travelling
   * frames. A negative age (rAF timestamp before the enqueue clock) is skipped
   * and kept for the next frame, never dropped.
   */
  private drawCannonShots(
    ctx: CanvasRenderingContext2D,
    view: MatchView,
    now: number
  ): void {
    if (this.cannonShots.length === 0 || !this.viewport) return;
    const viewport = this.viewport;
    const reduced = this.prefersReducedMotion();
    const keep: CannonShot[] = [];
    for (let i = 0; i < this.cannonShots.length; i += 1) {
      const shot = this.cannonShots[i];
      if (shot.mapId !== view.mapId) continue;
      const age = now - shot.startedAt;
      // A frame timestamp may sit just before the enqueue clock; keep the
      // receipt for the next frame instead of dropping a real shot.
      if (age > CANNON_EFFECT_MS) continue;
      keep.push(shot);
      if (age < 0) continue;

      const from = mapToScreen(viewport, shot.from[0], shot.from[1]);
      const to = mapToScreen(viewport, shot.to[0], shot.to[1]);
      const cached = shot.towerId ? this.cache[shot.towerId] : null;
      const tower = cached && cached.defense ? cached.defense.tower : null;
      const pivotX = tower ? tower.x : from[0];
      const pivotY = tower ? tower.y - tower.radius * 0.15 : from[1];
      const barrelLength = tower ? tower.barrelLength : 0;
      let dirX = to[0] - pivotX;
      let dirY = to[1] - pivotY;
      const length = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
      dirX /= length;
      dirY /= length;
      const recoil = reduced ? 0 : age < 170 ? clamp(1 - age / 170, 0, 1) * 3 : 0;
      const muzzleX = pivotX + dirX * Math.max(0, barrelLength - recoil);
      const muzzleY = pivotY + dirY * Math.max(0, barrelLength - recoil);
      const progress = clamp(age / CANNON_EFFECT_MS, 0, 1);
      const flight = reduced ? 1 : clamp((age - 90) / 360, 0, 1);
      const tracerAlpha = reduced ? 0.55 : 1 - progress * 0.6;

      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      // Muzzle flash / smoke: only the real firing tower produces it.
      if (tower && !reduced && age < 170) {
        const flash = clamp(1 - age / 170, 0, 1);
        ctx.globalAlpha = flash * 0.9;
        ctx.strokeStyle = 'rgba(251, 245, 233, 0.9)';
        ctx.lineWidth = 2.2;
        for (let s = 0; s < 4; s += 1) {
          const a = Math.atan2(dirY, dirX) + (s - 1.5) * 0.34;
          ctx.beginPath();
          ctx.moveTo(muzzleX, muzzleY);
          ctx.lineTo(muzzleX + Math.cos(a) * (4 + flash * 5), muzzleY + Math.sin(a) * (4 + flash * 5));
          ctx.stroke();
        }
        ctx.globalAlpha = flash * 0.35;
        ctx.fillStyle = '#8E8371';
        ctx.beginPath();
        ctx.arc(muzzleX - dirX * 4, muzzleY - dirY * 4, 2 + flash * 2.4, 0, TAU);
        ctx.fill();
      }

      // Tracer: cream underlay keeps it readable over every owner fill.
      ctx.globalAlpha = tracerAlpha;
      ctx.strokeStyle = 'rgba(251, 245, 233, 0.92)';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(muzzleX, muzzleY);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(237, 182, 78, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash(reduced ? [] : [4, 5]);
      ctx.globalAlpha = tracerAlpha * 0.7;
      ctx.strokeStyle = 'rgba(142, 57, 43, 0.55)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.setLineDash([]);

      // Projectile (normal motion only); reduced motion goes straight to the
      // static impact flare below.
      if (!reduced && flight < 1 && age > 90) {
        const px = muzzleX + (to[0] - muzzleX) * flight;
        const py = muzzleY + (to[1] - muzzleY) * flight;
        ctx.globalAlpha = 1 - progress * 0.35;
        ctx.beginPath();
        ctx.arc(px, py, 2.6, 0, TAU);
        ctx.fillStyle = '#FFF8EA';
        ctx.fill();
        ctx.strokeStyle = 'rgba(76, 70, 60, 0.9)';
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }

      const hit =
        reduced || flight >= 1 || age >= 450;
      // The impact is only announced at the receipt's REAL `to` point. When
      // that point is entirely outside the viewport nothing is drawn there and
      // nothing is clamped to an edge; the tracer above stays a real line that
      // the canvas clips naturally.
      const toOffScreen =
        to[0] < 0 || to[0] > this.cssWidth || to[1] < 0 || to[1] > this.cssHeight;
      if (hit && !toOffScreen) {
        const impactLocal = reduced ? 0.35 : clamp((age - 430) / 250, 0, 1);
        const impactAlpha = reduced ? 0.7 : 1 - impactLocal;
        ctx.globalAlpha = impactAlpha * 0.9;
        ctx.strokeStyle = 'rgba(237, 182, 78, 0.95)';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(to[0], to[1], 4 + impactLocal * 7, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = impactAlpha * 0.45;
        ctx.fillStyle = '#FFF8EA';
        ctx.beginPath();
        ctx.arc(to[0], to[1], 2.6 + impactLocal * 2, 0, TAU);
        ctx.fill();

        if (shot.amount > 0) {
          ctx.globalAlpha = impactAlpha;
          ctx.font = font('800', 9);
          ctx.textBaseline = 'middle';
          const text = '-' + shot.amount;
          // No clamp: the number stays at the real impact point. Near the
          // right edge it is flipped to the left of the hit so it stays
          // readable without pretending the hit happened elsewhere.
          const rightSide = to[0] > this.cssWidth / 2;
          ctx.textAlign = rightSide ? 'right' : 'left';
          const tx = rightSide ? to[0] - 6 : to[0] + 6;
          const ty = to[1] - 8;
          ctx.lineJoin = 'round';
          ctx.strokeStyle = 'rgba(251, 245, 233, 0.95)';
          ctx.lineWidth = 2.6;
          ctx.strokeText(text, tx, ty);
          ctx.fillStyle = '#8E392B';
          ctx.fillText(text, tx, ty);
        }
      }
      ctx.restore();
    }
    this.cannonShots = keep;
  }

  private drawHighlights(
    ctx: CanvasRenderingContext2D,
    gestures: readonly GestureState[],
    selectedId: string | null,
    reachableIds: readonly string[],
    reachableByOwner: Partial<Record<OwnerId, readonly string[]>>,
    alliedFrontierIds: readonly string[],
    versus: boolean,
    now: number
  ): void {
    if (!versus && (selectedId || gestures.length > 0)) {
      for (let i = 0; i < alliedFrontierIds.length; i += 1) {
        const frontier = this.cache[alliedFrontierIds[i]];
        if (!frontier) continue;
        this.strokeReachable(ctx, frontier.path, '#176C88', 2.5, [3, 5], 0, 0.95);
        ctx.save();
        ctx.font = font('700', 10);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#172B44';
        const y = Math.max(12, frontier.anchorY - 29);
        roundedRect(ctx, frontier.anchorX - 29, y - 10, 58, 16, 7, 'rgba(251, 245, 233, 0.96)');
        ctx.fillText('借道前沿', frontier.anchorX, y + 2);
        ctx.restore();
      }
    }
    if (selectedId) {
      const territory = this.byId[selectedId];
      const highlight = selectionHighlight(
        territory ? territory.owner : null,
        gestures,
        reachableIds,
        reachableByOwner,
        versus
      );
      const cached = this.cache[selectedId];
      if (highlight.draw && cached) {
        this.strokeDashed(ctx, cached.path, GOLD, 2.4, [7, 6], -((now / 80) % 13), 0.95);
        for (let i = 0; i < highlight.reachable.length; i += 1) {
          const id = highlight.reachable[i];
          if (id === selectedId) continue;
          const reachable = this.cache[id];
          if (reachable) {
            this.strokeReachable(ctx, reachable.path, LEGAL, 1.9, [6, 7], 0, 0.8);
          }
        }
      }
    }

    for (let i = 0; i < gestures.length; i += 1) {
      this.drawGesture(ctx, gestures[i], reachableIds, reachableByOwner, versus, now);
    }
  }

  /** One charge ring / connector / chip per live slot, in that side's colour. */
  private drawGesture(
    ctx: CanvasRenderingContext2D,
    gesture: GestureState,
    reachableIds: readonly string[],
    reachableByOwner: Partial<Record<OwnerId, readonly string[]>>,
    versus: boolean,
    now: number
  ): void {
    const activeSource = gesture.sourceId;
    if (!activeSource) return;
    const style = gestureStyle(gesture, this.palette);
    const reachable = this.reachableFor(gesture, reachableIds, reachableByOwner);
    const target = gesture.targetId;
    const accent = versus ? style.fill : LEGAL;

    // Same ownerReachableTargets set the core validator uses. A friendly
    // target isolated from every owned frontier is therefore never marked
    // legal here. Each finger gets its own side's set in versus.
    for (let i = 0; i < reachable.length; i += 1) {
      const id = reachable[i];
      if (id === target || id === activeSource) continue;
      const cached = this.cache[id];
      if (cached) this.strokeReachable(ctx, cached.path, accent, 2.1, [6, 8], 0, 0.86);
    }

    if (target) {
      const cached = this.cache[target];
      if (cached) {
        if (gesture.targetOk) {
          ctx.fillStyle = 'rgba(47, 128, 104, 0.14)';
          ctx.fill(cached.path);
          ctx.strokeStyle = LEGAL;
          ctx.lineWidth = 2.6;
          ctx.stroke(cached.path);
        } else {
          ctx.fillStyle = 'rgba(210, 85, 63, 0.12)';
          ctx.fill(cached.path);
          this.strokeDashed(ctx, cached.path, INVALID, 2.4, [7, 5], -((now / 90) % 12), 0.95);
          this.emphasizeBlockedBarrier(ctx, target, gesture);
        }
      }
    }

    const source = this.cache[activeSource];
    if (source) {
      this.strokeDashed(ctx, source.path, CREAM_SOFT, 5, [], 0, 0.72);
      this.strokeDashed(
        ctx,
        source.path,
        versus ? style.fill : GOLD,
        2.2,
        [6, 5],
        -((now / 100) % 11),
        0.95
      );
    }

    if (gesture.phase === 'dragging') {
      this.drawPointerConnector(ctx, gesture, activeSource, style, versus);
    }
    this.drawChargeRing(ctx, gesture, source, now, style, versus);
  }

  private reachableFor(
    gesture: GestureState,
    reachableIds: readonly string[],
    reachableByOwner: Partial<Record<OwnerId, readonly string[]>>
  ): readonly string[] {
    const owner = gesture.owner;
    if (owner === 'player' || owner === 'ai1' || owner === 'ai2') {
      const list = reachableByOwner[owner];
      if (list) return list;
      // No per-owner set supplied: only the blue fallback is trustworthy, so
      // never paint blue targets behind a red finger.
      return owner === 'player' ? reachableIds : [];
    }
    return reachableIds;
  }

  /** Cream bed keeps the frontier dashes legible over every owner fill. */
  private strokeReachable(
    ctx: CanvasRenderingContext2D,
    path: Path2D,
    color: string,
    width: number,
    dash: number[],
    offset: number,
    alpha: number
  ): void {
    this.strokeDashed(ctx, path, 'rgba(251, 245, 233, 0.82)', width + 2.2, [], 0, 0.5);
    this.strokeDashed(ctx, path, color, width, dash, offset, alpha);
  }

  /**
   * The real preview reason plus the current edges decide whether a blocked
   * river/ridge can explain the rejection. The pure helper also enforces the
   * frontier rule (target adjacent to an owner's territory) so source
   * adjacency can never leak into the hint.
   */
  private blockedBarriersFor(
    targetId: string,
    owner: OwnerId | null | undefined,
    reason: string | null | undefined
  ): ScreenBoundary[] {
    if (!this.screenTopology) return [];
    return barrierBlockedBoundaries({
      reason: reason,
      sourceOwner: owner,
      targetId: targetId,
      edges: this.viewEdges,
      territories: this.byId,
      boundaries: this.screenTopology.boundaries,
    });
  }

  /**
   * Terrain wording is only safe after the real preview says not_adjacent and
   * the view's edges confirm the target has no legal own frontier. Otherwise
   * the generic "not connected" text stands; terrain never overrides edges.
   */
  private barrierBlockLabel(
    targetId: string,
    owner: OwnerId | null | undefined,
    reason: string | null | undefined
  ): string | null {
    const blocked = this.blockedBarriersFor(targetId, owner, reason);
    if (blocked.length === 0) return null;
    let river = false;
    let ridge = false;
    for (let i = 0; i < blocked.length; i += 1) {
      if (blocked[i].kind === 'river') river = true;
      else if (blocked[i].kind === 'ridge') ridge = true;
    }
    if (river && ridge) return '山河阻隔 · ' + this.routeRuleText();
    if (river) return '河川阻隔 · ' + this.routeRuleText();
    if (ridge) return '山脊阻隔 · ' + this.routeRuleText();
    return null;
  }

  /**
   * The real routing rule behind a not_adjacent refusal. When the player has
   * an active truce partner the passage may legally cross that ally's land
   * (reachability judges pairs with isHostileAt), so the copy names it; in
   * modes without allies the same sentence stays true without hinting that
   * alliance is possible.
   */
  private routeRuleText(): string {
    // Kept short: the terrain prefix ("山河阻隔 · ") precedes it and the
    // floater must stay inside a 390px phone width.
    return this.allyRouteHint
      ? '须沿相连的己方或盟友领地借道'
      : '须沿相连的己方领地出兵';
  }

  private emphasizeBlockedBarrier(
    ctx: CanvasRenderingContext2D,
    targetId: string,
    gesture: GestureState
  ): void {
    if (gesture.targetOk) return;
    const route = gesture.targetRoute;
    const blocked = route
      ? route.reason === 'blocked-boundary' && this.screenTopology
        ? this.screenTopology.boundaries.filter((boundary) => this.viewEdges.some((edge) =>
          !!route.blockedEdgeIds && route.blockedEdgeIds.indexOf(edge.id || edge.from + '-' + edge.to) >= 0 &&
          ((edge.from === boundary.from && edge.to === boundary.to) ||
           (edge.to === boundary.from && edge.from === boundary.to))))
        : []
      : this.blockedBarriersFor(targetId, gesture.owner, gesture.targetReason);
    if (blocked.length === 0) return;
    const scale = this.viewport ? this.viewport.scale : 1;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(210, 85, 63, 0.3)';
    ctx.lineWidth = clamp(scale * 11, 6, 10);
    for (let i = 0; i < blocked.length; i += 1) {
      const path = buildPath(blocked[i].points);
      if (path) ctx.stroke(path);
    }
    ctx.restore();
  }

  private publishGestureSummary(gestures: readonly GestureState[]): void {
    const summary = this.lastGestureSummary;
    summary.length = 0;
    for (let i = 0; i < gestures.length; i += 1) {
      const gesture = gestures[i];
      summary.push({
        owner: gesture.owner || 'player',
        phase: gesture.phase,
        sourceId: gesture.sourceId,
        targetId: gesture.targetId,
        targetOk: gesture.targetOk,
        ratio: Math.round(gesture.ratio * 1000) / 1000,
      });
    }
  }

  /** Short red outline after a refused versus drag (no toast, no text). */
  private drawRejectFlashes(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.rejectFlashes.length === 0) return;
    const keep: RejectFlash[] = [];
    for (let i = 0; i < this.rejectFlashes.length; i += 1) {
      const flash = this.rejectFlashes[i];
      const age = now - flash.startedAt;
      if (age < 0 || age >= REJECT_FLASH_MS) continue;
      const cached = this.cache[flash.territoryId];
      if (!cached) continue;
      keep.push(flash);
      const alpha = 0.95 * (1 - age / REJECT_FLASH_MS);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = INVALID;
      ctx.lineWidth = 3;
      ctx.stroke(cached.path);
      ctx.restore();
    }
    this.rejectFlashes = keep;
  }

  private drawPointerConnector(
    ctx: CanvasRenderingContext2D,
    gesture: GestureState,
    sourceId: string,
    style: OwnerStyle,
    versus: boolean
  ): void {
    const source = this.cache[sourceId];
    if (!source) return;
    const movement = gesture.targetPlannedMovement;
    const points = gesture.targetOk && movement && this.viewport
      ? movement.routePoints.map((point) => mapToScreen(this.viewport as Viewport, point[0], point[1]))
      : [[source.anchorX, source.anchorY], [gesture.x, gesture.y]];
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(251, 245, 233, 0.92)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    for (let i = 0; i < points.length; i += 1) {
      if (i === 0) ctx.moveTo(points[i][0], points[i][1]);
      else ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.stroke();
    ctx.setLineDash([5, 6]);
    ctx.strokeStyle = gesture.targetOk ? LEGAL : 'rgba(23, 43, 68, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(gesture.x, gesture.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(251, 245, 233, 0.92)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = versus ? style.fill : this.palette.style.player.fill;
    ctx.stroke();
  }

  private drawChargeRing(
    ctx: CanvasRenderingContext2D,
    gesture: GestureState,
    source: CachedTerritory | undefined,
    now: number,
    style: OwnerStyle,
    versus: boolean
  ): void {
    if (!source) return;
    const centerX = source.anchorX;
    const centerY = source.anchorY;
    const label = source.label;
    const baseRadius = label
      ? Math.max(label.box.width, label.box.height) / 2 + 8
      : Math.min(source.width, source.height) * 0.33;
    const radius = clamp(baseRadius, 24, 48);
    const start = -Math.PI / 2;
    const end = start + Math.PI * 2 * clamp(gesture.ratio, 0, 1);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(251, 245, 233, 0.34)';
    ctx.lineWidth = 5.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, start, end);
    ctx.strokeStyle = gesture.frozen
      ? GOLD
      : versus
        ? style.fill
        : 'rgba(251, 245, 233, 0.95)';
    ctx.lineWidth = 5.5;
    ctx.stroke();

    if (gesture.frozen) {
      const tickX = centerX + Math.cos(end) * (radius + 6);
      const tickY = centerY + Math.sin(end) * (radius + 6);
      ctx.beginPath();
      ctx.arc(tickX, tickY, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = GOLD;
      ctx.fill();
    }
    ctx.restore();

    const pulse = gesture.frozen ? 1 : 0.82 + Math.sin(now / 170) * 0.12;
    const text = formatPercent(gesture.ratio) + (gesture.frozen ? ' 已锁定' : '');
    ctx.font = font('700', 11);
    const width = ctx.measureText(text).width + 14;
    const height = 20;
    let boxX = centerX - width / 2;
    let boxY = centerY - radius - height - 7;
    if (boxY < 4) boxY = centerY + radius + 7;
    boxX = clamp(boxX, 4, this.cssWidth - width - 4);
    ctx.save();
    ctx.globalAlpha = pulse;
    roundedRect(
      ctx,
      boxX,
      boxY,
      width,
      height,
      10,
      versus ? style.badge : 'rgba(23, 43, 68, 0.88)'
    );
    ctx.fillStyle = CREAM_SOFT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, boxX + width / 2, boxY + height / 2 + 0.5);
    ctx.restore();

    if (gesture.phase === 'dragging') {
      this.drawPreviewChip(ctx, gesture, style, versus);
    }
  }

  private drawPreviewChip(
    ctx: CanvasRenderingContext2D,
    gesture: GestureState,
    style: OwnerStyle,
    versus: boolean
  ): void {
    const target = gesture.targetId;
    let lineOne = '拖到己方接壤领地';
    let lineTwo = '';
    let accent = versus ? style.fill : NAVY;
    if (target) {
      if (gesture.targetOk) {
        lineOne = '派出 ' + gesture.targetSent + ' · 留守 ' + gesture.targetRemaining;
        lineTwo = routePassageText({ territories: this.viewTerritories }, gesture.targetPlannedMovement) || forecastText(gesture.targetForecast);
        accent = LEGAL;
      } else {
        // Only the core's not_adjacent rejection can be explained by terrain,
        // and only after edges confirm there is no legal own frontier. The
        // terrain-less not_adjacent case uses the same ally-aware routing
        // rule as the barrier copy; every other reason keeps its own text.
        const barrierText = this.barrierBlockLabel(
          target,
          gesture.owner,
          gesture.targetReason
        );
        lineOne =
          routeFailureText(gesture.targetRoute) || barrierText ||
          (gesture.targetReason === 'not_adjacent'
            ? '未接通前线 · ' + this.routeRuleText()
            : reasonText(gesture.targetReason));
        accent = INVALID;
      }
    }
    ctx.save();
    const maxTextWidth = Math.max(1, this.cssWidth - 30);
    function fitLine(text: string): string {
      if (ctx.measureText(text).width <= maxTextWidth) return text;
      let fitted = text;
      while (fitted.length > 0 && ctx.measureText(fitted + '…').width > maxTextWidth) fitted = fitted.slice(0, -1);
      return fitted + '…';
    }
    ctx.font = font('700', 11);
    lineOne = fitLine(lineOne);
    const widthOne = ctx.measureText(lineOne).width;
    ctx.font = font('600', 10);
    lineTwo = fitLine(lineTwo);
    const widthTwo = lineTwo ? ctx.measureText(lineTwo).width : 0;
    const width = Math.min(this.cssWidth - 8, Math.max(widthOne, widthTwo) + 22);
    const height = lineTwo ? 42 : 26;
    let x = gesture.x - width / 2;
    let y = gesture.y - height - 18;
    if (y < 6) y = gesture.y + 18;
    x = clamp(x, 4, this.cssWidth - width - 4);
    y = clamp(y, 4, this.cssHeight - height - 4);

    roundedRect(ctx, x, y, width, height, 11, 'rgba(251, 245, 233, 0.97)', 'rgba(23, 43, 68, 0.18)', 1);
    ctx.fillStyle = accent;
    roundedRect(ctx, x, y, 4, height, 2, accent);
    ctx.fillStyle = '#172B44';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = font('700', 11);
    ctx.fillText(lineOne, x + 13, y + (lineTwo ? 14 : height / 2));
    if (lineTwo) {
      ctx.fillStyle = accent;
      ctx.font = font('600', 10);
      ctx.fillText(lineTwo, x + 13, y + 29);
    }
    ctx.restore();
  }

  private drawArmies(ctx: CanvasRenderingContext2D, view: MatchView, alpha: number): void {
    if (!this.viewport) return;
    const viewport = this.viewport;
    const tick = view.tick + alpha;
    for (let i = 0; i < view.armies.length; i += 1) {
      const army = view.armies[i];
      const source = this.byId[army.sourceId];
      const target = this.byId[army.targetId];
      if (!source || !target) continue;
      const sourceEndpoint = {
        id: source.id,
        center: source.center,
        labelAnchor: source.labelAnchor,
      };
      const targetEndpoint = {
        id: target.id,
        center: target.center,
        labelAnchor: target.labelAnchor,
      };
      // The core helper is the single route authority: same endpoints and
      // boundary crossings used by cannon sweeps and hit-testing previews.
      const world = armyPositionAt(
        army,
        sourceEndpoint,
        targetEndpoint,
        view.boundaries,
        tick
      );
      const worldAhead = armyPositionAt(
        army,
        sourceEndpoint,
        targetEndpoint,
        view.boundaries,
        tick + 0.02
      );
      const point = mapToScreen(viewport, world[0], world[1]);
      const ahead = mapToScreen(viewport, worldAhead[0], worldAhead[1]);
      let dx = ahead[0] - point[0];
      let dy = ahead[1] - point[1];
      if (Math.abs(dx) + Math.abs(dy) < 0.001) {
        dx = mapToScreen(viewport, target.center[0], target.center[1])[0] - point[0];
        dy = mapToScreen(viewport, target.center[0], target.center[1])[1] - point[1];
      }
      const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const nx = -dy / length;
      const ny = dx / length;
      const style = ownerStyle(army.owner, this.palette);

      for (let dot = 1; dot <= 4; dot += 1) {
        const trailWorld = armyPositionAt(
          army,
          sourceEndpoint,
          targetEndpoint,
          view.boundaries,
          tick - dot * 0.035
        );
        if (tick - dot * 0.035 <= army.startTick) break;
        const trail = mapToScreen(viewport, trailWorld[0], trailWorld[1]);
        ctx.beginPath();
        ctx.arc(trail[0], trail[1], 2.4 - dot * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(251, 245, 233, ' + (0.55 - dot * 0.09).toFixed(2) + ')';
        ctx.fill();
      }

      const badgeX = point[0] + nx * 15;
      const badgeY = point[1] + ny * 15;
      ctx.save();
      ctx.font = font('800', 10);
      const text = String(army.troops);
      const badgeWidth = Math.max(22, ctx.measureText(text).width + 12);
      const badgeHeight = 17;
      ctx.translate(badgeX, badgeY);
      ctx.rotate(Math.atan2(dy, dx) * 0.08);
      roundedRect(
        ctx,
        -badgeWidth / 2,
        -badgeHeight / 2,
        badgeWidth,
        badgeHeight,
        8.5,
        style.badge,
        'rgba(251, 245, 233, 0.92)',
        1.4
      );
      ctx.fillStyle = '#FFF8EA';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, 0.5);
      ctx.restore();

      ctx.beginPath();
      ctx.arc(point[0], point[1], 4.2, 0, Math.PI * 2);
      ctx.fillStyle = style.fill;
      ctx.fill();
      ctx.strokeStyle = 'rgba(251, 245, 233, 0.95)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    view: MatchView,
    selectedId: string | null
  ): void {
    for (let i = 0; i < this.order.length; i += 1) {
      const id = this.order[i];
      const cached = this.cache[id];
      const territory = this.byId[id];
      if (!cached || !territory || !cached.label) continue;
      const label = cached.label;
      const style = ownerStyle(territory.owner, this.palette);
      const box = label.box;
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;

      if (label.leader) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(251, 245, 233, 0.9)';
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(label.leader.x1, label.leader.y1);
        ctx.lineTo(label.leader.x2, label.leader.y2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(23, 43, 68, 0.55)';
        ctx.lineWidth = 0.9;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(label.leader.x1, label.leader.y1, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(251, 245, 233, 0.96)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(23, 43, 68, 0.55)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.restore();
      }

      const selected = selectedId === id;
      roundedRect(
        ctx,
        box.x,
        box.y,
        box.width,
        box.height,
        Math.min(8, box.height / 2),
        'rgba(251, 245, 233, 0.96)',
        selected ? GOLD : 'rgba(23, 43, 68, 0.2)',
        selected ? 1.8 : 1
      );
      roundedRect(
        ctx,
        box.x + 3,
        box.y + 4,
        2.4,
        box.height - 8,
        1.2,
        territory.owner === 'neutral' ? 'rgba(139, 127, 107, 0.8)' : style.fill
      );

      const numberText = String(Math.round(territory.troops));
      const capText = '/' + Math.round(territory.capacity);
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      if (label.mode === 'compact') {
        // Narrow two-line chip: current on top, capacity directly beneath.
        const textHeight = label.numberFont * 1.02 + label.capFont * 1.18;
        let y = box.y + Math.max(1, (box.height - textHeight) / 2) + label.numberFont * 0.52;
        ctx.textAlign = 'center';
        ctx.font = font('800', label.numberFont);
        ctx.fillStyle = NAVY;
        ctx.fillText(numberText, centerX, y);
        y += label.numberFont * 0.5 + label.capFont * 0.62;
        ctx.font = font('700', label.capFont);
        ctx.fillStyle = 'rgba(23, 43, 68, 0.62)';
        ctx.fillText(capText, centerX, y);
        continue;
      }

      if (label.mode === 'row') {
        ctx.font = font('800', label.numberFont);
        const numberWidth = ctx.measureText(numberText).width;
        ctx.font = font('700', label.capFont);
        const capWidth = ctx.measureText(capText).width;
        const name = label.showName ? label.name : '';
        ctx.font = font('700', label.nameFont);
        const nameWidth = name ? ctx.measureText(name).width + 4 : 0;
        const total = numberWidth + 1 + capWidth + nameWidth;
        const start = centerX - total / 2;
        ctx.textAlign = 'left';
        ctx.font = font('800', label.numberFont);
        ctx.fillStyle = NAVY;
        ctx.fillText(numberText, start, centerY + 0.5);
        ctx.font = font('700', label.capFont);
        ctx.fillStyle = 'rgba(23, 43, 68, 0.62)';
        ctx.fillText(capText, start + numberWidth + 1, centerY + 1);
        if (name) {
          ctx.font = font('700', label.nameFont);
          ctx.fillStyle = 'rgba(23, 43, 68, 0.68)';
          ctx.fillText(name, start + numberWidth + 1 + capWidth + 4, centerY + 0.5);
        }
        continue;
      }

      // Stacked: current on top, capacity directly beneath, optional name last.
      const showName = label.showName && label.name.length > 0;
      const textHeight =
        label.numberFont * 1.02 +
        label.capFont * 1.24 +
        (showName ? label.nameFont * 1.18 + 2 : 0);
      let y = box.y + Math.max(2, (box.height - textHeight) / 2) + label.numberFont * 0.52;
      ctx.textAlign = 'center';
      ctx.font = font('800', label.numberFont);
      ctx.fillStyle = NAVY;
      ctx.fillText(numberText, centerX, y);
      y += label.numberFont * 0.5 + label.capFont * 0.62;
      ctx.font = font('700', label.capFont);
      ctx.fillStyle = 'rgba(23, 43, 68, 0.62)';
      ctx.fillText(capText, centerX, y);
      if (showName) {
        y += label.capFont * 0.58 + label.nameFont * 0.62;
        ctx.font = font('700', label.nameFont);
        ctx.fillStyle = 'rgba(23, 43, 68, 0.68)';
        ctx.fillText(label.name, centerX, y);
      }
    }
    void view;
  }

  private drawFloaters(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.floaters.length === 0) return;
    const keep: Floater[] = [];
    for (let i = 0; i < this.floaters.length; i += 1) {
      const floater = this.floaters[i];
      const age = now - floater.startedAt;
      if (age > 1500 || age < 0) continue;
      const cached = this.cache[floater.territoryId];
      if (!cached) continue;
      keep.push(floater);
      const progress = age / 1500;
      const alpha = progress < 0.15 ? progress / 0.15 : 1 - (progress - 0.15) / 0.85;
      const rise = 18 + progress * 20;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.font = font('800', 11);
      const width = ctx.measureText(floater.text).width + 16;
      const x = clamp(cached.anchorX - width / 2, 4, this.cssWidth - width - 4);
      const y = cached.anchorY - 16 - rise;
      const fill =
        floater.tone === 'good'
          ? 'rgba(31, 87, 72, 0.94)'
          : floater.tone === 'bad'
            ? 'rgba(142, 57, 43, 0.94)'
            : 'rgba(23, 43, 68, 0.9)';
      roundedRect(ctx, x, y, width, 20, 10, fill);
      ctx.fillStyle = CREAM_SOFT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(floater.text, x + width / 2, y + 10.5);
      ctx.restore();
    }
    this.floaters = keep;
  }

  /**
   * Field pass: red damage wash and previous-owner fade, clipped to territory
   * paths and drawn before borders/labels so map structure stays readable.
   */
  private drawFieldEffects(ctx: CanvasRenderingContext2D, now: number): void {
    const effects = this.effects.active(now);
    for (let i = 0; i < effects.length; i += 1) {
      const effect = effects[i];
      const age = now - effect.startedAt;
      if (age < 0) continue;
      if (effect.kind === 'disaster') this.drawDisasterField(ctx, effect, age);
      else this.drawBetrayalField(ctx, effect, age);
    }
  }

  private drawDisasterField(
    ctx: CanvasRenderingContext2D,
    effect: DisasterEffect,
    age: number
  ): void {
    const FLASH_MS = 900;
    if (age > FLASH_MS) return;
    for (let i = 0; i < effect.affected.length; i += 1) {
      const local = age - i * 12;
      if (local <= 0) continue;
      const cached = this.cache[effect.affected[i].id];
      if (!cached) continue;
      const alpha =
        local < 90
          ? local / 90
          : Math.max(0, 1 - (local - 90) / (FLASH_MS - 90));
      if (alpha <= 0) continue;
      ctx.save();
      ctx.fillStyle = INVALID;
      ctx.globalAlpha = alpha * 0.42;
      ctx.fill(cached.path);
      ctx.strokeStyle = DISASTER_EDGE;
      ctx.globalAlpha = alpha * 0.72;
      ctx.lineWidth = 1.6;
      ctx.stroke(cached.path);
      ctx.restore();
    }
  }

  private drawBetrayalField(
    ctx: CanvasRenderingContext2D,
    effect: BetrayalEffect,
    age: number
  ): void {
    // The core has already flipped the owner. Hold the old colour through the
    // lock phase, then dissolve it across the convert phase so the blue reveal
    // is staged instead of popping on the first frame.
    if (!effect.previousOwner || age >= BETRAYAL_CONVERT_END_MS) return;
    const cached = this.cache[effect.targetId];
    if (!cached) return;
    const alpha =
      age < BETRAYAL_LOCK_END_MS
        ? 1
        : 1 -
          (age - BETRAYAL_LOCK_END_MS) /
            (BETRAYAL_CONVERT_END_MS - BETRAYAL_LOCK_END_MS);
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.fillStyle = ownerStyle(effect.previousOwner, this.palette).fill;
    ctx.fill(cached.path);
    ctx.restore();
  }

  /** Overlay pass: dim, shockwave rings, damage numbers and betrayal clash. */
  private drawOverlayEffects(ctx: CanvasRenderingContext2D, now: number): void {
    const effects = this.effects.active(now);
    for (let i = 0; i < effects.length; i += 1) {
      const effect = effects[i];
      const age = now - effect.startedAt;
      if (age < 0) continue;
      if (effect.kind === 'disaster') this.drawDisasterOverlay(ctx, effect, age);
      else this.drawBetrayalOverlay(ctx, effect, age);
    }
  }

  private drawDisasterOverlay(
    ctx: CanvasRenderingContext2D,
    effect: DisasterEffect,
    age: number
  ): void {
    if (!this.viewport) return;

    // Full-screen dim, sharp in and slow out.
    const dim = age < 240 ? age / 240 : Math.max(0, 1 - (age - 240) / 420);
    if (dim > 0) {
      ctx.save();
      ctx.fillStyle = NAVY;
      ctx.globalAlpha = dim * 0.3;
      ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
      ctx.restore();
    }

    const center = mapToScreen(this.viewport, effect.x, effect.y);
    const cx = center[0];
    const cy = center[1];

    // Impact core flash.
    if (age < 260) {
      const q = 1 - age / 260;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 10 + q * 30, 0, TAU);
      ctx.fillStyle = DISASTER_CORE;
      ctx.globalAlpha = q * 0.7;
      ctx.fill();
      ctx.restore();
    }

    // Three staggered shockwave rings, expanding past the viewport.
    const maxRadius = Math.max(this.cssWidth, this.cssHeight) * 0.72;
    ctx.save();
    ctx.strokeStyle = DISASTER_RING;
    for (let ring = 0; ring < 3; ring += 1) {
      const start = 70 + ring * 140;
      const local = age - start;
      if (local < 0 || local > 900) continue;
      const q = local / 900;
      const radius = q * maxRadius;
      const alpha = (1 - q) * (ring === 0 ? 0.78 : 0.55);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, radius), 0, TAU);
      ctx.globalAlpha = alpha;
      ctx.lineWidth = (ring === 0 ? 5 : 3) * (1 - q * 0.6);
      ctx.stroke();
    }
    ctx.restore();

    // Rising "-N" for every visibly damaged cell.
    if (age < 1300) {
      ctx.save();
      ctx.font = EFFECT_LABEL_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      for (let i = 0; i < effect.affected.length; i += 1) {
        const cell = effect.affected[i];
        const local = age - 200 - i * 35;
        if (local < 0 || local > 900) continue;
        const q = local / 900;
        const alpha = q < 0.15 ? q / 0.15 : 1 - (q - 0.15) / 0.85;
        const cached = this.cache[cell.id];
        if (!cached) continue;
        const x = clamp(
          cached.anchorX + ((i % 3) - 1) * 8,
          12,
          this.cssWidth - 12
        );
        const y = cached.anchorY - 14 - (22 + q * 26);
        ctx.globalAlpha = clamp(alpha, 0, 1) * 0.95;
        ctx.strokeStyle = CREAM_SOFT;
        ctx.lineWidth = 2.8;
        ctx.strokeText(cell.label, x, y);
        ctx.globalAlpha = clamp(alpha, 0, 1);
        ctx.fillStyle = DISASTER_LABEL;
        ctx.fillText(cell.label, x, y);
      }
      ctx.restore();
    }
  }

  private drawBetrayalOverlay(
    ctx: CanvasRenderingContext2D,
    effect: BetrayalEffect,
    age: number
  ): void {
    const cached = this.cache[effect.targetId];
    if (!cached) return;
    const territory = this.byId[effect.targetId];
    const targetLabel = effect.targetName
      ? effect.targetName
      : territory
        ? territory.shortName || territory.name || territory.id
        : effect.targetId;
    const geometry: BetrayalGeometry = {
      path: cached.path,
      x: cached.x,
      y: cached.y,
      width: cached.width,
      height: cached.height,
      centerX: cached.routeX,
      centerY: cached.routeY,
      labelBox: cached.label ? cached.label.box : undefined,
    };
    drawBetrayalEffect({
      ctx: ctx,
      age: age,
      palette: this.palette,
      data: {
        targetName: effect.targetName,
        previousOwner: effect.previousOwner,
        beforeTroops: effect.beforeTroops,
        beforeShield: effect.beforeShield,
        captured: effect.captured,
        removed: effect.removed,
        survivors: effect.survivors,
        afterOwner: effect.afterOwner,
        afterTroops: effect.afterTroops,
        afterShield: effect.afterShield,
      },
      seed: effect.seed,
      targetLabel: targetLabel,
      geometry: geometry,
      viewWidth: this.cssWidth,
      viewHeight: this.cssHeight,
      reducedMotion: this.prefersReducedMotion(),
    });
  }

  private drawStatusWash(ctx: CanvasRenderingContext2D, view: MatchView): void {
    if (view.status !== 'paused' && view.status !== 'ended') return;
    ctx.fillStyle = view.status === 'ended' ? 'rgba(23, 43, 68, 0.10)' : 'rgba(23, 43, 68, 0.05)';
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
  }

  private strokeDashed(
    ctx: CanvasRenderingContext2D,
    path: Path2D,
    color: string,
    width: number,
    dash: number[],
    offset: number,
    alpha: number
  ): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.setLineDash(dash);
    ctx.lineDashOffset = offset;
    ctx.stroke(path);
    ctx.restore();
  }

  private rebuildBackground(): void {
    const width = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const height = Math.max(1, Math.round(this.cssHeight * this.dpr));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.background = null;
      return;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = WATER;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    const gradient = ctx.createLinearGradient(0, 0, this.cssWidth, this.cssHeight);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
    gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0)');
    gradient.addColorStop(1, 'rgba(58, 91, 106, 0.08)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    ctx.strokeStyle = 'rgba(72, 112, 124, 0.10)';
    ctx.lineWidth = 1;
    for (let row = 0; row < 8; row += 1) {
      const y = this.cssHeight * (0.08 + row * 0.12);
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= this.cssWidth; x += 18) {
        ctx.lineTo(x, y + Math.sin((x + row * 23) / 38) * 3.2);
      }
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(23, 43, 68, 0.055)';
    for (let ring = 1; ring <= 3; ring += 1) {
      ctx.beginPath();
      ctx.arc(this.cssWidth * 0.9, this.cssHeight * 0.07, 40 * ring, 0, Math.PI * 2);
      ctx.stroke();
    }

    this.background = canvas;
    this.backgroundKey = this.cssWidth + 'x' + this.cssHeight + '@' + this.dpr;
  }
}

function boxContains(box: LabelBox, x: number, y: number, padding: number): boolean {
  return (
    x >= box.x - padding &&
    x <= box.x + box.width + padding &&
    y >= box.y - padding &&
    y <= box.y + box.height + padding
  );
}

function polylineScreenLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}
