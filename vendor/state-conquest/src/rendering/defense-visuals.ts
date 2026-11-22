/**
 * v1.2.0 defense presentation: 受击 / 护盾吸收 / 失守.
 *
 * Every number and every state change shown here comes from a real core
 * receipt or a before/after snapshot. This module never invents a hit, a
 * shield amount or a capture:
 *
 *   - `normalizeDefenseReceipt` accepts the real core event
 *       { type:'defend', targetId, owner, amount, shieldLoss, troopLoss,
 *         siege, targetArmyId, tick }
 *     and the existing `capture` event (失守/占领), and rejects anything else
 *     by returning null. The caller can therefore forward raw drained events
 *     without a type guard in app-shell.
 *   - Optional fields stay null; copy drops a number instead of printing 0.
 *   - The effect queue is bounded and prunes by age only (no timers, no
 *     callbacks), so a burst of receipts can never accumulate frames.
 *   - Capture collapse (`DEFENSE_COLLAPSE_MS`) is driven ONLY by a real
 *     `capture` event that carries the core's exact pre-state
 *     `previousDefenseLevel` (1 wall / 2 turret). A missing or 0 level means
 *     the territory had no fort, so nothing collapses. The event's
 *     `previousOwner` colours the vanishing pennant; neither value is ever
 *     guessed from the current map state or a shield of 0.
 *
 * Geometry/copy helpers are DOM-free and unit-testable; only
 * `drawDefenseEffect`, `drawDefenseCollapse` and `drawShieldBadge` touch a
 * 2D context.
 */
import type { OwnerId } from '../ui/view-model';
import { pointInPolygon } from './geometry';
import type { Point } from './geometry';
import { ownerAccent } from './owner-palette';
import type { OwnerAccent, OwnerPalette } from './owner-palette';

export const DEFENSE_EFFECT_MS = 1400;
/** Impact frames are the strongest; the ring is gone by this age. */
export const DEFENSE_IMPACT_END_MS = 420;
export const DEFENSE_MAX_EFFECTS = 6;

/** One real cannon receipt lives through aim, recoil, flight and impact. */
export const CANNON_EFFECT_MS = 680;
/** At most this many cannon receipts are kept (the core fires at most a few). */
export const CANNON_MAX_EFFECTS = 10;

/** What really happened to the defending territory. */
export type DefenseOutcome = 'hold' | 'shield' | 'repel' | 'fall';

export interface DefenseReceipt {
  kind: 'defend' | 'fall';
  territoryId: string;
  /** Defender owner for 'defend'; new owner for 'capture'/'fall'. */
  owner: OwnerId | null;
  attackerOwner?: OwnerId | null;
  /** Attacking army id when the event exposes it (never a target id). */
  targetArmyId?: number | null;
  /** Origin territory of the attacking army, when the core exposes it. */
  attackerSourceId?: string | null;
  tick?: number | null;
  /** Total damage/hit value from the event, when supplied. */
  amount?: number | null;
  shieldLoss?: number | null;
  troopLoss?: number | null;
  /** Real core flag: the siege rule removed the last-stand floor. */
  siege?: boolean;
  /** True only for a real capture event. */
  captured?: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

function asOwner(value: unknown): OwnerId | null {
  if (value === 'player' || value === 'ai1' || value === 'ai2' || value === 'neutral') {
    return value;
  }
  // v1.4 four-way purple faction; a purple receipt must never degrade to
  // neutral or red, so it is recognised explicitly.
  if (value === 'ai3') return value as OwnerId;
  return null;
}

function optionalCount(value: unknown): number | null {
  if (!isFiniteNumber(value) || value < 0) return null;
  return Math.floor(value);
}

function optionalId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/**
 * Accepts a raw event/record and returns a display receipt, or null when the
 * shape is not a defense receipt. Both `type` and `kind` spellings are read so
 * an integration rename cannot silently drop the visual.
 */
export function normalizeDefenseReceipt(payload: unknown): DefenseReceipt | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const rawType = record.type !== undefined ? record.type : record.kind;
  const territoryId =
    optionalId(record.targetId) || optionalId(record.territoryId) || optionalId(record.id);
  if (!territoryId) return null;

  if (rawType === 'defend') {
    const shieldLoss = optionalCount(record.shieldLoss);
    const troopLoss = optionalCount(record.troopLoss);
    const amount = optionalCount(record.amount);
    return {
      kind: 'defend',
      territoryId: territoryId,
      owner: asOwner(record.owner),
      attackerOwner: asOwner(record.attackerOwner),
      targetArmyId: isFiniteNumber(record.targetArmyId)
        ? Math.floor(record.targetArmyId)
        : null,
      attackerSourceId:
        optionalId(record.sourceId) ||
        optionalId(record.attackerSourceId) ||
        optionalId(record.from),
      tick: optionalCount(record.tick),
      amount: amount !== null ? amount : null,
      shieldLoss: shieldLoss !== null ? shieldLoss : null,
      troopLoss: troopLoss !== null ? troopLoss : null,
      siege: record.siege === true,
      captured: false,
    };
  }

  if (rawType === 'capture') {
    // The engine is the only authority on a capture; `amount` is the new
    // garrison it reports, never a damage number.
    return {
      kind: 'fall',
      territoryId: territoryId,
      owner: asOwner(record.owner),
      attackerOwner: asOwner(record.owner),
      targetArmyId: isFiniteNumber(record.targetArmyId)
        ? Math.floor(record.targetArmyId)
        : null,
      attackerSourceId: optionalId(record.sourceId) || optionalId(record.attackerSourceId),
      tick: optionalCount(record.tick),
      amount: optionalCount(record.amount),
      shieldLoss: null,
      troopLoss: null,
      siege: false,
      captured: true,
    };
  }

  return null;
}

/**
 * One real core cannon receipt. `towerId` is the event's `targetId` (the
 * firing tower, never the hit army), `to` is the real impact point in map
 * coordinates and `amount` is the damage the core actually applied. Anything
 * malformed is rejected so the renderer can never invent a shot.
 */
export interface CannonReceipt {
  towerId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  amount: number;
  targetArmyId: number | null;
  tick: number | null;
}

function finitePoint(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (!isFiniteNumber(value[0]) || !isFiniteNumber(value[1])) return null;
  return [value[0], value[1]];
}

export function normalizeCannonReceipt(payload: unknown): CannonReceipt | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (record.type !== 'cannon') return null;
  const towerId = optionalId(record.targetId);
  const from = finitePoint(record.from);
  const to = finitePoint(record.to);
  if (!towerId || !from || !to) return null;
  if (!isFiniteNumber(record.amount) || record.amount < 0) return null;
  return {
    towerId: towerId,
    fromX: from[0],
    fromY: from[1],
    toX: to[0],
    toY: to[1],
    amount: Math.floor(record.amount),
    targetArmyId: isFiniteNumber(record.targetArmyId)
      ? Math.floor(record.targetArmyId)
      : null,
    tick: optionalCount(record.tick),
  };
}

function receiptCount(value: number | null | undefined): number {
  return typeof value === 'number' && isFinite(value) && value > 0 ? value : 0;
}

/**
 * The displayed outcome. Ties favour the defender (the core rule), so a
 * receipt with no damage still reads as a held line, not a repel.
 */
export function defenseOutcome(receipt: DefenseReceipt): DefenseOutcome {
  if (receipt.kind === 'fall') return receipt.captured === false ? 'hold' : 'fall';
  const shield = receiptCount(receipt.shieldLoss);
  const troops = receiptCount(receipt.troopLoss);
  if (shield > 0 && troops <= 0) return 'shield';
  if (troops > 0) return 'repel';
  return 'hold';
}

export type DefenseTone = 'good' | 'bad' | 'info';

export interface DefenseCopy {
  /** Main chip line. */
  title: string;
  /** Optional second line, only when a real number exists. */
  note: string | null;
  tone: DefenseTone;
}

/**
 * Player-facing copy. `viewerOwner` decides the perspective, using only fields
 * the real event carries:
 *
 *  - `capture`: `owner` is the NEW owner, so the viewer took it (占领) or lost
 *    it (失守); an absent owner reads as the neutral 易主.
 *  - `defend`: `owner` is the DEFENDER (absent for a neutral defender — that is
 *    exactly what `core/fronts.ts` emits). A viewer-owned defender reads as a
 *    successful hold; any other known defender means the viewer's attack was
 *    stopped and reads as 进攻受阻; a neutral defender reads as 守军抵抗
 *    without claiming who attacked.
 */
