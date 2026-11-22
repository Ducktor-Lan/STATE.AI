/**
 * v1.2 continuous dispatch ("兵线") — UI-side policy only.
 *
 * The simulation of a persistent line lives in the core (`core/fronts`) and is
 * advanced by the engine itself. This module contains no timer and never
 * re-issues moves: it only decides what a completed drag *means* against the
 * lines the core reports, and what the selection panel should offer.
 *
 * Drag contract (single mode, the default; continuous is opt-in per match):
 *   - single mode                                          => legacy one-shot
 *                                                            dispatch, no line
 *   - continuous mode:
 *     - own territory  -> target with no matching line    => create the line
 *     - same source    -> same target again               => stop that line
 *     - same source    -> another target                  => replace (stop old,
 *                                                            create new)
 *
 * Versus keeps the same rules per side; a line always belongs to the owner of
 * the territory the drag started on.
 */

import type { OwnerId } from './view-model';

export type DispatchMode = 'continuous' | 'single';
/** New matches always start with one-shot orders; continuous is an in-match choice. */
export const DEFAULT_DISPATCH_MODE: DispatchMode = 'single';

/** Which owner a line belongs to; neutral never owns one. */
export type LineOwner = 'player' | 'ai1';

/**
 * Structural view of one core front. Extra fields from the core are allowed and
 * ignored here, so the core contract can grow without touching this file.
 */
export interface FrontLineView {
  id: string;
  owner: LineOwner;
  sourceId: string;
  targetId: string;
  /** Dispatch ratio the line keeps sending (0..1). Informational here. */
  ratio?: number;
}

export interface LineDragInput {
  owner: OwnerId;
  sourceId: string;
  targetId: string;
  /** Ratio charged when the drag was released (continuous creation only). */
  ratio?: number;
}

export type LineDragAction = 'create' | 'stop' | 'replace' | 'none';

export interface LineDragPlan {
  action: LineDragAction;
  /** Lines the shell must stop before creating the replacement. */
  stopIds: string[];
  /** Source/target pair for the create step, when the action creates one. */
  create: { sourceId: string; targetId: string; ratio: number } | null;
  /** Short HUD copy; empty when the plan needs no narration. */
  notice: string;
}

function ownerOf(owner: OwnerId): LineOwner | null {
  if (owner === 'player') return 'player';
  if (owner === 'ai1') return 'ai1';
  return null;
}

function clampRatio(ratio: number | undefined): number {
  if (typeof ratio !== 'number' || !isFinite(ratio)) return 0.5;
  return Math.max(0.05, Math.min(1, ratio));
}

function linesForOwner(lines: readonly FrontLineView[], owner: LineOwner): FrontLineView[] {
  const out: FrontLineView[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].owner === owner) out.push(lines[i]);
  }
  return out;
}

export function findLine(
  lines: readonly FrontLineView[],
  owner: LineOwner,
  sourceId: string,
  targetId: string
): FrontLineView | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.owner === owner && line.sourceId === sourceId && line.targetId === targetId) {
      return line;
    }
  }
  return null;
}

/** Lines a drag would replace: same source, a different target. */
export function conflictingLines(
  lines: readonly FrontLineView[],
  owner: LineOwner,
  sourceId: string,
  targetId: string
): FrontLineView[] {
  const out: FrontLineView[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.owner !== owner || line.sourceId !== sourceId) continue;
    if (line.targetId !== targetId) out.push(line);
  }
  return out;
}

/**
 * One completed drag in continuous mode. The shell executes the plan in order:
 * stop every `stopIds` entry, then create `create` when present. Any refusal
 * (source lost, target illegal) is decided by the core at execution time; this
 * plan only encodes the user's intent.
 */
export function planLineDrag(
  lines: readonly FrontLineView[],
  input: LineDragInput
): LineDragPlan {
  const owner = ownerOf(input.owner);
  if (!owner) {
    return { action: 'none', stopIds: [], create: null, notice: '' };
  }
  if (input.sourceId === input.targetId) {
    return { action: 'none', stopIds: [], create: null, notice: '' };
  }

  const same = findLine(lines, owner, input.sourceId, input.targetId);
  if (same) {
    return {
      action: 'stop',
      stopIds: [same.id],
      create: null,
      notice: '兵线已停止',
    };
  }

  const conflicts = conflictingLines(lines, owner, input.sourceId, input.targetId);
  const create = {
    sourceId: input.sourceId,
    targetId: input.targetId,
    ratio: clampRatio(input.ratio),
  };
  if (conflicts.length > 0) {
    return {
      action: 'replace',
      stopIds: conflicts.map(function (line) {
        return line.id;
      }),
      create: create,
      notice: '兵线已改道',
    };
  }
  return {
    action: 'create',
    stopIds: [],
    create: create,
    notice: '兵线已建立 · 再次拖向同一目标可停止',
  };
}

