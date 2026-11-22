/**
 * Offline sound effects — a small Web Audio synthesizer with no assets.
 *
 * Design constraints:
 * - No audio files, no data: URIs, no network, no packages. Every effect is
 *   synthesized from short oscillator notes, so the bundled app stays tiny.
 * - `AudioContext` is feature-detected together with the legacy
 *   `webkitAudioContext` name used by old WebViews.
 * - Browsers start audio contexts suspended until a user gesture. `unlock()`
 *   must therefore be called synchronously from a pointer/click handler; it
 *   creates the context and requests `resume()` inside the same call stack.
 * - `play()` never queues and never throws. When the context is not running
 *   (autoplay gate, lifecycle pause, mute, unsupported browser) it returns
 *   false. A later `resume()` only re-enables future playback; skipped sounds
 *   are never replayed.
 * - resume()/suspend() promises settle later than the intent that produced
 *   them. A monotonically increasing intent sequence guards every async
 *   completion: a stale resolve/reject can neither flip the current pause state
 *   nor overwrite the newest error. One single-flight reconciler serializes
 *   opposite transitions, so "unlock then mute", "suspend while a resume is
 *   pending" and rapid toggling always end in the newest requested state.
 * - A context can suspend itself (browser interruption, backgrounding). Any
 *   non-running `statechange` severs scheduled notes, and every resume severs
 *   them again first, so a resumed context can never continue stale audio.
 *   Contexts without `statechange` support fall back to the pre-resume sever.
 * - Failures are reported through `lastError()` / `state()`; the service never
 *   pretends audio is available when it is not.
 *
 * The UI/settings/lifecycle wiring is intentionally not part of this module.
 */

export type SoundEvent =
  | 'tap'
  | 'march'
  | 'defend'
  | 'capture'
  | 'lost'
  | 'upgrade'
  | 'victory'
  | 'defeat';

export type SoundState =
  | 'idle'
  | 'suspended'
  | 'running'
  | 'disabled'
  | 'unavailable'
  | 'failed'
  | 'disposed';

export type SoundFailureStage = 'construct' | 'resume' | 'suspend' | 'play';

export interface SoundInitError {
  stage: SoundFailureStage;
  message: string;
}

/**
 * Minimal structural subset of the Web Audio API used by this module. Kept
 * free of lib.dom types so tests can inject a plain object and old WebViews
 * are not accidentally required to expose newer members.
 */
export interface SoundAudioParam {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime?: (value: number, time: number) => unknown;
  exponentialRampToValueAtTime?: (value: number, time: number) => unknown;
  cancelScheduledValues?: (time: number) => unknown;
}

