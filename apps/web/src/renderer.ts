import { FIXED_DT_MS } from '../../../.generated/state-conquest/src/config/balance';
import { CanvasRenderer } from '../../../.generated/state-conquest/src/rendering/canvas-renderer';
import { idleGestureState } from '../../../.generated/state-conquest/src/input/gesture-controller';
import type { MatchView } from '../../../.generated/state-conquest/src/ui/view-model';
import type { MatchSnapshot, StateFrame } from './api';

interface BattlefieldFrame {
  snapshot: MatchSnapshot;
  events?: StateFrame['events'];
}

type FrameOptions = { seek?: boolean; clockMs?: number; alpha?: number };
type RecordedPlayback = {
  frames: BattlefieldFrame[];
  start?: { time: number; tick: number };
  onFrame?: (snapshot: MatchSnapshot) => void;
};

/** Pure projection of a real engine snapshot; no UI rules or simulated outcomes. */
export function snapshotView(snapshot: MatchSnapshot): MatchView {
  return {
    ...snapshot,
    diplomacy: snapshot.diplomacy ? { ...snapshot.diplomacy, truces: snapshot.diplomacy.truces.map(record => ({ ...record })) } : undefined,
    territories: snapshot.territories,
    edges: snapshot.edges,
    armies: snapshot.armies,
    fronts: snapshot.fronts,
    boundaries: snapshot.layout?.boundaries,
    geography: snapshot.layout?.geography,
    geog: snapshot.geog,
    scores: { ...snapshot.scores, ai3: snapshot.scores.ai3 ?? 0 },
    territoryCounts: { ...snapshot.territoryCounts, ai3: snapshot.territoryCounts.ai3 ?? 0 },
  };
}

/** The production engine renderer is shared by the UI and the video endpoint. */
export class Battlefield {
  readonly renderer: CanvasRenderer;
  private snapshot: MatchSnapshot | null = null;
  private view: MatchView | null = null;
  private clockMs = 0;
  private alpha = 0;
  private animation: number | null = null;
  private playback: RecordedPlayback | null = null;
  private selectedId: string | null = null;
  private runId = '';
  private destroyed = false;
  private readonly gesture = idleGestureState();
  private readonly resize: ResizeObserver;

  constructor(readonly canvas: HTMLCanvasElement, private readonly animate = true) {
    this.renderer = new CanvasRenderer(canvas, { clock: () => this.clockMs });
    this.resize = new ResizeObserver(() => { this.renderer.invalidateLayout(); this.invalidate(); });
    this.resize.observe(canvas);
  }

  setFrame(frame: StateFrame, options: FrameOptions = {}): void {
    this.playback = null;
    const reset = options.seek || frame.run.id !== this.runId || frame.snapshot.tick < (this.snapshot?.tick ?? -1);
    if (reset) {
      this.renderer.resetMatch();
      this.snapshot = null;
    }
    this.runId = frame.run.id;
    this.applyFrame(frame, options);
    this.invalidate();
  }

  /** Advance within the displayed tick when the caller has the next recorded tick. */
  displayTime(gameTick: number): void {
    if (!this.animate || !this.snapshot || !Number.isFinite(gameTick)) return;
    const alpha = Math.min(1, Math.max(0, gameTick - this.snapshot.tick));
    const clockMs = (this.snapshot.tick + alpha) * FIXED_DT_MS;
    if (this.alpha === alpha && this.clockMs === clockMs) return;
    this.alpha = alpha;
    this.clockMs = clockMs;
    this.invalidate();
  }

