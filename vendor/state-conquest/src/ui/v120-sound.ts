/**
 * v1.2 sound wiring.
 *
 * `src/platform/sound.ts` owns the synthesizer. This module owns the *shell
 * policy* on top of it: unlock-on-first-gesture, suspend/resume around pause
 * and page visibility, one shared bus so a versus event cannot be played
 * twice, and honest status copy for the settings/pause surfaces.
 *
 * Nothing here fakes availability: without a real service every call is false
 * and `statusText()` says the environment cannot play audio.
 */

import type {
  SoundEvent,
  SoundInitError,
  SoundService,
  SoundState,
} from '../platform/sound';
import { SOUND_EVENTS } from '../platform/sound';

export type { SoundEvent, SoundState };
export { SOUND_EVENTS };

export interface SoundBusOptions {
  /** Reads the persisted sound switch (defaults to on). */
  enabled?: () => boolean;
  /** Called once when the service reports it cannot play audio. */
  onUnavailable?: (message: string) => void;
}

export interface SoundBus {
  /** True when the platform has a working AudioContext. */
  available(): boolean;
  state(): SoundState;
  /** Honest, player-facing status for the settings row. */
  statusText(): string;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  /** Must be invoked synchronously from a real user gesture. */
  unlock(): boolean;
  /**
   * Plays one cue. `frameToken` (any monotonic number, normally the engine
   * tick) dedupes repeated calls for the same frame/event.
   */
  play(event: SoundEvent, frameToken?: number): boolean;
  suspend(): Promise<boolean>;
  resume(): Promise<boolean>;
  dispose(): void;
}

function errorText(error: SoundInitError | null): string {
  return error && error.message ? error.message : '';
}

class Bus implements SoundBus {
  private readonly service: SoundService;
  private readonly onUnavailable: ((message: string) => void) | null;
  private unavailableReported = false;
  private readonly played: Set<SoundEvent> = new Set();
  private frameToken = -1;

  constructor(service: SoundService, options?: SoundBusOptions) {
    this.service = service;
    this.onUnavailable = (options && options.onUnavailable) || null;
    if (options && options.enabled) {
      try {
        this.service.setEnabled(options.enabled() === true);
      } catch (error) {
        this.reportUnavailable();
      }
    }
  }

  available(): boolean {
    return this.service.isSupported();
  }

  state(): SoundState {
    return this.service.state();
  }

  statusText(): string {
    const state = this.service.state();
    if (state === 'unavailable') return '音效不可用（当前环境无音频支持），已静音';
    if (state === 'failed') {
      const detail = errorText(this.service.lastError());
      return '音效初始化失败' + (detail ? '：' + detail : '');
    }
    if (state === 'disposed') return '音效已释放';
    if (state === 'disabled') return '音效已关闭';
    if (state === 'idle') return '音效待激活 · 首次触屏后生效';
    if (state === 'suspended') return '音效已暂停';
    return '音效已开启';
  }

  setEnabled(enabled: boolean): void {
    this.service.setEnabled(enabled === true);
  }

  isEnabled(): boolean {
    return this.service.isEnabled();
  }

  unlock(): boolean {
    // A deliberately muted service returns false without being broken: that is
    // the player's preference, not an unavailable environment. Only report a
    // failure when the service is enabled and still cannot start.
    if (!this.service.isEnabled()) return false;
    const ok = this.service.unlock();
    if (!ok && this.service.state() !== 'disabled') this.reportUnavailable();
    return ok;
  }

  play(event: SoundEvent, frameToken?: number): boolean {
    if (frameToken !== undefined && frameToken >= 0) {
      if (frameToken !== this.frameToken) {
        this.frameToken = frameToken;
        this.played.clear();
      }
      if (this.played.has(event)) return false;
      this.played.add(event);
    }
    return this.service.play(event);
  }

  async suspend(): Promise<boolean> {
    return this.service.suspend();
  }

  async resume(): Promise<boolean> {
    return this.service.resume();
  }

  dispose(): void {
    this.service.dispose();
  }

  private reportUnavailable(): void {
    if (this.unavailableReported) return;
    this.unavailableReported = true;
    if (this.onUnavailable) this.onUnavailable(this.statusText());
  }
}

/** Wraps the real service. `service` may be null only before it is created. */
export function createSoundBus(
  service: SoundService | null,
  options?: SoundBusOptions
): SoundBus {
  if (!service) {
    return {
      available: function () {
        return false;
      },
      state: function () {
        return 'unavailable';
      },
      statusText: function () {
        return '音效不可用（当前环境无音频支持），已静音';
      },
      setEnabled: function () {},
      isEnabled: function () {
        return false;
      },
      unlock: function () {
        return false;
      },
      play: function () {
        return false;
      },
      suspend: async function () {
        return false;
      },
      resume: async function () {
        return false;
      },
      dispose: function () {},
    };
  }
  return new Bus(service, options);
}

/** Maps a core match event to its cue, if that event type makes a sound. */
export function soundForCoreEvent(
  type: string,
  owner: string | undefined,
  playerOwner: 'player' | 'ai1'
): SoundEvent | null {
  // Front events carry their own action (start/replace/stop/cancel/capture), so
  // the shell maps those explicitly instead of picking one cue per type.
  if (type === 'front') return null;
  if (type === 'march') return 'march';
  if (type === 'defend') return 'defend';
  if (type === 'capture') return owner === playerOwner ? 'capture' : 'lost';
  if (type === 'overflow') return 'defend';
  if (type === 'cannon') return 'defend';
  if (type === 'upgrade') return 'upgrade';
  if (type === 'eliminated') return owner === playerOwner ? 'lost' : 'capture';
  return null;
}

/**
 * One cue per real match event, already resolved for the session's mode.
 *
 * Versus shares one speaker between two humans: any capture is a positive cue
 * there (playing "lost" for the capturing side would be plainly wrong). Solo
 * keeps the player-centric capture/lost split.
 */
export function soundForMatchEvent(
  type: string,
  owner: string | undefined,
  versus: boolean
): SoundEvent | null {
  if (!versus) return soundForCoreEvent(type, owner, 'player');
  if (type === 'capture') return 'capture';
  if (type === 'eliminated') return owner === 'player' ? 'lost' : 'capture';
  return soundForCoreEvent(type, owner, 'player');
}