export interface SoundOscillator {
  type: string;
  frequency: SoundAudioParam;
  onended: (() => void) | null;
  connect(target: unknown): unknown;
  disconnect?: () => void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface SoundGain {
  gain: SoundAudioParam;
  connect(target: unknown): unknown;
  disconnect?: () => void;
}

export interface SoundAudioContext {
  /** Missing on very old WebKit contexts: those are treated as running. */
  readonly state?: string;
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator(): SoundOscillator;
  createGain(): SoundGain;
  resume?: () => Promise<void> | void;
  suspend?: () => Promise<void> | void;
  close?: () => Promise<void> | void;
  /** Preferred state notification; `onstatechange` is the legacy fallback. */
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  onstatechange?: (() => void) | null;
}

export interface SoundServiceOptions {
  /** Defaults to true; false starts muted without creating a context. */
  enabled?: boolean;
  /** Master gain 0..1 applied once per context. Defaults to 0.35. */
  masterVolume?: number;
  /** Maximum simultaneously scheduled oscillators. Defaults to 12. */
  maxVoices?: number;
  /** Test seam; defaults to AudioContext/webkitAudioContext. */
  contextFactory?: () => SoundAudioContext | null;
  /** Monotonic millisecond clock used for throttling. Defaults to Date.now. */
  now?: () => number;
}

/** Every event key, in display order. */
export const SOUND_EVENTS: readonly SoundEvent[] = [
  'tap',
  'march',
  'defend',
  'capture',
  'lost',
  'upgrade',
  'victory',
  'defeat',
];

/**
 * This module deliberately knows nothing about core match events: the shell
 * layer maps them to these keys (`capture` events include AI captures, so only
 * the caller can tell a 'capture' from a 'lost' cue by owner).
 */

interface SoundNote {
  wave: string;
  freq: number;
  endFreq: number;
  /** Offset from the event start, seconds. */
  start: number;
  /** Note length, seconds. */
  duration: number;
  /** Peak gain for this note (before the master gain). */
  gain: number;
}

interface SoundRecipe {
  throttleMs: number;
  notes: SoundNote[];
}

function note(
  wave: string,
  freq: number,
  endFreq: number,
  start: number,
  duration: number,
  gain: number
): SoundNote {
  return { wave: wave, freq: freq, endFreq: endFreq, start: start, duration: duration, gain: gain };
}

/**
 * Eight clearly different short cues. Everything stays under 0.65 s and each
 * recipe uses at most four oscillators, so the default voice budget of 12
 * covers three overlapping fanfares.
 */
const RECIPES: Record<SoundEvent, SoundRecipe> = {
  // Short high blip for buttons and territory taps.
  tap: {
    throttleMs: 50,
    notes: [note('sine', 660, 880, 0, 0.06, 0.16)],
  },
  // Mid sweep plus a low square pulse: "troops leaving".
  march: {
    throttleMs: 90,
    notes: [
      note('triangle', 240, 392, 0, 0.18, 0.2),
      note('square', 120, 196, 0, 0.16, 0.1),
    ],
  },
  // Low falling thud; also used for cannon hits.
  defend: {
    throttleMs: 60,
    notes: [
      note('square', 200, 96, 0, 0.2, 0.2),
      note('triangle', 300, 130, 0, 0.14, 0.12),
    ],
  },
  // Rising major triad.
  capture: {
    throttleMs: 150,
    notes: [
      note('sine', 523.25, 523.25, 0, 0.1, 0.16),
      note('sine', 659.25, 659.25, 0.07, 0.1, 0.16),
      note('sine', 783.99, 783.99, 0.14, 0.18, 0.18),
    ],
  },
  // Falling minor line.
  lost: {
    throttleMs: 150,
    notes: [
      note('sawtooth', 392, 196, 0, 0.3, 0.14),
      note('triangle', 294, 147, 0.12, 0.3, 0.1),
      note('sine', 196, 98, 0.06, 0.36, 0.1),
    ],
  },
  // Two-step sparkle.
  upgrade: {
    throttleMs: 200,
    notes: [
      note('sine', 880, 880, 0, 0.08, 0.14),
      note('sine', 1174.66, 1174.66, 0.07, 0.12, 0.14),
      note('triangle', 1318.51, 1318.51, 0.14, 0.12, 0.08),
    ],
  },
  // Short fanfare.
  victory: {
    throttleMs: 700,
    notes: [
      note('triangle', 523.25, 523.25, 0, 0.18, 0.14),
      note('triangle', 659.25, 659.25, 0.1, 0.18, 0.14),
      note('triangle', 783.99, 783.99, 0.2, 0.2, 0.14),
      note('sine', 1046.5, 1046.5, 0.32, 0.42, 0.18),
    ],
  },
  // Low descending saw with a long tail.
  defeat: {
    throttleMs: 700,
    notes: [
      note('sawtooth', 220, 110, 0, 0.5, 0.14),
      note('sawtooth', 196, 98, 0.14, 0.5, 0.1),
      note('triangle', 146.83, 73.42, 0.05, 0.6, 0.12),
    ],
  },
};

const DEFAULT_MASTER_VOLUME = 0.35;
const DEFAULT_MAX_VOICES = 12;
const LOOKAHEAD_SECONDS = 0.004;
/** Exponential ramps cannot start at exactly zero. */
const SILENCE = 0.0001;
/** Upper bound on intent re-evaluation inside one reconciler run. */
const MAX_RECONCILE_PASSES = 4;
/**
 * Upper bound on statechange-driven reverse drives per user intent. A browser
 * that keeps restarting a context the user muted must not be fought forever;
 * playback stays blocked and the context is simply left alone after this.
 */
const MAX_AUTO_REDRIVES = 3;

interface Voice {
  oscillator: SoundOscillator;
  gain: SoundGain;
  released: boolean;
  /** Context time at which `stop()` was scheduled, for the lease sweep. */
  endsAt: number;
}

type AudioContextConstructor = new () => SoundAudioContext;

interface AudioHost {
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
}

/**
 * Window first (the container is a WebView), then the ambient global for
 * tests/Node. `typeof` keeps this safe on engines without `globalThis`.
 */
function readAudioHost(): AudioHost | null {
  if (typeof window !== 'undefined' && window) return window as unknown as AudioHost;
  if (typeof globalThis !== 'undefined') return globalThis as unknown as AudioHost;
  return null;
}

function readAudioContextConstructor(): AudioContextConstructor | null {
  const host = readAudioHost();
  if (!host) return null;
  if (typeof host.AudioContext === 'function') {
    return host.AudioContext as AudioContextConstructor;
  }
  if (typeof host.webkitAudioContext === 'function') {
    return host.webkitAudioContext as AudioContextConstructor;
  }
  return null;
}

function defaultContextFactory(): SoundAudioContext | null {
  const Ctor = readAudioContextConstructor();
  if (!Ctor) return null;
  return new Ctor();
}

export function isSoundEvent(value: unknown): value is SoundEvent {
  return typeof value === 'string' && SOUND_EVENTS.indexOf(value as SoundEvent) >= 0;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error);
  return text && text !== '[object Object]' ? text : '未知错误';
}