export function defenseCopy(
  receipt: DefenseReceipt,
  viewerOwner: OwnerId = 'player'
): DefenseCopy {
  const outcome = defenseOutcome(receipt);
  if (outcome === 'fall') {
    const owner = receipt.owner;
    let title = '易主';
    let tone: DefenseTone = 'info';
    if (owner !== null) {
      if (owner === viewerOwner) {
        title = '占领';
        tone = 'good';
      } else {
        title = '失守';
        tone = 'bad';
      }
    }
    const garrison = receipt.amount;
    return {
      title: title,
      note: garrison !== null ? '驻军 ' + garrison : null,
      tone: tone,
    };
  }

  const shield = optionalCount(receipt.shieldLoss);
  const troops = optionalCount(receipt.troopLoss);
  const hit = optionalCount(receipt.amount);
  // `amount` is the TOTAL real loss. The split fields are authoritative when
  // the core supplies them, even when one of them is 0: a 0 troopLoss with a
  // positive amount must NOT be re-read as damage. `amount` is used only when
  // no split is present at all.
  const hasSplit = receipt.shieldLoss !== null && receipt.shieldLoss !== undefined
    ? true
    : receipt.troopLoss !== null && receipt.troopLoss !== undefined;
  let damageNote: string | null = null;
  if (troops !== null && troops > 0) {
    damageNote =
      shield !== null && shield > 0
        ? '护盾 -' + shield + ' · 守军 -' + troops
        : '守军 -' + troops;
  } else if (!hasSplit && hit !== null && hit > 0) {
    damageNote = '承伤 ' + hit;
  }

  const defender = receipt.owner;
  const viewerDefends = defender !== null && defender === viewerOwner;
  const enemyDefends = defender !== null && defender !== viewerOwner;

  if (outcome === 'shield') {
    return {
      title: viewerDefends ? '护盾抵挡' : '护盾吸收',
      note: shield !== null && shield > 0 ? '护盾 -' + shield : damageNote,
      tone: 'info',
    };
  }
  if (outcome === 'repel') {
    if (viewerDefends) return { title: '击退进攻', note: damageNote, tone: 'good' };
    if (enemyDefends) return { title: '进攻受阻', note: damageNote, tone: 'bad' };
    return { title: '守军抵抗', note: damageNote, tone: 'info' };
  }
  if (viewerDefends) return { title: '守住阵线', note: damageNote, tone: 'good' };
  if (enemyDefends) return { title: '进攻无效', note: damageNote, tone: 'bad' };
  return { title: '守军未损', note: damageNote, tone: 'info' };
}

/** UI colour band for an outcome, shared by the ring, sparks and chip stripe. */
export function defenseTone(outcome: DefenseOutcome): DefenseTone {
  if (outcome === 'fall') return 'bad';
  if (outcome === 'shield') return 'info';
  return 'good';
}

export interface DefenseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clampValue(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Places the receipt chip above the territory, below it near the top edge,
 * and clamps so a border state never pushes the chip off-screen.
 */
export function placeDefenseBadge(
  bounds: DefenseRect,
  viewWidth: number,
  viewHeight: number,
  desiredWidth: number,
  height: number
): DefenseRect {
  const safeViewWidth = Math.max(1, viewWidth);
  const safeViewHeight = Math.max(1, viewHeight);
  const width = Math.min(Math.max(1, desiredWidth), Math.max(24, safeViewWidth - 12));
  const maxX = Math.max(6, safeViewWidth - width - 6);
  const x = clampValue(bounds.x + bounds.width / 2 - width / 2, 6, maxX);
  const aboveY = bounds.y - height - 7;
  const belowY = bounds.y + bounds.height + 7;
  const maxY = Math.max(6, safeViewHeight - height - 6);
  let y: number;
  if (aboveY >= 6) y = aboveY;
  else if (belowY + height <= safeViewHeight - 6) y = belowY;
  else y = clampValue(bounds.y + 6, 6, maxY);
  return { x: x, y: y, width: width, height: clampValue(height, 1, safeViewHeight - 12) };
}

export interface DefenseImpact {
  x: number;
  y: number;
  /** Approximate territory radius used for the ring. */
  radius: number;
  /** Orientation of the incoming attack (unit vector); 0,0 when unknown. */
  fromX: number;
  fromY: number;
}

/**
 * Derives the impact point on the territory border facing the attacker. When
 * no attacker source is known the territory anchor itself is the impact point,
 * which is still truthful (no direction is invented).
 */
export function defenseImpactPoint(
  bounds: DefenseRect,
  anchorX: number,
  anchorY: number,
  attackerX: number | null,
  attackerY: number | null
): DefenseImpact {
  const radius = Math.max(6, Math.min(bounds.width, bounds.height) * 0.42);
  let fromX = 0;
  let fromY = 0;
  if (attackerX !== null && attackerY !== null) {
    let dx = anchorX - attackerX;
    let dy = anchorY - attackerY;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length > 1e-6) {
      dx /= length;
      dy /= length;
      fromX = dx;
      fromY = dy;
      return {
        x: anchorX - dx * Math.min(radius, length * 0.6),
        y: anchorY - dy * Math.min(radius, length * 0.6),
        radius: Math.max(4, radius * 0.55),
        fromX: fromX,
        fromY: fromY,
      };
    }
  }
  return {
    x: anchorX,
    y: anchorY,
    radius: Math.max(4, radius * 0.55),
    fromX: fromX,
    fromY: fromY,
  };
}

/* ------------------------------------------------------------------ */
/* Static fort (level 1 wall / level 2 tower)                          */
/* ------------------------------------------------------------------ */

export interface FortTower {
  /** Barrel pivot in screen pixels. */
  x: number;
  y: number;
  radius: number;
  barrelLength: number;
  /** Rest angle; a live real cannon receipt can override it. */
  angle: number;
}

export interface ShieldMarker {
  x: number;
  y: number;
  radius: number;
}

/**
 * Screen-space fort geometry, built once per viewport/level and cached by the
 * renderer. Every value is in CSS pixels so the size can be clamped on a phone
 * and still follow zoom: a zoomed-in cell gets a bigger building up to the cap,
 * a tiny cell shrinks to fit instead of spilling into its neighbours.
 */
export interface FortLayout {
  level: 1 | 2;
  /** Wall body rectangle; `y + height` is the ground line. */
  x: number;
  y: number;
  width: number;
  height: number;
  tower: FortTower | null;
  shield: ShieldMarker;
}

export interface FortPlanInput {
  level: number;
  bounds: DefenseRect;
  /** Core route endpoint (labelAnchor || center) in screen pixels. */
  anchorX: number;
  anchorY: number;
  labelBox: DefenseRect | null;
  labelInside: boolean;
  polygon: Point[] | null;
  viewWidth: number;
  viewHeight: number;
}

