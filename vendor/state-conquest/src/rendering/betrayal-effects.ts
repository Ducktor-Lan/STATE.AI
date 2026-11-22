/**
 * Betrayal ("策反") canvas choreography.
 *
 * The core resolves the cast immediately and the map already shows the new
 * owner. This module only presents a deterministic four-phase story over the
 * real receipt:
 *
 *     0 -  450 ms  lock      gold target outline + "策反 · 州简称" command chip
 *   450 - 1250 ms  convert   defectors leave the red garrison and turn blue
 *  1250 - 2000 ms  clash     the two squads meet in a short internal fight
 *  2000 - 3000 ms  result    flag/waves on capture, cracks on failure
 *
 * Every number comes from the receipt or the before/after territory snapshots.
 * `removed` is the converted detachment and `survivors` its surviving
 * attackers; `survivors` is never shown as a garrison. When an optional field
 * is absent the copy drops that number instead of inferring it.
 *
 * The phase/copy/layout helpers below are DOM-free so unit tests can exercise
 * the contract without a canvas. The drawing helpers only use the context and
 * deterministic index noise: no Math.random, no timers and no simulation RNG.
 */
import type { OwnerId } from '../ui/view-model';
import { ownerStyle } from './owner-palette';
import type { OwnerPalette, OwnerStyle } from './owner-palette';

export const BETRAYAL_LOCK_END_MS = 450;
export const BETRAYAL_CONVERT_END_MS = 1250;
export const BETRAYAL_CLASH_END_MS = 2000;
export const BETRAYAL_EFFECT_MS = 3000;

export type BetrayalPhase = 'lock' | 'convert' | 'clash' | 'result' | 'done';

/** Real receipt / snapshot data the choreography may display. */
export interface BetrayalVisualData {
  targetName?: string;
  previousOwner: OwnerId | null;
  beforeTroops?: number;
  beforeShield?: number;
  captured: boolean;
  /** Converted soldiers (receipt.removed). */
  removed: number;
  /** Surviving converted attackers (receipt.survivors), never a garrison. */
  survivors: number;
  afterOwner?: OwnerId | null;
  afterTroops?: number;
  afterShield?: number;
}

export function betrayalPhaseAt(age: number): BetrayalPhase {
  if (!isFinite(age) || age <= 0) return 'lock';
  if (age < BETRAYAL_LOCK_END_MS) return 'lock';
  if (age < BETRAYAL_CONVERT_END_MS) return 'convert';
  if (age < BETRAYAL_CLASH_END_MS) return 'clash';
  if (age < BETRAYAL_EFFECT_MS) return 'result';
  return 'done';
}

/** Local 0..1 progress inside the current phase (done reports 1). */
export function betrayalPhaseProgress(age: number): number {
  if (!isFinite(age) || age <= 0) return 0;
  if (age < BETRAYAL_LOCK_END_MS) return age / BETRAYAL_LOCK_END_MS;
  if (age < BETRAYAL_CONVERT_END_MS) {
    return (age - BETRAYAL_LOCK_END_MS) / (BETRAYAL_CONVERT_END_MS - BETRAYAL_LOCK_END_MS);
  }
  if (age < BETRAYAL_CLASH_END_MS) {
    return (age - BETRAYAL_CONVERT_END_MS) / (BETRAYAL_CLASH_END_MS - BETRAYAL_CONVERT_END_MS);
  }
  if (age < BETRAYAL_EFFECT_MS) {
    return (age - BETRAYAL_CLASH_END_MS) / (BETRAYAL_EFFECT_MS - BETRAYAL_CLASH_END_MS);
  }
  return 1;
}

export interface BetrayalNumbers {
  converted: number;
  /** Pre-battle garrison left after the defection (before - removed). */
  defendersBeforeBattle: number | null;
  /** Real post-battle garrison from the after snapshot. */
  garrisonAfter: number | null;
  shieldBefore: number | null;
  shieldAfter: number | null;
}