function readContextState(
  context: SoundAudioContext
): 'running' | 'suspended' | 'closed' | 'unknown' {
  let raw: string | undefined;
  try {
    raw = context.state;
  } catch {
    // A broken getter on an exotic WebView must not break public methods.
    return 'unknown';
  }
  if (raw === 'running') return 'running';
  if (raw === 'suspended' || raw === 'interrupted') return 'suspended';
  if (raw === 'closed') return 'closed';
  // Older WebKit exposes no state; treat it as a working, auto-started context.
  return 'unknown';
}

function setParamAt(param: SoundAudioParam, value: number, time: number): void {
  try {
    param.setValueAtTime(value, time);
  } catch {
    param.value = value;
  }
}

function rampParamAt(param: SoundAudioParam, value: number, time: number): void {
  if (typeof param.linearRampToValueAtTime === 'function') {
    try {
      param.linearRampToValueAtTime(value, time);
      return;
    } catch {
      // fall through to a plain assignment
    }
  }
  setParamAt(param, value, time);
}

function decayParamAt(param: SoundAudioParam, value: number, time: number): void {
  if (typeof param.exponentialRampToValueAtTime === 'function') {
    try {
      param.exponentialRampToValueAtTime(Math.max(value, SILENCE), time);
      return;
    } catch {
      // fall through
    }
  }
  setParamAt(param, Math.max(value, SILENCE), time);
}

function normalizeVolume(value: number | undefined): number {
  if (typeof value !== 'number' || !isFinite(value)) return DEFAULT_MASTER_VOLUME;
  if (value <= 0) return 0;
  return Math.min(1, value);
}

function normalizeMaxVoices(value: number | undefined): number {
  if (typeof value !== 'number' || !isFinite(value) || value < 1) return DEFAULT_MAX_VOICES;
  return Math.min(64, Math.floor(value));
}

function noop(): void {
  // Intentionally empty: promise results are only used to clear/record errors.
}

/**
 * Owner of the audio context. One instance per app; the shell should call
 * `unlock()` from the first real pointer/click, `suspend()`/`resume()` from the
 * visibility lifecycle, `setEnabled()` from the settings toggle and `dispose()`
 * when tearing everything down.
 */
export class SoundService {
  private readonly contextFactory: () => SoundAudioContext | null;
  private readonly clock: () => number;
  private readonly maxVoices: number;
  private readonly masterVolume: number;

  private enabledValue: boolean;
  private supportedValue: boolean;
  private disposedValue = false;
  /** A real user gesture happened, even if it happened while muted. */
  private gestureSeen = false;
  /** Explicit lifecycle/mute pause. Browser-initiated suspension is NOT this. */
  private paused = false;
  /**
   * Bumped by every intent change. Async resume/suspend completions compare
   * their captured value against it and are ignored once they are stale, so a
   * late resolution can neither flip `paused` nor overwrite `lastError()`.
   */
  private intentSeq = 0;
  /** statechange-driven reverse drives already spent for the current intent. */
  private autoRedrives = 0;
  private context: SoundAudioContext | null = null;
  private master: SoundGain | null = null;
  private detachStateChange: (() => void) | null = null;
  private failure: SoundInitError | null = null;
  private voices: Voice[] = [];
  private lastPlayedAt: Partial<Record<SoundEvent, number>> = {};
  /** Serializes opposite context transitions; never two drives at once. */
  private inFlight: Promise<boolean> | null = null;
  /** A newer intent arrived while a drive was in flight; re-run afterwards. */
  private rerun = false;