function rectsOverlap(a: DefenseRect, b: DefenseRect, gap: number): boolean {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

function insidePolygon(x: number, y: number, polygon: Point[] | null): boolean {
  if (!polygon || polygon.length < 3) return true;
  return pointInPolygon(x, y, polygon);
}

function wallInside(
  x: number,
  y: number,
  width: number,
  height: number,
  polygon: Point[] | null
): boolean {
  if (!polygon || polygon.length < 3) return true;
  const insetX = Math.min(3, width * 0.25);
  const insetY = Math.min(3, height * 0.3);
  return (
    insidePolygon(x + width / 2, y + height * 0.65, polygon) &&
    insidePolygon(x + insetX, y + height - insetY, polygon) &&
    insidePolygon(x + width - insetX, y + height - insetY, polygon) &&
    insidePolygon(x + width / 2, y + insetY, polygon)
  );
}

/**
 * Places a paper-stone fort inside its own territory, clear of the real label
 * box and away from the army route endpoint (the centre where march lines and
 * army chips converge).
 *
 * Every candidate is derived from the screen-space anchor of THAT territory,
 * so a pan/zoom moves the fort exactly as far as the territory itself moves.
 * The plan is deliberately never clamped toward the viewport: clamping would
 * turn an off-screen territory into a fake fort stuck to the canvas edge (and
 * a fake cannon origin). A territory whose fort would be entirely outside the
 * viewport yields `null`, and a partially visible one keeps its real anchored
 * position (the canvas clips it naturally).
 */
export function planDefenseFort(input: FortPlanInput): FortLayout | null {
  if (!(input.level >= 1)) return null;
  const level: 1 | 2 = input.level >= 2 ? 2 : 1;
  const viewWidth = Math.max(40, input.viewWidth);
  const viewHeight = Math.max(40, input.viewHeight);
  const bounds = input.bounds;
  const span = Math.min(bounds.width, bounds.height);
  let width = clampValue(
    span * (level === 2 ? 0.56 : 0.48),
    level === 2 ? 32 : 26,
    level === 2 ? 70 : 58
  );
  width = Math.max(14, Math.min(width, bounds.width - 6));
  if (span < 20) width = Math.max(12, Math.min(width, span * 0.94));
  const height = clampValue(width * 0.3, 7, 20);
  const tooth = clampValue(width * 0.06, 1.6, 3.2);
  const towerRadius = level === 2 ? clampValue(width * 0.17, 4.2, 9) : 0;
  const footprintWidth = width + (level === 2 ? towerRadius * 1.1 : 0);
  const rise = level === 2 ? towerRadius * 1.9 : tooth + 2;
  const totalHeight = height + rise;

  const label = input.labelBox;
  const belowLabel = label
    ? label.y + label.height + 6 + totalHeight
    : input.anchorY + totalHeight * 0.72 + 5;
  const aboveLabel = label ? label.y - 6 : input.anchorY - totalHeight * 0.45;
  const sideY = input.anchorY + totalHeight * 0.55;
  const candidates: Array<[number, number]> = [
    [input.anchorX, belowLabel],
    [input.anchorX, aboveLabel],
    [input.anchorX + footprintWidth * 0.8, sideY],
    [input.anchorX - footprintWidth * 0.8, sideY],
    [
      label && input.labelInside
        ? label.x + label.width + footprintWidth * 0.55 + 6
        : input.anchorX + footprintWidth * 1.2,
      input.anchorY + totalHeight * 0.4,
    ],
    [
      label && input.labelInside
        ? label.x - footprintWidth * 0.55 - 6
        : input.anchorX - footprintWidth * 1.2,
      input.anchorY + totalHeight * 0.4,
    ],
    [input.anchorX, input.anchorY + totalHeight * 1.15],
  ];

  let bestWallX = input.anchorX - footprintWidth / 2;
  let bestWallY = belowLabel - height;
  let bestTop = bestWallY - rise;
  let bestScore = -Infinity;
  let bestDistance = Infinity;
  let nearestWallX = bestWallX;
  let nearestWallY = bestWallY;
  let nearestTop = bestTop;
  let nearestDistance = Infinity;

  // Candidates may only move inside the territory's OWN projected box (never
  // toward the viewport). Both the box and the anchor pan/zoom together, so
  // this keeps the fort glued to its cell while still allowing the label
  // avoidance offsets above to be honoured.
  const boundMinWallX = bounds.x + (footprintWidth - width) / 2;
  const boundMaxWallX = bounds.x + bounds.width - width - (footprintWidth - width) / 2;
  const clampCx = function (value: number): number {
    if (boundMaxWallX < boundMinWallX) {
      return bounds.x + bounds.width / 2 - footprintWidth / 2;
    }
    return clampValue(
      value,
      boundMinWallX + footprintWidth / 2,
      boundMaxWallX + footprintWidth / 2
    );
  };
  const clampBaseline = function (value: number): number {
    const minBaseline = bounds.y + totalHeight;
    const maxBaseline = bounds.y + bounds.height;
    if (maxBaseline <= minBaseline) return bounds.y + bounds.height / 2 + totalHeight / 2;
    return clampValue(value, minBaseline, maxBaseline);
  };

  for (let i = 0; i < candidates.length; i += 1) {
    const cx = clampCx(candidates[i][0]);
    const baseline = clampBaseline(candidates[i][1]);
    const wallX = cx - footprintWidth / 2;
    const wallY = baseline - height;
    const top = wallY - rise;
    const effective: DefenseRect = {
      x: wallX - 1,
      y: top - 1,
      width: footprintWidth + 2,
      height: baseline - top + 2,
    };
    const inside = wallInside(wallX, wallY, footprintWidth, height, input.polygon);
    const overlapsLabel = label ? rectsOverlap(effective, label, 3) : false;
    const dx = cx - input.anchorX;
    const dy = baseline - input.anchorY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    // Viewport-independent score, so panning never flips the chosen slot.
    // `inside` and label clearance dominate; the reach from the anchor is a
    // small tie-breaker so the fort stays next to its own cell centre.
    let score = (inside ? 100 : 0) - (overlapsLabel ? 180 : 0);
    score += Math.min(6, distance / 14);
    if (baseline >= input.anchorY) score += 4;
    score -= Math.max(0, distance - footprintWidth * 0.7) * 0.25;
    if (score > bestScore) {
      bestScore = score;
      bestWallX = wallX;
      bestWallY = wallY;
      bestTop = top;
      bestDistance = distance;
    }
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestWallX = wallX;
      nearestWallY = wallY;
      nearestTop = top;
    }
  }
  void bestDistance;

  // A very wide cell can still have its scored slot land past the edge while
  // the territory itself is on screen. In that case fall back to the slot
  // nearest the real anchor instead of dropping a visible territory's fort.
  if (
    (bestWallX + footprintWidth <= 0 ||
      bestWallX >= viewWidth ||
      bestWallY + height <= 0 ||
      bestWallY >= viewHeight) &&
    input.anchorX >= 0 &&
    input.anchorX <= viewWidth &&
    input.anchorY >= 0 &&
    input.anchorY <= viewHeight
  ) {
    bestWallX = nearestWallX;
    bestWallY = nearestWallY;
    bestTop = nearestTop;
  }

  // Entirely outside the viewport: no fort at all (and therefore no cannon
  // muzzle origin snapped to an edge). Overlap with the viewport is enough.
  if (
    bestWallX + footprintWidth <= 0 ||
    bestWallX >= viewWidth ||
    bestWallY + height <= 0 ||
    bestWallY >= viewHeight
  ) {
    return null;
  }

  const shieldRadius = clampValue(width * 0.14, 4.5, 8);
  const sideGap = shieldRadius + 3;
  const shieldCandidates: Array<[number, number]> =
    level === 2
      ? [
          [bestWallX - sideGap, bestTop + shieldRadius + 2],
          [bestWallX + width + sideGap, bestTop + shieldRadius + 2],
          [bestWallX + width * 0.5, bestTop - shieldRadius - 1],
          [bestWallX + width * 0.5, bestTop + shieldRadius + 1],
        ]
      : [
          [bestWallX + width + sideGap, bestTop + shieldRadius + 2],
          [bestWallX - sideGap, bestTop + shieldRadius + 2],
          [bestWallX + width * 0.5, bestTop - shieldRadius - 1],
          [bestWallX + width * 0.5, bestTop + shieldRadius + 1],
        ];
  let shieldX = bestWallX + width * 0.5;
  let shieldY = bestTop + shieldRadius + 1;
  let shieldPlaced = false;
  for (let i = 0; i < shieldCandidates.length; i += 1) {
    const candidateX = shieldCandidates[i][0];
    const candidateY = shieldCandidates[i][1];
    const box: DefenseRect = {
      x: candidateX - shieldRadius,
      y: candidateY - shieldRadius,
      width: shieldRadius * 2,
      height: shieldRadius * 2,
    };
    if (label && rectsOverlap(box, label, 2)) continue;
    if (!insidePolygon(candidateX, candidateY, input.polygon)) continue;
    shieldX = candidateX;
    shieldY = candidateY;
    shieldPlaced = true;
    break;
  }
  if (!shieldPlaced) {
    // No side/top candidate fits a very small cell: keep the marker inside
    // the cell's own bounding box rather than spilling into a neighbour.
    // Like the fort, this is anchored to the territory and never clamped
    // toward the viewport, so panning cannot drag it to the canvas edge.
    const innerMinX = bounds.x + shieldRadius + 1;
    const innerMaxX = bounds.x + bounds.width - shieldRadius - 1;
    const innerMinY = bounds.y + shieldRadius + 1;
    const innerMaxY = bounds.y + bounds.height - shieldRadius - 1;
    shieldX = clampValue(shieldX, Math.min(innerMinX, innerMaxX), Math.max(innerMinX, innerMaxX));
    shieldY = clampValue(shieldY, Math.min(innerMinY, innerMaxY), Math.max(innerMinY, innerMaxY));
  }

  const tower: FortTower | null =
    level === 2
      ? {
          x: bestWallX + width - towerRadius * 0.35,
          y: bestWallY - towerRadius * 0.55,
          radius: towerRadius,
          barrelLength: towerRadius * 2.6,
          angle: -0.42,
        }
      : null;

  return {
    level: level,
    x: bestWallX,
    y: bestWallY,
    width: width,
    height: height,
    tower: tower,
    shield: { x: shieldX, y: shieldY, radius: shieldRadius },
  };
}