export interface LineStopTarget {
  id: string;
  sourceId: string;
  targetId: string;
  /** 'source' when the selected territory is sending, 'target' when it is hit. */
  role: 'source' | 'target';
}

/**
 * Stoppable lines for the current selection. A selected territory exposes both
 * the lines it sends and the lines aimed at it, so "selected, then tap stop"
 * always reaches every line that involves that territory.
 */
export function lineStopTargets(
  lines: readonly FrontLineView[],
  owner: LineOwner,
  selectedId: string | null
): LineStopTarget[] {
  if (!selectedId) return [];
  const out: LineStopTarget[] = [];
  const own = linesForOwner(lines, owner);
  for (let i = 0; i < own.length; i += 1) {
    const line = own[i];
    if (line.sourceId === selectedId) {
      out.push({
        id: line.id,
        sourceId: line.sourceId,
        targetId: line.targetId,
        role: 'source',
      });
    } else if (line.targetId === selectedId) {
      out.push({
        id: line.id,
        sourceId: line.sourceId,
        targetId: line.targetId,
        role: 'target',
      });
    }
  }
  return out;
}

/**
 * Panel copy for the selection. `sendCount` / `incomingCount` drive the compact
 * two-chip summary; `hint` is the always-visible instruction that makes the
 * stop button discoverable.
 *
 * Only OUTGOING lines are stoppable: an incoming line belongs to the attacker,
 * so offering "stop incoming" would be a button that can never work.
 */
export interface LineSelectionSummary {
  sendCount: number;
  incomingCount: number;
  hint: string;
  /** Label for the stop button, or null when this selection owns no line. */
  stopLabel: string | null;
}

export function summarizeSelectionLines(
  targets: readonly LineStopTarget[]
): LineSelectionSummary {
  let sendCount = 0;
  let incomingCount = 0;
  for (let i = 0; i < targets.length; i += 1) {
    if (targets[i].role === 'source') sendCount += 1;
    else incomingCount += 1;
  }
  if (sendCount === 0 && incomingCount === 0) {
    return {
      sendCount: 0,
      incomingCount: 0,
      hint: '拖向接壤目标建立兵线 · 再拖同目标可停止',
      stopLabel: null,
    };
  }
  const parts: string[] = [];
  if (sendCount > 0) parts.push('发出 ' + sendCount + ' 条');
  if (incomingCount > 0) parts.push('受攻 ' + incomingCount + ' 条');
  return {
    sendCount: sendCount,
    incomingCount: incomingCount,
    hint:
      '选中领地的兵线 · ' + parts.join(' · ') + (
        sendCount > 0 ? ' · 可随时停止' : ' · 来袭兵线由敌方控制'
      ),
    stopLabel: sendCount > 0 ? '停止兵线' : null,
  };
}

/** Mode toggle copy shared by the HUD and the pause overlay. */
export function dispatchModeLabel(mode: DispatchMode): string {
  return mode === 'continuous' ? '连续派兵' : '单次派兵';
}

export function dispatchModeHint(mode: DispatchMode): string {
  return mode === 'continuous'
    ? '拖向接壤目标建立兵线，自动持续增援'
    : '按住蓄力，拖向接壤目标派出一次';
}

/**
 * Hint for a selection that owns no line while the bar is idle. Mode-aware:
 * single mode must never repeat the continuous "建立兵线" copy, and when live
 * lines exist elsewhere it must say the drag only sends once — stopping those
 * lines stays with the visible stop button, never the mode switch.
 */
export function idleSelectionHint(
  mode: DispatchMode,
  frontsAvailable: boolean,
  lineCount: number
): string {
  if (!frontsAvailable) {
    return mode === 'continuous'
      ? plainLineNotice('continuous')
      : dispatchModeHint('single');
  }
  if (mode === 'continuous') return dispatchModeHint('continuous');
  return lineCount > 0
    ? '已有兵线继续 · 当前拖拽仅派一次'
    : dispatchModeHint('single');
}

/**
 * Line ids that must be dropped when a match is paused/restarted/left. The
 * core owns the actual state; the UI only needs the ids to clear its own
 * per-line view cache (and to prove restart releases every line).
 */
