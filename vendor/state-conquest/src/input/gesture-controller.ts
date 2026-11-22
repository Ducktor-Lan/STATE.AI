import type { PlannedMovement, MoveRouteInspection } from '../game-api';

export type GesturePhase = 'idle' | 'holding' | 'dragging';
export type GesturePointerType = 'pointer' | 'touch' | 'mouse';
/** Owner bound to a pointer when its press starts on a territory. */
export type GestureOwner = 'player' | 'ai1' | 'ai2' | 'ai3' | 'neutral';
export type GestureCancelReason =
  | 'multi-touch'
  | 'pointer-cancel'
  | 'blank'
  | 'illegal'
  | 'rejected'
  | 'source-lost'
  | 'resize'
  | 'blur'
  | 'pause'
  | 'status'
  | 'superseded';

export interface GestureDispatch {
  available: number;
  reserve: number;
  sent: number;
  remaining: number;
}

export interface GestureEvaluation extends GestureDispatch {
  ok: boolean;
  reason?: string;
  forecast?: string;
  plannedMovement?: PlannedMovement;
  route?: MoveRouteInspection;
  travelTicks?: number;
}

export interface GestureState {
  phase: GesturePhase;
  pointerId: number | null;
  pointerType: GesturePointerType | null;
  /** Owner of the territory the press started on (versus binds one per finger). */
  owner: GestureOwner | null;
  sourceId: string | null;
  targetId: string | null;
  targetOk: boolean;
  targetReason: string | null;
  targetForecast: string | null;
  targetPlannedMovement: PlannedMovement | null;
  targetRoute?: MoveRouteInspection | null;
  targetTravelTicks: number;
  targetSent: number;
  targetRemaining: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  holdMs: number;
  ratio: number;
  frozen: boolean;
  sent: number;
  remaining: number;
  available: number;
  reserve: number;
}

export interface GestureCallbacks {
  isPlaying(): boolean;
  findTerritory(x: number, y: number): string | null;
  /** Owner lookup for the pressed territory (versus uses this to bind a side). */
  ownerOfTerritory?(territoryId: string): GestureOwner | null;
  canHold(territoryId: string, owner?: GestureOwner): boolean;
  plan(sourceId: string, ratio: number, owner?: GestureOwner): GestureDispatch;
  evaluate(
    sourceId: string,
    targetId: string,
    ratio: number,
    owner?: GestureOwner
  ): GestureEvaluation;
  commit(
    sourceId: string,
    targetId: string,
    ratio: number,
    owner?: GestureOwner
  ): boolean;
  select(territoryId: string): void;
  /** `sourceId` identifies the cancelled slot's origin (versus flash feedback). */
  cancel(reason: GestureCancelReason, detail?: string, sourceId?: string | null): void;
  change(state: GestureState): void;
}

export interface GestureOptions {
  minRatio?: number;
  fullHoldMs?: number;
  dragThreshold?: number;
  /**
   * When true, every pointerId owns an independent state machine (local
   * versus). When false/omitted the controller keeps the original single-finger
   * contract: a second finger cancels the active order.
   */
  multiPointer?: boolean;
}

export function holdRatio(
  elapsedMs: number,
  minRatio: number = 0.2,
  fullHoldMs: number = 1000
): number {
  if (!isFinite(elapsedMs) || elapsedMs <= 0) return minRatio;
  const span = 1 - minRatio;
  const progress = Math.min(1, elapsedMs / fullHoldMs);
  return minRatio + span * progress;
}

export function idleGestureState(): GestureState {
  return {
    phase: 'idle',
    pointerId: null,
    pointerType: null,
    owner: null,
    sourceId: null,
    targetId: null,
    targetOk: false,
    targetReason: null,
    targetForecast: null,
    targetPlannedMovement: null,
        targetRoute: null,
    targetTravelTicks: 0,
    targetSent: 0,
    targetRemaining: 0,
    startX: 0,
    startY: 0,
    x: 0,
    y: 0,
    holdMs: 0,
    ratio: 0,
    frozen: false,
    sent: 0,
    remaining: 0,
    available: 0,
    reserve: 0,
  };
}