  constructor(options?: SoundServiceOptions) {
    const opts = options || {};
    this.enabledValue = opts.enabled !== false;
    this.masterVolume = normalizeVolume(opts.masterVolume);
    this.maxVoices = normalizeMaxVoices(opts.maxVoices);
    this.clock = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    if (typeof opts.contextFactory === 'function') {
      this.contextFactory = opts.contextFactory;
      // The factory owns capability reporting; failures surface on unlock().
      this.supportedValue = true;
    } else {
      this.contextFactory = defaultContextFactory;
      this.supportedValue = readAudioContextConstructor() !== null;
    }
    if (!this.supportedValue) {
      this.failure = {
        stage: 'construct',
        message: '当前环境不支持 Web Audio（AudioContext 与 webkitAudioContext 均不可用）',
      };
    }
  }

  /**
   * User preference. Disabling silences every scheduled note synchronously and
   * drives the context to suspended; enabling asks for a resume but never waits.
   * Returns the effective enabled value (not a capability), which can be true
   * on an unsupported browser: check `state()`/`canPlay()` for that.
   */
  setEnabled(value: boolean): boolean {
    if (this.disposedValue) return false;
    const next = value !== false;
    if (next === this.enabledValue) {
      if (next) this.reconcile();
      return this.enabledValue;
    }
    this.enabledValue = next;
    this.bumpIntent();
    if (!next) {
      // Mute takes effect immediately, even while a resume() is still pending.
      this.stopVoices();
    } else if (this.gestureSeen) {
      // The settings toggle IS a user gesture, so creating the context here is
      // legal. Without it, starting muted would never get a live context.
      this.ensureContext();
    }
    this.reconcile();
    return this.enabledValue;
  }

  isEnabled(): boolean {
    return this.enabledValue;
  }

  /**
   * Creates the context on first use and requests `resume()` inside this very
   * call stack. MUST be called from a pointer/click handler: browsers only
   * start audio from a real gesture. Returns true when a context is available
   * and resume was requested (or already running); false when unsupported,
   * muted, paused, disposed, construction failed or `resume()` threw
   * synchronously. An asynchronous rejection is reported by `state()` /
   * `lastError()` instead of this boolean.
   */
  unlock(): boolean {
    if (this.disposedValue) return false;
    this.gestureSeen = true;
    if (!this.enabledValue) return false;
    if (this.paused) {
      // A deliberate lifecycle/mute pause wins over incidental gestures.
      return true;
    }
    const context = this.ensureContext();
    if (!context) return false;
    const raw = readContextState(context);
    if (raw === 'closed') return this.noteClosedContext();
    if (raw === 'running' || raw === 'unknown') {
      this.clearFailure('resume');
      return true;
    }
    if (typeof context.resume !== 'function') return false;
    this.bumpIntent();
    this.clearFailure('resume');
    // reconcile() runs synchronously up to its first await, and that await is
    // after context.resume() was called: the gesture stack is preserved.
    this.reconcile();
    // A synchronous throw is already recorded here; an async rejection is not.
    if (readContextState(context) !== 'running'
      && this.failure !== null
      && this.failure.stage === 'resume') {
      return false;
    }
    return true;
  }

  /**
   * Schedules one short cue. Returns false (without queuing anything) when
   * muted, disposed, unsupported, paused, not unlocked, still waiting for the
   * autoplay gesture, throttled or out of voices.
   */
  play(event: SoundEvent): boolean {
    if (!this.canPlay()) return false;
    if (!isSoundEvent(event)) return false;
    const recipe = RECIPES[event];
    const context = this.context;
    if (!context) return false;

    const now = this.clock();
    const last = this.lastPlayedAt[event];
    // A backwards clock (or a test clock reset) must not silence the service.
    if (typeof last === 'number' && now >= last && now - last < recipe.throttleMs) return false;
    this.pruneFinishedVoices(context);
    if (this.voices.length + recipe.notes.length > this.maxVoices) return false;

    const base = this.startTime(context) + LOOKAHEAD_SECONDS;
    const scheduled: Voice[] = [];
    try {
      for (let i = 0; i < recipe.notes.length; i += 1) {
        scheduled.push(this.scheduleNote(context, recipe.notes[i], base));
      }
    } catch (error) {
      for (let i = 0; i < scheduled.length; i += 1) {
        this.releaseVoice(scheduled[i], true);
      }
      this.recordFailure('play', error);
      return false;
    }
    this.lastPlayedAt[event] = now;
    return true;
  }

