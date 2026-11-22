/**
 * v1.2 match speed (0.75x / 1x / 1.25x).
 *
 * Pure, DOM-free model shared by the setup screen, the in-match HUD, the pause
 * overlay and the shell's simulation loop. Only the shell owns the accumulator;
 * this module decides how much simulated time one animation frame is worth and
 * how a stored/new-player default is resolved.
 *
 * Fairness rules that depend on speed live in `v120-challenge-policy.ts`: the
 * speed itself never changes the core simulation, only how many fixed 100 ms
 * ticks are fed to it per real second.
 */

export type MatchSpeed = 0.75 | 1 | 1.25;

export const MATCH_SPEEDS: readonly MatchSpeed[] = [0.75, 1, 1.25];

/** Longest real-time gap a single frame may claim before the clamp. */
export const MAX_FRAME_ELAPSED_MS = 300;

/**
 * New single-player installs start on the slower pace; an archive created by an
 * earlier version (settings stored but no speed field) keeps the historical 1x.
 */
export const NEW_PLAYER_SPEED: MatchSpeed = 0.75;
export const LEGACY_SPEED: MatchSpeed = 1;

export const SPEED_LABELS: Record<MatchSpeed, string> = {
  0.75: '0.75×',
  1: '1×',
  1.25: '1.25×',
};

export const SPEED_TAGLINES: Record<MatchSpeed, string> = {
  0.75: '慢速 · 从容布阵',
  1: '标准 · 经典节奏',
  1.25: '快速 · 分秒必争',
};

export function isMatchSpeed(value: unknown): value is MatchSpeed {
  return value === 0.75 || value === 1 || value === 1.25;
}

/** Strict parser for untrusted input (storage, challenge payloads, query). */
export function parseMatchSpeed(value: unknown): MatchSpeed | null {
  if (isMatchSpeed(value)) return value;
  if (typeof value === 'number' && isFinite(value)) {
    for (let i = 0; i < MATCH_SPEEDS.length; i += 1) {
      if (Math.abs(MATCH_SPEEDS[i] - value) < 0.001) return MATCH_SPEEDS[i];
    }
  }
  return null;
}

/** Total order for the segmented control (slow -> fast). */
export function speedIndex(speed: MatchSpeed): number {
  return MATCH_SPEEDS.indexOf(speed);
}

export function stepSpeed(speed: MatchSpeed, direction: -1 | 1): MatchSpeed {
  const index = speedIndex(speed);
  const next = Math.max(0, Math.min(MATCH_SPEEDS.length - 1, index + direction));
  return MATCH_SPEEDS[next];
}

export type SpeedSource = 'stored' | 'new-player' | 'legacy-archive' | 'fallback';

export interface ResolveSpeedInput {
  /** Speed persisted by v1.2+, if any. Unknown/missing means "not stored". */
  storedSpeed?: unknown;
  /**
   * True when the settings key existed at all. An existing archive without a
   * speed field is a v1.0/v1.1 save and keeps 1x; a first launch has no key.
   */
  hasStoredSettings: boolean;
}

export interface ResolvedSpeed {
  speed: MatchSpeed;
  source: SpeedSource;
}

/**
 * "New user" means no stored settings at all. An archive from an older build
 * (settings present, speed absent) must not silently start slower: replaying a
 * familiar pace is part of keeping existing players' habits.
 */
export function resolveInitialSpeed(input: ResolveSpeedInput): ResolvedSpeed {
  const stored = parseMatchSpeed(input.storedSpeed);
  if (stored !== null) return { speed: stored, source: 'stored' };
  if (input.storedSpeed !== undefined && input.storedSpeed !== null) {
    // Present but invalid: keep the historical pace instead of silently
    // treating a damaged field as a brand-new player.
    return { speed: LEGACY_SPEED, source: 'fallback' };
  }
  return input.hasStoredSettings
    ? { speed: LEGACY_SPEED, source: 'legacy-archive' }
    : { speed: NEW_PLAYER_SPEED, source: 'new-player' };
}

export interface SimulationStepOptions {
  /** Fixed core step in milliseconds (100 ms = 10 ticks per second). */
  fixedDtMs: number;
  /** 0.75 / 1 / 1.25; the core itself always sees fixed steps. */
  speed: MatchSpeed;
  /**
   * Hard cap of core ticks per frame. This is the anti-spiral guard: after a
   * long stall the remainder is dropped instead of snowballing into more work
   * on the next frame.
   */
  maxStepsPerFrame: number;
  /** Optional elapsed clamp (defaults to MAX_FRAME_ELAPSED_MS). */
  maxElapsedMs?: number;
}

export interface SimulationStepPlan {
  /** Fixed core ticks to execute this frame. */
  steps: number;
  /** Accumulator to carry into the next frame (always < fixedDtMs). */
  accumulatorMs: number;
  /** Scaled simulation time that could not be simulated because of the cap. */
  droppedMs: number;
  /** Clamped, speed-scaled elapsed time added this frame. */
  scaledElapsedMs: number;
}

/**
 * Speed-scaled fixed-step accumulator.
 *
 * `elapsedMs` is real time since the previous frame. At 0.75x a 16 ms frame
 * buys 12 ms of simulation, at 1.25x it buys 20 ms; the core never receives a
 * partial tick. The remainder is preserved across frames, which is what keeps
 * slow speeds from rounding down to zero progress.
 */