function finiteCount(value: number | undefined): number | null {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export function betrayalNumbers(data: BetrayalVisualData): BetrayalNumbers {
  const converted = finiteCount(data.removed) || 0;
  const before = finiteCount(data.beforeTroops);
  const defendersBeforeBattle =
    before !== null && before >= converted ? before - converted : null;
  const shieldBefore = finiteCount(data.beforeShield);
  const shieldAfter = finiteCount(data.afterShield);
  return {
    converted: converted,
    defendersBeforeBattle: defendersBeforeBattle,
    garrisonAfter: finiteCount(data.afterTroops),
    shieldBefore: shieldBefore !== null && shieldBefore > 0 ? shieldBefore : null,
    shieldAfter: shieldAfter !== null && shieldAfter > 0 ? shieldAfter : null,
  };
}

export type BetrayalTone = 'command' | 'success' | 'failure';

export interface BetrayalCopy {
  title: string;
  /** Separate shield note, so a shield is never folded into troop counts. */
  shieldNote: string | null;
  tone: BetrayalTone;
}

/**
 * Player-facing copy. `targetLabel` is the renderer's short state label
 * (`shortName`) and only used when no targetName was supplied.
 */
export function betrayalCopyAt(
  phase: BetrayalPhase,
  data: BetrayalVisualData,
  targetLabel?: string
): BetrayalCopy {
  const numbers = betrayalNumbers(data);
  // The renderer's view shortName wins, so a caller passing a full state name
  // never widens the lock chip unnecessarily.
  const label =
    targetLabel && targetLabel.length > 0
      ? targetLabel
      : data.targetName && data.targetName.length > 0
        ? data.targetName
        : '目标州';

  if (phase === 'lock') {
    return { title: '策反 · ' + label, shieldNote: null, tone: 'command' };
  }
  if (phase === 'convert' || phase === 'clash') {
    let title = '策反 ' + numbers.converted;
    if (numbers.defendersBeforeBattle !== null) {
      title += ' / 剩余守军 ' + numbers.defendersBeforeBattle;
    }
    return {
      title: title,
      shieldNote:
        numbers.shieldBefore !== null ? '独立护盾 ' + numbers.shieldBefore : null,
      tone: 'command',
    };
  }
  if (phase === 'result') {
    if (data.captured) {
      let title = '策反成功';
      if (numbers.garrisonAfter !== null) title += ' · 驻军 ' + numbers.garrisonAfter;
      return {
        title: title,
        shieldNote: numbers.shieldAfter !== null ? '护盾 ' + numbers.shieldAfter : null,
        tone: 'success',
      };
    }
    let title = '策反受挫';
    if (numbers.garrisonAfter !== null) title += ' · 守军余 ' + numbers.garrisonAfter;
    return {
      title: title,
      shieldNote:
        numbers.shieldAfter !== null ? '剩余护盾 ' + numbers.shieldAfter : null,
      tone: 'failure',
    };
  }
  return { title: '', shieldNote: null, tone: 'command' };
}

export interface BetrayalTokenCounts {
  defectors: number;
  loyalists: number;
}

/**
 * Bounded token counts. Labels always carry the true receipt numbers; the
 * tokens themselves are capped so a tiny state stays legible and a large
 * garrison cannot flood the cell.
 */
export function betrayalTokenCounts(
  data: BetrayalVisualData,
  minDimension: number
): BetrayalTokenCounts {
  const minDim = isFinite(minDimension) && minDimension > 0 ? minDimension : 0;
  let maxDefectors = 10;
  let maxLoyalists = 6;
  if (minDim < 22) {
    maxDefectors = 4;
    maxLoyalists = 2;
  } else if (minDim < 40) {
    maxDefectors = 6;
    maxLoyalists = 3;
  }
  const numbers = betrayalNumbers(data);
  return {
    defectors:
      numbers.converted > 0
        ? Math.min(maxDefectors, Math.max(1, numbers.converted))
        : 0,
    loyalists:
      numbers.defendersBeforeBattle === null
        ? 0
        : Math.min(maxLoyalists, numbers.defendersBeforeBattle),
  };
}

export interface BetrayalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BetrayalBadgeBox extends BetrayalRect {}

function clampValue(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Places the command/result chip above the target when possible, below it at
 * the top edge, and clamps horizontally so a small border state can never push
 * the chip off-screen.
 */
export function placeBetrayalBadge(
  bounds: BetrayalRect,
  viewWidth: number,
  viewHeight: number,
  desiredWidth: number,
  height: number
): BetrayalBadgeBox {
  const safeViewWidth = Math.max(1, viewWidth);
  const safeViewHeight = Math.max(1, viewHeight);
  const width = Math.min(
    Math.max(1, desiredWidth),
    Math.max(24, safeViewWidth - 12)
  );
  const maxX = Math.max(6, safeViewWidth - width - 6);
  const x = clampValue(bounds.x + bounds.width / 2 - width / 2, 6, maxX);
  const aboveY = bounds.y - height - 8;
  const belowY = bounds.y + bounds.height + 8;
  const maxY = Math.max(6, safeViewHeight - height - 6);
  let y: number;
  if (aboveY >= 6) y = aboveY;
  else if (belowY + height <= safeViewHeight - 6) y = belowY;
  else y = clampValue(bounds.y + 6, 6, maxY);
  return {
    x: x,
    y: clampValue(y, 6, maxY),
    width: width,
    height: height,
  };
}

export interface BetrayalSquadLayout {
  axis: 'horizontal' | 'vertical';
  redX: number;
  redY: number;
  blueX: number;
  blueY: number;
  radius: number;
  step: number;
}

/**
 * Two squad anchors around the target's route point. Narrow states stack the
 * squads vertically so the red/blue split remains readable.
 */
export function betrayalSquadLayout(
  bounds: BetrayalRect,
  centerX: number,
  centerY: number
): BetrayalSquadLayout {
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const minDim = Math.min(width, height);
  const radius = clampValue(minDim * 0.028, 1.2, 3.2);
  const step = radius * 2.7;
  const gap = clampValue(minDim * 0.22, 6, 26);
  const minX = bounds.x + radius + 2;
  const maxX = bounds.x + width - radius - 2;
  const minY = bounds.y + radius + 2;
  const maxY = bounds.y + height - radius - 2;
  const safeX =
    maxX >= minX
      ? clampValue(centerX, minX, maxX)
      : bounds.x + width / 2;
  const safeY =
    maxY >= minY
      ? clampValue(centerY, minY, maxY)
      : bounds.y + height / 2;
  const axis: BetrayalSquadLayout['axis'] = width >= height ? 'horizontal' : 'vertical';

  if (axis === 'horizontal') {
    const redX = maxX >= minX ? clampValue(safeX - gap, minX, maxX) : safeX;
    const blueX = maxX >= minX ? clampValue(safeX + gap, minX, maxX) : safeX;
    return {
      axis: axis,
      redX: redX,
      redY: safeY,
      blueX: blueX,
      blueY: safeY,
      radius: radius,
      step: step,
    };
  }
  const redY = maxY >= minY ? clampValue(safeY - gap, minY, maxY) : safeY;
  const blueY = maxY >= minY ? clampValue(safeY + gap, minY, maxY) : safeY;
  return {
    axis: axis,
    redX: safeX,
    redY: redY,
    blueX: safeX,
    blueY: blueY,
    radius: radius,
    step: step,
  };
}

export interface BetrayalGeometry extends BetrayalRect {
  path: Path2D;
  /** Route point (core labelAnchor || center), matching armies and cannons. */
  centerX: number;
  centerY: number;
  /** Fitted state chip, when the renderer has one, so the badge clears it. */
  labelBox?: BetrayalRect;
}

export interface BetrayalDrawScene {
  ctx: CanvasRenderingContext2D;
  age: number;
  /** Palette owned by the renderer/match; omitted callers use legacy blue. */
  palette?: OwnerPalette;
  data: BetrayalVisualData;
  seed: number;
  targetLabel: string;
  geometry: BetrayalGeometry;
  viewWidth: number;
  viewHeight: number;
  reducedMotion: boolean;
}

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

const NAVY = '#172B44';
const PAPER = 'rgba(251, 245, 233, 0.97)';
const CREAM = '#FFF8EA';
const GOLD = '#EDB64E';
const TAU = Math.PI * 2;

function previousOwnerStyle(scene: BetrayalDrawScene): OwnerStyle {
  return ownerStyle(scene.data.previousOwner, scene.palette);
}

function playerOwnerStyle(scene: BetrayalDrawScene): OwnerStyle {
  return ownerStyle('player', scene.palette);
}

function resultOwnerStyle(scene: BetrayalDrawScene): OwnerStyle {
  return ownerStyle(scene.data.afterOwner || 'player', scene.palette);
}

function font(weight: string, size: number): string {
  return weight + ' ' + Math.round(size * 10) / 10 + 'px ' + FONT_STACK;
}

/** Index-derived noise: stable for one seed and independent of frame count. */
function effectNoise(seed: number, index: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function easeOut(value: number): number {
  const inverse = 1 - value;
  return 1 - inverse * inverse * inverse;
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function slotOffset(
  index: number,
  count: number,
  step: number
): [number, number] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  return [(column - (columns - 1) / 2) * step, (row - (rows - 1) / 2) * step];
}

function unionRect(first: BetrayalRect, second: BetrayalRect): BetrayalRect {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  return {
    x: x,
    y: y,
    width: Math.max(first.x + first.width, second.x + second.width) - x,
    height: Math.max(first.y + first.height, second.y + second.height) - y,
  };
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

function dimAlpha(age: number): number {
  if (age < 300) return 0.18 * (age / 300);
  if (age < 1100) return 0.18;
  if (age < 1650) return 0.18 * (1 - (age - 1100) / 550);
  return 0;
}

/**
 * Four rectangles around the target bounding box: the surroundings dim, the
 * target itself stays fully readable, and no per-frame path is allocated.
 */
function drawDim(scene: BetrayalDrawScene): void {
  const alpha = dimAlpha(scene.age);
  if (alpha <= 0) return;
  const ctx = scene.ctx;
  const geometry = scene.geometry;
  const width = scene.viewWidth;
  const height = scene.viewHeight;
  const top = Math.max(0, geometry.y);
  const bottom = Math.max(0, geometry.y + geometry.height);
  const midTop = Math.min(top, height);
  const midBottom = Math.min(bottom, height);
  const midHeight = Math.max(0, midBottom - midTop);
  const left = Math.max(0, geometry.x);
  const right = Math.max(0, geometry.x + geometry.width);
  ctx.save();
  ctx.fillStyle = NAVY;
  ctx.globalAlpha = alpha;
  ctx.fillRect(0, 0, width, top);
  ctx.fillRect(0, bottom, width, Math.max(0, height - bottom));
  ctx.fillRect(0, midTop, left, midHeight);
  ctx.fillRect(right, midTop, Math.max(0, width - right), midHeight);
  ctx.restore();
}

/** Two gold pulses on the target border during the lock phase. */
function drawLockOutline(scene: BetrayalDrawScene): void {
  const ctx = scene.ctx;
  const pulse = scene.reducedMotion
    ? 0.55
    : Math.abs(Math.sin((scene.age / BETRAYAL_LOCK_END_MS) * Math.PI * 2));
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.78;
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 6;
  ctx.stroke(scene.geometry.path);
  ctx.globalAlpha = 0.6 + pulse * 0.4;
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 2.2 + pulse * 1.4;
  ctx.stroke(scene.geometry.path);
  ctx.restore();
}

function drawToken(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  alpha: number
): void {
  if (alpha <= 0.02) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = 'rgba(251, 245, 233, 0.92)';
  ctx.stroke();
  ctx.restore();
}

/** Red token that fades through blue as it defects. */
function drawTransitionToken(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  progress: number,
  previousColor: string,
  playerColor: string
): void {
  if (progress < 0.98) {
    drawToken(ctx, x, y, radius, previousColor, (1 - progress) * 0.95);
  }
  if (progress > 0.02) {
    drawToken(ctx, x, y, radius, playerColor, progress * 0.95);
  }
  if (progress > 0.2 && progress < 0.8) {
    const ring = Math.sin(((progress - 0.2) / 0.6) * Math.PI);
    ctx.save();
    ctx.globalAlpha = ring * 0.55;
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(x, y, radius + 1.6 + ring * 2, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
}

function drawClashSparks(
  scene: BetrayalDrawScene,
  local: number,
  centerX: number,
  centerY: number,
  minDim: number
): void {
  const fade = clampValue((local - 0.12) / 0.58, 0, 1);
  const alpha = Math.sin(fade * Math.PI);
  if (alpha <= 0.03) return;
  const ctx = scene.ctx;
  const seed = scene.seed;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < 4; i += 1) {
    const angle = effectNoise(seed, i + 61) * TAU + local * 2.2;
    const half = minDim * (0.035 + effectNoise(seed, i + 71) * 0.035);
    const dx = Math.cos(angle) * half;
    const dy = Math.sin(angle) * half;
    ctx.strokeStyle = i % 2 === 0 ? GOLD : CREAM;
    ctx.globalAlpha = alpha * (i % 2 === 0 ? 0.82 : 0.6);
    ctx.lineWidth = i % 2 === 0 ? 1.25 : 0.9;
    ctx.beginPath();
    ctx.moveTo(centerX - dx, centerY - dy);
    ctx.lineTo(centerX + dx, centerY + dy);
    ctx.stroke();
  }
  ctx.globalAlpha = alpha * 0.85;
  ctx.fillStyle = CREAM;
  ctx.beginPath();
  ctx.arc(centerX, centerY, 1.4 + minDim * 0.025 * (1 - alpha), 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawTokenStory(
  scene: BetrayalDrawScene,
  phase: BetrayalPhase,
  local: number
): void {
  const ctx = scene.ctx;
  const geometry = scene.geometry;
  const minDim = Math.max(1, Math.min(geometry.width, geometry.height));
  const counts = betrayalTokenCounts(scene.data, minDim);
  const total = counts.defectors + counts.loyalists;
  if (total <= 0) return;
  const previousColor = previousOwnerStyle(scene).fill;
  const playerColor = playerOwnerStyle(scene).fill;

  const layout = betrayalSquadLayout(geometry, geometry.centerX, geometry.centerY);
  const minX = geometry.x + layout.radius + 1;
  const maxX = Math.max(minX, geometry.x + geometry.width - layout.radius - 1);
  const minY = geometry.y + layout.radius + 1;
  const maxY = Math.max(minY, geometry.y + geometry.height - layout.radius - 1);
  const centerX = clampValue(geometry.centerX, minX, maxX);
  const centerY = clampValue(geometry.centerY, minY, maxY);
  const placeX = function (value: number): number {
    return clampValue(value, minX, maxX);
  };
  const placeY = function (value: number): number {
    return clampValue(value, minY, maxY);
  };

  if (phase === 'lock') {
    const alpha = scene.reducedMotion ? 0.95 : clampValue(local / 0.18, 0, 1);
    for (let i = 0; i < total; i += 1) {
      const offset = slotOffset(i, total, layout.step);
      drawToken(
        ctx,
        placeX(centerX + offset[0]),
        placeY(centerY + offset[1]),
        layout.radius,
        previousColor,
        alpha * 0.95
      );
    }
    return;
  }

  if (phase === 'convert') {
    // Loyalists split off to the red anchor; defectors peel away to blue.
    for (let j = 0; j < counts.loyalists; j += 1) {
      const from = slotOffset(counts.defectors + j, total, layout.step);
      const to = slotOffset(j, counts.loyalists, layout.step);
      const progress = scene.reducedMotion
        ? 1
        : easeOut(clampValue(local * 1.7, 0, 1));
      const x = scene.reducedMotion
        ? layout.redX + to[0]
        : lerp(centerX + from[0], layout.redX + to[0], progress);
      const y = scene.reducedMotion
        ? layout.redY + to[1]
        : lerp(centerY + from[1], layout.redY + to[1], progress);
      drawToken(ctx, placeX(x), placeY(y), layout.radius, previousColor, 0.95);
    }
    for (let i = 0; i < counts.defectors; i += 1) {
      const from = slotOffset(i, total, layout.step);
      const to = slotOffset(i, counts.defectors, layout.step);
      const progress = scene.reducedMotion
        ? local
        : easeOut(clampValue(local * 1.7 - i * 0.045, 0, 1));
      const x = scene.reducedMotion
        ? layout.blueX + to[0]
        : lerp(centerX + from[0], layout.blueX + to[0], progress);
      const y = scene.reducedMotion
        ? layout.blueY + to[1]
        : lerp(centerY + from[1], layout.blueY + to[1], progress);
      drawTransitionToken(
        ctx,
        placeX(x),
        placeY(y),
        layout.radius,
        progress,
        previousColor,
        playerColor
      );
    }
    return;
  }

  if (phase === 'clash') {
    const lunge = scene.reducedMotion
      ? 0
      : Math.sin(clampValue(local / 0.8, 0, 1) * Math.PI);
    for (let j = 0; j < counts.loyalists; j += 1) {
      const offset = slotOffset(j, counts.loyalists, layout.step);
      const shake = scene.reducedMotion
        ? 0
        : Math.sin(local * 24 + j * 2.3) * layout.radius * 0.8 * lunge;
      drawToken(
        ctx,
        placeX(layout.redX + offset[0] + shake),
        placeY(layout.redY + offset[1] - shake * 0.4),
        layout.radius,
        previousColor,
        0.95
      );
    }
    for (let i = 0; i < counts.defectors; i += 1) {
      const from = slotOffset(i, counts.defectors, layout.step);
      const to = slotOffset(i, counts.defectors, layout.step);
      const amount = lunge * 0.5;
      const x = lerp(layout.blueX + from[0], layout.redX + to[0], amount);
      const y = lerp(layout.blueY + from[1], layout.redY + to[1], amount);
      drawToken(ctx, placeX(x), placeY(y), layout.radius, playerColor, 0.95);
    }
    if (!scene.reducedMotion) {
      drawClashSparks(
        scene,
        local,
        (layout.blueX + layout.redX) / 2,
        (layout.blueY + layout.redY) / 2,
        minDim
      );
    }
    return;
  }

  if (phase === 'result') {
    // Tokens hand over to flag/cracks; fade them quickly but keep continuity.
    const fade = 1 - clampValue((scene.age - BETRAYAL_CLASH_END_MS) / 360, 0, 1);
    if (fade <= 0.02) return;
    for (let j = 0; j < counts.loyalists; j += 1) {
      const offset = slotOffset(j, counts.loyalists, layout.step);
      drawToken(
        ctx,
        placeX(layout.redX + offset[0]),
        placeY(layout.redY + offset[1]),
        layout.radius,
        previousColor,
        fade * 0.8
      );
    }
    for (let i = 0; i < counts.defectors; i += 1) {
      const offset = slotOffset(i, counts.defectors, layout.step);
      drawToken(
        ctx,
        placeX(layout.blueX + offset[0]),
        placeY(layout.blueY + offset[1]),
        layout.radius,
        playerColor,
        fade * 0.85
      );
    }
  }
}

/** Blue capture wave + planted flag for a captured target. */
function drawCaptureResult(scene: BetrayalDrawScene): void {
  const ctx = scene.ctx;
  const geometry = scene.geometry;
  const playerColor = resultOwnerStyle(scene).fill;
  const minDim = Math.max(1, Math.min(geometry.width, geometry.height));
  const minX = geometry.x + 3;
  const maxX = Math.max(minX, geometry.x + geometry.width - 3);
  const minY = geometry.y + 3;
  const maxY = Math.max(minY, geometry.y + geometry.height - 3);
  const centerX = clampValue(geometry.centerX, minX, maxX);
  const centerY = clampValue(geometry.centerY, minY, maxY);
  const age = scene.age;

  ctx.save();
  for (let ring = 0; ring < 2; ring += 1) {
    const local = scene.reducedMotion
      ? ring === 0
        ? 0.5
        : 0.25
      : clampValue(
          (age - BETRAYAL_CLASH_END_MS - ring * 120) / 620,
          0,
          1
        );
    if (local <= 0) continue;
    const radius = minDim * (0.1 + local * 0.55);
    const alpha = (1 - local) * 0.75;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = playerColor;
    ctx.lineWidth = 1 + 2.4 * (1 - local * 0.5);
    ctx.beginPath();
    ctx.arc(centerX, centerY, Math.max(1, radius), 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.8;
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, Math.max(1, radius * 0.86), 0, TAU);
    ctx.stroke();
  }

  const raise = scene.reducedMotion
    ? 1
    : easeOut(clampValue((age - BETRAYAL_CLASH_END_MS) / 340, 0, 1));
  const flagHeight = clampValue(
    Math.min(geometry.width * 0.34, minDim * 0.46),
    9,
    30
  );
  const baseY = clampValue(
    centerY + flagHeight * 0.3,
    minY + flagHeight * 0.65,
    Math.max(minY + flagHeight * 0.65, geometry.y + geometry.height - 2)
  );
  const topY = baseY - flagHeight * raise;
  const pennantWidth = flagHeight * 0.58;
  const pennantHeight = flagHeight * 0.34;

  ctx.globalAlpha = 0.95;
  ctx.lineCap = 'round';
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(centerX, baseY);
  ctx.lineTo(centerX, topY);
  ctx.stroke();
  ctx.strokeStyle = NAVY;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(centerX, topY);
  ctx.lineTo(centerX + pennantWidth, topY + pennantHeight * 0.5);
  ctx.lineTo(centerX, topY + pennantHeight);
  ctx.closePath();
  ctx.fillStyle = playerColor;
  ctx.fill();
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 0.9;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(centerX, topY, 1.7, 0, TAU);
  ctx.fillStyle = GOLD;
  ctx.fill();
  ctx.restore();
}

/** Dull red cracks + core for a failed cast; the target stays enemy-coloured. */
function drawFailureResult(scene: BetrayalDrawScene): void {
  const ctx = scene.ctx;
  const geometry = scene.geometry;
  const previous = previousOwnerStyle(scene);
  const minDim = Math.max(1, Math.min(geometry.width, geometry.height));
  const minX = geometry.x + 3;
  const maxX = Math.max(minX, geometry.x + geometry.width - 3);
  const minY = geometry.y + 3;
  const maxY = Math.max(minY, geometry.y + geometry.height - 3);
  const centerX = clampValue(geometry.centerX, minX, maxX);
  const centerY = clampValue(geometry.centerY, minY, maxY);
  const local = scene.reducedMotion
    ? 1
    : clampValue((scene.age - BETRAYAL_CLASH_END_MS) / 620, 0, 1);

  ctx.save();
  ctx.globalAlpha = 0.18 * (1 - local * 0.5);
  ctx.fillStyle = previous.fill;
  ctx.beginPath();
  ctx.arc(
    centerX,
    centerY,
    Math.max(1, minDim * (0.08 + 0.06 * local)),
    0,
    TAU
  );
  ctx.fill();

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 5; i += 1) {
    const angle = effectNoise(scene.seed, i + 91) * TAU;
    const inner = minDim * 0.04;
    const outer = inner + minDim * (0.1 + 0.3 * local);
    const middle = (inner + outer) * 0.55;
    const bend =
      (effectNoise(scene.seed, i + 101) - 0.5) * minDim * 0.09;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const middleX = centerX + dx * middle - dy * bend;
    const middleY = centerY + dy * middle + dx * bend;
    ctx.globalAlpha = 0.85 * (1 - local * 0.2);
    ctx.strokeStyle = previous.edge;
    ctx.lineWidth = 1.3 + local * 0.5;
    ctx.beginPath();
    ctx.moveTo(centerX + dx * inner, centerY + dy * inner);
    ctx.lineTo(middleX, middleY);
    ctx.lineTo(centerX + dx * outer, centerY + dy * outer);
    ctx.stroke();
  }
  ctx.restore();
}

function chipAlpha(age: number, phase: BetrayalPhase): number {
  if (phase === 'lock') {
    if (age < 100) return age / 100;
    if (age < 400) return 1;
    return clampValue((BETRAYAL_LOCK_END_MS - age) / 50, 0, 1);
  }
  if (phase === 'convert') {
    return clampValue((age - BETRAYAL_LOCK_END_MS) / 70, 0, 1);
  }
  if (phase === 'clash') {
    if (age < 1920) return 1;
    return clampValue((BETRAYAL_CLASH_END_MS - age) / 80, 0, 1);
  }
  if (phase === 'result') {
    return clampValue((age - BETRAYAL_CLASH_END_MS) / 120, 0, 1);
  }
  return 0;
}

function drawChip(
  scene: BetrayalDrawScene,
  copy: BetrayalCopy,
  alpha: number
): void {
  const ctx = scene.ctx;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = font('800', 11);
  const mainWidth = ctx.measureText(copy.title).width;
  let subWidth = 0;
  if (copy.shieldNote) {
    ctx.font = font('700', 9);
    subWidth = ctx.measureText(copy.shieldNote).width;
  }
  const height = copy.shieldNote ? 38 : 25;
  const placement = scene.geometry.labelBox
    ? unionRect(scene.geometry, scene.geometry.labelBox)
    : scene.geometry;
  const box = placeBetrayalBadge(
    placement,
    scene.viewWidth,
    scene.viewHeight,
    Math.max(mainWidth, subWidth) + 24,
    height
  );
  const playerStyle = resultOwnerStyle(scene);
  const previousStyle = previousOwnerStyle(scene);
  const stripe =
    copy.tone === 'success' ? playerStyle.fill : copy.tone === 'failure' ? previousStyle.fill : GOLD;
  const border =
    copy.tone === 'success'
      ? playerStyle.edge
      : copy.tone === 'failure'
        ? previousStyle.edge
        : 'rgba(23, 43, 68, 0.22)';
  roundedRect(ctx, box.x, box.y, box.width, box.height, 10, PAPER, border, 1.2);
  roundedRect(ctx, box.x, box.y, 4, box.height, 2, stripe);
  ctx.fillStyle = NAVY;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = font('800', 11);
  ctx.fillText(
    copy.title,
    box.x + 13,
    box.y + (copy.shieldNote ? 14 : box.height / 2 + 0.5)
  );
  if (copy.shieldNote) {
    ctx.fillStyle = '#8A6A22';
    ctx.font = font('700', 9);
    ctx.fillText(copy.shieldNote, box.x + 13, box.y + 28);
  }
  ctx.restore();
}

/**
 * Single entry point used by the renderer. The caller owns the effect clock,
 * target geometry and the cached reduced-motion preference.
 */
export function drawBetrayalEffect(scene: BetrayalDrawScene): void {
  const age = scene.age;
  if (!isFinite(age) || age < 0) return;
  const phase = betrayalPhaseAt(age);
  if (phase === 'done') return;
  const local = betrayalPhaseProgress(age);

  drawDim(scene);
  if (phase === 'lock') drawLockOutline(scene);

  scene.ctx.save();
  scene.ctx.clip(scene.geometry.path);
  drawTokenStory(scene, phase, local);
  if (phase === 'result') {
    if (scene.data.captured) drawCaptureResult(scene);
    else drawFailureResult(scene);
  }
  scene.ctx.restore();

  const copy = betrayalCopyAt(phase, scene.data, scene.targetLabel);
  const alpha = chipAlpha(age, phase);
  if (copy.title.length > 0 && alpha > 0) drawChip(scene, copy, alpha);
}