export function lineIds(lines: readonly FrontLineView[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) out.push(lines[i].id);
  return out;
}

/**
 * Copy for an adapter that has no front API yet. The UI states the real
 * limitation instead of silently pretending continuous mode exists.
 */
export function plainLineNotice(mode: DispatchMode): string {
  if (mode === 'single') return '';
  return '当前核心版本不支持兵线 · 已按单次派兵执行';
}

/**
 * Drag legality for continuous mode.
 *
 * The one-shot preview rejects `no_troops` because a single dispatch with
 * nothing to send is meaningless. A line is different by design: it waits at
 * the source until troops accumulate, so an empty source (or one that can only
 * cover the reserve) must still be able to start, re-target or stop a line.
 * Every other refusal — wrong owner, self target, no passable route, wrong
 * status — stays a real refusal.
 */
export interface FrontPreviewVerdict {
  ok: boolean;
  reason?: string;
}

export function frontPreviewVerdict(preview: {
  ok: boolean;
  reason?: string | null;
}): FrontPreviewVerdict {
  if (preview.ok) return { ok: true };
  if (preview.reason === 'no_troops') return { ok: true };
  return { ok: false, reason: preview.reason || 'invalid' };
}

/**
 * Full drag evaluation for continuous mode. A drag onto the line's own target
 * is the documented stop gesture, so it is always legal (the core stops without
 * consulting troop levels). Otherwise the one-shot preview is used only as a
 * legality oracle, with `no_troops` downgraded by `frontPreviewVerdict`.
 */
export function evaluateFrontDrag(input: {
  /** A line from this exact source to this exact target already exists. */
  sameLineExists: boolean;
  preview: { ok: boolean; reason?: string | null };
}): FrontPreviewVerdict {
  if (input.sameLineExists) return { ok: true };
  return frontPreviewVerdict(input.preview);
}

/** The exact preview shape the gesture controller evaluates against. */
export interface DispatchPreviewLike {
  ok: boolean;
  reason?: string | null;
  forecast?: string;
  plannedMovement?: unknown;
  travelTicks?: number;
  available: number;
  reserve: number;
  sent: number;
  remaining: number;
}

export interface DispatchEvaluation extends DispatchPreviewLike {
  ok: boolean;
}

/**
 * One drag, resolved for the current dispatch mode. This is the single place
 * the shell and the gesture controller agree on, so a low-troop source can
 * start/retarget/stop a line while a genuinely illegal target stays illegal.
 *
 * `frontsAvailable` is false when the core exposes no front API; the drag then
 * keeps the legacy one-shot semantics instead of pretending a line exists.
 */
export function evaluateDispatchDrag(input: {
  mode: DispatchMode;
  frontsAvailable: boolean;
  lines: readonly FrontLineView[];
  owner: LineOwner;
  sourceId: string;
  targetId: string;
  preview: DispatchPreviewLike;
}): DispatchEvaluation {
  const preview = input.preview;
  if (input.mode !== 'continuous' || !input.frontsAvailable) {
    return preview as DispatchEvaluation;
  }
  const sameLineExists =
    findLine(input.lines, input.owner, input.sourceId, input.targetId) !== null;
  const verdict = evaluateFrontDrag({ sameLineExists: sameLineExists, preview: preview });
  if (!verdict.ok) {
    return {
      ok: false,
      reason: verdict.reason,
      available: preview.available,
      reserve: preview.reserve,
      sent: preview.sent,
      remaining: preview.remaining,
    };
  }
  return {
    ok: true,
    reason: null,
    forecast: sameLineExists ? 'reinforce' : preview.forecast,
    plannedMovement: preview.plannedMovement,
    travelTicks: preview.travelTicks,
    available: preview.available,
    reserve: preview.reserve,
    sent: preview.sent,
    remaining: preview.remaining,
  };
}

/**
 * Structural port the shell uses against the core adapter. The core agent owns
 * `issueFront` / `stopFront` / `fronts`; the port keeps the shell independent of
 * the exact method names so both sides compile while the core lands.
 */
export interface FrontCommandView {
  ok: boolean;
  action: 'start' | 'replace' | 'stop' | 'none';
  frontId?: number | string;
  reason?: string;
}

