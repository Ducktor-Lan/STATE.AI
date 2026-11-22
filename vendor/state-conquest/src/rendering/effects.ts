/**
 * Short-lived Canvas effect queue for the betrayal skill and the global
 * disaster. This module is DOM-free so the trigger/prune behaviour is unit
 * testable; the renderer only consumes the active entries.
 *
 * Cost model (low-end chrome61): an effect is allocated once per event and
 * lives in a fixed-capacity array. Per-frame work is a single in-place prune
 * plus index-derived particle positions, so no arrays/objects are created
 * while the effect plays. No callbacks or timers are registered here — an
 * effect is finished exactly when its age reaches `duration` and the next
 * `active()` call drops it.
 */
import { DISASTER_MAX_LOSS_RATIO } from '../config/balance';
import type { OwnerId } from '../ui/view-model';
import { BETRAYAL_EFFECT_MS } from './betrayal-effects';

export const DISASTER_EFFECT_MS = 2000;
export { BETRAYAL_EFFECT_MS };

/**
 * At most four overlapping effects; older betrayals are evicted first, while
 * disaster slots stay reserved so a strike is never starved out.
 */
const MAX_EFFECTS = 4;

export interface AffectedCell {
  id: string;
  loss: number;
  /** Precomputed "-N" copy, so drawing never builds strings. */
  label: string;
}

export interface DisasterEffect {
  kind: 'disaster';
  startedAt: number;
  duration: number;
  /** Epicenter in map coordinates (deterministic loss-weighted centroid). */
  x: number;
  y: number;
  seed: number;
  affected: AffectedCell[];
}

export interface BetrayalEffect {
  kind: 'betrayal';
  startedAt: number;
  duration: number;
  targetId: string;
  /** Optional short state label; the renderer falls back to view.shortName. */
  targetName?: string;
  previousOwner: OwnerId | null;
  /** Real pre-cast garrison / shield (optional for old callers). */
  beforeTroops?: number;
  beforeShield?: number;
  captured: boolean;
  /** Converted soldiers (receipt.removed). */
  removed: number;
  /** Surviving converted attackers (receipt.survivors), never a garrison. */
  survivors: number;
  afterOwner?: OwnerId | null;
  /** Real post-cast garrison from the after snapshot. */
  afterTroops?: number;
  afterShield?: number;
  seed: number;
}

export type ViewEffect = DisasterEffect | BetrayalEffect;

/** Minimal structural territory fields needed for a strike diff. */
export interface StrikeTerritory {
  id: string;
  center: [number, number];
  troops: number;
}

export interface DisasterStrikeInput {
  x: number;
  y: number;
  seed: number;
  affected: Array<{ id: string; loss: number }>;
}

/**
 * Compares the snapshot before and after the strike tick. Every cell whose
 * garrison shrank is reported; the epicenter is the loss-weighted centroid, so
 * the same match seed produces the same visual point. When no cell visibly
 * lost troops, the map centre is used as a neutral epiCentre.
 *
 * The disaster resolves first in a tick, then AI orders and upgrades settle,
 * so a cell's raw diff can combine disaster damage with a same-frame upgrade
 * cost or dispatched troops. A drop above the 20% disaster ceiling is not
 * discarded (that erased the whole cell's "-N"); the label is capped at the
 * ceiling instead, keeping every damaged cell visible.
 */