  /**
   * Requests a pause. The intent is recorded synchronously (and `play()` is
   * blocked from that moment), every scheduled note is stopped immediately, and
   * the context is driven to suspended. A resume() that is still pending is
   * awaited first, so a stale resume can never leave audio playing afterwards.
   *
   * With no context yet the intent is still remembered: it blocks playback and
   * `resume()` (or `unlock()` after a resume) clears it later. Never rejects.
   */
  suspend(): Promise<boolean> {
    if (this.disposedValue) return Promise.resolve(false);
    this.paused = true;
    this.bumpIntent();
    this.stopVoices();
    const context = this.context;
    if (!context) return Promise.resolve(true);
    const raw = readContextState(context);
    if (raw === 'closed') return Promise.resolve(this.noteClosedContext());
    if (raw === 'unknown') return Promise.resolve(true);
    return this.reconcile();
  }

  /**
   * Clears the lifecycle pause and drives the context back to running. The
   * pause is intent state, not audio state: it is cleared even while muted or
   * before any context exists, otherwise "muted -> suspend -> foreground
   * resume -> unmute" would leave `paused` set forever and unlock() would never
   * resume. Only the audio drive is skipped when muted.
   *
   * Returns false when there is no context/unlock, the service is muted/disposed,
   * the context closed or the drive failed. Never rejects, never replays cues.
   */
  resume(): Promise<boolean> {
    if (this.disposedValue) return Promise.resolve(false);
    this.paused = false;
    this.bumpIntent();
    if (!this.enabledValue) return Promise.resolve(false);
    const context = this.context;
    if (!context) return Promise.resolve(false);
    const raw = readContextState(context);
    if (raw === 'closed') return Promise.resolve(this.noteClosedContext());
    if (raw === 'unknown') return Promise.resolve(true);
    return this.reconcile();
  }

  /** Closes the context and releases every node. Idempotent; play is dead after. */
  dispose(): void {
    if (this.disposedValue) return;
    this.disposedValue = true;
    // A disposed service can never sound again; report mute instead of a
    // preference that is no longer actionable.
    this.enabledValue = false;
    this.paused = false;
    this.bumpIntent();
    this.stopVoices();
    this.lastPlayedAt = {};
    this.detachStateEvents();
    const context = this.context;
    this.context = null;
    this.inFlight = null;
    this.rerun = false;
    if (this.master) {
      this.disconnectNode(this.master);
      this.master = null;
    }
    if (!context || typeof context.close !== 'function') return;
    try {
      const pending = context.close();
      if (pending && typeof pending.then === 'function') pending.then(noop, noop);
    } catch {
      // A context that refuses to close is already unreachable from here.
    }
  }

  /**
   * Honest state: `disabled` reflects the preference first, `unavailable` means
   * no AudioContext constructor exists, `failed` means construction failed or
   * the context closed, `idle` means no context yet, `suspended` means paused
   * (even before a context exists) or waiting for the autoplay gesture (both
   * recoverable), `running` means cues can be scheduled now.
   */
  state(): SoundState {
    if (this.disposedValue) return 'disposed';
    if (!this.enabledValue) return 'disabled';
    if (!this.supportedValue) return 'unavailable';
    const context = this.context;
    if (!context) {
      if (this.failure && this.failure.stage === 'construct') return 'failed';
      // A pause requested before any context exists still holds.
      return this.paused ? 'suspended' : 'idle';
    }
    const raw = readContextState(context);
    if (raw === 'closed') return 'failed';
    if (this.paused || raw === 'suspended') return 'suspended';
    return 'running';
  }

  canPlay(): boolean {
    if (this.disposedValue || !this.enabledValue || !this.supportedValue || this.paused) {
      return false;
    }
    const context = this.context;
    if (!context) return false;
    const raw = readContextState(context);
    return raw === 'running' || raw === 'unknown';
  }

  isSupported(): boolean {
    return this.supportedValue;
  }

  /** Newest failure, kept for diagnostics; never cleared by a dropped play(). */
  lastError(): SoundInitError | null {
    if (!this.failure) return null;
    return { stage: this.failure.stage, message: this.failure.message };
  }