export interface FrontsPort {
  /** Current lines, clones owned by the adapter. */
  lines(): FrontLineView[];
  /** One drag in continuous mode; the core decides start/replace/stop. */
  issueFront(
    owner: LineOwner,
    sourceId: string,
    targetId: string,
    ratio: number
  ): FrontCommandView;
  /** Stops every line leaving one source (owner-scoped). */
  stopFront(sourceId: string, owner: LineOwner): boolean;
  /** Stops every line involving one territory in either direction. */
  stopLinesForTerritory?(owner: LineOwner, territoryId: string): number;
}

function frontActionOf(value: unknown): 'start' | 'replace' | 'stop' | 'none' {
  if (value === 'start' || value === 'replace' || value === 'stop') return value;
  return 'none';
}

function ownLines(value: unknown): FrontLineView[] {
  const out: FrontLineView[] = [];
  if (!Array.isArray(value)) return out;
  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i] as Partial<FrontLineView> | null;
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.id !== 'string' && typeof raw.id !== 'number') continue;
    if (raw.owner !== 'player' && raw.owner !== 'ai1') continue;
    if (typeof raw.sourceId !== 'string' || typeof raw.targetId !== 'string') continue;
    out.push({
      id: String(raw.id),
      owner: raw.owner,
      sourceId: raw.sourceId,
      targetId: raw.targetId,
      ratio: typeof raw.ratio === 'number' ? raw.ratio : undefined,
    });
  }
  return out;
}

interface FrontsCapableAdapter {
  fronts?: () => unknown;
  view?: () => { fronts?: unknown };
  issueFront?: (sourceId: string, targetId: string, ratio: number) => unknown;
  issueFrontForOwner?: (
    owner: string,
    sourceId: string,
    targetId: string,
    ratio: number
  ) => unknown;
  stopFront?: (sourceId: string, owner?: string) => unknown;
}

/**
 * Builds the port from whatever the adapter actually exposes. Returns null
 * while the core has no front API at all, so the shell can fall back to the
 * legacy single dispatch and say so honestly instead of faking a line.
 */
export function createAdapterFrontsPort(adapter: unknown): FrontsPort | null {
  if (!adapter || typeof adapter !== 'object') return null;
  const io = adapter as FrontsCapableAdapter;
  const hasIssue = typeof io.issueFront === 'function';
  const hasOwnerIssue = typeof io.issueFrontForOwner === 'function';
  if (!hasIssue && !hasOwnerIssue) return null;

  function listLines(): FrontLineView[] {
    try {
      if (typeof io.fronts === 'function') return ownLines(io.fronts());
      if (typeof io.view === 'function') {
        const view = io.view();
        return view ? ownLines(view.fronts) : [];
      }
    } catch (error) {
      return [];
    }
    return [];
  }

  return {
    lines: listLines,
    issueFront: function (owner, sourceId, targetId, ratio) {
      let raw: unknown = null;
      try {
        raw = owner === 'ai1' && hasOwnerIssue && typeof io.issueFrontForOwner === 'function'
          ? io.issueFrontForOwner('ai1', sourceId, targetId, ratio)
          : typeof io.issueFront === 'function'
            ? io.issueFront(sourceId, targetId, ratio)
            : null;
      } catch (error) {
        return { ok: false, action: 'none', reason: 'invalid' };
      }
      if (!raw || typeof raw !== 'object') {
        return { ok: false, action: 'none', reason: 'invalid' };
      }
      const result = raw as { ok?: unknown; action?: unknown; frontId?: unknown; reason?: unknown };
      return {
        ok: result.ok === true,
        action: result.ok === true ? frontActionOf(result.action) : 'none',
        frontId:
          typeof result.frontId === 'number' || typeof result.frontId === 'string'
            ? result.frontId
            : undefined,
        reason: typeof result.reason === 'string' ? result.reason : undefined,
      };
    },
    stopFront: function (sourceId, owner) {
      if (typeof io.stopFront !== 'function') return false;
      try {
        const result =
          owner === 'ai1'
            ? io.stopFront(sourceId, 'ai1')
            : io.stopFront(sourceId);
        return result === true || (!!result && typeof result === 'object' && (result as { ok?: unknown }).ok === true);
      } catch (error) {
        return false;
      }
    },
  };
}

/** Narrowing helper for an optional adapter member without importing core. */
export function asFrontsPort(value: unknown): FrontsPort | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<FrontsPort>;
  if (typeof candidate.lines !== 'function') return null;
  if (typeof candidate.issueFront !== 'function') return null;
  if (typeof candidate.stopFront !== 'function') return null;
  return candidate as FrontsPort;
}
