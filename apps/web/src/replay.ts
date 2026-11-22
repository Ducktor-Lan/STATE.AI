import type { ReplayFrames, RunEvent, StateFrame } from './api';

const WINDOW_TICKS = 40;
const BACK_BUFFER_TICKS = 12;
const MS_PER_TICK = 100;

interface ReplayCallbacks {
  load: (from: number, limit: number, signal: AbortSignal) => Promise<ReplayFrames>;
  frame: (frame: StateFrame, seek: boolean) => void;
  clock: (tick: number) => void;
  status: () => void;
  error: (error: unknown) => void;
}

/** The clock advances over a contiguous buffer of authoritative engine frames. */
export class ReplayPlayback {
  private readonly frames = new Map<number, Omit<StateFrame, 'run' | 'events'>>();
  private latestRun: StateFrame['run'] | null = null;
  private end = -1;
  private request: AbortController | null = null;
  private animation = 0;
  private lastTime: number | null = null;
  private position = 0;
  private speed = 1;
  private stalled = false;
  tick: number | null = null;
  seekTick: number | null = null;
  playing = false;

  constructor(readonly maximum: number, private readonly callbacks: ReplayCallbacks) {}

  get buffering(): boolean { return this.stalled || this.seekTick !== null && this.request !== null; }

  seek(tick: number): void {
    this.stopClock();
    this.select(tick);
  }

  cancelSeek(): void {
    if (this.seekTick === null) return;
    this.abortRequest();
    this.seekTick = null;
    this.callbacks.status();
  }

  play(): void {
    if (this.playing || this.tick === null || this.maximum === 0 || this.buffering) return;
    this.seekTick = null;
    this.playing = true;
    if (this.position >= this.maximum) this.select(0);
    else this.wake();
    this.callbacks.status();
  }

  pause(): void {
    if (!this.playing) return;
    this.stopClock();
    if (this.seekTick !== null) this.cancelSeek();
    else this.callbacks.status();
  }

  setSpeed(speed: number): void {
    if (this.lastTime !== null) this.advanceTo(performance.now());
    this.speed = speed;
    this.wake();
  }

  destroy(): void {
    this.stopClock();
    this.abortRequest();
  }

  private stopClock(): void {
    this.playing = false;
    this.stalled = false;
    this.lastTime = null;
    cancelAnimationFrame(this.animation);
    this.animation = 0;
  }

  private select(tick: number): void {
    this.abortRequest();
    this.seekTick = tick;
    if (this.frames.has(tick)) {
      this.finishSeek(tick);
      return;
    }
    this.frames.clear();
    this.end = -1;
    void this.load(tick, 1, true);
  }

  private finishSeek(tick: number): void {
    this.seekTick = null;
    this.position = tick;
    this.lastTime = null;
    this.present(tick, true);
    this.callbacks.clock(tick);
    this.callbacks.status();
    this.wake();
  }

  private abortRequest(): void {
    const request = this.request;
    this.request = null;
    request?.abort();
  }

  private async load(from: number, limit: number, seek = false): Promise<void> {
    const request = new AbortController();
    this.request = request;
    if (seek) this.callbacks.status();
    let batch: ReplayFrames;
    try {
      batch = await this.callbacks.load(from, limit, request.signal);
      if (this.request !== request) return;
      if (batch.frames.length !== limit || batch.frames.some(({ snapshot }, index) => snapshot.tick !== from + index)) {
        throw new Error(`回放缺少从第 ${from} 帧起的连续记录。`);
      }
    } catch (error) {
      if (this.request !== request) return;
      this.request = null;
      // Retain a failed seek target for a deliberate retry.
      this.stopClock();
      this.callbacks.status();
      this.callbacks.error(error);
      return;
    }
    this.request = null;
    this.latestRun = batch.run;
    const noDecisions: StateFrame['decisions'] = [];
    for (const frame of batch.frames) {
      const round = batch.decisionsByRound.findLast(item => item.tick <= frame.snapshot.tick);
      this.frames.set(frame.snapshot.tick, { ...frame, decisions: round?.decisions ?? noDecisions });
    }
    this.end = from + limit - 1;
    if (seek) this.finishSeek(from);
    else this.wake();
  }

  private present(tick: number, seek: boolean): void {
    const buffered = this.frames.get(tick);
    if (!buffered || !this.latestRun) return;
    this.tick = tick;
    for (const old of this.frames.keys()) {
      if (old >= tick - BACK_BUFFER_TICKS) break;
      this.frames.delete(old);
    }
    this.callbacks.frame({ ...buffered, run: this.latestRun, events: [] }, seek);
  }

  private wake(): void {
    if (!this.playing || this.seekTick !== null || this.tick === null) return;
    const end = Math.max(this.tick, this.end);
    const lead = Math.max(4, Math.min(32, Math.ceil(this.speed * 5)));
    if (!this.request && end < this.maximum && end - this.position <= lead) {
      void this.load(end + 1, Math.min(WINDOW_TICKS, this.maximum - end));
    }
    const stalled = this.position >= end && end < this.maximum;
    if (stalled !== this.stalled) {
      this.stalled = stalled;
      this.lastTime = null;
      this.callbacks.status();
    }
    if (!stalled && !this.animation) this.animation = requestAnimationFrame(this.advance);
  }

  private readonly advance = (now: number): void => {
    this.animation = 0;
    this.advanceTo(now);
  };

  private advanceTo(now: number): void {
    if (!this.playing || this.tick === null) return;
    const nextTime = Math.max(now, this.lastTime ?? now);
    const elapsed = this.lastTime === null ? 0 : nextTime - this.lastTime;
    this.lastTime = nextTime;
    this.position = Math.min(this.end, this.position + elapsed / MS_PER_TICK * this.speed);
    const tick = Math.floor(this.position);
    if (tick > this.tick) this.present(tick, false);
    this.callbacks.clock(this.position);
    if (tick === this.maximum) this.pause();
    else this.wake();
  }
}

/** Detail events are sorted by tick by the server. Bounds exclude the already rendered tick. */
export function replayEventsBetween(events: RunEvent[], previous: number, current: number): RunEvent[] {
  function after(tick: number): number {
    let from = 0, to = events.length;
    while (from < to) {
      const middle = (from + to) >>> 1;
      if (events[middle]!.tick <= tick) from = middle + 1;
      else to = middle;
    }
    return from;
  }
  return events.slice(after(previous), after(current));
}