const STONE = '#E6DBC4';
const STONE_LIGHT = '#F4EBD9';
const STONE_DARK = '#CFC1A4';
const STONE_EDGE = '#6F6758';
const STONE_GATE = '#4C463C';
const MUZZLE = '#EDB64E';

/**
 * Draws the cached fort. `aim` is supplied only while a real core cannon
 * receipt for this tower is live; it turns the barrel and adds recoil/muzzle
 * flash. Nothing here reads simulation state or invents a shot.
 */
export function drawDefenseFort(
  ctx: CanvasRenderingContext2D,
  fort: FortLayout,
  owner: OwnerId | null,
  aim?: { angle: number; recoil: number; flash: number } | null,
  palette?: OwnerPalette
): void {
  const accent: OwnerAccent = ownerAccent(owner, palette);
  const x = fort.x;
  const y = fort.y;
  const width = fort.width;
  const height = fort.height;
  const bottom = y + height;
  const tooth = clampValue(width * 0.06, 1.6, 3.2);

  ctx.save();
  // Ground shadow keeps the stonework seated on the paper map.
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = NAVY;
  ctx.beginPath();
  ctx.ellipse
    ? ctx.ellipse(x + width / 2, bottom + 1, width * 0.62, Math.max(2, height * 0.25), 0, 0, TAU)
    : ctx.arc(x + width / 2, bottom + 1, width * 0.5, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Plinth, then the wall body.
  ctx.fillStyle = STONE_DARK;
  ctx.strokeStyle = STONE_EDGE;
  ctx.lineWidth = 0.9;
  roundedRect(ctx, x - 1.5, bottom - 2.6, width + 3, 2.8, 1.2, STONE_DARK, STONE_EDGE, 0.8);
  roundedRect(ctx, x, y, width, height, 1.8, STONE, STONE_EDGE, 1.15);
  ctx.fillStyle = STONE_LIGHT;
  ctx.fillRect(x + 1.2, y + 1, width - 2.4, Math.max(1, height * 0.16));

  // Stone courses: two mortar lines and offset joints.
  ctx.strokeStyle = 'rgba(111, 103, 88, 0.34)';
  ctx.lineWidth = 0.7;
  for (let row = 1; row <= 2; row += 1) {
    const lineY = y + (height * row) / 3;
    ctx.beginPath();
    ctx.moveTo(x + 1, lineY);
    ctx.lineTo(x + width - 1, lineY);
    ctx.stroke();
    const joints = row === 1 ? 2 : 1;
    for (let j = 1; j <= joints; j += 1) {
      const jointX = x + (width * j) / (joints + 1) + (row === 2 ? width * 0.08 : 0);
      ctx.beginPath();
      ctx.moveTo(jointX, lineY);
      ctx.lineTo(jointX, lineY + height / 3);
      ctx.stroke();
    }
  }

  // Crenellations.
  ctx.fillStyle = STONE;
  ctx.strokeStyle = STONE_EDGE;
  ctx.lineWidth = 0.8;
  const teeth = fort.level === 2 ? 4 : 3;
  const toothWidth = Math.max(2, (width / teeth) * 0.52);
  for (let i = 0; i < teeth; i += 1) {
    const tx = x + (width * (i + 0.5)) / teeth - toothWidth / 2;
    ctx.beginPath();
    ctx.rect(tx, y - tooth, toothWidth, tooth + 0.6);
    ctx.fill();
    ctx.stroke();
  }

  // Gate.
  const gateWidth = Math.min(width * 0.22, 7);
  const gateHeight = Math.min(height * 0.72, bottom - y - 2);
  roundedRect(
    ctx,
    x + width / 2 - gateWidth / 2,
    bottom - gateHeight,
    gateWidth,
    gateHeight,
    gateWidth / 2,
    STONE_GATE
  );

  // Owner pennant: a small faction marker on the wall/tower.
  const poleX = fort.tower ? fort.tower.x : x + width - 3;
  const poleBase = fort.tower
    ? fort.tower.y - fort.tower.radius * 0.7
    : y - tooth;
  const poleTop = poleBase - Math.max(5, height * 0.72);
  ctx.strokeStyle = accent.deep;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(poleX, poleBase);
  ctx.lineTo(poleX, poleTop);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(poleX, poleTop);
  ctx.lineTo(poleX + Math.max(4.5, width * 0.13), poleTop + 1.8);
  ctx.lineTo(poleX, poleTop + 4.2);
  ctx.closePath();
  ctx.fillStyle = accent.ink;
  ctx.fill();
  ctx.strokeStyle = accent.deep;
  ctx.lineWidth = 0.7;
  ctx.stroke();

  const tower = fort.tower;
  if (tower) {
    const angle = aim && isFinite(aim.angle) ? aim.angle : tower.angle;
    const recoil = aim && isFinite(aim.recoil) ? clampValue(aim.recoil, 0, 1) * 3 : 0;
    const pivotX = tower.x;
    const pivotY = tower.y - tower.radius * 0.15;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    // Barrel first, so the tower body reads as its mount.
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = STONE_GATE;
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(pivotX - dirX * recoil, pivotY - dirY * recoil);
    ctx.lineTo(
      pivotX + dirX * (tower.barrelLength - recoil),
      pivotY + dirY * (tower.barrelLength - recoil)
    );
    ctx.stroke();
    ctx.strokeStyle = '#B7AA91';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pivotX - dirX * recoil, pivotY - dirY * recoil);
    ctx.lineTo(
      pivotX + dirX * (tower.barrelLength - recoil),
      pivotY + dirY * (tower.barrelLength - recoil)
    );
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(
      pivotX + dirX * (tower.barrelLength - recoil),
      pivotY + dirY * (tower.barrelLength - recoil),
      1.7,
      0,
      TAU
    );
    ctx.fillStyle = STONE_GATE;
    ctx.fill();
    ctx.restore();

    // Round bastion with its own crenellated cap.
    ctx.beginPath();
    ctx.arc(tower.x, tower.y, tower.radius, 0, TAU);
    ctx.fillStyle = STONE_DARK;
    ctx.fill();
    ctx.strokeStyle = STONE_EDGE;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tower.x, tower.y, tower.radius * 0.68, 0, TAU);
    ctx.fillStyle = STONE;
    ctx.fill();
    ctx.fillStyle = STONE;
    ctx.strokeStyle = STONE_EDGE;
    ctx.lineWidth = 0.7;
    for (let i = 0; i < 3; i += 1) {
      const bx = tower.x - tower.radius * 0.72 + i * tower.radius * 0.72;
      ctx.beginPath();
      ctx.rect(bx, tower.y - tower.radius - 1.4, tower.radius * 0.44, 2);
      ctx.fill();
      ctx.stroke();
    }
    // Pivot hub hides the barrel root inside the bastion.
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, Math.max(1.4, tower.radius * 0.24), 0, TAU);
    ctx.fillStyle = accent.ink;
    ctx.fill();
    ctx.strokeStyle = accent.deep;
    ctx.lineWidth = 0.7;
    ctx.stroke();

    if (aim && aim.flash > 0) {
      const flash = clampValue(aim.flash, 0, 1);
      const muzzleX = pivotX + dirX * (tower.barrelLength - recoil);
      const muzzleY = pivotY + dirY * (tower.barrelLength - recoil);
      ctx.save();
      ctx.globalAlpha = 0.9 * flash;
      ctx.fillStyle = MUZZLE;
      ctx.beginPath();
      ctx.arc(muzzleX, muzzleY, 2.6 + flash * 2.6, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = CREAM;
      ctx.lineWidth = 1.3;
      for (let i = 0; i < 4; i += 1) {
        const a = angle + (i - 1.5) * 0.42;
        ctx.beginPath();
        ctx.moveTo(muzzleX, muzzleY);
        ctx.lineTo(muzzleX + Math.cos(a) * (5 + flash * 4), muzzleY + Math.sin(a) * (5 + flash * 4));
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  ctx.restore();
}

/**
 * Short stone-hit overlay for a REAL defend receipt with troop loss. No text:
 * the receipt chip owns the numbers and the capture prompt owns a fall.
 */
function drawWallHit(scene: DefenseDrawScene, color: string): void {
  if (!scene.fort || scene.age > 380) return;
  const fort = scene.fort;
  const local = clampValue(scene.age / 380, 0, 1);
  const alpha = 1 - local;
  const ctx = scene.ctx;
  const seed = scene.effect.seed;
  const px = clampValue(scene.impact.x, fort.x + 3, fort.x + fort.width - 3);
  const py = clampValue(scene.impact.y, fort.y + 2, fort.y + fort.height - 2);
  ctx.save();
  ctx.globalAlpha = alpha * 0.42;
  ctx.fillStyle = CREAM;
  ctx.fillRect(fort.x, fort.y, fort.width, fort.height);
  ctx.globalAlpha = alpha * 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.1;
  for (let i = 0; i < 3; i += 1) {
    const angle = noise(seed, i + 41) * TAU;
    const length = 4 + noise(seed, i + 51) * (4 + fort.width * 0.18);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(angle) * length, py + Math.sin(angle) * length * 0.6);
    ctx.stroke();
  }
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = STONE_DARK;
  for (let i = 0; i < 3; i += 1) {
    const angle = -Math.PI + noise(seed, i + 61) * Math.PI;
    const spread = 3 + noise(seed, i + 71) * 7;
    ctx.beginPath();
    ctx.arc(
      px + Math.cos(angle) * spread,
      py - Math.abs(Math.sin(angle)) * spread * 0.8,
      1 + noise(seed, i + 81) * 1.8,
      0,
      TAU
    );
    ctx.fill();
  }
  ctx.restore();
}

/**
 * One live defense effect. `receivedAt` uses the renderer clock (performance
 * timestamps), never the simulation tick, so a paused match cannot fast-forward
 * the animation and a resumed match cannot replay it.
 */
export interface DefenseEffect {
  receipt: DefenseReceipt;
  outcome: DefenseOutcome;
  copy: DefenseCopy;
  receivedAt: number;
  /** Stable index-derived spark seed, so no Math.random is used. */
  seed: number;
}

/**
 * Fixed-capacity receipt queue. A newer receipt for the same territory
 * replaces the older one (one chip per cell), and the oldest effect is evicted
 * when the cap is reached. Pruning happens in place.
 */
export class DefenseEffectQueue {
  private items: DefenseEffect[] = [];
  private seed = 0;

  enqueue(receipt: DefenseReceipt, receivedAt: number, viewerOwner: OwnerId = 'player'): DefenseEffect {
    this.seed = (this.seed + 1) >>> 0;
    const effect: DefenseEffect = {
      receipt: receipt,
      outcome: defenseOutcome(receipt),
      copy: defenseCopy(receipt, viewerOwner),
      receivedAt: receivedAt,
      seed: this.seed,
    };
    for (let i = 0; i < this.items.length; i += 1) {
      if (this.items[i].receipt.territoryId === receipt.territoryId) {
        this.items.splice(i, 1);
        break;
      }
    }
    if (this.items.length >= DEFENSE_MAX_EFFECTS) this.items.shift();
    this.items.push(effect);
    return effect;
  }

  /** Live effects (pruned in place); never allocates per frame. */
  active(now: number): readonly DefenseEffect[] {
    this.prune(now);
    return this.items;
  }

  /**
   * Drops only the pending defense effects for ONE territory. Called when a
   * real `capture` for that same territory arrives later in the same drained
   * batch: a "击退/守住" chip must not sit next to the real 失守 prompt. Other
   * territories (and any receipt that arrives AFTER the capture) are
   * untouched, so a genuinely new defend still plays in order.
   */
  removeFor(territoryId: string): number {
    const items = this.items;
    let write = 0;
    for (let read = 0; read < items.length; read += 1) {
      if (items[read].receipt.territoryId !== territoryId) {
        items[write] = items[read];
        write += 1;
      }
    }
    const removed = items.length - write;
    items.length = write;
    return removed;
  }

  prune(now: number): number {
    const items = this.items;
    let write = 0;
    for (let read = 0; read < items.length; read += 1) {
      const age = now - items[read].receivedAt;
      // A frame timestamp can sit a millisecond before the enqueue clock;
      // park the effect until time catches up instead of dropping it.
      if (age < DEFENSE_EFFECT_MS) {
        items[write] = items[read];
        write += 1;
      }
    }
    const removed = items.length - write;
    items.length = write;
    return removed;
  }

  clear(): void {
    this.items.length = 0;
  }

  size(): number {
    return this.items.length;
  }
}

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

const CREAM = '#FBF5E9';
const NAVY = '#172B44';
const GOOD = '#2F8068';
const BAD = '#C0452F';
const SHIELD_INK = '#3C7E93';
const TAU = Math.PI * 2;

function font(weight: string, size: number): string {
  return weight + ' ' + Math.round(size * 10) / 10 + 'px ' + FONT_STACK;
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

/** Stable per-seed noise; deterministic and allocation-free. */
function noise(seed: number, index: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

export interface DefenseDrawScene {
  ctx: CanvasRenderingContext2D;
  effect: DefenseEffect;
  /** Palette owned by the renderer/match; omitted callers use legacy blue. */
  palette?: OwnerPalette;
  age: number;
  impact: DefenseImpact;
  bounds: DefenseRect;
  /** Cached fort body when this territory has one; anchors the wall hit. */
  fort?: DefenseRect | null;
  viewWidth: number;
  viewHeight: number;
  reducedMotion: boolean;
  /**
   * True when the territory is only partly on screen. A partly visible cell
   * keeps a readable chip inside the viewport; a fully off-screen cell is
   * skipped by the caller and never clamped to an edge.
   */
  partialOnScreen?: boolean;
}

function toneColor(tone: DefenseTone): string {
  if (tone === 'good') return GOOD;
  if (tone === 'bad') return BAD;
  return SHIELD_INK;
}

function drawImpactSparks(scene: DefenseDrawScene, color: string): void {
  if (scene.age > DEFENSE_IMPACT_END_MS) return;
  const ctx = scene.ctx;
  const local = clampValue(scene.age / DEFENSE_IMPACT_END_MS, 0, 1);
  const alpha = 1 - local;
  const seed = scene.effect.seed;
  const impact = scene.impact;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < 5; i += 1) {
    const angle = noise(seed, i) * TAU;
    const reach = impact.radius * (0.7 + noise(seed, i + 17) * 1.1) * (0.4 + local);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    ctx.globalAlpha = alpha * (i % 2 === 0 ? 0.9 : 0.62);
    ctx.strokeStyle = i % 2 === 0 ? CREAM : color;
    ctx.lineWidth = i % 2 === 0 ? 2.4 : 1.4;
    ctx.beginPath();
    ctx.moveTo(impact.x + dx * 1.5, impact.y + dy * 1.5);
    ctx.lineTo(impact.x + dx * reach, impact.y + dy * reach);
    ctx.stroke();
  }
  ctx.restore();
}

function drawShieldArc(scene: DefenseDrawScene, local: number): void {
  const ctx = scene.ctx;
  const impact = scene.impact;
  // A shield bubble wraps the whole fort when it exists, so the absorb reads
  // as protecting the building; otherwise it stays a small truthfully placed
  // arc around the real impact point.
  const baseRadius = scene.fort
    ? Math.max(impact.radius, scene.fort.width * 0.55)
    : impact.radius;
  const radius = baseRadius * (0.9 + local * 0.28);
  const alpha = (1 - local) * 0.9;
  // The arc faces the attacker when a direction is known; otherwise a full ring.
  const known = Math.abs(impact.fromX) + Math.abs(impact.fromY) > 0.01;
  const facing = known ? Math.atan2(-impact.fromY, -impact.fromX) : 0;
  const start = known ? facing - Math.PI * 0.42 : 0;
  const end = known ? facing + Math.PI * 0.42 : TAU;
  ctx.save();
  ctx.globalAlpha = alpha * 0.5;
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(impact.x, impact.y, Math.max(2, radius), start, end);
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = SHIELD_INK;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawFallRing(scene: DefenseDrawScene): void {
  const ctx = scene.ctx;
  const local = clampValue(scene.age / 900, 0, 1);
  const impact = scene.impact;
  const radius = impact.radius * (0.8 + local * 1.6);
  ctx.save();
  ctx.globalAlpha = (1 - local) * 0.85;
  ctx.strokeStyle = BAD;
  ctx.lineWidth = 2.6 * (1 - local * 0.5);
  ctx.beginPath();
  ctx.arc(impact.x, impact.y, Math.max(2, radius), 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = (1 - local) * 0.35;
  ctx.fillStyle = BAD;
  ctx.beginPath();
  ctx.arc(impact.x, impact.y, Math.max(1, impact.radius * 0.5), 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawHoldRing(scene: DefenseDrawScene, color: string): void {
  const ctx = scene.ctx;
  const local = clampValue(scene.age / 700, 0, 1);
  if (local >= 1) return;
  const impact = scene.impact;
  ctx.save();
  ctx.globalAlpha = (1 - local) * 0.6;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(impact.x, impact.y, Math.max(2, impact.radius * (0.7 + local * 0.9)), 0, TAU);
  ctx.stroke();
  ctx.restore();
}

function drawChip(scene: DefenseDrawScene): void {
  const ctx = scene.ctx;
  const copy = scene.effect.copy;
  const age = scene.age;
  const fadeIn = scene.reducedMotion ? 1 : clampValue(age / 130, 0, 1);
  const fadeOut =
    age > DEFENSE_EFFECT_MS - 260
      ? clampValue((DEFENSE_EFFECT_MS - age) / 260, 0, 1)
      : 1;
  const alpha = fadeIn * fadeOut;
  if (alpha <= 0.02) return;
  const stripe = toneColor(copy.tone);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = font('800', 10);
  const titleWidth = ctx.measureText(copy.title).width;
  let noteWidth = 0;
  if (copy.note) {
    ctx.font = font('700', 9);
    noteWidth = ctx.measureText(copy.note).width;
  }
  const height = copy.note ? 34 : 22;
  // A territory that is only partly visible still gets a readable chip that
  // is kept on screen; a fully off-screen one is not drawn at all (see
  // `receiptVisibleOnScreen`), so a chip can never be pinned to an edge for
  // a cell the user cannot see.
  const box = scene.partialOnScreen
    ? placeDefenseBadge(
        scene.bounds,
        scene.viewWidth,
        scene.viewHeight,
        Math.max(titleWidth, noteWidth) + 20,
        height
      )
    : {
        x:
          scene.bounds.x +
          scene.bounds.width / 2 -
          (Math.max(titleWidth, noteWidth) + 20) / 2,
        y: scene.bounds.y - height - 7,
        width: Math.max(titleWidth, noteWidth) + 20,
        height: height,
      };
  roundedRect(ctx, box.x, box.y, box.width, box.height, 9, 'rgba(251, 245, 233, 0.96)', 'rgba(23, 43, 68, 0.18)', 1);
  roundedRect(ctx, box.x, box.y, 3.2, box.height, 1.6, stripe);
  ctx.fillStyle = NAVY;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = font('800', 10);
  ctx.fillText(copy.title, box.x + 11, box.y + (copy.note ? 12.5 : box.height / 2 + 0.5));
  if (copy.note) {
    ctx.fillStyle = stripe;
    ctx.font = font('700', 9);
    ctx.fillText(copy.note, box.x + 11, box.y + 25);
  }
  ctx.restore();
}

/**
 * True when the guarded territory's own screen box is entirely outside the
 * viewport. Such a receipt draws nothing: the ring, sparks and chip all stay
 * at the real coordinates (or are skipped) instead of being dragged to an
 * edge by a clamp, which would put a fake "击退/守住" next to a neighbour.
 */
export function receiptOffScreen(bounds: DefenseRect, viewWidth: number, viewHeight: number): boolean {
  return (
    bounds.x + bounds.width <= 0 ||
    bounds.x >= viewWidth ||
    bounds.y + bounds.height <= 0 ||
    bounds.y >= viewHeight
  );
}

/**
 * Single entry point per live effect. Short (1.4 s) and bounded so a defended
 * frontier under sustained attack never blocks the map.
 */
export function drawDefenseEffect(scene: DefenseDrawScene): void {
  const age = scene.age;
  if (!isFinite(age) || age < 0) return;
  const outcome = scene.effect.outcome;
  const shieldLoss = receiptCount(scene.effect.receipt.shieldLoss);
  const troopLoss = receiptCount(scene.effect.receipt.troopLoss);

  // A shield arc is drawn only when the real receipt says shield was lost,
  // never for a plain hold and never for a capture (which carries no split).
  if (outcome !== 'fall' && shieldLoss > 0) {
    drawShieldArc(scene, scene.reducedMotion ? 0.4 : clampValue(age / 760, 0, 1));
    drawImpactSparks(scene, SHIELD_INK);
  } else if (outcome === 'fall') {
    drawFallRing(scene);
    drawImpactSparks(scene, BAD);
  } else if (outcome === 'repel') {
    drawHoldRing(scene, GOOD);
    drawImpactSparks(scene, GOOD);
  } else {
    drawHoldRing(scene, GOOD);
    drawImpactSparks(scene, CREAM);
  }
  // Stone damage only when the defender really lost troops.
  if (outcome !== 'fall' && troopLoss > 0) {
    drawWallHit(scene, outcome === 'repel' ? GOOD : SHIELD_INK);
  }
  drawChip(scene);
}

/**
 * Persistent shield state marker for a territory whose `shield > 0`.
 * Deliberately static and faint: it must not compete with the receipt chip and
 * must not animate continuously on a low-end phone. `fraction` is
 * shield / shieldCapacity (0..1).
 */
export function drawShieldBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  fraction: number,
  owner: OwnerId | null,
  palette?: OwnerPalette
): void {
  if (!(radius > 0)) return;
  const accent: OwnerAccent = ownerAccent(owner, palette);
  const clamped = clampValue(isFinite(fraction) ? fraction : 0, 0, 1);
  ctx.save();
  ctx.globalAlpha = 0.82;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.strokeStyle = 'rgba(251, 245, 233, 0.6)';
  ctx.lineWidth = 2.6;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(0.06, clamped));
  ctx.strokeStyle = SHIELD_INK;
  ctx.lineWidth = 1.7;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x - radius * 0.34, y - radius * 0.34, 1.3, 0, TAU);
  ctx.fillStyle = accent.ink;
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Capture collapse (previous level 1 wall / level 2 turret)           */
/* ------------------------------------------------------------------ */

/** Whole collapse lifetime. After this the queue drops the entry. */
export const DEFENSE_COLLAPSE_MS = 1200;
/**
 * Hard safety window for holding the settlement while a real capture collapse
 * is still playing. It only exists so a stopped/hidden/violent frame clock can
 * never keep the result screen away forever; normal settles happen exactly when
 * the queue empties, not at this deadline.
 */
export const END_COLLAPSE_HOLD_MS = DEFENSE_COLLAPSE_MS + 400;
/** At most this many captures collapse at once (bursts stay bounded). */
export const DEFENSE_COLLAPSE_MAX_EFFECTS = 6;
/** The intact fort jolts for this long before the masonry lets go. */
const COLLAPSE_STAND_MS = 230;
/** Gravity for the falling chunks, in screen px/s². */
const COLLAPSE_GRAVITY = 1250;
const DUST_INK = '#CDBEA4';
const DUST_LIGHT = '#E7DCC8';

/**
 * The exact pre-capture state a real `capture` event carries. `level` is the
 * vanished level itself (1 | 2); a 0/missing value never produces a receipt, so
 * a capture of an undefended territory can never fake a collapse. The
 * previous owner is optional: when the core omits it the pennant simply takes
 * the neutral accent instead of guessing who held the cell.
 */
export interface DefenseCollapseReceipt {
  territoryId: string;
  previousDefenseLevel: 1 | 2;
  previousOwner: OwnerId | null;
  /** New owner reported by the same real capture event (never inferred). */
  owner: OwnerId | null;
  tick: number | null;
}

function collapseLevel(value: unknown): 1 | 2 | null {
  if (value === 1 || value === 2) return value;
  return null;
}

/**
 * Whether the ended match must wait before the result screen, because a REAL
 * capture collapse started by the ending frame is still playing.
 *
 * Only a live collapse holds the settlement, and only up to
 * `END_COLLAPSE_HOLD_MS` of real elapsed time. A match that ends without a
 * fort capture (timer, elimination, undefended capture) has zero live collapses
 * and therefore settles on the very same frame: no added wait at all. The
 * deadline is measured on the frame clock, so a paused/hidden page simply
 * resumes the wait instead of expiring it early, and it can never hang forever.
 */
export function shouldHoldEndForCollapse(
  liveCollapses: number,
  elapsedMs: number
): boolean {
  if (!(liveCollapses > 0)) return false;
  if (!isFinite(elapsedMs)) return false;
  return elapsedMs < END_COLLAPSE_HOLD_MS;
}

/**
 * Accepts the raw core capture event and returns the collapse receipt, or null
 * when there is nothing real to fall. Only the capture's own
 * `previousDefenseLevel` decides that; the renderer cache, the current defense
 * level and the shield value are deliberately never consulted.
 */
export function normalizeDefenseCollapse(payload: unknown): DefenseCollapseReceipt | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const rawType = record.type !== undefined ? record.type : record.kind;
  if (rawType !== 'capture') return null;
  const territoryId = optionalId(record.targetId) || optionalId(record.territoryId);
  if (!territoryId) return null;
  const level = collapseLevel(record.previousDefenseLevel);
  if (!level) return null;
  return {
    territoryId: territoryId,
    previousDefenseLevel: level,
    previousOwner: asOwner(record.previousOwner),
    owner: asOwner(record.owner),
    tick: optionalCount(record.tick),
  };
}

/**
 * One live collapse. `receivedAt` is on the renderer (rAF) clock, so a paused
 * or hidden page cannot fast-forward or replay it.
 */
export interface DefenseCollapseEffect {
  receipt: DefenseCollapseReceipt;
  receivedAt: number;
  /** Stable seed for the deterministic debris layout (no Math.random). */
  seed: number;
}

/**
 * Bounded collapse queue. One collapse per territory (a same-tick recapture
 * replaces the older shell instead of stacking two), oldest evicted at the cap.
 */
export class DefenseCollapseQueue {
  private items: DefenseCollapseEffect[] = [];
  private seed = 0;

  enqueue(receipt: DefenseCollapseReceipt, receivedAt: number): DefenseCollapseEffect {
    this.seed = (this.seed + 1) >>> 0;
    const effect: DefenseCollapseEffect = {
      receipt: receipt,
      receivedAt: receivedAt,
      seed: this.seed,
    };
    for (let i = 0; i < this.items.length; i += 1) {
      if (this.items[i].receipt.territoryId === receipt.territoryId) {
        this.items.splice(i, 1);
        break;
      }
    }
    if (this.items.length >= DEFENSE_COLLAPSE_MAX_EFFECTS) this.items.shift();
    this.items.push(effect);
    return effect;
  }

  /** Live collapses, pruned in place. A negative age is kept for next frame. */
  active(now: number): readonly DefenseCollapseEffect[] {
    this.prune(now);
    return this.items;
  }

  removeFor(territoryId: string): number {
    const items = this.items;
    let write = 0;
    for (let read = 0; read < items.length; read += 1) {
      if (items[read].receipt.territoryId !== territoryId) {
        items[write] = items[read];
        write += 1;
      }
    }
    const removed = items.length - write;
    items.length = write;
    return removed;
  }

  prune(now: number): number {
    const items = this.items;
    let write = 0;
    for (let read = 0; read < items.length; read += 1) {
      const age = now - items[read].receivedAt;
      if (age < DEFENSE_COLLAPSE_MS) {
        items[write] = items[read];
        write += 1;
      }
    }
    const removed = items.length - write;
    items.length = write;
    return removed;
  }

  /**
   * Pushes every pending collapse forward by the wall-clock time that passed
   * with NO frame drawn (paused match, hidden tab, a stalled rAF). Without it
   * a two-second pause would fast-forward the whole animation and the debris
   * would skip its fall. Only real elapsed time is shifted; nothing is
   * created, replayed or extended beyond the real gap.
   */
  shift(byMs: number): void {
    if (!(byMs > 0) || !isFinite(byMs)) return;
    for (let i = 0; i < this.items.length; i += 1) {
      this.items[i].receivedAt += byMs;
    }
  }

  clear(): void {
    this.items.length = 0;
  }

  size(): number {
    return this.items.length;
  }
}

export interface DefenseCollapseDrawScene {
  ctx: CanvasRenderingContext2D;
  effect: DefenseCollapseEffect;
  /** Palette owned by the renderer/match; omitted callers use legacy blue. */
  palette?: OwnerPalette;
  age: number;
  /**
   * The pre-capture fort layout, re-planned against the current viewport by
   * the caller, so pan/zoom moves the debris exactly with its territory.
   */
  fort: FortLayout;
  /**
   * True only while no living fort occupies the cell. A new owner who upgrades
   * in the same tick keeps its real building: the stale shell then starts
   * directly as fragments and can never paint a whole old fort over it.
   */
  standing: boolean;
  reducedMotion: boolean;
}

function collapseLife(age: number, delay: number): number {
  if (delay >= DEFENSE_COLLAPSE_MS) return 1;
  return clampValue((age - delay) / (DEFENSE_COLLAPSE_MS - delay), 0, 1);
}

/** Debris fades only in the last 40% of its own life. */
function collapseAlpha(life: number): number {
  if (life >= 1) return 0;
  if (life < 0.6) return 1;
  return 1 - (life - 0.6) / 0.4;
}

function drawCollapseBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  angle: number,
  alpha: number,
  fill: string
): void {
  if (alpha <= 0.02 || !(width > 0.5) || !(height > 0.5)) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x + width / 2, y + height / 2);
  ctx.rotate(angle);
  ctx.fillStyle = fill;
  ctx.fillRect(-width / 2, -height / 2, width, height);
  ctx.strokeStyle = STONE_EDGE;
  ctx.lineWidth = 0.8;
  ctx.strokeRect(-width / 2, -height / 2, width, height);
  ctx.restore();
}

function drawCollapseDust(
  ctx: CanvasRenderingContext2D,
  fort: FortLayout,
  age: number,
  seed: number
): void {
  if (age < 40) return;
  const bottom = fort.y + fort.height;
  for (let i = 0; i < 5; i += 1) {
    const delay = 50 + i * 65 + noise(seed, i + 61) * 60;
    if (age < delay) continue;
    const life = collapseLife(age, delay);
    // Dust blooms quickly, then thins out; it never reaches full opacity.
    const alpha = (life < 0.35 ? life / 0.35 : 1 - (life - 0.35) / 0.65) * 0.5;
    if (alpha <= 0.02) continue;
    const tau = (age - delay) / 1000;
    const drift = (noise(seed, i + 71) - 0.5) * 24;
    const x = fort.x + fort.width * (0.1 + i * 0.2) + drift * tau * 3;
    const y = bottom - (8 + noise(seed, i + 81) * 14) * Math.min(1, tau * 3);
    const radius = 3 + noise(seed, i + 91) * 4 + tau * 16;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = i % 2 === 0 ? DUST_INK : DUST_LIGHT;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

function drawCollapseChunks(
  ctx: CanvasRenderingContext2D,
  fort: FortLayout,
  age: number,
  seed: number
): void {
  const cols = 3;
  const rows = 2;
  const width = fort.width / cols;
  const height = fort.height / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const delay = 55 + noise(seed, index + 5) * 115;
      const tau = (age - delay) / 1000;
      if (tau <= 0) continue;
      const alpha = collapseAlpha(collapseLife(age, delay));
      if (alpha <= 0.02) continue;
      // Edge columns are thrown outward; the middle drops almost straight.
      const side = col === 0 ? -1 : col === cols - 1 ? 1 : 0;
      const vx = side * (18 + noise(seed, index + 9) * 30) + (noise(seed, index + 10) - 0.5) * 16;
      const vy = -(10 + noise(seed, index + 11) * 30);
      const fall = vy * tau + 0.5 * COLLAPSE_GRAVITY * tau * tau;
      const x = fort.x + col * width + vx * tau;
      const y = fort.y + row * height + fall;
      const angle = (noise(seed, index + 13) - 0.5) * 3.4 * tau;
      drawCollapseBlock(
        ctx,
        x,
        y,
        Math.max(1, width - 0.6),
        Math.max(1, height - 0.6),
        angle,
        alpha,
        row === 0 ? STONE : STONE_DARK
      );
    }
  }
}

/** Level 2 only: the bastion splits into two halves and the barrel flies off. */
function drawCollapseTower(
  ctx: CanvasRenderingContext2D,
  fort: FortLayout,
  age: number,
  seed: number
): void {
  const tower = fort.tower;
  if (!tower || !(tower.radius > 1)) return;
  for (let half = 0; half < 2; half += 1) {
    const delay = 60 + noise(seed, half + 31) * 105;
    const tau = (age - delay) / 1000;
    if (tau <= 0) continue;
    const alpha = collapseAlpha(collapseLife(age, delay));
    if (alpha <= 0.02) continue;
    const direction = half === 0 ? -1 : 1;
    const drift = direction * (14 + noise(seed, half + 33) * 18);
    const fall = -12 * tau + 0.5 * COLLAPSE_GRAVITY * tau * tau;
    const angle = direction * (1.4 + noise(seed, half + 35) * 1.6) * tau;
    const start = half === 0 ? -Math.PI / 2 : Math.PI / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(tower.x + drift * tau, tower.y + fall);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, tower.radius, start, start + Math.PI);
    ctx.closePath();
    ctx.fillStyle = half === 0 ? STONE_DARK : STONE;
    ctx.fill();
    ctx.strokeStyle = STONE_EDGE;
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.restore();
  }

  const barrelDelay = 90 + noise(seed, 41) * 100;
  const barrelTau = (age - barrelDelay) / 1000;
  if (barrelTau > 0) {
    const alpha = collapseAlpha(collapseLife(age, barrelDelay));
    if (alpha > 0.02) {
      const fall = -20 * barrelTau + 0.5 * COLLAPSE_GRAVITY * barrelTau * barrelTau;
      const angle = tower.angle + (noise(seed, 43) - 0.5) * 5 * barrelTau;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(
        tower.x + (noise(seed, 42) - 0.5) * 40 * barrelTau,
        tower.y - tower.radius * 0.15 + fall
      );
      ctx.rotate(angle);
      ctx.fillStyle = STONE_GATE;
      ctx.fillRect(0, -1.9, tower.barrelLength, 3.8);
      ctx.strokeStyle = STONE_EDGE;
      ctx.lineWidth = 0.8;
      ctx.strokeRect(0, -1.9, tower.barrelLength, 3.8);
      ctx.restore();
    }
  }
}