  /** Play an already committed, contiguous window at the engine's fixed tick rate. */
  playRecordedFrames(runId: string, frames: readonly BattlefieldFrame[], onFrame?: (snapshot: MatchSnapshot) => void): void {
    if (!frames.length) return;
    if (!this.animate || !this.snapshot || this.runId !== runId) throw new Error('观战帧与当前战场不一致。');
    const playback = this.playback ?? { frames: [], onFrame };
    let tick = playback.frames.at(-1)?.snapshot.tick ?? this.snapshot.tick;
    for (const frame of frames) {
      if (frame.snapshot.tick !== ++tick) throw new Error(`缺少 tick ${tick} 的真实观战帧。`);
    }
    playback.frames.push(...frames);
    this.playback = playback;
    this.invalidate();
  }

  private applyFrame(frame: BattlefieldFrame, options: FrameOptions = {}): void {
    const { snapshot } = frame;
    const previousTick = this.snapshot?.tick ?? snapshot.tick;
    if (snapshot !== this.snapshot) this.view = snapshotView(snapshot);
    this.snapshot = snapshot;
    if (snapshot.tick > previousTick) {
      const seen = new Set<string>();
      const playReceipt = (raw: unknown): void => {
        if (!raw || typeof raw !== 'object') return;
        const tick = (raw as { tick?: unknown }).tick;
        if (typeof tick !== 'number' || tick <= previousTick || tick > snapshot.tick) return;
        const key = JSON.stringify(raw);
        if (seen.has(key)) return;
        seen.add(key);
        this.clockMs = options.clockMs ?? tick * FIXED_DT_MS;
        this.renderer.playCannonEvent(raw, snapshot.mapId);
        this.renderer.playDefenseReceipt(raw);
        this.renderer.playDefenseCollapse(raw);
      };
      for (const receipt of snapshot.events ?? []) playReceipt(receipt);
      for (const event of frame.events ?? []) {
        if (event.tick > previousTick && event.tick <= snapshot.tick) playReceipt(event.payload);
      }
    }
    this.clockMs = options.clockMs ?? snapshot.tick * FIXED_DT_MS;
    this.alpha = Math.min(1, Math.max(0, options.alpha ?? 0));
  }

  private invalidate(): void {
    if (this.destroyed || !this.view) return;
    if (!this.animate) { this.draw(); return; }
    if (this.animation === null) this.animation = requestAnimationFrame(this.paint);
  }

  private readonly paint = (now: number): void => {
    this.animation = null;
    const playback = this.playback;
    let presented: MatchSnapshot | undefined;
    if (playback && this.snapshot) {
      const start = playback.start ??= { time: now, tick: this.snapshot.tick };
      const frontier = playback.frames.at(-1)!.snapshot.tick;
      const gameTick = Math.min(frontier, start.tick + (now - start.time) / FIXED_DT_MS);
      while (playback.frames[0] && playback.frames[0].snapshot.tick <= gameTick) {
        const frame = playback.frames.shift()!;
        this.applyFrame(frame);
        presented = frame.snapshot;
      }
      this.alpha = gameTick - this.snapshot.tick;
      this.clockMs = gameTick * FIXED_DT_MS;
      if (!playback.frames.length) this.playback = null;
    }
    this.draw();
    if (presented) playback?.onFrame?.(presented);
    if (this.playback) this.invalidate();
  };

  setClock(clockMs: number): void {
    if (!Number.isFinite(clockMs) || clockMs < 0) throw new Error('渲染时钟须为非负毫秒数。');
    if (this.clockMs !== clockMs) { this.clockMs = clockMs; this.invalidate(); }
  }
  select(id: string | null): void {
    if (this.selectedId !== id) { this.selectedId = id; this.invalidate(); }
  }
  zoom(factor: number): void { this.renderer.zoomBy(factor); this.invalidate(); }
  resetCamera(): void { this.renderer.resetCamera(); this.invalidate(); }
  private draw(): void {
    if (!this.view) return;
    this.renderer.draw({ view: this.view, gesture: this.gesture, selectedId: this.selectedId, alpha: this.alpha }, this.clockMs);
  }
  destroy(): void {
    this.destroyed = true;
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    this.animation = null;
    this.playback = null;
    this.resize.disconnect();
    this.renderer.destroy();
  }
}