  /** True when enabled, unpaused and a gesture has happened. */
  private wantsRunning(): boolean {
    return !this.disposedValue && this.enabledValue && !this.paused && this.gestureSeen;
  }

  /** Records a terminal closed context and reports failure. Always false. */
  private noteClosedContext(): boolean {
    this.stopVoices();
    this.recordFailure('construct', '音频上下文已关闭');
    return false;
  }

  /** Records a new user intent and restores the per-intent auto-drive budget. */
  private bumpIntent(): void {
    this.intentSeq += 1;
    this.autoRedrives = 0;
  }

  /**
   * Single-flight reconciler. Every public intent change funnels through here so
   * an opposite transition always waits for the in-flight one and then applies
   * the newest intent. Returns a promise that settles only after any queued
   * re-run, so callers can report the real end state.
   */
  private reconcile(): Promise<boolean> {
    if (this.disposedValue) return Promise.resolve(true);
    if (this.inFlight) {
      // A transition is already running; apply the newest intent right after it.
      this.rerun = true;
      return this.inFlight;
    }
    const context = this.context;
    if (!context) return Promise.resolve(true);
    const raw = readContextState(context);
    // A closed context is terminal: report a real failure. `unknown` (legacy
    // WebKit with no state property) stays compatible and is treated as running.
    if (raw === 'closed') return Promise.resolve(this.noteClosedContext());
    if (raw === 'unknown') return Promise.resolve(true);
    if (this.wantsRunning() === (raw === 'running')) return Promise.resolve(true);

    // A real transition is needed. Engage the single-flight slot synchronously
    // and start the loop, which calls resume()/suspend() before its first await
    // (so unlock() keeps the user-gesture stack).
    const self = this;
    const run = this.reconcileLoop();
    let slot: Promise<boolean> | null = null;
    const tracked = run.then(
      function (ok) {
        if (self.inFlight === slot) self.inFlight = null;
        const again = self.rerun;
        self.rerun = false;
        if (!again) return ok;
        // A newer intent (or a statechange-driven re-check) arrived while this
        // drive ran: its outcome is the authoritative one.
        return self.reconcile();
      },
      function () {
        if (self.inFlight === slot) self.inFlight = null;
        const again = self.rerun;
        self.rerun = false;
        // Never drop a queued intent because this run failed.
        if (!again) return false;
        return self.reconcile();
      }
    );
    slot = tracked;
    this.inFlight = tracked;
    return tracked;
  }

  private async reconcileLoop(): Promise<boolean> {
    for (let pass = 0; pass < MAX_RECONCILE_PASSES; pass += 1) {
      if (this.disposedValue) return true;
      const context = this.context;
      if (!context) return true;
      const raw = readContextState(context);
      // Legacy contexts expose no state to drive; a closed one is terminal.
      if (raw === 'unknown') return true;
      if (raw === 'closed') return this.noteClosedContext();

      const wantRunning = this.wantsRunning();
      if (wantRunning === (raw === 'running')) {
        // The context is in the requested state; a later restart gets a full
        // fight budget again.
        if (wantRunning) this.autoRedrives = 0;
        return true;
      }

      // Sever scheduled notes BEFORE either transition. A context that resumes
      // must never continue notes queued before the pause.
      this.stopVoices();
      const seq = this.intentSeq;
      const drove = await this.drive(context, wantRunning ? 'resume' : 'suspend', seq);
      // The intent changed while awaiting: ignore this result entirely and
      // re-evaluate, so the newest pause/mute cannot be skipped.
      if (this.intentSeq !== seq) continue;
      if (!drove) return false;

      // A resolved transition promise is not proof of the final state: the
      // browser can flip the context again (interruption, its own restart, a
      // late statechange). Re-read before reporting success. Do not spin here;
      // a running statechange while silence is wanted has queued a rerun, and
      // that path is bounded by MAX_AUTO_REDRIVES.
      const after = readContextState(context);
      if (after === 'unknown') return true;
      if (after === 'closed') return this.noteClosedContext();
      if (this.wantsRunning() === (after === 'running')) {
        if (this.wantsRunning()) this.autoRedrives = 0;
        return true;
      }
      return false;
    }
    // Intent kept changing; the queued re-run (if any) finishes the job.
    return true;
  }

