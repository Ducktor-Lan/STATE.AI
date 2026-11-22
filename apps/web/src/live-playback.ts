import { api } from './api';
import type { ReplayFrame, RunEvent, StateFrame } from './api';
import type { Battlefield } from './renderer';

const ROUND_TICKS = 20;
const MAX_LAG_TICKS = 2 * ROUND_TICKS;
type Presentation = Pick<StateFrame, 'snapshot' | 'decisions' | 'outcome'>;

/** Display committed game time behind the live status when a round arrives all at once. */
export class LivePlayback {
  private latest: StateFrame | null = null;
  private shown: Presentation | null = null;
  private request: AbortController | null = null;
  private playing = false;
  private destroyed = false;
  private failure: unknown = null;

  constructor(
    private readonly battlefield: Battlefield,
    private readonly onFrame: () => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  get presentation(): Presentation | null { return this.shown; }
  get caughtUp(): boolean { return !!this.latest && this.shown?.snapshot.tick === this.latest.snapshot.tick; }
  get error(): unknown { return this.failure; }

  update(frame: StateFrame, seek = false): void {
    if (this.destroyed) return;
    const reset = seek || !this.latest || this.latest.run.id !== frame.run.id || frame.snapshot.tick < this.latest.snapshot.tick;
    this.latest = frame;
    if (reset) {
      this.request?.abort();
      this.request = null;
      this.playing = false;
      this.failure = null;
      this.battlefield.setFrame(frame, { seek: true });
      this.shown = frame;
    } else if (this.caughtUp) {
      if (this.shown?.snapshot.status !== frame.snapshot.status) this.battlefield.setFrame(frame);
      this.shown = frame;
    }
    void this.fill();
  }

  private async fill(): Promise<void> {
    const latest = this.latest;
    const shown = this.shown;
    if (this.destroyed || !latest || !shown || this.request || this.playing || this.caughtUp) return;
    const { id } = latest.run;
    const gap = latest.snapshot.tick - shown.snapshot.tick;
    const resync = gap > MAX_LAG_TICKS;
    const from = resync ? latest.snapshot.tick - ROUND_TICKS : shown.snapshot.tick + 1;
    const limit = Math.min(latest.snapshot.tick - from + 1, ROUND_TICKS + Number(resync));
    const request = new AbortController();
    this.request = request;
    try {
      const batch = await api.replayFrames(id, from, limit, request.signal);
      if (request.signal.aborted) return;
      if (batch.run.id !== id || batch.frames.length !== limit || batch.frames.some((frame, index) => frame.snapshot.tick !== from + index)) {
        throw new Error(`服务未返回 tick ${from}–${from + limit - 1} 的完整真实观战帧。`);
      }
      const records = new Map(batch.frames.map(frame => [frame.snapshot.tick, frame]));
      const events = new Map<number, RunEvent[]>();
      for (const event of latest.events) {
        if (event.tick < from || event.tick >= from + limit) continue;
        const sameTick = events.get(event.tick);
        if (sameTick) sameTick.push(event); else events.set(event.tick, [event]);
      }
      const presentation = (frame: ReplayFrame): Presentation => {
        if (this.latest?.snapshot.tick === frame.snapshot.tick) return this.latest;
        const decisions = batch.decisionsByRound.findLast(round => round.tick <= frame.snapshot.tick)?.decisions ?? shown.decisions;
        return { ...frame, decisions };
      };
      const frames = batch.frames.slice(resync ? 1 : 0).map(frame => ({
        snapshot: frame.snapshot.tick === latest.snapshot.tick ? latest.snapshot : frame.snapshot,
        events: events.get(frame.snapshot.tick),
      }));
      if (resync) {
        this.shown = presentation(batch.frames[0]!);
        this.battlefield.setFrame({ ...latest, ...this.shown }, { seek: true });
      }
      this.battlefield.playRecordedFrames(id, frames, snapshot => {
        const current = this.latest;
        if (current?.snapshot.tick === snapshot.tick && current.snapshot.status !== snapshot.status) {
          this.battlefield.setFrame(current);
        }
        this.shown = presentation(records.get(snapshot.tick)!);
        this.onFrame();
        if (snapshot.tick === from + limit - 1) {
          this.playing = false;
          void this.fill();
        }
      });
      this.playing = true;
      if (resync) this.onFrame();
      if (this.failure) { this.failure = null; this.onError(null); }
    } catch (error) {
      if (!request.signal.aborted) { this.failure = error; this.onError(error); }
    } finally {
      if (this.request === request) this.request = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.request?.abort();
    this.request = null;
  }
}