function drawCollapsePennant(
  ctx: CanvasRenderingContext2D,
  fort: FortLayout,
  accent: OwnerAccent,
  age: number,
  seed: number
): void {
  const delay = 140 + noise(seed, 51) * 90;
  const tau = (age - delay) / 1000;
  if (tau <= 0) return;
  const alpha = collapseAlpha(collapseLife(age, delay));
  if (alpha <= 0.02) return;
  const tooth = clampValue(fort.width * 0.06, 1.6, 3.2);
  const poleX = fort.tower ? fort.tower.x : fort.x + fort.width - 3;
  const poleBase = fort.tower ? fort.tower.y - fort.tower.radius * 0.7 : fort.y - tooth;
  const top = poleBase - Math.max(5, fort.height * 0.72);
  const size = Math.max(4.5, fort.width * 0.13);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(
    poleX + (noise(seed, 52) - 0.5) * 30 * tau,
    top - 8 * tau + 0.5 * COLLAPSE_GRAVITY * tau * tau
  );
  ctx.rotate((noise(seed, 53) - 0.5) * 5 * tau);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size, 1.8);
  ctx.lineTo(0, 4.2);
  ctx.closePath();
  ctx.fillStyle = accent.ink;
  ctx.fill();
  ctx.strokeStyle = accent.deep;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();
}