function sameDispatch(a: GestureDispatch, b: GestureDispatch): boolean {
  return (
    a.available === b.available &&
    a.reserve === b.reserve &&
    a.sent === b.sent &&
    a.remaining === b.remaining
  );
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

interface PointerSlot {
  key: string;
  state: GestureState;
  holdStartMs: number;
}

/**
 * Pure gesture state machine. DOM event binding lives in pointer-binding.ts;
 * all time is injected so unit tests use exact hold durations.
 *
 * The default mode is the original single-finger machine. `multiPointer: true`
 * gives each pointerId its own slot, so two players can charge and drag at the
 * same time without cancelling or overwriting each other. The owner of the
 * territory a press starts on is frozen into that slot: every later preview and
 * commit is evaluated as that owner.
 */
export class GestureController {
  private readonly callbacks: GestureCallbacks;
  private readonly minRatio: number;
  private readonly fullHoldMs: number;
  private readonly dragThreshold: number;
  private readonly multiPointer: boolean;
  private readonly slots: Map<string, PointerSlot> = new Map();
  private primaryKey: string | null = null;

  constructor(callbacks: GestureCallbacks, options?: GestureOptions) {
    this.callbacks = callbacks;
    const opts = options || {};
    this.minRatio = typeof opts.minRatio === 'number' ? opts.minRatio : 0.2;
    this.fullHoldMs = typeof opts.fullHoldMs === 'number' ? opts.fullHoldMs : 1000;
    this.dragThreshold = typeof opts.dragThreshold === 'number' ? opts.dragThreshold : 10;
    this.multiPointer = opts.multiPointer === true;
  }

  isMultiPointer(): boolean {
    return this.multiPointer;
  }

  getState(): GestureState {
    const slot = this.primaryKey !== null ? this.slots.get(this.primaryKey) : undefined;
    if (slot) return slot.state;
    const first = this.firstSlot();
    return first ? first.state : idleGestureState();
  }

  /** All active pointer machines (versus HUD/dev hooks); empty in solo idle. */
  getStates(): GestureState[] {
    const out: GestureState[] = [];
    this.slots.forEach(function (slot) {
      out.push(slot.state);
    });
    return out;
  }

  getStateFor(pointerId: number): GestureState | null {
    const slot = this.slotFor(pointerId);
    return slot ? slot.state : null;
  }

  isPointerActive(pointerId: number): boolean {
    return this.slotFor(pointerId) !== null;
  }

  isActive(): boolean {
    return this.slots.size > 0;
  }

  isDragging(): boolean {
    let dragging = false;
    this.slots.forEach(function (slot) {
      if (slot.state.phase === 'dragging') dragging = true;
    });
    return dragging;
  }

  begin(
    x: number,
    y: number,
    pointerId: number,
    pointerType: GesturePointerType,
    timeMs: number
  ): boolean {
    if (this.multiPointer) {
      // A duplicate pointerId means the previous machine for that finger is
      // stale (missed pointerup). Cancel it explicitly so every abandoned slot
      // is observable, then start the new one instead of failing silently.
      const previous = this.slotFor(pointerId);
      if (previous) this.cancelSlot(previous, 'superseded');
    } else if (this.slots.size > 0) {
      const active = this.firstSlot();
      if (
        active &&
        active.state.pointerId === pointerId &&
        active.state.pointerType === pointerType
      ) {
        return false;
      }
      this.cancel('multi-touch');
      return false;
    }
    if (!this.callbacks.isPlaying()) return false;

    const territoryId = this.callbacks.findTerritory(x, y);
    if (!territoryId) return false;
    const owner = this.ownerFor(territoryId);
    if (!this.callbacks.canHold(territoryId, owner || undefined)) return false;

    const ratio = this.minRatio;
    const plan = this.callbacks.plan(territoryId, ratio, owner || undefined);
    const state: GestureState = {
      phase: 'holding',
      pointerId: pointerId,
      pointerType: pointerType,
      owner: owner,
      sourceId: territoryId,
      targetId: null,
      targetOk: false,
      targetReason: null,
      targetForecast: null,
      targetPlannedMovement: null,
        targetRoute: null,
      targetTravelTicks: 0,
      targetSent: 0,
      targetRemaining: 0,
      startX: x,
      startY: y,
      x: x,
      y: y,
      holdMs: 0,
      ratio: ratio,
      frozen: false,
      sent: plan.sent,
      remaining: plan.remaining,
      available: plan.available,
      reserve: plan.reserve,
    };
    const key = this.keyFor(pointerId, pointerType);
    this.slots.set(key, { key: key, state: state, holdStartMs: timeMs });
    this.primaryKey = key;
    this.callbacks.select(territoryId);
    this.callbacks.change(state);
    return true;
  }

  move(x: number, y: number, pointerId: number, timeMs: number): void {
    const slot = this.slotFor(pointerId);
    if (!slot) return;
    this.moveSlot(slot, x, y, timeMs);
  }

  end(x: number, y: number, pointerId: number, timeMs: number): boolean {
    const slot = this.slotFor(pointerId);
    if (!slot) return false;

    this.moveSlot(slot, x, y, timeMs);
    // A validation failure inside moveSlot (status/source lost/NaN) removed
    // the slot; never commit from its stale state.
    if (!this.slots.get(slot.key)) return false;

    const current = slot.state;
    if (current.phase === 'idle') return false;

    if (current.phase === 'holding') {
      this.resetSlot(slot, true);
      return true;
    }

    const targetId = current.targetId;
    if (!targetId) {
      this.cancelSlot(slot, 'blank');
      return false;
    }
    if (!current.targetOk) {
      this.cancelSlot(slot, 'illegal', current.targetReason || undefined);
      return false;
    }

    const committed = this.callbacks.commit(
      current.sourceId as string,
      targetId,
      current.ratio,
      current.owner || undefined
    );
    if (!committed) {
      this.cancelSlot(slot, 'rejected', current.targetReason || undefined);
      return false;
    }
    this.resetSlot(slot, true);
    return true;
  }

  /** Called by the render loop so a long hold keeps charging without pointer moves. */
  update(timeMs: number): void {
    if (this.slots.size === 0) return;
    const slots: PointerSlot[] = [];
    this.slots.forEach(function (slot) {
      slots.push(slot);
    });
    for (let i = 0; i < slots.length; i += 1) {
      this.updateSlot(slots[i], timeMs);
    }
  }

  /** Re-evaluate plan/target after the simulation advances a tick. */
  refresh(): void {
    const slots: PointerSlot[] = [];
    this.slots.forEach(function (slot) {
      slots.push(slot);
    });
    for (let i = 0; i < slots.length; i += 1) {
      this.refreshSlot(slots[i]);
    }
  }

  /** Aborts every active pointer (pause, blur, resize, external cancel). */
  cancel(reason: GestureCancelReason, detail?: string): void {
    if (this.slots.size === 0) return;
    this.slots.clear();
    this.primaryKey = null;
    this.callbacks.cancel(reason, detail, null);
    this.callbacks.change(idleGestureState());
  }

  /** Aborts only the machine owned by this pointer (pointercancel). */
  cancelPointer(pointerId: number, reason: GestureCancelReason, detail?: string): void {
    const slot = this.slotFor(pointerId);
    if (!slot) return;
    this.cancelSlot(slot, reason, detail);
  }

  private moveSlot(slot: PointerSlot, x: number, y: number, timeMs: number): void {
    if (!isFinite(x) || !isFinite(y)) {
      this.cancelSlot(slot, 'pointer-cancel');
      return;
    }
    if (!this.callbacks.isPlaying()) {
      this.cancelSlot(slot, 'status');
      return;
    }
    const sourceId = slot.state.sourceId;
    if (!sourceId) {
      this.cancelSlot(slot, 'source-lost');
      return;
    }
    const owner = slot.state.owner || undefined;
    if (!this.callbacks.canHold(sourceId, owner)) {
      this.cancelSlot(slot, 'source-lost');
      return;
    }

    const draggedNow =
      distance(slot.state.startX, slot.state.startY, x, y) >= this.dragThreshold;
    let next: GestureState = { ...slot.state, x: x, y: y };

    if (next.phase === 'holding') {
      next.holdMs = Math.max(0, timeMs - slot.holdStartMs);
      if (draggedNow) {
        next.phase = 'dragging';
        next.frozen = true;
        next.ratio = holdRatio(next.holdMs, this.minRatio, this.fullHoldMs);
        const plan = this.callbacks.plan(sourceId, next.ratio, owner);
        next = this.withPlan(next, plan);
      } else {
        next.ratio = holdRatio(next.holdMs, this.minRatio, this.fullHoldMs);
        const plan = this.callbacks.plan(sourceId, next.ratio, owner);
        next = this.withPlan(next, plan);
      }
    }

    if (next.phase === 'dragging') {
      const hit = this.callbacks.findTerritory(x, y);
      const targetId = hit && hit !== sourceId ? hit : null;
      if (targetId !== next.targetId) {
        next = this.withTarget(next, sourceId, targetId, owner);
      }
    }

    this.applySlot(slot, next, true);
  }

  private updateSlot(slot: PointerSlot, timeMs: number): void {
    if (!this.callbacks.isPlaying()) {
      this.cancelSlot(slot, 'status');
      return;
    }
    const sourceId = slot.state.sourceId;
    const owner = slot.state.owner || undefined;
    if (!sourceId || !this.callbacks.canHold(sourceId, owner)) {
      this.cancelSlot(slot, 'source-lost');
      return;
    }
    if (slot.state.phase !== 'holding') return;

    const holdMs = Math.max(0, timeMs - slot.holdStartMs);
    const ratio = holdRatio(holdMs, this.minRatio, this.fullHoldMs);
    const plan = this.callbacks.plan(sourceId, ratio, owner);
    if (Math.abs(ratio - slot.state.ratio) < 0.0005 && sameDispatch(plan, slot.state)) {
      return;
    }
    const next = this.withPlan({ ...slot.state, holdMs: holdMs, ratio: ratio }, plan);
    this.applySlot(slot, next, true);
  }

  private refreshSlot(slot: PointerSlot): void {
    const sourceId = slot.state.sourceId;
    if (!sourceId) return;
    const owner = slot.state.owner || undefined;
    if (!this.callbacks.canHold(sourceId, owner)) {
      this.cancelSlot(slot, 'source-lost');
      return;
    }
    const plan = this.callbacks.plan(sourceId, slot.state.ratio, owner);
    let next = this.withPlan(slot.state, plan);
    if (next.phase === 'dragging' && next.targetId) {
      next = this.withTarget(next, sourceId, next.targetId, owner);
    }
    this.applySlot(slot, next, false);
  }

  private ownerFor(territoryId: string): GestureOwner | null {
    if (!this.callbacks.ownerOfTerritory) return null;
    return this.callbacks.ownerOfTerritory(territoryId);
  }

  private keyFor(pointerId: number, pointerType: GesturePointerType): string {
    return pointerType + ':' + pointerId;
  }

  private slotFor(pointerId: number): PointerSlot | null {
    let found: PointerSlot | null = null;
    this.slots.forEach(function (slot) {
      if (!found && slot.state.pointerId === pointerId) found = slot;
    });
    return found;
  }

  private firstSlot(): PointerSlot | null {
    let first: PointerSlot | null = null;
    this.slots.forEach(function (slot) {
      if (!first) first = slot;
    });
    return first;
  }

  private resetSlot(slot: PointerSlot, emit: boolean): void {
    this.slots.delete(slot.key);
    if (this.primaryKey === slot.key) {
      const next = this.firstSlot();
      this.primaryKey = next ? next.key : null;
    }
    if (emit) this.callbacks.change(this.getState());
  }

  private cancelSlot(
    slot: PointerSlot,
    reason: GestureCancelReason,
    detail?: string
  ): void {
    if (!this.slots.get(slot.key)) return;
    const sourceId = slot.state.sourceId;
    this.resetSlot(slot, false);
    this.callbacks.cancel(reason, detail, sourceId);
    this.callbacks.change(this.getState());
  }

  private withPlan(state: GestureState, plan: GestureDispatch): GestureState {
    return {
      ...state,
      sent: plan.sent,
      remaining: plan.remaining,
      available: plan.available,
      reserve: plan.reserve,
    };
  }

  private withTarget(
    state: GestureState,
    sourceId: string,
    targetId: string | null,
    owner?: GestureOwner
  ): GestureState {
    if (!targetId) {
      return {
        ...state,
        targetId: null,
        targetOk: false,
        targetReason: null,
        targetForecast: null,
        targetPlannedMovement: null,
        targetRoute: null,
        targetTravelTicks: 0,
        targetSent: 0,
        targetRemaining: 0,
      };
    }
    const evaluation = this.callbacks.evaluate(sourceId, targetId, state.ratio, owner);
    return {
      ...state,
      targetId: targetId,
      targetOk: evaluation.ok,
      targetReason: evaluation.ok ? null : evaluation.reason || 'invalid',
      targetForecast: evaluation.forecast || null,
      targetPlannedMovement: evaluation.plannedMovement || null,
      targetRoute: evaluation.route || null,
      targetTravelTicks: evaluation.travelTicks || 0,
      targetSent: evaluation.sent,
      targetRemaining: evaluation.remaining,
    };
  }

  private applySlot(slot: PointerSlot, next: GestureState, emit: boolean): void {
    slot.state = next;
    if (emit) this.callbacks.change(next);
  }
}