  /**
   * Performs one context transition. Results are only applied when the intent
   * captured at call time is still current, so a stale resolve/reject cannot
   * clear `paused`, clear a newer error or record an obsolete one.
   */
  private async drive(
    context: SoundAudioContext,
    direction: 'resume' | 'suspend',
    seq: number
  ): Promise<boolean> {
    const drive = direction === 'resume' ? context.resume : context.suspend;
    if (typeof drive !== 'function') {
      // A legacy context that cannot be driven either way. `paused`/`enabled`
      // still block play(), and state() reports the real context state.
      return true;
    }
    try {
      const pending = drive.call(context);
      if (pending && typeof pending.then === 'function') await pending;
      if (this.intentSeq === seq) this.clearFailure(direction);
      return true;
    } catch (error) {
      if (this.intentSeq === seq) this.recordFailure(direction, error);
      return false;
    }
  }

  /**
   * A context can suspend itself (browser interruption, backgrounding, the
   * autoplay gate) without any call from us. Whatever the cause, a non-running
   * state must drop queued notes so a later resume cannot continue them.
   */
  private handleContextStateChange(): void {
    if (this.disposedValue) return;
    const context = this.context;
    if (!context) return;
    const raw = readContextState(context);
    if (raw === 'unknown') return;
    if (raw === 'running') {
      if (this.wantsRunning()) {
        // The context is doing what the user wants; restore the fight budget.
        this.autoRedrives = 0;
        return;
      }
      // A browser-initiated (or late) start while the user wants silence. Even
      // if a drive is in flight, remember that we must re-check the final state
      // once it settles: a successful suspend() promise is not proof by itself.
      this.scheduleReverseSuspend();
      return;
    }
    // Whatever the cause (browser interruption, autoplay gate, our own
    // suspend), nothing may stay queued: a later resume must not continue it.
    if (raw === 'closed') {
      this.noteClosedContext();
      return;
    }
    this.stopVoices();
  }

  /**
   * Drives a restarting context back to suspended. Bounded per user intent so a
   * browser that keeps auto-starting audio cannot cause an endless fight; while
   * the bound is exhausted the context may run, but every note stays stopped
   * and play() stays blocked, so nothing is heard.
   */
  private scheduleReverseSuspend(): void {
    if (this.autoRedrives >= MAX_AUTO_REDRIVES) return;
    this.autoRedrives += 1;
    if (this.inFlight) {
      // The in-flight drive will re-evaluate the (newest) state when it
      // settles; do not start a second drive in parallel.
      this.rerun = true;
      return;
    }
    this.reconcile();
  }

  private attachStateEvents(context: SoundAudioContext): void {
    this.detachStateEvents();
    const self = this;
    const handler = function () {
      self.handleContextStateChange();
    };
    if (typeof context.addEventListener === 'function') {
      try {
        context.addEventListener('statechange', handler);
        this.detachStateChange = function () {
          if (typeof context.removeEventListener !== 'function') return;
          try {
            context.removeEventListener('statechange', handler);
          } catch {
            // Detaching from an already-closed context is harmless.
          }
        };
        return;
      } catch {
        // Fall through to the legacy property below.
      }
    }
    try {
      context.onstatechange = handler;
      this.detachStateChange = function () {
        try {
          context.onstatechange = null;
        } catch {
          // Ignore: the context is going away anyway.
        }
      };
    } catch {
      // No statechange support at all: every resume still severs notes first,
      // so stale audio cannot be replayed on such an environment.
    }
  }

  private detachStateEvents(): void {
    const detach = this.detachStateChange;
    this.detachStateChange = null;
    if (detach) detach();
  }

  private ensureContext(): SoundAudioContext | null {
    if (this.context) return this.context;
    if (this.disposedValue || !this.supportedValue) return null;
    let created: SoundAudioContext | null = null;
    try {
      created = this.contextFactory();
    } catch (error) {
      this.recordFailure('construct', '音频上下文初始化失败：' + errorText(error));
      return null;
    }
    if (!created || typeof created.createOscillator !== 'function'
      || typeof created.createGain !== 'function') {
      this.recordFailure('construct', '音频上下文初始化失败：AudioContext 不可用');
      return null;
    }
    let master: SoundGain | null = null;
    try {
      master = created.createGain();
      master.gain.value = this.masterVolume;
      master.connect(created.destination);
    } catch (error) {
      this.closeContext(created);
      this.recordFailure('construct', '音频上下文初始化失败：' + errorText(error));
      return null;
    }
    this.context = created;
    this.master = master;
    this.failure = null;
    this.attachStateEvents(created);
    return created;
  }