/** Reduced motion: settled rubble, static except for its fade. */
function drawCollapseRubble(
  ctx: CanvasRenderingContext2D,
  fort: FortLayout,
  accent: OwnerAccent,
  fade: number
): void {
  if (fade <= 0.02) return;
  const bottom = fort.y + fort.height;
  const blockWidth = Math.max(2, fort.width / 3);
  const blockHeight = Math.max(1.6, fort.height / 2);
  ctx.save();
  ctx.globalAlpha = fade * 0.92;
  for (let i = 0; i < 3; i += 1) {
    const x = fort.x + i * blockWidth * 0.94 + (i % 2 === 0 ? 0.5 : 1.4);
    const y = bottom - blockHeight * 0.42 + (i % 2 === 0 ? 0 : 1.2);
    ctx.fillStyle = i === 1 ? STONE_DARK : STONE;
    ctx.fillRect(x, y, blockWidth * 0.88, blockHeight * 0.5);
    ctx.strokeStyle = STONE_EDGE;
    ctx.lineWidth = 0.7;
    ctx.strokeRect(x, y, blockWidth * 0.88, blockHeight * 0.5);
  }
  if (fort.tower && fort.tower.radius > 1) {
    ctx.beginPath();
    ctx.moveTo(fort.tower.x, bottom);
    ctx.arc(fort.tower.x, bottom, fort.tower.radius, Math.PI, TAU);
    ctx.closePath();
    ctx.fillStyle = STONE_DARK;
    ctx.fill();
    ctx.strokeStyle = STONE_EDGE;
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }
  // A last sliver of the old pennant, resting on the rubble.
  ctx.beginPath();
  ctx.moveTo(fort.x + fort.width * 0.62, bottom - 1);
  ctx.lineTo(fort.x + fort.width * 0.72, bottom - 2.4);
  ctx.lineTo(fort.x + fort.width * 0.66, bottom + 1.6);
  ctx.closePath();
  ctx.fillStyle = accent.ink;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = fade * 0.22;
  ctx.fillStyle = DUST_INK;
  ctx.beginPath();
  ctx.arc(fort.x + fort.width * 0.5, bottom - 2, Math.max(4, fort.width * 0.45), 0, TAU);
  ctx.fill();
  ctx.restore();
}