export function collectDisasterStrike(
  before: ReadonlyArray<StrikeTerritory>,
  after: ReadonlyArray<StrikeTerritory>,
  mapWidth: number,
  mapHeight: number,
  seed: number
): DisasterStrikeInput {
  const afterById: Record<string, StrikeTerritory> = {};
  for (let i = 0; i < after.length; i += 1) afterById[after[i].id] = after[i];
  const affected: Array<{ id: string; loss: number }> = [];
  let sumX = 0;
  let sumY = 0;
  let totalLoss = 0;
  for (let i = 0; i < before.length; i += 1) {
    const previous = before[i];
    const current = afterById[previous.id];
    if (!current) continue;
    const loss = previous.troops - current.troops;
    if (loss <= 0) continue;
    // Disaster damage is 10-20% per cell (core balance). Cap the displayed
    // loss at that ceiling so an exaggerated diff never prints a fake number,
    // while the cell still gets its float.
    const maxDisasterLoss = Math.max(
      1,
      Math.ceil(previous.troops * DISASTER_MAX_LOSS_RATIO)
    );
    const shownLoss = loss > maxDisasterLoss ? maxDisasterLoss : loss;
    affected.push({ id: previous.id, loss: shownLoss });
    sumX += previous.center[0] * shownLoss;
    sumY += previous.center[1] * shownLoss;
    totalLoss += shownLoss;
  }
  const fallbackX = isFinite(mapWidth) && mapWidth > 0 ? mapWidth / 2 : 0;
  const fallbackY = isFinite(mapHeight) && mapHeight > 0 ? mapHeight / 2 : 0;
  return {
    x: totalLoss > 0 ? sumX / totalLoss : fallbackX,
    y: totalLoss > 0 ? sumY / totalLoss : fallbackY,
    seed: seed,
    affected: affected,
  };
}

export class EffectQueue {
  private items: ViewEffect[] = [];

  enqueueDisaster(input: {
    startedAt: number;
    x: number;
    y: number;
    seed: number;
    affected: ReadonlyArray<{ id: string; loss: number }>;
  }): DisasterEffect {
    const affected: AffectedCell[] = [];
    for (let i = 0; i < input.affected.length; i += 1) {
      const cell = input.affected[i];
      affected.push({ id: cell.id, loss: cell.loss, label: '-' + cell.loss });
    }
    const effect: DisasterEffect = {
      kind: 'disaster',
      startedAt: input.startedAt,
      duration: DISASTER_EFFECT_MS,
      x: input.x,
      y: input.y,
      seed: input.seed,
      affected: affected,
    };
    this.push(effect);
    return effect;
  }

  enqueueBetrayal(input: {
    startedAt: number;
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
    const effect: BetrayalEffect = {
      kind: 'betrayal',
      startedAt: input.startedAt,
      duration: BETRAYAL_EFFECT_MS,
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
    };
    this.push(effect);
    return effect;
  }

  /** Returns the live array (pruned in place); never allocates per frame. */
  active(now: number): ViewEffect[] {
    this.prune(now);
    return this.items;
  }

  /** Drops finished effects in place and returns how many were removed. */
  prune(now: number): number {
    const items = this.items;
    let write = 0;
    for (let read = 0; read < items.length; read += 1) {
      const effect = items[read];
      const age = now - effect.startedAt;
      // A rAF timestamp can be a few milliseconds earlier than the
      // performance.now() used at enqueue. Keep the effect parked until a
      // later frame reaches its start; the draw paths already skip age < 0.
      if (age < effect.duration) {
        items[write] = effect;
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

  count(kind: ViewEffect['kind']): number {
    let total = 0;
    for (let i = 0; i < this.items.length; i += 1) {
      if (this.items[i].kind === kind) total += 1;
    }
    return total;
  }

  private push(effect: ViewEffect): void {
    const items = this.items;
    if (items.length < MAX_EFFECTS) {
      items.push(effect);
      return;
    }
    // Disaster effects own a reserved slot: betrayal eviction only targets
    // other betrayals, so a burst of captures cannot squeeze out the strike.
    // A disaster replaces the oldest betrayal; when the queue holds only
    // disasters it replaces the oldest disaster (same-kind replacement).
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].kind === 'betrayal') {
        items.splice(i, 1);
        items.push(effect);
        return;
      }
    }
    if (effect.kind === 'disaster') {
      items.shift();
      items.push(effect);
    }
    // All four slots hold disasters: a new betrayal is dropped, never a strike.
  }
}