export function planSimulationSteps(
  accumulatorMs: number,
  elapsedMs: number,
  options: SimulationStepOptions
): SimulationStepPlan {
  const fixed =
    isFinite(options.fixedDtMs) && options.fixedDtMs > 0 ? options.fixedDtMs : 100;
  const speed = isMatchSpeed(options.speed) ? options.speed : 1;
  const maxSteps = Math.max(
    1,
    Math.floor(
      isFinite(options.maxStepsPerFrame) ? options.maxStepsPerFrame : 3
    )
  );
  const maxElapsed =
    typeof options.maxElapsedMs === 'number' && isFinite(options.maxElapsedMs)
      ? Math.max(0, options.maxElapsedMs)
      : MAX_FRAME_ELAPSED_MS;

  let base =
    isFinite(accumulatorMs) && accumulatorMs > 0 ? accumulatorMs : 0;
  if (base >= fixed) {
    // A caller that hands us a leftover tick worth of backlog should have
    // simulated it; keep the invariant without looping here.
    base = fixed - 0.0001;
  }
  const safeElapsed = isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const clampedElapsed = Math.min(safeElapsed, maxElapsed);
  const scaledElapsed = clampedElapsed * speed;
  let accumulator = base + scaledElapsed;

  let steps = Math.floor(accumulator / fixed);
  let droppedMs = 0;
  if (steps > maxSteps) {
    droppedMs = (steps - maxSteps) * fixed;
    steps = maxSteps;
    // Drop the excess entirely: carrying it would execute those ticks next
    // frame and turn one stall into a permanently lagging match.
    accumulator = accumulator - droppedMs;
  }
  accumulator -= steps * fixed;
  if (accumulator < 0) accumulator = 0;

  return {
    steps: steps,
    accumulatorMs: accumulator,
    droppedMs: droppedMs,
    scaledElapsedMs: scaledElapsed,
  };
}

/**
 * Progress of the current fixed step for render interpolation. Identical to
 * the legacy `accumulator / FIXED_DT_MS`, clamped defensively.
 */
export function stepAlpha(accumulatorMs: number, fixedDtMs: number): number {
  const fixed = isFinite(fixedDtMs) && fixedDtMs > 0 ? fixedDtMs : 100;
  const value = isFinite(accumulatorMs) ? accumulatorMs / fixed : 0;
  return Math.max(0, Math.min(1, value));
}

export interface SpeedChangeRecord {
  /** Speed the match started with (never changes after the countdown). */
  initial: MatchSpeed;
  current: MatchSpeed;
  /** True once any change happened; makes the result practice-only. */
  changed: boolean;
  /** Monotonic count of accepted changes (diagnostics + settlement). */
  changes: number;
}

/** Alias used by the shell's session state; identical shape. */
export type SpeedRecord = SpeedChangeRecord;

export function createSpeedRecord(initial: MatchSpeed): SpeedChangeRecord {
  return { initial: initial, current: initial, changed: false, changes: 0 };
}

/**
 * Applies a requested speed. Returns false (and changes nothing) when the
 * request cannot be honoured: a challenge locks its speed for the whole match.
 */
export function applySpeedChange(
  record: SpeedChangeRecord,
  next: MatchSpeed,
  options?: { locked?: boolean }
): boolean {
  if (options && options.locked) return false;
  if (!isMatchSpeed(next)) return false;
  if (next === record.current) return false;
  record.current = next;
  record.changed = true;
  record.changes += 1;
  return true;
}

/** HUD copy: "标准 1× · 整局固定" or "慢速 0.75× · 已切速（不计排名）". */
export function speedStatusText(record: SpeedChangeRecord, locked: boolean): string {
  const label = SPEED_LABELS[record.current];
  if (locked) return label + ' · 挑战锁定';
  if (record.changed) {
    return label + ' · 已切速（本局练习）';
  }
  return label;
}

/** Bare multiplier label for the in-match HUD chip. */
export function speedLabel(speed: MatchSpeed): string {
  return SPEED_LABELS[isMatchSpeed(speed) ? speed : 1];
}

/** Alias kept descriptive at call sites that create a fresh match record. */
export function createMatchSpeedRecord(initial: MatchSpeed): SpeedChangeRecord {
  return createSpeedRecord(initial);
}

/**
 * Catch-up budget per frame, derived from the accepted frame window.
 *
 * The cap must cover `MAX_FRAME_ELAPSED_MS * speed` PLUS one carried step, or a
 * low frame rate systematically discards scaled time: at 0.75x with a cap of 2,
 * four 300 ms frames produced 8 ticks instead of 9 (an effective 0.67x). The
 * formula gives 3 steps at 0.75x and 1x, 4 at 1.25x, so a legal frame never
 * loses time while a real stall still stops at a small, bounded CPU budget.
 */
export function maxCatchUpStepsFor(
  speed: MatchSpeed,
  fixedDtMs: number = 100
): number {
  const fixed = isFinite(fixedDtMs) && fixedDtMs > 0 ? fixedDtMs : 100;
  const rate = isMatchSpeed(speed) ? speed : 1;
  return Math.max(1, Math.ceil((MAX_FRAME_ELAPSED_MS * rate) / fixed));
}