/**
 * Draws one capture collapse and nothing else: no copy (the real capture
 * floater already announces the takeover), no simulation state, no shield.
 *
 * Timeline (non-reduced): 0-230 ms intact jolt + rising cracks and dust,
 * then the wall breaks into blocks, the level-2 bastion splits and the barrel
 * spins off, the old pennant flutters down, and dust disperses. Everything is
 * gone by DEFENSE_COLLAPSE_MS; no texture or saved state survives the effect.
 */
export function drawDefenseCollapse(scene: DefenseCollapseDrawScene): void {
  const age = scene.age;
  if (!isFinite(age) || age < 0 || age >= DEFENSE_COLLAPSE_MS) return;
  const ctx = scene.ctx;
  const fort = scene.fort;
  const receipt = scene.effect.receipt;
  const seed = scene.effect.seed;
  const accent: OwnerAccent = ownerAccent(receipt.previousOwner, scene.palette);

  if (scene.reducedMotion) {
    // A cell whose new owner already rebuilt keeps its real fort; a settled
    // rubble pile under it would only misread as a second building.
    if (!scene.standing) return;
    drawCollapseRubble(
      ctx,
      fort,
      accent,
      1 - clampValue(age / (DEFENSE_COLLAPSE_MS * 0.8), 0, 1)
    );
    return;
  }

  drawCollapseDust(ctx, fort, age, seed);

  if (scene.standing && age < COLLAPSE_STAND_MS) {
    const local = clampValue(age / COLLAPSE_STAND_MS, 0, 1);
    const shake = Math.sin(age * 0.11) * (1.1 + local * 1.5);
    ctx.save();
    // Fade only at the very end so the wall is clearly seen standing first.
    ctx.globalAlpha = age > 150 ? 1 - clampValue((age - 150) / (COLLAPSE_STAND_MS - 150), 0, 1) : 1;
    ctx.translate(shake, Math.sin(age * 0.17) * 0.6);
    drawDefenseFort(ctx, fort, receipt.previousOwner, undefined, scene.palette);
    ctx.restore();

    // Real fissures on the wall before it lets go.
    if (age > 60) {
      const crackAlpha = clampValue((age - 60) / 120, 0, 1) * 0.75;
      ctx.save();
      ctx.globalAlpha = crackAlpha;
      ctx.strokeStyle = STONE_EDGE;
      ctx.lineWidth = 0.8;
      for (let i = 0; i < 3; i += 1) {
        const cx = fort.x + fort.width * (0.24 + i * 0.26);
        ctx.beginPath();
        ctx.moveTo(cx, fort.y + 1);
        ctx.lineTo(cx + (noise(seed, i + 21) - 0.5) * 4, fort.y + fort.height * 0.55);
        ctx.lineTo(cx + (noise(seed, i + 23) - 0.5) * 5, fort.y + fort.height);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawCollapseChunks(ctx, fort, age, seed);
  if (fort.level === 2) drawCollapseTower(ctx, fort, age, seed);
  drawCollapsePennant(ctx, fort, accent, age, seed);
}