  private startTime(context: SoundAudioContext): number {
    const value = context.currentTime;
    return typeof value === 'number' && isFinite(value) && value > 0 ? value : 0;
  }

  /**
   * Builds one note. If anything throws after some nodes exist, those nodes are
   * stopped and disconnected here before the error propagates to play(), so a
   * partially built voice never leaks into the graph.
   */
  private scheduleNote(context: SoundAudioContext, spec: SoundNote, base: number): Voice {
    const oscillator = context.createOscillator();
    let gain: SoundGain | null = null;
    try {
      gain = context.createGain();
      const startAt = base + spec.start;
      const endAt = startAt + spec.duration;
      const attack = Math.min(0.012, spec.duration * 0.3);

      oscillator.type = spec.wave;
      setParamAt(oscillator.frequency, spec.freq, startAt);
      if (spec.endFreq !== spec.freq) {
        rampParamAt(oscillator.frequency, spec.endFreq, endAt);
      }
      setParamAt(gain.gain, SILENCE, startAt);
      rampParamAt(gain.gain, Math.max(spec.gain, SILENCE), startAt + attack);
      decayParamAt(gain.gain, SILENCE, endAt);

      oscillator.connect(gain);
      gain.connect(this.master || context.destination);

      const voice: Voice = {
        oscillator: oscillator,
        gain: gain,
        released: false,
        endsAt: endAt + 0.03,
      };
      const self = this;
      oscillator.onended = function () {
        self.releaseVoice(voice, false);
      };
      oscillator.start(startAt);
      oscillator.stop(voice.endsAt);
      this.voices.push(voice);
      return voice;
    } catch (error) {
      // Drop the half-built note: no ended callback, no live nodes, no voice.
      oscillator.onended = null;
      if (gain) this.disconnectNode(gain);
      this.disconnectNode(oscillator);
      try {
        oscillator.stop();
      } catch {
        // Never started, or already stopped.
      }
      throw error;
    }
  }

  private releaseVoice(voice: Voice, stopOscillator: boolean): void {
    if (voice.released) return;
    voice.released = true;
    const index = this.voices.indexOf(voice);
    if (index >= 0) this.voices.splice(index, 1);
    if (stopOscillator) {
      try {
        voice.oscillator.stop();
      } catch {
        // Already stopped or never started; nothing else to do.
      }
    }
    voice.oscillator.onended = null;
    this.disconnectNode(voice.oscillator);
    this.disconnectNode(voice.gain);
  }

  private disconnectNode(node: SoundOscillator | SoundGain): void {
    if (typeof node.disconnect !== 'function') return;
    try {
      node.disconnect();
    } catch {
      // Disconnecting a node that was never connected is harmless.
    }
  }

  private stopVoices(): void {
    if (this.voices.length === 0) return;
    const current = this.voices.slice();
    for (let i = 0; i < current.length; i += 1) {
      this.releaseVoice(current[i], true);
    }
  }

  /**
   * `onended` is not guaranteed on a suspended or background-tab context, so a
   * voice whose scheduled end has passed is released here as well. Without
   * this the budget could leak and silence the game after a suspension.
   */
  private pruneFinishedVoices(context: SoundAudioContext): void {
    if (this.voices.length === 0) return;
    const time = context.currentTime;
    if (typeof time !== 'number' || !isFinite(time)) return;
    const stale = this.voices.filter(function (voice) {
      return voice.endsAt <= time;
    });
    for (let i = 0; i < stale.length; i += 1) {
      this.releaseVoice(stale[i], false);
    }
  }

  private closeContext(context: SoundAudioContext): void {
    if (typeof context.close !== 'function') return;
    try {
      const pending = context.close();
      if (pending && typeof pending.then === 'function') pending.then(noop, noop);
    } catch {
      // Ignore: the context never became the active one.
    }
  }

  private recordFailure(stage: SoundFailureStage, error: unknown): void {
    const message = stage === 'construct' && typeof error === 'string'
      ? error
      : errorText(error);
    this.failure = { stage: stage, message: stage === 'play' ? '音效排程失败：' + message : message };
  }

  private clearFailure(stage: SoundFailureStage): void {
    if (this.failure && this.failure.stage === stage) this.failure = null;
  }
}
