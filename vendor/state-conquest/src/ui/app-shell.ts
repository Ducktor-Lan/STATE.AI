import { GestureController, idleGestureState } from '../input/gesture-controller';
import type { GestureCancelReason, GestureState } from '../input/gesture-controller';
import { hitTestTerritory } from '../input/hit-test';
import { bindGestureInput, createCanvasPointMapper } from '../input/pointer-binding';
import type { GestureBinding } from '../input/pointer-binding';
import type { PlayerId } from '../game-api';
import { createPlatformAdapter } from '../platform';
import type { PlatformAdapter } from '../platform';
import { SoundService } from '../platform/sound';
import { CanvasRenderer } from '../rendering/canvas-renderer';
import { playerColorOption } from './player-colors';
import { collectDisasterStrike } from '../rendering/effects';
import { shouldHoldEndForCollapse } from '../rendering/defense-visuals';
import {
  CHALLENGE_RULES_VERSION,
  compareChallengeScore,
  decodeChallengeAny,
  encodeChallengeV2,
  encodeChallengeV3,
} from '../core/challenge';
import type { ChallengePayload } from '../core/challenge';
import { createAuthorOverlay } from './author-overlay';
import { ChallengeScreen } from './challenge-screen';
import type { ChallengeStartContext } from './challenge-screen';
import {
  normalizeFactionCount,
} from './factions';
import type { FactionCount } from './factions';
import { createConfirmOverlay } from './confirm';
import { el, button, setText } from './dom';
import { durationLabel, reasonText } from './format';
import {
  deriveDiplomacyPanel,
  pendingOfferForPlayer,
  playerHasActiveAlly,
  truceLegalityText,
  truceOfferFailureText,
} from './diplomacy-view';
import { createGameAdapter, createTutorialGameAdapter, TUTORIAL_SCENE } from './game-adapter';
import type { GameAdapter } from './game-adapter';
import { GameScreen, betrayalReasonText } from './game-screen';
import type { DispatchPanelState } from './game-screen';
import { createOverlay } from './overlay';
import {
  TICKS_PER_SECOND,
  VERSUS_BLUE_NAME,
  VERSUS_INTRO_AUTO_DISMISS_MS,
  VERSUS_INTRO_BODY,
  VERSUS_INTRO_HINT,
  VERSUS_INTRO_TITLE,
  VERSUS_NO_UPGRADE_NOTE,
  VERSUS_RED_NAME,
  VERSUS_TAGLINE,
} from '../config/balance';
import { HomeScreen } from './home-screen';
import { LeaderboardScreen } from './leaderboard-screen';
import { LeaderboardStore } from './leaderboard-store';
import { createPauseOverlay } from './pause-screen';
import type { PauseOverlayElement } from './pause-screen';
import { ProfileScreen } from './profile-screen';
import { ProgressScreen } from './progress-screen';
import { ProfileStore, PROFILE_STORAGE_KEYS } from './profile-store';
import type { CommanderProfile } from './profile-store';
import { createResultScreen } from './result-screen';
import { createRulesOverlay } from './rules';
import { SetupScreen } from './setup-screen';
import { SettingsStore, SETTINGS_STORAGE_KEYS, isoDateLabel } from './settings-store';
import type { GameSpeed, MatchRecord } from './settings-store';
import { createResetConfirmOverlay, createSettingsOverlay } from './settings-overlay';
import type { StorageRemoveReport } from '../platform/storage';
import { createTutorialController } from './tutorial';
import type { TutorialAnchor, TutorialGate, TutorialState } from './tutorial';
import { UpgradeScreen } from './upgrade-screen';
import {
  DEFAULT_SETTINGS,
  RANDOM_MAP_ID,
  findTerritory,
  settlementPolicy,
} from './view-model';
import type {
  GameSettings,
  MatchMode,
  MatchView,
  UpgradeEvaluationDetail,
  UpgradeKind,
} from './view-model';
import {
  createMatchSpeedRecord,
  isMatchSpeed,
  maxCatchUpStepsFor,
  planSimulationSteps,
  speedLabel,
  speedStatusText,
  stepAlpha,
} from './v120-speed';
import { applySpeedChange } from './v120-speed';
import type { MatchSpeed, SpeedRecord } from './v120-speed';
import {
  DEFAULT_DISPATCH_MODE,
  createAdapterFrontsPort,
  evaluateDispatchDrag,
  lineStopTargets,
  idleSelectionHint,
  plainLineNotice,
  summarizeSelectionLines,
} from './v120-fronts';
import type { DispatchMode, FrontLineView, FrontsPort, LineOwner } from './v120-fronts';
import {
  evaluateCodeAcceptance,
  evaluateCodeEligibility,
} from './v120-challenge-policy';
import type { CodeEligibility } from './v120-challenge-policy';
import { createSoundBus, soundForMatchEvent } from './v120-sound';
import type { SoundBus } from './v120-sound';
import { captureLabel, captureTone, defenseViewerFor } from './v120-events';
import {
  closeCountdownOverlay,
  countdownFinishAction,
  countdownStartAllowed,
  planVisibilityChange,
} from './v120-lifecycle';
import type { LifecyclePhase } from './v120-lifecycle';
import type { VersusSide } from './versus-pane';

/**
 * Pure v1.4.0 seating derivation for one match start. The seat count comes
 * ONLY from the path that owns the match:
 *   - tutorial and versus are by definition the 2-faction layout;
 *   - a challenge carries its accepted code's count (v3 states 3|4; the older
 *     families are the historical 2) — the store is never consulted;
 *   - an ordinary solo match reads the player's stored preference.
 * Missing/illegal values degrade to the legacy 2 instead of guessing.
 */
export function resolveMatchFactionCount(options: {
  tutorialMode?: boolean;
  versus?: boolean;
  challengeFamily?: string | null;
  challengeFactionCount?: number | null;
  settingsFactionCount?: number | null;
  storeFactionCount?: number | null;
}): FactionCount {
  if (options.tutorialMode || options.versus) return 2;
  if (options.challengeFamily) {
    // A v3 context that lost its count degrades to practice below (the
    // settlement refuses comparability) but still never inherits the store.
    if (options.challengeFactionCount === 3 || options.challengeFactionCount === 4) {
      return options.challengeFactionCount;
    }
    return 2;
  }
  return normalizeFactionCount(
    options.settingsFactionCount !== undefined && options.settingsFactionCount !== null
      ? options.settingsFactionCount
      : options.storeFactionCount
  );
}

const FIXED_DT_MS = 100;
/** Last finished-match challenge code; kept in the shared platform KV store. */
const LAST_CHALLENGE_KEY = 'challenge-last';
/**
 * Every key owned by this tool. A reset removes exactly these; it never clears
 * the whole storage namespace, so unrelated keys on the same origin survive.
 */
const RESET_STORAGE_KEYS: readonly string[] = [
  ...PROFILE_STORAGE_KEYS,
  ...SETTINGS_STORAGE_KEYS,
  LAST_CHALLENGE_KEY,
];
/** A hung platform call must not leave the reset overlay up forever. */
const RESET_DEADLINE_MS = 15000;
const RESET_KEY_LABELS: Record<string, string> = {
  profile: '指挥官档案',
  'profile-backup': '损坏档案备份',
  settings: '偏好设置',
  records: '最近战绩',
  leaderboard: '本机排行榜',
  [LAST_CHALLENGE_KEY]: '上次挑战码',
};
/**
 * A 0 target is trivially beaten by any positive score, so accepting it would
 * make the comparison meaningless. The codec still round-trips 0 (it is a valid
 * boundary value); only the accept path refuses it.
 */
const CHALLENGE_ZERO_SCORE_MESSAGE = '挑战目标分数为 0，无法接受';

const UPGRADE_FEEDBACK: Record<UpgradeKind, string> = {
  production: '产兵↑',
  march: '行军↑',
  defense: '城防↑',
};
const UPGRADE_MAX_LEVEL: Record<UpgradeKind, number> = {
  production: 3,
  march: 3,
  defense: 2,
};

const NO_UPGRADE_STATES: Record<UpgradeKind, UpgradeEvaluationDetail | null> = {
  production: null,
  march: null,
  defense: null,
};

interface OverlayEntry {
  el: HTMLElement;
  escape: (() => void) | null;
  focus: boolean;
}

/**
 * Local structural contract for the reset barrier. The leaderboard module can
 * join by exposing the same three methods; no shared base class is needed.
 */
interface ResetParticipant {
  beginReset(): Promise<void>;
  completeReset(): void;
  abortReset(): void;
}

interface CommandLogEntry {
  at: number;
  type: string;
  source?: string;
  target?: string;
  territory?: string;
  ratio?: number;
  sent?: number;
  accepted: boolean;
}

interface StartMatchOptions {
  /** Opens the fixed teaching battlefield instead of a stored/random match. */
  tutorial?: boolean;
  tutorialEntry?: 'onboarding' | 'replay';
  /** Home/replay already expressed intent, so skip the intro card. */
  tutorialSkipIntro?: boolean;
}

function clockNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function moveReasonText(reason: string | null | undefined, hasAlly: boolean): string {
  if (reason === 'not_adjacent') {
    // The routing rule is real: with an active ally, reachability lets the
    // passage cross that ally's land; without one, own land only.
    return hasAlly
      ? '未接通前线 · 须沿相连的己方或盟友领地借道'
      : '未接通前线 · 须沿相连的己方领地出兵';
  }
  if (reason === 'truce') return '停战期间不能互相攻击';
  return reasonText(reason);
}

/** One seed per new match; dev builds can pin it for reproducible runs. */
function createMatchSeed(): number {
  const mixed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  return mixed === 0 ? 1 : mixed;
}

export class App {
  private readonly root: HTMLElement;
  private frameRoot!: HTMLElement;
  private viewHost!: HTMLElement;
  private overlayHost!: HTMLElement;

  private currentScreen: HTMLElement | null = null;
  private gameScreen: GameScreen | null = null;
  private mode:
    | 'home'
    | 'setup'
    | 'game'
    | 'result'
    | 'profile'
    | 'upgrade'
    | 'progress'
    | 'challenge'
    | 'leaderboard' = 'home';

  private settings: GameSettings = {
    durationSeconds: DEFAULT_SETTINGS.durationSeconds,
    difficulty: DEFAULT_SETTINGS.difficulty,
    mapId: DEFAULT_SETTINGS.mapId,
    // factionCount stays unset until hydration reads the stored preference;
    // match start then falls back to the store's 2-faction default.
  };

  private game: GameAdapter | null = null;
  /** Solo renderer; in versus this is the blue pane (legacy entry point). */
  private renderer: CanvasRenderer | null = null;
  /** Solo gesture; in versus this is the blue controller. */
  private gesture: GestureController | null = null;
  private binding: GestureBinding | null = null;
  private redRenderer: CanvasRenderer | null = null;
  private redGesture: GestureController | null = null;
  private redBinding: GestureBinding | null = null;
  private cameraRemovers: Array<() => void> = [];
  private cameraPanStops: Array<() => void> = [];
  /** Blue/solo selection plus the independent red selection in versus. */
  private selectedId: string | null = null;
  private selectedRedId: string | null = null;

  private rafId: number | null = null;
  private lastFrameTime = 0;
  private accumulator = 0;
  private matchStarted = false;
  private resultShown = false;
  /**
   * Frame clock of the moment the engine reported `ended`. Non-null only while
   * the shell is holding the settlement so a real capture collapse finished by
   * that same frame can play out. The core clock is already stopped then: no
   * simulation tick is ever advanced during the hold.
   */
  private endHoldSince: number | null = null;
  /** Diagnostics: how many real frames the ending was held for. */
  private endHoldFrames = 0;
  /** Wall-clock stamp of going hidden, so the hidden gap can be discarded. */
  private hiddenAt: number | null = null;
  /** Dedicated interactive lesson; non-null only while it owns `this.game`. */
  private tutorial: ReturnType<typeof createTutorialController> | null = null;
  private tutorialSession = false;
  /** Where an aborted lesson returns: onboarding -> setup, replay -> home. */
  private tutorialEntry: 'onboarding' | 'replay' = 'replay';
  /** The controller's free-play clock is extended exactly once. */
  private tutorialFreeplayEntered = false;
  /** The shell auto-opens its own result panel when the lesson completes. */
  private tutorialResultShown = false;
  private tutorialGate: TutorialGate | null = null;
  /**
   * Last canvas CSS size the lesson highlight was computed against. `-1` means
   * "not measured yet", so the first real frame always refreshes the anchor.
   * A canvas that starts at 0x0 (before layout) would otherwise pin the
   * highlight to the fallback 1x1 viewport until the player resized the window.
   */
  private tutorialLayoutWidth = -1;
  private tutorialLayoutHeight = -1;
  /** New archive's one-time casual default waits for settings hydration. */
  private firstRunDefaultsPending = false;
  /** Settings waiters run once the first asynchronous load has settled. */
  private settingsWaiters: Array<() => void> = [];
  /** Waiters for "load settled AND first-run defaults applied". */
  private settingsSettledWaiters: Array<() => void> = [];
  private settingsLoadingOverlay: HTMLElement | null = null;
  /** No onboarding prompt re-entry while one is already on screen. */
  private onboardingPromptOpen = false;
  /** A prompt was already offered this session (never on every home paint). */
  private onboardingPromptShown = false;
  private previousPlayerLand = -1;
  /** Match shape chosen at the entry point; survives "再来一局". */
  private matchMode: MatchMode = 'solo';

  private countdownTimer: number | null = null;
  private countdownOverlay: HTMLElement | null = null;
  /** A countdown that must (re)start once the page is visible again. */
  private countdownPending = false;
  private versusIntroTimer: number | null = null;
  private countdownToken = 0;

  /** v1.2 speed: chosen at start, may change while paused (never locked mid). */
  private speedRecord: SpeedRecord | null = null;
  /** True when the challenge code fixed this match's speed. */
  private speedLocked = false;
  /** v1.2 continuous dispatch. */
  private dispatchMode: DispatchMode = DEFAULT_DISPATCH_MODE;
  private fronts: FrontsPort | null = null;
  private linesCache: FrontLineView[] | null = null;
  private linesRevision = -1;
  /** Sound service lives for the whole app session (never disposed on restart). */
  private soundService: SoundService | null = null;
  private soundBus: SoundBus | null = null;
  /** Unlock is attempted once per user gesture until it succeeds. */
  private soundUnlocked = false;
  private soundUnlockHandlers: Array<() => void> = [];
  /** Context accepted from the challenge screen (family/comparable/...). */
  private activeChallengeContext: ChallengeStartContext | null = null;

  private overlayStack: OverlayEntry[] = [];
  private pauseOverlay: PauseOverlayElement | null = null;
  private truceOfferOverlay: HTMLElement | null = null;
  /** Offer ids are scoped to this match, including restarts with the same seed. */
  private shownTruceOfferIds = new Set<string>();
  private lastFocused: HTMLElement | null = null;

  private lastUpgradeAt = 0;
  private lastBetrayalAt = 0;
  /** A successful betrayal owns the toast briefly; generic land notices wait. */
  private lastBetrayalNoticeAt = 0;
  private disasterInitialized = false;
  private disasterStruckSeen = false;
  private upgradeCacheRevision = -1;
  private upgradeCacheSelected: string | null = null;
  private upgradeCache: Record<UpgradeKind, UpgradeEvaluationDetail | null> =
    NO_UPGRADE_STATES;
  private commandLog: CommandLogEntry[] = [];
  private frameCount = 0;
  private lastFrameAt = 0;
  private lastTickAt = 0;
  private rafScheduledAt = 0;

  private readonly frameLoop = (now: number): void => {
    this.frameStep(now);
  };

  private readonly handleResize = (): void => {
    this.setAppHeight();
    if (this.renderer) this.renderer.invalidateLayout();
    if (this.redRenderer) this.redRenderer.invalidateLayout();
    if (this.gesture) this.gesture.cancel('resize');
    if (this.redGesture) this.redGesture.cancel('resize');
    this.stopAllCameraPans();
    if (this.tutorial) this.tutorial.refreshTargetAnchor();
    if (this.game && this.matchStarted && this.game.view().status === 'playing') {
      this.updateGameUI();
    }
    // A resize while the frame loop is stopped (paused match or hidden IAB)
    // must still repaint from the current snapshot: the canvas bitmap keeps
    // the old aspect ratio and the CSS stretch would smear it (and leave the
    // stale layout cached) until the next frame. Pure presentation of the
    // live view — no tick is advanced and visibility/rAF handling is untouched.
    if (this.game) this.redrawMap();
  };

  private readonly handleVisibility = (): void => {
    const plan = planVisibilityChange(this.visibilitySnapshot());
    if (plan.stopLoop) this.stopLoop();
    if (plan.suspendSound && this.soundBus) void this.soundBus.suspend();
    if (plan.cancelCountdown) this.cancelCountdown();
    if (plan.deferCountdown) this.countdownPending = true;
    if (plan.autoPause) this.pauseGame(true);
    if (document.hidden) {
      // A capture collapse runs on the wall clock, and so does the settlement
      // hold that waits for it. Neither may burn its window while the tab is
      // in the background: freeze both, and let the visible path shift them by
      // exactly the hidden gap so the fall still plays from where it stopped.
      this.hiddenAt = clockNow();
      this.forEachRenderer(function (renderer) {
        renderer.pauseDefenseCollapses();
      });
      return;
    }
    this.resumeAfterHidden();
    // Coming back is a fresh chance to resume audio, but the browser may still
    // require a gesture. A rejected resume is reported by the service, not faked.
    if (plan.resumeSound && this.soundBus && this.soundUnlocked) {
      void this.soundBus.resume();
    }
    // A deferred countdown restarts from 3; it owns the kick-off and the loop.
    if (plan.restartCountdown) this.beginCountdown();
    else if ((plan.startLoop || this.needsEndSettle()) && this.rafId === null) {
      // The shared lifecycle policy only restarts the loop for a LIVE match.
      // A match that ended while the page was hidden still owes a settlement
      // frame, so coming back must drive it to the result screen instead of
      // leaving the game screen frozen with no rAF.
      this.startLoop();
    }
  };

  /**
   * Discards exactly the hidden gap from the collapse animations and from the
   * settlement hold. Without this the first visible frame would find every
   * collapse already expired and settle instantly, so the player would never
   * see the final fort fall.
   */
  private resumeAfterHidden(): void {
    const hiddenAt = this.hiddenAt;
    this.hiddenAt = null;
    if (hiddenAt === null) return;
    const gap = clockNow() - hiddenAt;
    if (!(gap > 0)) return;
    if (this.endHoldSince !== null) this.endHoldSince += gap;
    // A match still sitting on the pause card stays frozen; `resumeGame` owns
    // that path and discards the whole paused gap itself.
    if (this.game && this.game.view().status === 'paused') return;
    this.forEachRenderer(function (renderer) {
      renderer.resumeDefenseCollapses();
    });
  }

  /**
   * True while the engine reported `ended` but the result screen has not been
   * shown yet (a collapse is finishing, or a frame was missed). Read-only.
   */
  private needsEndSettle(): boolean {
    if (!this.game || !this.gameScreen || this.resultShown) return false;
    return this.game.view().status === 'ended';
  }

  /** Current lifecycle phase used by the visibility policy. */
  private visibilitySnapshot(): {
    hidden: boolean;
    phase: LifecyclePhase;
    rafPending: boolean;
    hasGame: boolean;
  } {
    const hidden = typeof document !== 'undefined' && document.hidden === true;
    let phase: LifecyclePhase = 'idle';
    if (this.game) {
      // The ENGINE status is authoritative: a session that reports `playing`
      // must auto-pause on hide even if the shell flag has not caught up yet.
      const status = this.game.view().status;
      if (status === 'playing') phase = 'playing';
      else if (status === 'paused') phase = 'paused';
      else if (status === 'ended') phase = 'ended';
      else if (this.countdownPending || this.countdownTimer !== null) {
        phase = 'countdown';
      } else {
        phase = 'pre-match';
      }
    }
    return {
      hidden: hidden,
      phase: phase,
      rafPending: this.rafId !== null,
      hasGame: this.game !== null,
    };
  }

  private readonly handleBlur = (): void => {
    if (this.soundBus) void this.soundBus.suspend();
    if (this.game && this.matchStarted && this.game.view().status === 'playing') {
      this.pauseGame(true);
    }
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    if (this.overlayStack.length === 0) return;
    const top = this.overlayStack[this.overlayStack.length - 1];
    if (!top.escape) return;
    if (event.preventDefault) event.preventDefault();
    top.escape();
  };

  private readonly seedOverride: number | null;
  private readonly platform: PlatformAdapter;
  private readonly store: SettingsStore;
  private readonly profiles: ProfileStore;
  private readonly leaderboard: LeaderboardStore;
  private profile: CommanderProfile | null = null;
  private activeProgressScreen: ProgressScreen | null = null;
  /** Frozen player swatch id for the currently running match/report. */
  private matchPlayerColorId = 'blue';
  private profileCorrupted = false;
  /** Read-only copy of the finished match, kept for dev diagnostics only. */
  private lastResultView: MatchView | null = null;
  /** Locked code accepted from the challenge screen; null in normal play. */
  private activeChallenge: ChallengePayload | null = null;
  /** Most recent finished-match code, shown under "我的挑战码" this session. */
  private lastChallengeCode: string | null = null;
  /** Serializes challenge-last writes so a wipe can drain them. */
  private challengeWriteChain: Promise<void> = Promise.resolve();
  /** Bumped after the challenge queue drains; queued pre-wipe writes still land. */
  private challengeWriteEpoch = 0;
  /**
   * Bumped at the start of a wipe. Hydration callbacks and queued challenge
   * writes captured an older epoch and drop their result instead of restoring
   * pre-wipe data after the wipe succeeded.
   */
  private resetEpoch = 0;
  private resetInProgress = false;
  /** Set while a removeMany call is still unresolved (timeout = unknown, not failure). */
  private pendingDeletion: Promise<StorageRemoveReport> | null = null;
  private resetPhase: 'idle' | 'running' | 'unknown' | 'failed' = 'idle';
  private resetDeadlineTimer: number | null = null;

  constructor(root: HTMLElement, seedOverride?: number, platform?: PlatformAdapter) {
    this.root = root;
    this.seedOverride =
      typeof seedOverride === 'number' && isFinite(seedOverride)
        ? Math.floor(seedOverride)
        : null;
    this.platform = platform || createPlatformAdapter();
    this.store = new SettingsStore(this.platform);
    this.leaderboard = new LeaderboardStore(this.platform, {
      optIn: () => this.store.current().leaderboardOptIn === true,
    });
    // A failed write while the home card is on screen repaints it with the
    // "cannot save" hint instead of waiting for the next navigation.
    this.profiles = new ProfileStore(this.platform, (ok) => {
      if (this.overlayStack.length > 0) return;
      if (this.mode === 'progress') {
        if (this.activeProgressScreen) this.activeProgressScreen.sync();
        return;
      }
      if (ok) return;
      if (this.mode !== 'home') return;
      this.showHome();
    });
  }

  init(): void {
    this.root.textContent = '';
    const frame = el('div', 'app-frame');
    const viewHost = el('div', 'view-host');
    const overlayHost = el('div', 'overlay-host');
    frame.appendChild(viewHost);
    frame.appendChild(overlayHost);
    this.root.appendChild(frame);
    this.frameRoot = frame;
    this.viewHost = viewHost;
    this.overlayHost = overlayHost;

    this.setAppHeight();
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('orientationchange', this.handleResize);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('visibilitychange', this.handleVisibility);
    document.addEventListener('keydown', this.handleKeydown);
    if (typeof window !== 'undefined' && 'visualViewport' in window) {
      const viewport = (window as unknown as { visualViewport?: VisualViewport }).visualViewport;
      if (viewport) viewport.addEventListener('resize', this.handleResize);
    }

    this.applyStoredSettings();
    this.syncPlayerColorVars();
    this.showHome();
    this.hydrateSettings();
    this.hydrateProfile();
    this.hydrateLeaderboard();
    this.hydrateChallengeCode();
    this.initSound();
    this.bindEarlySoundUnlock();
  }

  /**
   * One SoundService for the whole session. Restarting or leaving a match only
   * suspends/resumes it; disposing would kill audio until the app reloads.
   * Unlock happens inside the first real gesture (see the canvas bindings).
   */
  private initSound(): void {
    const self = this;
    try {
      this.soundService = new SoundService({ enabled: this.store.getSoundEnabled() });
    } catch (error) {
      this.soundService = null;
    }
    this.soundBus = createSoundBus(this.soundService, {
      enabled: function () {
        return self.store.getSoundEnabled();
      },
      onUnavailable: function (message) {
        if (self.gameScreen) self.gameScreen.showNotice(message, 'info');
      },
    });
  }

  /** Called synchronously from a real pointerdown/touchstart on the battlefield. */
  private unlockSound(): void {
    if (!this.soundBus) return;
    if (!this.store.getSoundEnabled()) return;
    const state = this.soundBus.state();
    if (state === 'unavailable' || state === 'failed' || state === 'disabled' || state === 'disposed') {
      return;
    }
    // A real gesture may be the only moment the browser lets us start (or
    // recover from a lifecycle suspend), so always try while not running.
    if (state === 'running' && this.soundUnlocked) return;
    if (this.soundBus.unlock() || this.soundBus.state() === 'running') {
      this.soundUnlocked = true;
      void this.soundBus.resume();
      // A life-long one-shot: the first successful gesture is enough for the
      // whole session, so the document listeners can go.
      this.removeSoundUnlockListeners();
    }
  }

  /**
   * Early unlock path: the first tap anywhere (start button, home card) is a
   * real gesture too, so audio is ready by the time a match begins. Kept as
   * document-level listeners because the battlefield binding only exists while
   * a match is open.
   */
  private bindEarlySoundUnlock(): void {
    const self = this;
    const handler = function (): void {
      self.unlockSound();
    };
    this.soundUnlockHandlers.push(handler);
    document.addEventListener('pointerdown', handler, { capture: true });
    document.addEventListener('touchstart', handler, { capture: true, passive: true });
  }

  private removeSoundUnlockListeners(): void {
    for (let i = 0; i < this.soundUnlockHandlers.length; i += 1) {
      const handler = this.soundUnlockHandlers[i];
      document.removeEventListener('pointerdown', handler, { capture: true } as EventListenerOptions);
      document.removeEventListener('touchstart', handler, { capture: true } as EventListenerOptions);
    }
    this.soundUnlockHandlers = [];
  }

  private playSound(event: string, owner?: string): void {
    if (!this.soundBus) return;
    const versus = !!this.game && this.game.view().mode === 'versus';
    const cue = soundForMatchEvent(event, owner, versus);
    if (!cue) return;
    // One token per rendered frame: both versus panes drain the same events and
    // must not double-play a capture.
    this.soundBus.play(cue, this.frameCount);
  }

  private applyStoredSettings(): void {
    const stored = this.store.current();
    this.settings = {
      durationSeconds: stored.durationSeconds,
      difficulty: stored.difficulty,
      mapId: stored.themeId,
      // v1.4.0: the stored faction preference travels with the rest of the
      // normal settings so a fresh match seats the saved count.
      factionCount: stored.factionCount,
    };
    // Hydration may reveal a persisted sound switch that the constructor's
    // session defaults did not know about yet.
    if (this.soundBus) this.soundBus.setEnabled(stored.soundEnabled);
  }

  /** Non-blocking: storage failures keep the in-memory defaults. */
  private hydrateSettings(navigate = true): void {
    const self = this;
    const epoch = this.resetEpoch;
    Promise.resolve()
      .then(function () {
        return self.store.load();
      })
      .then(function () {
        if (epoch !== self.resetEpoch) return;
        self.applyStoredSettings();
        // A first archive created before the settings read returned gets its
        // casual recommendation only now, so a late load cannot overwrite it.
        self.flushFirstRunDefaults();
        // Profile and settings reads race on startup. When the restored
        // first-run invite already opened, repainting home here would tear its
        // overlay down and the player would see no lesson entry at all.
        if (navigate && self.mode === 'home' && !self.onboardingPromptOpen) {
          self.showHome();
        }
      })
      .catch(function () {
        return undefined;
      })
      .then(function () {
        // Callbacks that must not run before hydration (the onboarding prompt,
        // the one-time casual default) are released even when the read failed:
        // the store then keeps its sanitized fallback, never a half state.
        if (epoch === self.resetEpoch) self.flushSettingsWaiters();
      });

    Promise.resolve()
      .then(function () {
        return self.platform.layout.applyCssVars();
      })
      .catch(function () {
        return undefined;
      });
  }

  /**
   * Loads the local best-score archive without blocking the first paint.
   * The store itself waits out a reset and rejects recording when storage could
   * not be read, so no reset-epoch copy is needed here.
   */
  private hydrateLeaderboard(): void {
    const self = this;
    Promise.resolve()
      .then(function () {
        return self.leaderboard.load();
      })
      .catch(function () {
        return undefined;
      });
  }

  /** Restores the last shareable code without blocking the first paint. */
  private hydrateChallengeCode(): void {
    const self = this;
    const epoch = this.resetEpoch;
    Promise.resolve()
      .then(function () {
        return self.platform.storage.read<string>(LAST_CHALLENGE_KEY);
      })
      .then(function (value) {
        if (epoch !== self.resetEpoch) return;
        if (typeof value !== 'string') {
          self.lastChallengeCode = null;
          return;
        }
        const decoded = decodeChallengeAny(value);
        // Keep the canonical uppercase/dashed form of either family; a
        // corrupted or foreign value is discarded instead of being shown as
        // "my challenge code".
        if (!decoded.ok) {
          self.lastChallengeCode = null;
          return;
        }
        self.lastChallengeCode = decoded.code;
      })
      .catch(function () {
        return undefined;
      });
  }

  /**
   * Loads the commander archive after the first paint. A missing archive (first
   * launch) forces the creation screen; a schema-invalid one forces it with a
   * "corrupted, will back up" notice; a storage read failure offers a retry and
   * never overwrites the existing key.
   */
  /** Keeps document-level accents in sync without mutating renderer palettes. */
  private syncPlayerColorVars(colorId?: string): void {
    const option = playerColorOption(colorId);
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.setProperty('--player', option.fill);
      document.documentElement.style.setProperty('--player-edge', option.edge);
      document.documentElement.style.setProperty('--player-badge', option.badge);
      document.documentElement.style.setProperty('--player-ink', option.ink);
      document.documentElement.style.setProperty('--player-deep', option.deep);
      document.documentElement.style.setProperty('--player-soft', option.soft);
    }
  }

  private hydrateProfile(forceHome = false, navigate = true): void {
    const self = this;
    const epoch = this.resetEpoch;
    Promise.resolve()
      .then(function () {
        return self.profiles.load();
      })
      .then(function (profile) {
        if (epoch !== self.resetEpoch) return;
        self.profile = profile;
        self.syncPlayerColorVars(profile ? profile.playerColorId : undefined);
        self.profileCorrupted = self.profiles.corrupted();
        if (!profile) {
          if (!navigate) return;
          if (self.profiles.loadState() === 'error') self.showProfileLoadError();
          else self.showProfileCreate();
          return;
        }
        if (navigate && (forceHome || self.mode === 'home')) self.showHome();
        // A persisted first-run marker (the app was closed before start/skip)
        // restores the entry, but only after settings hydration so a late load
        // cannot overwrite the lesson's difficulty choice.
        self.whenSettingsReady(function () {
          self.maybeShowOnboardingPrompt();
        });
      })
      .catch(function () {
        if (epoch !== self.resetEpoch) return;
        self.profile = null;
        self.profileCorrupted = true;
        if (navigate) self.showProfileLoadError();
      });
  }

  /**
   * Runs `callback` once the first settings read has settled. Before that the
   * resident value is only the in-memory fallback, so opening a first-run
   * prompt or applying the new-archive difficulty there could be overwritten
   * by the late load.
   */
  private whenSettingsReady(callback: () => void): void {
    if (this.store.isLoaded()) {
      callback();
      return;
    }
    this.settingsWaiters.push(callback);
  }

  private flushSettingsWaiters(): void {
    const waiters = this.settingsWaiters.slice();
    this.settingsWaiters = [];
    for (let i = 0; i < waiters.length; i += 1) {
      try {
        waiters[i]();
      } catch (error) {
        // One observer must not block the others.
      }
    }
    if (this.settingsSettled()) this.flushSettingsSettledWaiters();
  }

  /**
   * True only after the first settings read settled AND any first-run default
   * has been applied. Entering setup or starting before this would build the
   * screen from the in-memory fallback and let the late load overwrite it.
   */
  private settingsSettled(): boolean {
    return this.store.isLoaded() && !this.firstRunDefaultsPending;
  }

  private whenSettingsSettled(callback: () => void): void {
    if (this.settingsSettled()) {
      callback();
      return;
    }
    this.settingsSettledWaiters.push(callback);
    this.whenSettingsReady(() => {
      if (this.settingsSettled()) this.flushSettingsSettledWaiters();
    });
  }

  private flushSettingsSettledWaiters(): void {
    if (!this.settingsSettled()) return;
    const waiters = this.settingsSettledWaiters.slice();
    this.settingsSettledWaiters = [];
    for (let i = 0; i < waiters.length; i += 1) {
      try {
        waiters[i]();
      } catch (error) {
        // One observer must not block the others.
      }
    }
  }

  /**
   * Visible gate for every setup/start path. The player is told the local
   * settings are still loading instead of silently entering a default match
   * that a late hydration (and first-run casual default) would overwrite.
   */
  private waitForSettingsThen(
    action: () => void,
    expectedMode?: 'home'
  ): void {
    if (this.settingsSettled()) {
      this.runSettingsIntent(action, expectedMode);
      return;
    }
    if (this.settingsLoadingOverlay) return;
    const epoch = this.resetEpoch;
    const parts = createOverlay('settings-loading-overlay');
    parts.card.setAttribute('role', 'alertdialog');
    parts.card.setAttribute('aria-modal', 'true');
    parts.card.setAttribute('aria-busy', 'true');
    parts.card.setAttribute('aria-labelledby', 'settings-loading-title');
    parts.card.appendChild(el('p', 'overlay-kicker', 'LOCAL SETTINGS'));
    const title = el('h2', 'overlay-title', '正在读取本机设置');
    title.id = 'settings-loading-title';
    parts.card.appendChild(title);
    parts.card.appendChild(
      el(
        'p',
        'pause-copy',
        '设置尚未就绪，读取完成后会自动继续。期间不会使用默认值开局。'
      )
    );
    this.openOverlay(parts.root, { focus: false, escape: null });
    this.settingsLoadingOverlay = parts.root;

    this.whenSettingsSettled(() => {
      if (this.settingsLoadingOverlay === parts.root) {
        this.closeOverlay(parts.root);
        this.settingsLoadingOverlay = null;
      }
      // A wipe or another lifecycle reset owns this continuation now.
      if (epoch !== this.resetEpoch) return;
      this.runSettingsIntent(action, expectedMode);
    });
  }

  private runSettingsIntent(
    action: () => void,
    expectedMode?: 'home'
  ): void {
    if (expectedMode && this.mode !== expectedMode) return;
    // A brand-new archive still owes its start/skip decision; never let an
    // early start attempt jump straight into setup or a match.
    if (this.profiles.isOnboardingPending()) {
      this.maybeShowOnboardingPrompt();
      return;
    }
    action();
  }

  /**
   * Requests the one-time casual default for a brand-new archive. It waits for
   * hydration, and the flag is consumed exactly once: restoring a pending
   * onboarding on a later launch must not overwrite the player's choice.
   */
  private armFirstRunDefaults(): void {
    this.firstRunDefaultsPending = true;
    this.whenSettingsReady(() => this.flushFirstRunDefaults());
  }

  private flushFirstRunDefaults(): void {
    if (!this.firstRunDefaultsPending) return;
    if (!this.store.isLoaded()) return;
    const self = this;
    // The player already moved past the archive-creation home and is choosing
    // settings (or playing). A late default must never rewrite that choice.
    if (this.mode === 'setup' || this.mode === 'game' || this.mode === 'result') {
      this.firstRunDefaultsPending = false;
      Promise.resolve().then(function () {
        self.flushSettingsSettledWaiters();
      });
      return;
    }
    this.firstRunDefaultsPending = false;
    this.store.applyNewProfileDefaults();
    this.applyStoredSettings();
    // Let the caller finish its current render (home repaint) before a queued
    // start intent or the invite opens on top of it.
    Promise.resolve().then(function () {
      self.flushSettingsSettledWaiters();
    });
  }

  /** Offers the lesson only to a genuinely new, still-pending archive. */
  private maybeShowOnboardingPrompt(): void {
    if (this.mode !== 'home' || this.onboardingPromptOpen) return;
    if (this.onboardingPromptShown) return;
    if (!this.profiles.isLoaded() || !this.profile) return;
    if (!this.profiles.isOnboardingPending()) return;
    this.onboardingPromptShown = true;
    this.showOnboardingInvite();
  }

  /**
   * Start/skip for the first archive. The pending marker already rode in the
   * same profile write that created the archive, so closing the app here still
   * restores this entry on the next launch.
   */
  private showOnboardingInvite(): void {
    const self = this;
    const parts = createOverlay('onboarding-overlay');
    parts.card.setAttribute('role', 'dialog');
    parts.card.setAttribute('aria-modal', 'true');
    parts.card.setAttribute('aria-labelledby', 'onboarding-title');

    // Padding lives on the card and this body carries the scroll, so the copy
    // never sits against the rounded edges the way it did when the invite
    // appended straight onto the bare card.
    const body = el('div', 'onboarding-body');
    body.appendChild(el('p', 'overlay-kicker', 'FIRST STEPS · 新手引导'));
    const title = el('h2', 'overlay-title', '先用 1 分钟学会打仗');
    title.id = 'onboarding-title';
    body.appendChild(title);
    body.appendChild(
      el(
        'p',
        'pause-copy',
        '跟着真实战场做一遍：拖动出兵、占领村庄、升级主城、攻击敌哨。只认真实操作，随时可以跳过。'
      )
    );
    body.appendChild(
      el(
        'p',
        'pause-copy onboarding-note',
        '教学演练不计战绩、金币和排行榜，也不会改变正式对局设置。'
      )
    );
    // The pending marker shares the archive write. If that write failed, the
    // next launch cannot restore this invite; say so instead of implying it
    // was saved.
    if (!this.profiles.lastWriteOk()) {
      const warning = el(
        'p',
        'pause-copy onboarding-note',
        '当前环境无法保存档案：本次教学入口仅在本次会话内有效。'
      );
      warning.setAttribute('role', 'status');
      body.appendChild(warning);
    }

    const actions = el('div', 'pause-actions');
    const start = button('开始教学', 'btn btn-primary btn-wide', function () {
      self.onboardingPromptOpen = false;
      self.closeOverlay(parts.root);
      self.startTutorial('onboarding', true);
    });
    start.setAttribute('aria-label', '开始新手教学');
    start.setAttribute('data-autofocus', 'true');
    const skip = button('跳过，直接设置', 'btn btn-secondary btn-wide', function () {
      self.onboardingPromptOpen = false;
      self.closeOverlay(parts.root);
      self.settleOnboarding();
      self.showSetup();
    });
    skip.setAttribute('aria-label', '跳过新手教学，进入单人设置');
    actions.appendChild(start);
    actions.appendChild(skip);
    body.appendChild(actions);
    parts.card.appendChild(body);

    this.onboardingPromptOpen = true;
    this.openOverlay(parts.root, { focus: true, escape: null });
  }

  /**
   * The only place the first-run marker is cleared. It is called by explicit
   * skip, by leaving the lesson for home/setup, and by a completed or ended
   * lesson. `tutorialDone` stays written for pre-v1.3 compatibility.
   */
  private settleOnboarding(): void {
    if (this.profiles.isOnboardingPending()) {
      const result = this.profiles.completeOnboarding();
      if (result.ok) this.profile = this.profiles.current();
    }
    if (!this.store.current().tutorialDone) {
      this.store.update({ tutorialDone: true });
    }
  }

  private startTutorial(entry: 'onboarding' | 'replay', skipIntro = true): void {
    this.startMatch({
      tutorial: true,
      tutorialEntry: entry,
      tutorialSkipIntro: skipIntro,
    });
  }

  devApi(): unknown {
    const self = this;
    return {
      version: 'p0-dev',
      getSnapshot: function () {
        if (!self.game) return null;
        try {
          return JSON.parse(JSON.stringify(self.game.rawSnapshot()));
        } catch (error) {
          return null;
        }
      },
      getView: function () {
        if (!self.game) return null;
        try {
          return JSON.parse(JSON.stringify(self.game.view()));
        } catch (error) {
          return null;
        }
      },
      getLastResultView: function () {
        if (!self.lastResultView) return null;
        try {
          return JSON.parse(JSON.stringify(self.lastResultView));
        } catch (error) {
          return null;
        }
      },
      getGesture: function () {
        if (!self.gesture) return null;
        try {
          return JSON.parse(JSON.stringify(self.gesture.getState()));
        } catch (error) {
          return null;
        }
      },
      getGestures: function () {
        if (!self.gesture && !self.redGesture) return null;
        try {
          return JSON.parse(JSON.stringify(self.gestureStates()));
        } catch (error) {
          return null;
        }
      },
      getRenderGestures: function () {
        if (!self.renderer) return null;
        try {
          return JSON.parse(JSON.stringify(self.renderer.gestureRenderSummary()));
        } catch (error) {
          return null;
        }
      },
      getRejectFlashes: function () {
        let count = 0;
        self.forEachRenderer(function (renderer) {
          count += renderer.rejectFlashCount();
        });
        return count;
      },
      getSelected: function () {
        return self.selectedId;
      },
      getSelectedRed: function () {
        return self.selectedRedId;
      },
      getLastMessage: function () {
        return self.game ? self.game.lastMessage() : null;
      },
      getCommandLog: function () {
        try {
          return JSON.parse(JSON.stringify(self.commandLog));
        } catch (error) {
          return [];
        }
      },
      getScreen: function () {
        return self.mode;
      },
      getProfile: function () {
        if (!self.profile) return null;
        try {
          return JSON.parse(JSON.stringify(self.profile));
        } catch (error) {
          return null;
        }
      },
      /** Read-only onboarding/tutorial diagnostics (never mutates the archive). */
      getTutorial: function () {
        if (!self.tutorial) return null;
        try {
          return JSON.parse(JSON.stringify(self.tutorial.getState()));
        } catch (error) {
          return null;
        }
      },
      isTutorialSession: function () {
        return self.tutorialSession;
      },
      isOnboardingPending: function () {
        return self.profiles.isOnboardingPending();
      },
      getOverlayCount: function () {
        return self.overlayStack.length;
      },
      getViewport: function () {
        if (!self.game || !self.renderer) return null;
        const viewport = self.renderer.getViewport(self.game.view());
        return {
          width: viewport.width,
          height: viewport.height,
          mapWidth: viewport.mapWidth,
          mapHeight: viewport.mapHeight,
          scale: viewport.scale,
          offsetX: viewport.offsetX,
          offsetY: viewport.offsetY,
        };
      },
      /** Read-only per-pane diagnostics for the headless smoke and V1 GUI. */
      getPaneViewport: function (owner: string) {
        if (!self.game) return null;
        const side: 'player' | 'ai1' = owner === 'ai1' ? 'ai1' : 'player';
        const renderer = self.rendererForOwner(side);
        if (!renderer) return null;
        const viewport = renderer.getViewport(self.game.view());
        return {
          owner: side,
          width: viewport.width,
          height: viewport.height,
          mapWidth: viewport.mapWidth,
          mapHeight: viewport.mapHeight,
          scale: viewport.scale,
          offsetX: viewport.offsetX,
          offsetY: viewport.offsetY,
        };
      },
      getPaneCamera: function (owner: string) {
        const side: 'player' | 'ai1' = owner === 'ai1' ? 'ai1' : 'player';
        const renderer = self.rendererForOwner(side);
        if (!renderer) return null;
        const camera = renderer.getCamera();
        return {
          owner: side,
          zoom: camera.zoom,
          panX: camera.panX || 0,
          panY: camera.panY || 0,
        };
      },
      getPaneRotation: function (owner: string) {
        if (!self.gameScreen || !self.gameScreen.panes) return 0;
        return owner === 'ai1'
          ? self.gameScreen.panes.red.rotation
          : self.gameScreen.panes.blue.rotation;
      },
      getPaneSelection: function (owner: string) {
        return owner === 'ai1' ? self.selectedRedId : self.selectedId;
      },
      getPaneRenderGestures: function (owner: string) {
        const side: 'player' | 'ai1' = owner === 'ai1' ? 'ai1' : 'player';
        const renderer = self.rendererForOwner(side);
        if (!renderer) return null;
        try {
          return JSON.parse(JSON.stringify(renderer.gestureRenderSummary()));
        } catch (error) {
          return null;
        }
      },
      getPanes: function () {
        if (!self.gameScreen || !self.gameScreen.panes) return null;
        const out: unknown[] = [];
        const owners: Array<'player' | 'ai1'> = ['player', 'ai1'];
        for (let i = 0; i < owners.length; i += 1) {
          const owner = owners[i];
          const renderer = self.rendererForOwner(owner);
          if (!renderer || !self.game) continue;
          const viewport = renderer.getViewport(self.game.view());
          const camera = renderer.getCamera();
          out.push({
            owner: owner,
            rotation: self.gameScreen.panes[owner === 'ai1' ? 'red' : 'blue'].rotation,
            selection:
              owner === 'ai1' ? self.selectedRedId : self.selectedId,
            viewport: {
              width: viewport.width,
              height: viewport.height,
              scale: viewport.scale,
              offsetX: viewport.offsetX,
              offsetY: viewport.offsetY,
            },
            camera: {
              zoom: camera.zoom,
              panX: camera.panX || 0,
              panY: camera.panY || 0,
            },
            gestures: renderer.gestureRenderSummary(),
            rejectFlashes: renderer.rejectFlashCount(),
          });
        }
        return out;
      },
      getFrameStats: function () {
        return {
          now: Math.round(clockNow()),
          frameCount: self.frameCount,
          lastFrameAt: Math.round(self.lastFrameAt),
          lastTickAt: Math.round(self.lastTickAt),
          rafScheduledAt: Math.round(self.rafScheduledAt),
          rafPending: self.rafId !== null,
          accumulator: Math.round(self.accumulator * 10) / 10,
          hidden: typeof document !== 'undefined' ? document.hidden : null,
          visibility:
            typeof document !== 'undefined' ? document.visibilityState : null,
          hasFocus:
            typeof document !== 'undefined' && typeof document.hasFocus === 'function'
              ? document.hasFocus()
              : null,
        };
      },
    };
  }

  private setAppHeight(): void {
    const height =
      typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 0;
    if (height) {
      document.documentElement.style.setProperty('--app-height', height + 'px');
    }
  }

  private showHome(): void {
    this.closeAllOverlays();
    this.teardownGame();
    this.activeChallenge = null;
    this.setMode('home');
    const home = new HomeScreen(
      {
        onStart: () => {
          // Before hydration finishes, ignore the tap rather than risk
          // creating a fresh archive over an existing one.
          if (!this.profiles.isLoaded()) return;
          if (!this.profile) {
            this.showProfileEntry();
            return;
          }
          this.showSetup();
        },
        onVersus: () => {
          if (!this.profiles.isLoaded()) return;
          if (!this.profile) {
            this.showProfileEntry();
            return;
          }
          this.startVersus();
        },
        onChallenge: () => {
          if (!this.profiles.isLoaded()) return;
          if (!this.profile) {
            this.showProfileEntry();
            return;
          }
          this.showChallenge();
        },
        onRules: () => this.showRules(),
        onProfile: () => this.showProfileEdit(),
        onUpgrade: () => this.showUpgrade(),
        onProgress: () => this.showProgress(),
        onLeaderboard: () => this.showLeaderboard(),
        onSettings: () => this.showSettings(),
        onAuthor: () => this.showAuthor(),
        onTutorial: () =>
          this.startTutorial(
            this.profiles.isOnboardingPending() ? 'onboarding' : 'replay',
            true
          ),
      },
      {
        records: this.store.recentRecords(),
        profile: this.profile,
      }
    );
    this.setScreen(home.el);
    if (this.profile && !this.profiles.lastWriteOk()) {
      home.el.appendChild(this.saveWarningNode('home-save-warning'));
    }
  }

  /** Local best scores: grouped, local-only, and fully driven by LeaderboardStore. */
  private showLeaderboard(): void {
    this.closeAllOverlays();
    this.teardownGame();
    this.setMode('leaderboard');
    const self = this;
    const screen = new LeaderboardScreen(
      this.leaderboard,
      {
        optIn: () => self.store.current().leaderboardOptIn === true,
      },
      { onBack: () => self.showHome() }
    );
    this.setScreen(screen.el);
  }

  /** Reuses the profile notice styling for the "cannot persist" hint. */
  private saveWarningNode(extraClass: string, message?: string): HTMLElement {
    const warn = el(
      'p',
      'profile-notice ' + extraClass,
      message || '当前环境无法保存档案，金币与等级仅在本次会话内有效。'
    );
    warn.setAttribute('role', 'status');
    return warn;
  }

  /**
   * Every "no archive" entry keeps the read-error path recoverable: a failed
   * load is not proof of a missing archive, so it must offer retry instead of
   * dropping the player into a create form that would overwrite the key.
   */
  private showProfileEntry(): void {
    if (this.profiles.loadState() === 'error') {
      this.showProfileLoadError();
      return;
    }
    this.showProfileCreate();
  }

  private showProfileCreate(noticeOverride?: string): void {
    this.closeAllOverlays();
    this.teardownGame();
    this.setMode('profile');
    const self = this;
    const notice =
      noticeOverride !== undefined
        ? noticeOverride
        : this.profileCorrupted
          ? '本地档案数据已损坏，无法读取。建立新档案前会自动备份原始数据（仅保留最近一份）。'
          : undefined;
    const screen = new ProfileScreen(
      {
        mode: 'create',
        profile: null,
        notice: notice,
      },
      {
        onSave: function (nickname, avatarId, playerColorId) {
          // Capture the raw pre-create state: only a genuinely empty key is a
          // first launch. A corrupt rebuild or a read failure must not opt the
          // returning player into new-player defaults or the lesson prompt.
          const firstLaunch = self.profiles.loadState() === 'missing';
          const result = self.profiles.create(nickname, avatarId, playerColorId);
          if (result.ok) {
            self.profile = self.profiles.current();
            self.syncPlayerColorVars(self.profile ? self.profile.playerColorId : undefined);
            self.profileCorrupted = false;
            if (firstLaunch) {
              self.armFirstRunDefaults();
              self.onboardingPromptShown = false;
            }
            // Home must be the active screen before the prompt check: with an
            // already-hydrated settings store the callback below runs
            // synchronously, and it only offers the lesson on `mode==='home'`.
            self.showHome();
            if (firstLaunch) {
              self.whenSettingsReady(function () {
                self.maybeShowOnboardingPrompt();
              });
            }
          }
          return result;
        },
      }
    );
    this.setScreen(screen.el);
  }

  /**
   * Storage itself failed. This is not proof of a damaged archive, so the old
   * key is left untouched and the player can retry instead of rebuilding.
   */
  private showProfileLoadError(): void {
    this.closeAllOverlays();
    this.teardownGame();
    this.setMode('profile');
    const self = this;
    const root = el('section', 'screen profile-screen');
    root.setAttribute('aria-labelledby', 'profile-load-title');
    const header = el('header', 'setup-header');
    const titles = el('div', 'setup-titles');
    const title = el('h1', 'setup-title', '档案读取失败');
    title.id = 'profile-load-title';
    titles.appendChild(title);
    titles.appendChild(el('p', 'setup-subtitle', '本地存储暂时不可用'));
    header.appendChild(titles);
    const body = el('div', 'setup-body');
    const notice = el(
      'p',
      'profile-notice profile-load-error',
      '本地档案读取失败，但数据不一定损坏。请重试读取；成功之前不会覆盖原有档案。'
    );
    notice.setAttribute('role', 'alert');
    body.appendChild(notice);
    const retry = button('重试读取', 'btn btn-primary btn-wide', function () {
      self.hydrateProfile(true);
    });
    retry.setAttribute('aria-label', '重试读取本地档案');
    body.appendChild(retry);
    root.appendChild(header);
    root.appendChild(body);
    this.setScreen(root);
  }

  private showProfileEdit(): void {
    if (!this.profile) {
      this.showProfileEntry();
      return;
    }
    this.closeAllOverlays();
    this.teardownGame();
    this.setMode('profile');
    const self = this;
    const screen = new ProfileScreen(
      { mode: 'edit', profile: this.profile },
      {
        onBack: () => this.showHome(),
        onSave: function (nickname, avatarId, playerColorId) {
          const result = self.profiles.updateIdentity(nickname, avatarId, playerColorId);
          if (result.ok) {
            self.profile = self.profiles.current();
            self.syncPlayerColorVars(self.profile ? self.profile.playerColorId : undefined);
            self.showHome();
          }
          return result;
        },
      }
    );
    this.setScreen(screen.el);
  }

  private showUpgrade(): void {
    const profile = this.profiles.current();
    if (!profile) {
      this.showProfileEntry();
      return;
    }
    this.closeAllOverlays();
    this.teardownGame();
    this.setMode('upgrade');
    const self = this;
    const screen = new UpgradeScreen(profile, {
      onBack: () => this.showHome(),
      getProfile: () => self.profiles.current(),
      onBuy: function (level) {
        const result = self.profiles.buyBetrayalLevel(level);
        if (result.ok) self.profile = self.profiles.current();
        return result;
      },
    });
    this.setScreen(screen.el);
  }

  private showProgress(): void {
    const profile = this.profiles.current();
    if (!profile) {
      this.showProfileEntry();
      return;
    }
    this.closeAllOverlays();
    this.teardownGame();
    this.setMode('progress');
    const self = this;
    const screen = new ProgressScreen(profile, {
      onBack: () => self.showHome(),
      getProfile: () => self.profiles.current(),
      getSaveStatus: () => self.profiles.saveStatus(),
      onCheckIn: () => {
        const result = self.profiles.claimDailyCheckIn(new Date());
        if (result.ok) self.profile = self.profiles.current();
        return result;
      },
    });
    this.activeProgressScreen = screen;
    this.setScreen(screen.el);
  }

  private showSetup(): void {
    if (!this.settingsSettled()) {
      this.waitForSettingsThen(
        () => this.showSetup(),
        this.mode === 'home' ? 'home' : undefined
      );
      return;
    }
    if (this.profiles.isOnboardingPending() && this.mode === 'home') {
      this.maybeShowOnboardingPrompt();
      return;
    }
    this.openSetup();
  }

  private openSetup(): void {
    this.closeAllOverlays();
    this.teardownGame();
    this.activeChallenge = null;
    this.activeChallengeContext = null;
    this.setMode('setup');
    // The setup screen always opens on the STORED ordinary preferences — never
    // on the settings of the previous challenge or versus match. v1.4.0: the
    // faction count is part of those preferences.
    const stored = this.store.current();
    const setupSettings: GameSettings = {
      durationSeconds: stored.durationSeconds,
      difficulty: stored.difficulty,
      mapId: stored.themeId,
      factionCount: this.store.getFactionCount(),
    };
    const setup = new SetupScreen(
      {
        onBack: () => this.showHome(),
        onStart: (settings, speed) => {
          this.settings = settings;
          this.matchMode = 'solo';
          this.speedLocked = false;
          this.speedRecord = createMatchSpeedRecord(
            isMatchSpeed(speed) ? speed : this.store.getGameSpeed()
          );
          this.store.update({
            themeId: settings.mapId,
            durationSeconds: settings.durationSeconds,
            difficulty: settings.difficulty,
            // The chosen seating is an ordinary preference: saved with the
            // rest so the next plain match reuses it.
            factionCount: settings.factionCount,
          });
          if (isMatchSpeed(speed)) this.store.setGameSpeed(speed);
          this.startMatch();
        },
        getGameSpeed: () => this.store.getGameSpeed(),
        setGameSpeed: (speed) => {
          this.store.setGameSpeed(speed);
        },
        getFactionCount: () => this.store.getFactionCount(),
        setFactionCount: (count) => {
          this.store.setFactionCount(count);
        },
      },
      setupSettings,
      this.store.getGameSpeed()
    );
    this.setScreen(setup.el);
  }

  /**
   * Challenge entry. No network: the player types/pastes a code, sees the
   * locked parameters, then starts the exact seeded match.
   */
  private showChallenge(): void {
    if (!this.settingsSettled()) {
      this.waitForSettingsThen(() => this.showChallenge(), 'home');
      return;
    }
    if (this.profiles.isOnboardingPending()) {
      this.maybeShowOnboardingPrompt();
      return;
    }
    if (!this.profile) {
      this.showProfileEntry();
      return;
    }
    this.closeAllOverlays();
    this.teardownGame();
    this.activeChallenge = null;
    this.activeChallengeContext = null;
    this.setMode('challenge');
    const screen = new ChallengeScreen(
      {
        onBack: () => this.showHome(),
        onStart: (payload, code, context) => this.startChallenge(payload, code, context),
        // Policy lives with the shell; the screen renders it in its own error
        // node so accept-time refusals look identical to decode errors.
        validate: (payload) =>
          payload.score === 0 ? CHALLENGE_ZERO_SCORE_MESSAGE : null,
        // v1.2: legacy SC codes stay playable but are practice-only.
        validateCode: (decoded) => {
          const acceptance = evaluateCodeAcceptance(
            {
              family: decoded.family,
              fairness: decoded.fairness,
              speed: decoded.speed,
              rulesVersion: decoded.rulesVersion,
              comparable: decoded.comparable,
              // v1.4.0: an SM code must state its own 3|4 here — the policy
              // refuses a multi-party code without a legal count.
              factionCount: decoded.factionCount,
            },
            { currentRulesVersion: CHALLENGE_RULES_VERSION }
          );
          return acceptance.playable ? null : acceptance.notice;
        },
      },
      { lastCode: this.lastChallengeCode, decode: decodeChallengeAny }
    );
    this.setScreen(screen.el);
  }

  private startChallenge(
    payload: ChallengePayload,
    code?: string,
    context?: ChallengeStartContext
  ): void {
    // The setup screen is bypassed entirely: startMatch derives duration,
    // difficulty and speed from the active challenge, so neither the setup
    // defaults nor the stored settings are mutated by accepting a code.
    this.activeChallenge = payload;
    this.activeChallengeContext = context || null;
    this.matchMode = 'solo';
    // A v2 fair code fixes its own pace; a legacy or practice code is played at
    // the app's current pace and can never be compared.
    const challengeSpeed =
      context && isMatchSpeed(context.speed) ? context.speed : null;
    if (challengeSpeed !== null) {
      this.speedRecord = createMatchSpeedRecord(challengeSpeed);
      this.speedLocked = false; // pause may still change pace -> practice
    } else {
      this.speedRecord = createMatchSpeedRecord(this.store.getGameSpeed());
      this.speedLocked = false;
    }
    this.startMatch();
  }

  /**
   * Local versus entry. Duration reuses the stored setting; difficulty is
   * irrelevant because no planner runs, and the betrayal skill is forced off
   * (there is no AI side to betray and both humans must share one ruleset).
   */
  private startVersus(): void {
    if (!this.settingsSettled()) {
      this.waitForSettingsThen(() => this.startVersus(), 'home');
      return;
    }
    if (this.profiles.isOnboardingPending()) {
      this.maybeShowOnboardingPrompt();
      return;
    }
    this.matchMode = 'versus';
    this.activeChallenge = null;
    this.activeChallengeContext = null;
    this.speedRecord = createMatchSpeedRecord(this.store.getGameSpeed());
    this.speedLocked = false;
    this.startMatch();
  }

  private startMatch(options?: StartMatchOptions): void {
    const tutorialMode = !!(options && options.tutorial);
    this.closeAllOverlays();
    this.teardownGame();
    this.matchPlayerColorId = playerColorOption(
      this.profile ? this.profile.playerColorId : undefined
    ).id;
    this.syncPlayerColorVars(this.matchPlayerColorId);
    // Every new match — solo, versus, challenge, tutorial or "再来一局" —
    // starts with one-shot orders. Continuous dispatch is an explicit in-match
    // choice and never carries over from the previous match.
    this.dispatchMode = 'single';
    this.tutorialSession = tutorialMode;
    this.tutorialEntry =
      options && options.tutorialEntry === 'onboarding' ? 'onboarding' : 'replay';
    this.tutorialResultShown = false;
    this.tutorialFreeplayEntered = false;
    this.tutorialGate = null;
    if (tutorialMode) {
      // The lesson is a solo drill on its own fixed scene: no accepted
      // challenge, no versus side, and the stored match settings are never
      // touched by entering or leaving it.
      this.matchMode = 'solo';
      this.activeChallenge = null;
      this.activeChallengeContext = null;
      // The teaching budget assumes one accepted order per step. A live line
      // would turn the recovery drag (home -> front) into a stop gesture, so
      // the lesson forces single dispatch. Every match already resets to
      // single above, so there is no previous mode to restore on exit.
      this.dispatchMode = 'single';
    }
    this.resultShown = false;
    this.endHoldSince = null;
    this.endHoldFrames = 0;
    this.selectedId = null;
    this.selectedRedId = null;
    this.matchStarted = false;
    this.accumulator = 0;
    this.previousPlayerLand = -1;
    this.commandLog = [];
    this.lastResultView = null;
    // Every match — including "再来一局" — starts a fresh speed record. The
    // previous match's change flag must never leak into a new run, or a single
    // pause adjustment would mark every following match practice. The tutorial
    // runs at the standard pace so its fixed 8 s free-play drill is the same
    // wall-clock lesson for every player.
    if (tutorialMode) {
      this.speedRecord = createMatchSpeedRecord(1);
      this.speedLocked = false;
    } else if (this.activeChallenge && this.activeChallengeContext) {
      const lockedSpeed =
        typeof this.activeChallengeContext.speed === 'number' &&
        isMatchSpeed(this.activeChallengeContext.speed)
          ? this.activeChallengeContext.speed
          : this.store.getGameSpeed();
      this.speedRecord = createMatchSpeedRecord(lockedSpeed);
    } else {
      this.speedRecord = createMatchSpeedRecord(
        this.speedRecord ? this.speedRecord.current : this.store.getGameSpeed()
      );
    }

    let game: GameAdapter;
    try {
      // The fixed teaching scene is pinned by the adapter factory. A dev seed
      // still wins there so automated runs can reproduce the same lesson.
      const tutorialSeed =
        this.seedOverride === null ? TUTORIAL_SCENE.seed : this.seedOverride;
      // A challenge owns its seed; the dev seed override only applies to
      // normal matches, so smoke runs and fairness checks never conflict.
      const seed = tutorialMode
        ? tutorialSeed
        : this.activeChallenge
          ? this.activeChallenge.seed
          : this.seedOverride === null
            ? createMatchSeed()
            : this.seedOverride;
      // The archive level is read at match creation only; buying later applies
      // to the next match. Level 0 is passed as-is and the core keeps it locked.
      // A challenge locks duration/difficulty/map here: they come from the
      // accepted code, so restarting keeps the same locked parameters.
      const base = tutorialMode
        ? {
            durationSeconds: TUTORIAL_SCENE.durationSeconds,
            difficulty: 'easy' as const,
            mapId: TUTORIAL_SCENE.mapId,
          }
        : this.activeChallenge
          ? {
              durationSeconds: this.activeChallenge.durationSeconds,
              difficulty: this.activeChallenge.difficulty,
              mapId: RANDOM_MAP_ID,
            }
          : this.settings;
      const versus = this.matchMode === 'versus';
      // v1.4.0 seating: tutorial/versus are always 2; a challenge runs with the
      // count its accepted code states; a plain match uses the stored
      // preference. Restarting keeps the same inputs, so a restart keeps the
      // same seating.
      const matchFactionCount = resolveMatchFactionCount({
        tutorialMode: tutorialMode,
        versus: versus,
        challengeFamily: this.activeChallenge
          ? this.activeChallengeContext
            ? this.activeChallengeContext.family
            : 'v2'
          : null,
        challengeFactionCount: this.activeChallengeContext
          ? this.activeChallengeContext.factionCount
          : null,
        settingsFactionCount: this.settings.factionCount,
        storeFactionCount: this.store.getFactionCount(),
      });
      const matchSettings: GameSettings = {
        durationSeconds: base.durationSeconds,
        difficulty: base.difficulty,
        mapId: base.mapId,
        mode: this.matchMode,
        factionCount: matchFactionCount,
        diplomacyEnabled: !tutorialMode && !this.activeChallenge && !versus,
        // A challenge is a same-map strategy comparison, so the archive
        // betrayal skill is forced off: the challenger's code cannot carry a
        // level and two players must face identical rules. Versus also locks it
        // off (the control is hidden and neither human may use it). The lesson
        // is likewise skill-free so its fixed scene stays deterministic.
        betrayalLevel: tutorialMode || this.activeChallenge || versus
          ? 0
          : this.profile
            ? this.profile.betrayalLevel
            : 0,
      };
      game = tutorialMode
        ? createTutorialGameAdapter(seed)
        : createGameAdapter(matchSettings, seed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showFatal(
        message,
        tutorialMode
          ? () => this.startTutorial(this.tutorialEntry, true)
          : undefined
      );
      return;
    }
    this.game = game;
    const initialRaw = game.rawSnapshot();
    this.disasterInitialized = true;
    this.disasterStruckSeen = initialRaw.disaster.struck;
    this.lastBetrayalAt = 0;
    this.lastBetrayalNoticeAt = 0;

    const screen = new GameScreen({
      onPause: () => this.pauseGame(false),
      onUpgrade: (kind: UpgradeKind) => this.handleUpgrade(kind),
      onBetrayal: () => this.handleBetrayal(),
      onRules: () => {
        if (this.game && this.game.view().status === 'playing') this.pauseGame(false);
        this.showRules();
      },
      onZoomIn: (owner) => this.adjustMapZoom(1.35, owner),
      onZoomOut: (owner) => this.adjustMapZoom(1 / 1.35, owner),
      onZoomReset: (owner) => this.resetMapZoom(owner),
      onVersusLayoutChange: () => {
        // Pane rects and rotations changed together: no finger may survive.
        if (this.gesture) this.gesture.cancel('resize');
        if (this.redGesture) this.redGesture.cancel('resize');
        this.stopAllCameraPans();
      },
      onDispatchModeChange: (mode) => {
        if (tutorialMode) {
          // The guided receipts and recovery path are defined for one-shot
          // orders. Keep the HUD honest and snap it back rather than letting a
          // toggle create a live line the lesson never expects. Free play is
          // the exception: it exists so the player can really try a line.
          const tutorialState = this.tutorial ? this.tutorial.getState() : null;
          if (!tutorialState || tutorialState.phase !== 'freeplay') {
            this.dispatchMode = 'single';
            if (this.gameScreen) {
              this.gameScreen.setDispatchMode('single');
              this.gameScreen.showNotice('教学使用单次出兵 · 完成教学后恢复原设置', 'info');
            }
            this.updateGameUI();
            return;
          }
        }
        this.dispatchMode = mode;
        this.updateGameUI();
      },
      onStopLines: (owner) => this.stopLinesForOwner(owner),
      getSpeedLabel: () => this.speedHudLabel(),
      mode: this.matchMode,
      fairMode: this.activeChallenge !== null,
    });
    this.gameScreen = screen;
    screen.setDispatchMode(this.dispatchMode);
    this.setMode('game');
    this.setScreen(screen.el);

    // The core's front API may not exist yet; the port is null then and the
    // dispatch path stays one-shot while the HUD says so.
    this.fronts = createAdapterFrontsPort(game);

    this.renderer = new CanvasRenderer(screen.canvas);
    this.renderer.setPlayerColor(this.matchPlayerColorId);
    this.gesture = this.createGestureController('player');
    const panes = screen.panes;
    if (this.matchMode === 'versus' && panes) {
      this.redRenderer = new CanvasRenderer(panes.red.canvas);
      this.redRenderer.setPlayerColor(this.matchPlayerColorId);
      this.redGesture = this.createGestureController('ai1');
      this.binding = bindGestureInput(screen.canvas, this.gesture, {
        rotation: function () {
          return panes.blue.rotation;
        },
        secondPointerPolicy: 'isolate',
      });
      this.redBinding = bindGestureInput(panes.red.canvas, this.redGesture, {
        // Live callback: portrait red is 180, landscape red is 0.
        rotation: function () {
          return panes.red.rotation;
        },
        secondPointerPolicy: 'isolate',
      });
      this.bindCameraPan(screen.canvas, 'player');
      this.bindCameraPan(panes.red.canvas, 'ai1');
      this.gameScreen.setPaneCamera('player', this.renderer.getCamera());
      this.gameScreen.setPaneCamera('ai1', this.redRenderer.getCamera());
    } else {
      this.binding = bindGestureInput(screen.canvas, this.gesture);
      this.bindCameraPan(screen.canvas, 'player');
    }
    this.bindSoundUnlock(screen.canvas);
    if (panes) this.bindSoundUnlock(panes.red.canvas);

    this.renderInitialFrame();
    this.updateGameUI();
    this.startLoop();
    // A restart from the pause card leaves audio deliberately suspended; a new
    // session resumes it only when it was previously unlocked and enabled.
    if (this.soundBus && this.soundUnlocked && this.store.getSoundEnabled()) {
      void this.soundBus.resume();
    }
    if (tutorialMode) {
      this.beginTutorialSession(screen, !!(options && options.tutorialSkipIntro));
      return;
    }
    if (this.matchMode === 'versus') this.showVersusIntro();
    else this.beginCountdown();
  }

  /**
   * Starts the lesson on an already-built GameScreen. There is deliberately no
   * 3-2-1 countdown: the controller's intro (or the caller's explicit start)
   * owns the first tap, and the match stays `playing` with a frozen gate so a
   * real hold/drag can be accepted while the simulation waits.
   */
  private beginTutorialSession(screen: GameScreen, skipIntro: boolean): void {
    if (!this.game || !this.gameScreen) return;
    this.game.start();
    this.matchStarted = true;
    this.lastFrameTime = clockNow();
    this.accumulator = 0;
    // The canvas may not have a CSS size yet (it was just mounted); the first
    // frame that reads a real size recomputes the lesson highlight.
    this.tutorialLayoutWidth = -1;
    this.tutorialLayoutHeight = -1;
    this.gameScreen.showNotice('跟着提示操作 · 随时可以跳过', 'info');

    const self = this;
    const upgradeId = TUTORIAL_SCENE.upgradeTerritoryId;
    const attackSource = TUTORIAL_SCENE.captureTargetId;
    const enemyId = TUTORIAL_SCENE.enemyTargetId;

    this.tutorial = createTutorialController({
      root: screen.mapWrap,
      // The lesson prompt is a normal-flow banner above the canvas; only the
      // highlight stays in the overlay, so no cell is ever covered.
      bannerHost: screen.tutorialBannerHost,
      scenario: {
        initialSourceId: TUTORIAL_SCENE.initialSourceId,
        initialTargetId: TUTORIAL_SCENE.initialTargetId,
        captureTargetId: TUTORIAL_SCENE.captureTargetId,
        upgradeTerritoryId: upgradeId,
        attackSourceId: attackSource,
        enemyTargetId: enemyId,
        initialSourceName: '主城',
        initialTargetName: '村庄',
        upgradeTerritoryName: '主城',
        attackSourceName: '村庄',
        enemyTargetName: '敌哨',
        // The lesson only counts an attack with enough troops to beat the
        // outpost; a smaller accepted order does not skip the step.
        minimumAttackSent: 10,
      },
      callbacks: {
        onSkip: () => this.handleTutorialSkip(),
        onComplete: () =>
          this.finishTutorialSession(this.game ? this.game.view() : null, 'complete'),
        onStep: (state: TutorialState) => this.handleTutorialStep(state),
        onGate: (gate: TutorialGate) => {
          this.tutorialGate = gate;
        },
        onFocus: () => this.redrawMap(),
      },
      resolveAnchor: (targetId) => this.tutorialAnchorFor(targetId),
      isUpgradeAffordable: (territoryId) => {
        if (!this.game) return false;
        return (
          this.game.evaluateUpgrade(territoryId, 'production').ok ||
          this.game.evaluateUpgrade(territoryId, 'march').ok ||
          this.game.evaluateUpgrade(territoryId, 'defense').ok
        );
      },
      isAttackReady: (sourceId, targetId) => {
        if (!self.game) return false;
        return self.game.preview(sourceId, targetId, 1, 'player').forecast === 'capture';
      },
      hasOngoingArmies: (sourceId, targetId) => {
        if (!self.game) return false;
        // Real player armies still travelling that exact route. The controller
        // keeps the attack/reinforcement gate open until this is false, so a
        // wave is never stranded by an early freeze.
        return self.game
          .view()
          .armies.some(function (army) {
            return (
              army.owner === 'player' &&
              army.sourceId === sourceId &&
              army.targetId === targetId
            );
          });
      },
    });

    this.tutorial.start();
    if (skipIntro) this.tutorial.begin();
    // The tutorial layer must start from a real frame; the loop was already
    // scheduled above, and a tick is only produced when the gate allows it.
    if (this.gesture) this.gesture.refresh();
    this.redrawMap();
  }

  /** Auto-selects the highlighted home when the lesson enters its upgrade step. */
  private handleTutorialStep(state: TutorialState): void {
    if (state.phase !== 'active' || state.step !== 'upgrade') return;
    const targetId = state.targetId;
    if (!targetId || this.selectedId === targetId) return;
    // The upgrade row acts on the selection; the lesson only accepts the
    // highlighted home, so the two must never disagree.
    this.selectedId = targetId;
    this.updateGameUI();
  }

  /** The lesson's real upgrade target while its upgrade step is active. */
  private tutorialUpgradeTargetId(): string | null {
    if (!this.tutorialSession || !this.tutorial) return null;
    const state = this.tutorial.getState();
    if (state.phase !== 'active' || state.step !== 'upgrade') return null;
    return state.targetId;
  }

  /**
   * Selection filter for the lesson. During the upgrade step another own cell
   * snaps back to the highlighted home instead of leaving the upgrade row
   * enabled for a cell the lesson would reject.
   */
  private tutorialUpgradeSelection(territoryId: string | null): string | null {
    const targetId = this.tutorialUpgradeTargetId();
    if (!targetId || !territoryId || territoryId === targetId) return territoryId;
    if (!this.game) return territoryId;
    const territory = findTerritory(this.game.view(), territoryId);
    if (!territory || territory.owner !== 'player') return territoryId;
    if (this.gameScreen) {
      this.gameScreen.showNotice('升级步骤已锁定高亮主城 · 请升级主城', 'info');
    }
    return targetId;
  }

  /**
   * Keeps the lesson highlight attached to the real canvas size. The first
   * frame after mount, a late layout pass and an orientation change all look
   * the same here: the canvas CSS size changes, the renderer's cached layout is
   * invalidated, and the controller rebuilds the highlight outline.
   */
  private syncTutorialLayout(): void {
    if (!this.tutorialSession || !this.tutorial || !this.gameScreen) return;
    const canvas = this.gameScreen.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === this.tutorialLayoutWidth && height === this.tutorialLayoutHeight) {
      return;
    }
    this.tutorialLayoutWidth = width;
    this.tutorialLayoutHeight = height;
    // A 0x0 canvas has nothing to measure yet; wait for the real layout pass.
    if (width <= 0 || height <= 0) return;
    if (this.renderer) this.renderer.invalidateLayout();
    if (this.redRenderer) this.redRenderer.invalidateLayout();
    this.tutorial.refreshTargetAnchor();
  }

  /**
   * Screen-space outline of one territory, relative to the tutorial layer.
   * The transformed ring is the highlight itself; the bounding box travels
   * with it so the controller can clamp the whole shape inside the layer.
   */
  private tutorialAnchorFor(targetId: string): TutorialAnchor | null {
    if (!this.game || !this.renderer) return null;

    const view = this.game.view();
    const territory = findTerritory(view, targetId);
    if (!territory) return null;
    const viewport = this.renderer.getViewport(view);
    const points: Array<[number, number]> = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < territory.polygon.length; i += 1) {
      const point = territory.polygon[i];
      const x = viewport.offsetX + point[0] * viewport.scale;
      const y = viewport.offsetY + point[1] * viewport.scale;
      points.push([x, y]);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!isFinite(minX) || !isFinite(minY)) return null;
    return {
      x: minX,
      y: minY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
      points: points,
    };
  }

  /**
   * One owner-locked machine per pane. The frozen territory owner must match
   * the pane owner, so a red press on the blue canvas (or vice versa) never
   * begins an order even before commit validation.
   */
  private createGestureController(
    lockedOwner: 'player' | 'ai1'
  ): GestureController {
    const self = this;
    return new GestureController({
      isPlaying: () =>
        !!self.game && self.matchStarted && self.game.view().status === 'playing',
      findTerritory: (x, y) => self.hitTestForOwner(lockedOwner, x, y),
      ownerOfTerritory: (territoryId) => {
        if (!self.game) return null;
        const territory = findTerritory(self.game.view(), territoryId);
        return territory ? territory.owner : null;
      },
      canHold: (territoryId, owner) => {
        if (!self.game) return false;
        const view = self.game.view();
        if (view.status !== 'playing' || !self.matchStarted) return false;
        const territory = findTerritory(view, territoryId);
        if (!territory) return false;
        if (view.mode === 'versus') {
          return owner === lockedOwner && territory.owner === lockedOwner;
        }
        return territory.owner === 'player';
      },
      plan: (sourceId, ratio) => {
        if (!self.game) {
          return { available: 0, reserve: 0, sent: 0, remaining: 0 };
        }
        return self.game.plan(sourceId, ratio);
      },
      evaluate: (sourceId, targetId, ratio, owner) => {
        if (!self.game) {
          return {
            ok: false,
            reason: 'invalid',
            available: 0,
            reserve: 0,
            sent: 0,
            remaining: 0,
          };
        }
        const side: 'player' | 'ai1' = owner === 'ai1' ? 'ai1' : 'player';
        const preview = self.game.preview(sourceId, targetId, ratio, side);
        // Continuous mode: a line waits for troops, and dragging onto its own
        // target is the stop gesture, so `no_troops` and same-target drags stay
        // legal. Ownership/route/status refusals are still refusals.
        const evaluation = evaluateDispatchDrag({
          mode: self.dispatchMode,
          frontsAvailable: self.fronts !== null,
          lines: self.currentLines(),
          owner: side,
          sourceId: sourceId,
          targetId: targetId,
          preview: preview,
        });
        return {
          ok: evaluation.ok,
          reason: evaluation.reason === null ? undefined : evaluation.reason,
          forecast: evaluation.forecast,
          plannedMovement: preview.plannedMovement,
          route: preview.route,
          travelTicks: evaluation.travelTicks,
          available: evaluation.available,
          reserve: evaluation.reserve,
          sent: evaluation.sent,
          remaining: evaluation.remaining,
        };
      },
      commit: (sourceId, targetId, ratio, owner) =>
        self.commitMove(
          sourceId,
          targetId,
          ratio,
          owner === 'ai1' ? 'ai1' : 'player'
        ),
      select: (territoryId) => {
        if (!self.game) return;
        const view = self.game.view();
        if (view.mode === 'versus' && lockedOwner === 'ai1') {
          self.selectedRedId = territoryId;
        } else {
          self.selectedId = self.tutorialUpgradeSelection(territoryId);
        }
        self.updateGameUI();
      },
      cancel: (reason, detail, sourceId) =>
        self.onGestureCancel(reason, detail, sourceId),
      change: () => self.updateGameUI(),
    });
  }

  private teardownGame(): void {
    if (this.truceOfferOverlay) this.closeOverlay(this.truceOfferOverlay);
    this.truceOfferOverlay = null;
    this.shownTruceOfferIds.clear();
    this.destroyTutorialController();
    this.countdownToken += 1;
    if (this.countdownTimer !== null) {
      window.clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.countdownOverlay = closeCountdownOverlay(
      this.countdownOverlay,
      (overlay) => this.closeOverlay(overlay)
    );
    this.countdownPending = false;
    if (this.versusIntroTimer !== null) {
      window.clearTimeout(this.versusIntroTimer);
      this.versusIntroTimer = null;
    }
    this.stopLoop();
    // Controllers first: no queued pointer/cancel may run against a half-dead
    // renderer or the next session's GameScreen.
    if (this.gesture) this.gesture.cancel('superseded');
    if (this.redGesture) this.redGesture.cancel('superseded');
    if (this.binding) {
      this.binding.destroy();
      this.binding = null;
    }
    if (this.redBinding) {
      this.redBinding.destroy();
      this.redBinding = null;
    }
    this.unbindCameraPan();
    if (this.gameScreen) {
      this.gameScreen.destroy();
      this.gameScreen = null;
    }
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
    if (this.redRenderer) {
      this.redRenderer.destroy();
      this.redRenderer = null;
    }
    this.gesture = null;
    this.redGesture = null;
    this.game = null;
    this.selectedId = null;
    this.selectedRedId = null;
    this.upgradeCacheRevision = -1;
    this.upgradeCacheSelected = null;
    this.upgradeCache = NO_UPGRADE_STATES;
    this.matchStarted = false;
    this.accumulator = 0;
    this.previousPlayerLand = -1;
    this.disasterInitialized = false;
    this.disasterStruckSeen = false;
    // Teardown cancels any pending end-frame obligation; the next session
    // computes its own hold from its own captures.
    this.endHoldSince = null;
    this.endHoldFrames = 0;
    // Lines belong to the session that just ended; the next match starts empty.
    this.fronts = null;
    this.tutorialSession = false;
    this.tutorialEntry = 'replay';
    this.tutorialFreeplayEntered = false;
    this.tutorialGate = null;
  }

  private destroyTutorialController(): void {
    if (!this.tutorial) return;
    try {
      this.tutorial.destroy();
    } catch (error) {
      // Destroy is best effort: the layer is about to leave the DOM anyway.
    }
    this.tutorial = null;
    this.tutorialGate = null;
    this.tutorialFreeplayEntered = false;
    this.tutorialLayoutWidth = -1;
    this.tutorialLayoutHeight = -1;
  }

  private setMode(
    mode:
      | 'home'
      | 'setup'
      | 'game'
      | 'result'
      | 'profile'
      | 'upgrade'
      | 'progress'
      | 'challenge'
      | 'leaderboard'
  ): void {
    this.mode = mode;
    this.frameRoot.setAttribute('data-screen', mode);
  }

  private setScreen(screen: HTMLElement): void {
    if (this.currentScreen && this.currentScreen.parentNode === this.viewHost) {
      this.viewHost.removeChild(this.currentScreen);
    }
    this.viewHost.appendChild(screen);
    screen.classList.remove('is-active');
    void screen.offsetWidth;
    screen.classList.add('is-active');
    this.currentScreen = screen;
  }

  private renderInitialFrame(): void {
    if (!this.game || !this.renderer || !this.gameScreen) return;
    const view = this.game.view();
    const gestures = this.gestureStates();
    const reach = this.reachabilityFor(gestures);
    this.drawPane('player', view, gestures, reach, 0, clockNow());
    if (this.redRenderer) {
      this.drawPane('ai1', view, gestures, reach, 0, clockNow());
    }
  }

  private controllerForOwner(owner: 'player' | 'ai1'): GestureController | null {
    return owner === 'ai1' ? this.redGesture : this.gesture;
  }

  private rendererForOwner(owner: 'player' | 'ai1'): CanvasRenderer | null {
    return owner === 'ai1' ? this.redRenderer : this.renderer;
  }

  /** Draws one pane with its own gesture/selection; engine view is shared. */
  private drawPane(
    owner: 'player' | 'ai1',
    view: MatchView,
    gestures: readonly GestureState[],
    reach: {
      ids: string[];
      alliedFrontierIds: string[];
      byOwner: Partial<Record<'player' | 'ai1', readonly string[]>>;
    },
    alpha: number,
    now: number
  ): void {
    const renderer = this.rendererForOwner(owner);
    if (!renderer) return;
    const controller = this.controllerForOwner(owner);
    const state = controller ? controller.getState() : idleGestureState();
    renderer.draw(
      {
        view: view,
        gesture: state,
        gestures: gestures,
        selectedId: owner === 'ai1' ? this.selectedRedId : this.selectedId,
        reachableIds: reach.ids,
        alliedFrontierIds: reach.alliedFrontierIds,
        reachableByOwner: reach.byOwner,
        alpha: alpha,
        // Line lanes come from the real snapshot; the renderer normalizes them
        // and draws nothing when the core has no fronts.
        fronts: this.rawFronts(),
        frontTick: view.tick,
      },
      now
    );
  }

  /** Raw snapshot lines for the renderer (empty when the core has none). */
  private rawFronts(): readonly unknown[] {
    if (!this.game) return [];
    try {
      const raw = this.game.rawSnapshot();
      return raw && Array.isArray(raw.fronts) ? raw.fronts : [];
    } catch (error) {
      return [];
    }
  }

  private startLoop(): void {
    this.stopLoop();
    // Never schedule animation (or, through it, simulation) while hidden; the
    // visibility return path starts the loop explicitly.
    if (typeof document !== 'undefined' && document.hidden) return;
    this.lastFrameTime = clockNow();
    this.accumulator = 0;
    this.rafScheduledAt = clockNow();
    this.rafId = window.requestAnimationFrame(this.frameLoop);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private frameStep(now: number): void {
    this.rafId = null;
    // A frame that was already queued when the page hid must not simulate,
    // render or reschedule; the visibility return path restarts the loop.
    if (typeof document !== 'undefined' && document.hidden) {
      this.accumulator = 0;
      return;
    }
    this.frameCount += 1;
    this.lastFrameAt = clockNow();
    if (!this.game || !this.renderer || !this.gameScreen) return;

    // The tutorial mounts before its canvas has a CSS size. Refresh the
    // highlight as soon as a real size is readable, without waiting for the
    // player to resize the window.
    this.syncTutorialLayout();
    if (this.maybeShowTruceOffer()) return;

    let elapsed = now - this.lastFrameTime;
    if (!isFinite(elapsed) || elapsed < 0) elapsed = 0;
    this.lastFrameTime = now;

    const before = this.game.view();
    let steps = 0;
    const speed = this.currentSpeed();
    if (this.matchStarted && before.status === 'playing') {
      if (this.tutorialSession) {
        steps = this.tutorialFrameSteps(elapsed);
      } else {
        // Speed scales simulated time, never the core step: 0.75x and 1.25x
        // both feed whole 100 ms ticks, so every rule and seed stays identical.
        const plan = planSimulationSteps(this.accumulator, elapsed, {
          fixedDtMs: FIXED_DT_MS,
          speed: speed,
          maxStepsPerFrame: maxCatchUpStepsFor(speed),
          maxElapsedMs: 300,
        });
        this.accumulator = plan.accumulatorMs;
        steps = plan.steps;
        for (let step = 0; step < steps; step += 1) {
          this.game.tick();
          this.lastTickAt = clockNow();
          this.drainCoreEvents();
          // Stop on the arrival tick, including frames that planned several
          // catch-up steps: the offer's core deadline freezes with the match.
          if (this.maybeShowTruceOffer()) {
            steps = step + 1;
            break;
          }
        }
      }
    } else {
      this.accumulator = 0;
    }

    // The lesson settles through its own panel. This check is deliberately
    // before the generic finishMatch branch: no tutorial result may ever reach
    // the record/leaderboard/gold/challenge publishing path.
    if (this.tutorialSession && this.tutorial) {
      const tutorialState = this.tutorial.getState();
      if (tutorialState.phase === 'complete') {
        // The completion card is a reading surface: its gate already holds the
        // match, so the loop keeps drawing here and only the player's
        // "完成教学" (confirmCompletion -> onComplete) settles the lesson.
      } else if (this.game.view().status === 'ended') {
        // Guided steps keep the old "ended" outcome. Free play is a real
        // practice match: if it ends (win or loss) the practice itself is
        // done, so it settles as a completed lesson instead of "未完成".
        this.finishTutorialSession(
          this.game.view(),
          tutorialState.phase === 'freeplay' ? 'complete' : 'ended'
        );
        return;
      }
    }

    const view = this.game.view();
    if (this.selectedId) {
      const selected = findTerritory(view, this.selectedId);
      if (!selected || selected.owner !== 'player' || view.status === 'ended') {
        this.selectedId = null;
      }
    }
    if (this.selectedRedId) {
      const selectedRed = findTerritory(view, this.selectedRedId);
      if (
        view.mode !== 'versus' ||
        !selectedRed ||
        selectedRed.owner !== 'ai1' ||
        view.status === 'ended'
      ) {
        this.selectedRedId = null;
      }
    }
    if (this.gesture) {
      this.gesture.update(now);
      if (steps > 0) this.gesture.refresh();
    }
    if (this.redGesture) {
      this.redGesture.update(now);
      if (steps > 0) this.redGesture.refresh();
    }
    const state = this.gesture ? this.gesture.getState() : idleGestureState();
    const gestures = this.gestureStates();
    const reach = this.reachabilityFor(gestures);
    const alpha = stepAlpha(this.accumulator, FIXED_DT_MS);

    this.drawPane('player', view, gestures, reach, alpha, now);
    this.drawPane('ai1', view, gestures, reach, alpha, now);
    this.gameScreen.update(
      view,
      state,
      this.selectedId,
      this.upgradeStates(),
      this.game.hudState(),
      gestures,
      this.matchMode === 'versus'
        ? { player: this.selectedId, ai1: this.selectedRedId }
        : undefined,
      this.dispatchPanelState()
    );
    this.syncDisasterStrike(before, view);

    if (
      view.status === 'playing' &&
      this.previousPlayerLand >= 0 &&
      view.territoryCounts.player !== this.previousPlayerLand
    ) {
      const delta = view.territoryCounts.player - this.previousPlayerLand;
      if (delta > 0 && clockNow() - this.lastBetrayalNoticeAt > 1600) {
        this.gameScreen.showNotice('占领成功 · 控地 +' + delta, 'good');
      } else if (delta < 0) {
        this.gameScreen.showNotice('失去领地 · 控地 ' + delta, 'bad');
      }
    }
    this.previousPlayerLand = view.territoryCounts.player;

    if (!this.tutorialSession && view.status === 'ended' && !this.resultShown) {
      // A real capture that ended the match may still be collapsing on the
      // frame that produced it. Hold the settlement until that animation
      // finishes (frame clock, no simulation tick, no setTimeout) so the
      // player actually sees the final fort fall. A match that ends without a
      // fort capture has zero live collapses and settles on this very frame.
      if (this.endHoldSince === null) this.endHoldSince = now;
      const live = this.liveCollapseCount();
      if (!shouldHoldEndForCollapse(live, now - this.endHoldSince)) {
        this.finishMatch(view);
        return;
      }
      this.endHoldFrames += 1;
    }

    if (this.truceOfferOverlay) return;
    this.rafScheduledAt = clockNow();
    this.rafId = window.requestAnimationFrame(this.frameLoop);
  }

  /**
   * One tutorial frame. The controller's gate is the single authority:
   *  - hold/frozen: advance nothing, but leave the match `playing` so a real
   *    hold/drag still reaches the core;
   *  - guided: real arrivals/production/cannons/lines with AI suppressed;
   *  - live: the normal tick, after extending the lesson clock exactly once.
   */
  private tutorialFrameSteps(elapsed: number): number {
    if (!this.game || !this.tutorial) {
      this.accumulator = 0;
      return 0;
    }
    const gate = this.tutorial.getGate();
    this.tutorialGate = gate;
    if (gate.frozen || gate.mode === 'hold') {
      this.accumulator = 0;
      return 0;
    }
    const plan = planSimulationSteps(this.accumulator, elapsed, {
      fixedDtMs: FIXED_DT_MS,
      speed: 1,
      maxStepsPerFrame: maxCatchUpStepsFor(1),
      maxElapsedMs: 300,
    });
    this.accumulator = plan.accumulatorMs;

    let steps = 0;
    if (gate.mode === 'guided') {
      for (let step = 0; step < plan.steps; step += 1) {
        let advanced = false;
        try {
          advanced = this.game.tickWithoutAi();
        } catch (error) {
          // The adapter is the only acceptance boundary; a missing tutorial
          // advance surfaces as a real notice instead of a silently frozen
          // lesson.
          if (this.gameScreen) {
            const message =
              error instanceof Error ? error.message : String(error);
            this.gameScreen.showNotice(message, 'bad');
          }
          this.accumulator = 0;
          break;
        }
        this.lastTickAt = clockNow();
        this.drainCoreEvents();
        this.tutorial.notifyTick(this.game.view().tick);
        steps += 1;
        if (!advanced || this.game.view().status !== 'playing') break;
        const phase = this.tutorial.getState().phase;
        // A capture in this batch may have released the lesson into free play:
        // stop the no-AI batch here and let the next frame take the live gate
        // (and run `enterTutorialFreeplay` once).
        if (phase === 'complete' || phase === 'freeplay') break;
      }
      return steps;
    }

    // Free play: the timeout deadline must move before the first normal tick,
    // otherwise a long guided lesson would settle instantly. Only the deadline
    // moves; absolute army/front ticks are untouched.
    if (!this.tutorialFreeplayEntered) {
      try {
        this.game.enterTutorialFreeplay();
      } catch (error) {
        if (this.gameScreen) {
          const message = error instanceof Error ? error.message : String(error);
          this.gameScreen.showNotice(message, 'bad');
        }
      }
      this.tutorialFreeplayEntered = true;
      this.accumulator = 0;
    }
    for (let step = 0; step < plan.steps; step += 1) {
      this.game.tick();
      this.lastTickAt = clockNow();
      this.drainCoreEvents();
      this.tutorial.notifyTick(this.game.view().tick);
      steps += 1;
      if (this.game.view().status !== 'playing') break;
      if (this.tutorial.getState().phase === 'complete') break;
    }
    return steps;
  }

  /** Live capture collapses across every pane (0 when none is playing). */
  private liveCollapseCount(): number {
    let count = 0;
    this.forEachRenderer(function (renderer) {
      count += renderer.defenseCollapseCount();
    });
    return count;
  }

  /**
   * Consumes core events (the engine is the only authority on overflow and
   * captures) and forwards them to the purely visual layers.
   */
  private drainCoreEvents(): void {
    if (!this.game || !this.gameScreen) return;
    const events = this.game.drainEvents();
    if (events.length === 0) return;
    const view = this.game.view();
    const versus = view.mode === 'versus';
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      this.playSound(event.type, event.owner);
      if (event.type === 'overflow') {
        this.forEachRenderer(function (renderer) {
          renderer.addFloater(event.targetId, '溢出 ' + event.amount + ' 兵', 'bad');
        });
        if (event.owner === 'player') {
          this.gameScreen.showNotice(
            '援军抵达 · ' + event.amount + ' 兵因容量上限未能驻扎',
            'info'
          );
        }
      } else if (event.type === 'capture') {
        // The lesson advances only on this real ownership event, never on a
        // button. Its own capture step waits for `tut_front` -> player, and a
        // real `tut_enemy` capture also satisfies the attack step.
        if (this.tutorial && this.tutorialSession) {
          this.tutorial.reportCapture({
            targetId: event.targetId,
            owner:
              event.owner === 'player' ||
              event.owner === 'ai1' ||
              event.owner === 'ai2' ||
              event.owner === 'ai3'
                ? event.owner
                : 'neutral',
          });
        }
        // One real floater per pane, phrased from that pane's perspective. The
        // capture floater is the single feedback for a capture (the defense
        // receipt is for defended waves only), so nothing is announced twice.
        this.forEachPane(function (side, renderer) {
          // A defended wave for the SAME cell that was drained earlier in this
          // batch must not keep playing "击退/守住" next to the real 失守
          // prompt. Scoped to this territory only; a defend drained AFTER this
          // capture enqueues normally and still plays in event order.
          renderer.invalidateDefense(event.targetId);
          // Presentation-only collapse of the PRE-capture wall/turret. The
          // renderer reads the event's own `previousDefenseLevel` (1|2) and
          // `previousOwner`; a capture of an undefended cell paints nothing and
          // the map icon was already removed by the core zeroing the level.
          // Both panes receive the same real event.
          renderer.playDefenseCollapse(event);
          renderer.addFloater(
            event.targetId,
            captureLabel(event.owner, event.amount, versus, VERSUS_BLUE_NAME, VERSUS_RED_NAME),
            captureTone(event.owner, side, versus)
          );
        });
      } else if (event.type === 'defend') {
        // Each pane judges the same defended wave with its own owner, so the
        // red player never sees "进攻受阻" for its own defence.
        this.forEachPane(function (side, renderer) {
          renderer.playDefenseReceipt(event, defenseViewerFor(side));
        });
      } else if (event.type === 'front') {
        if (event.frontAction === 'capture') {
          // The core also emits a real `capture` event for the same takeover;
          // that event owns the floater AND the cue, so the front event stays
          // silent here to avoid a second (or opposite) sound.
          this.gameScreen.showNotice(
            (event.owner === 'player' ? '' : '敌军') + '兵线攻陷目标',
            event.owner === 'player' ? 'good' : 'bad'
          );
        } else if (event.frontAction === 'stop' || event.frontAction === 'cancel') {
          if (this.soundBus) this.soundBus.play('tap');
          if (event.frontAction === 'cancel' && event.owner === 'player') {
            const copy =
              event.frontReason === 'source-lost'
                ? '来源领地失守 · 兵线已解除'
                : event.frontReason === 'route-invalid'
                  ? '通路被切断 · 兵线已解除'
                  : event.frontReason === 'exhausted'
                    ? '兵线兵力耗尽 · 已自动解除'
                    : '兵线已解除';
            this.gameScreen.showNotice(copy, 'info');
          }
        } else if (
          this.soundBus &&
          (event.frontAction === 'start' || event.frontAction === 'replace')
        ) {
          // Only lifecycle changes make the "troops leaving" cue; per-wave
          // `send` events stay silent (they would drone every second).
          this.soundBus.play('march');
        }
      } else if (event.type === 'cannon' && event.from && event.to) {
        // The raw event keeps the firing tower id (event.targetId); the
        // renderer turns that cached turret toward the real impact point and
        // uses the event's real damage. No core state is read or mutated.
        const mapId = this.game.mapId;
        this.forEachRenderer(function (renderer) {
          renderer.playCannonEvent(event, mapId);
        });
      }
    }
  }

  private forEachRenderer(callback: (renderer: CanvasRenderer) => void): void {
    if (this.renderer) callback(this.renderer);
    if (this.redRenderer) callback(this.redRenderer);
  }

  /**
   * Per-pane iteration with the pane's own owner. The red renderer must judge a
   * defended wave as `ai1`, not as the blue player, or its receipt reads
   * backwards for the second human.
   */
  private forEachPane(
    callback: (owner: 'player' | 'ai1', renderer: CanvasRenderer) => void
  ): void {
    if (this.renderer) callback('player', this.renderer);
    if (this.redRenderer) callback('ai1', this.redRenderer);
  }

  private hitTestForOwner(owner: 'player' | 'ai1', x: number, y: number): string | null {
    if (!this.game) return null;
    const renderer = this.rendererForOwner(owner);
    if (!renderer) return null;
    const view = this.game.view();
    const viewport = renderer.getViewport(view);
    return hitTestTerritory(viewport, view.territories, x, y, 20);
  }

  private hitTest(x: number, y: number): string | null {
    return this.hitTestForOwner('player', x, y);
  }

  private syncPaneCamera(owner: 'player' | 'ai1'): void {
    if (!this.gameScreen) return;
    const renderer = this.rendererForOwner(owner);
    if (!renderer) return;
    this.gameScreen.setPaneCamera(owner, renderer.getCamera());
  }

  private adjustMapZoom(
    factor: number,
    owner: 'player' | 'ai1' = 'player'
  ): void {
    const renderer = this.rendererForOwner(owner);
    if (!renderer) return;
    const gesture = this.controllerForOwner(owner);
    if (gesture && gesture.isActive()) gesture.cancel('superseded');
    renderer.zoomBy(factor);
    this.syncPaneCamera(owner);
    this.redrawMap(owner);
  }

  private resetMapZoom(owner: 'player' | 'ai1' = 'player'): void {
    const renderer = this.rendererForOwner(owner);
    if (!renderer) return;
    const gesture = this.controllerForOwner(owner);
    if (gesture && gesture.isActive()) gesture.cancel('superseded');
    renderer.resetCamera();
    this.syncPaneCamera(owner);
    this.redrawMap(owner);
  }

  private redrawMap(owner?: 'player' | 'ai1'): void {
    if (!this.game || !this.renderer) return;
    const view = this.game.view();
    const gestures = this.gestureStates();
    const reach = this.reachabilityFor(gestures);
    const now = clockNow();
    if (owner !== 'ai1') {
      this.drawPane('player', view, gestures, reach, 0, now);
    }
    if (owner !== 'player' && this.redRenderer) {
      this.drawPane('ai1', view, gestures, reach, 0, now);
    }
    // Camera/zoom changes move the highlighted tutorial cell with the canvas.
    if (this.tutorial) this.tutorial.refreshTargetAnchor();
  }

  /**
   * Single-finger pan is claimable only on empty water/background while the
   * map is zoomed. A press on any territory still belongs to the hold/drag
   * gesture, so the two interactions never race for the same touch.
   */
  /**
   * Audio may only start inside a real user gesture. This listener runs in the
   * same synchronous pointer/touch sequence as the gesture binding, so the
   * first tap on the battlefield unlocks playback for the whole session.
   */
  private bindSoundUnlock(canvas: HTMLCanvasElement): void {
    const self = this;
    const unlock = function (): void {
      self.unlockSound();
    };
    canvas.addEventListener('pointerdown', unlock);
    canvas.addEventListener('touchstart', unlock, { passive: true });
    this.cameraRemovers.push(function () {
      canvas.removeEventListener('pointerdown', unlock);
      canvas.removeEventListener('touchstart', unlock);
    });
  }

  private bindCameraPan(
    canvas: HTMLCanvasElement,
    owner: 'player' | 'ai1'
  ): void {
    const self = this;
    const panes = this.gameScreen ? this.gameScreen.panes : null;
    // The same live rotation the gesture binding consumes; a red-on-top pane
    // turns screen deltas back into its own upright content space.
    const toLocal = createCanvasPointMapper(canvas, function () {
      if (!panes) return 0;
      return owner === 'ai1' ? panes.red.rotation : panes.blue.rotation;
    });
    const hasPointerEvents =
      typeof window !== 'undefined' &&
      typeof (window as unknown as { PointerEvent?: unknown }).PointerEvent !== 'undefined';

    let panPointerId: number | null = null;
    let panLastX = 0;
    let panLastY = 0;

    function stop(): void {
      panPointerId = null;
    }
    this.cameraPanStops.push(stop);

    function canPan(x: number, y: number): boolean {
      const renderer = self.rendererForOwner(owner);
      const gesture = self.controllerForOwner(owner);
      if (!renderer || !gesture) return false;
      if (renderer.getCamera().zoom <= 1.001) return false;
      if (gesture.isActive()) return false;
      return self.hitTestForOwner(owner, x, y) === null;
    }

    function begin(clientX: number, clientY: number, pointerId: number): boolean {
      if (panPointerId !== null) return false;
      const point = toLocal(clientX, clientY);
      if (!canPan(point[0], point[1])) return false;
      panPointerId = pointerId;
      panLastX = point[0];
      panLastY = point[1];
      try {
        if (typeof canvas.setPointerCapture === 'function') {
          canvas.setPointerCapture(pointerId);
        }
      } catch (error) {
        // Capture is an enhancement; window listeners still see the pointer.
      }
      return true;
    }

    function move(clientX: number, clientY: number, pointerId: number, event: Event): void {
      if (panPointerId === null || pointerId !== panPointerId) return;
      const point = toLocal(clientX, clientY);
      const dx = point[0] - panLastX;
      const dy = point[1] - panLastY;
      if (dx === 0 && dy === 0) return;
      panLastX = point[0];
      panLastY = point[1];
      const renderer = self.rendererForOwner(owner);
      if (!renderer) return;
      renderer.panBy(dx, dy);
      self.syncPaneCamera(owner);
      self.redrawMap(owner);
      if (event.cancelable) event.preventDefault();
    }

    if (hasPointerEvents) {
      const downPointers: Record<number, boolean> = {};
      const down = function (event: Event): void {
        const pointer = event as PointerEvent;
        if (pointer.pointerType === 'mouse' && pointer.button !== 0) return;
        downPointers[pointer.pointerId] = true;
        let downCount = 0;
        for (const key in downPointers) {
          if (downPointers[key]) downCount += 1;
        }
        if (downCount > 1) {
          stop();
          return;
        }
        if (!begin(pointer.clientX, pointer.clientY, pointer.pointerId)) return;
      };
      const pointerMove = function (event: Event): void {
        const pointer = event as PointerEvent;
        move(pointer.clientX, pointer.clientY, pointer.pointerId, event);
      };
      const up = function (event: Event): void {
        const pointer = event as PointerEvent;
        downPointers[pointer.pointerId] = false;
        if (panPointerId !== null && pointer.pointerId === panPointerId) stop();
      };
      canvas.addEventListener('pointerdown', down);
      window.addEventListener('pointermove', pointerMove, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      this.cameraRemovers.push(function () {
        canvas.removeEventListener('pointerdown', down);
        window.removeEventListener('pointermove', pointerMove);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      });
      return;
    }

    let touchId: number | null = null;
    const touchStart = function (event: Event): void {
      const touchEvent = event as TouchEvent;
      const touch = touchEvent.changedTouches[0];
      if (!touch) return;
      if (touchEvent.changedTouches.length > 1) {
        stop();
        return;
      }
      if (!begin(touch.clientX, touch.clientY, touch.identifier)) return;
      touchId = touch.identifier;
    };
    const touchMove = function (event: Event): void {
      if (touchId === null) return;
      const touchEvent = event as TouchEvent;
      let touch: Touch | null = null;
      for (let i = 0; i < touchEvent.touches.length; i += 1) {
        if (touchEvent.touches[i].identifier === touchId) {
          touch = touchEvent.touches[i];
          break;
        }
      }
      if (!touch) return;
      move(touch.clientX, touch.clientY, touch.identifier, event);
    };
    const touchEnd = function (event: Event): void {
      if (touchId === null) return;
      const touchEvent = event as TouchEvent;
      for (let i = 0; i < touchEvent.changedTouches.length; i += 1) {
        if (touchEvent.changedTouches[i].identifier === touchId) {
          touchId = null;
          stop();
          return;
        }
      }
    };
    canvas.addEventListener('touchstart', touchStart, { passive: false });
    window.addEventListener('touchmove', touchMove, { passive: false });
    window.addEventListener('touchend', touchEnd);
    window.addEventListener('touchcancel', touchEnd);
    this.cameraRemovers.push(function () {
      canvas.removeEventListener('touchstart', touchStart);
      window.removeEventListener('touchmove', touchMove);
      window.removeEventListener('touchend', touchEnd);
      window.removeEventListener('touchcancel', touchEnd);
    });
  }

  private stopAllCameraPans(): void {
    for (let i = 0; i < this.cameraPanStops.length; i += 1) this.cameraPanStops[i]();
  }

  private unbindCameraPan(): void {
    for (let i = 0; i < this.cameraRemovers.length; i += 1) this.cameraRemovers[i]();
    this.cameraRemovers = [];
    this.stopAllCameraPans();
    this.cameraPanStops = [];
  }

  private updateGameUI(): void {
    if (!this.game || !this.gameScreen) return;
    const view = this.game.view();
    const state = this.gesture ? this.gesture.getState() : idleGestureState();
    this.gameScreen.update(
      view,
      state,
      this.selectedId,
      this.upgradeStates(),
      this.game.hudState(),
      this.gestureStates(),
      this.matchMode === 'versus'
        ? { player: this.selectedId, ai1: this.selectedRedId }
        : undefined,
      this.dispatchPanelState()
    );
  }

  /** Everything the dispatch bar renders; the shell owns the line selection. */
  private dispatchPanelState(): DispatchPanelState {
    const lines = this.currentLines();
    const targets = lineStopTargets(lines, 'player', this.selectedId);
    const summary = summarizeSelectionLines(targets);
    const redTargets =
      this.matchMode === 'versus'
        ? summarizeSelectionLines(lineStopTargets(lines, 'ai1', this.selectedRedId))
        : null;
    return {
      mode: this.dispatchMode,
      sendCount: summary.sendCount,
      incomingCount: summary.incomingCount,
      // A selection WITH lines keeps its own summary (发出/受攻 · 可停止).
      // An idle selection is mode-aware even while other lines exist: single
      // mode must say the drag only sends once — the stop button, not the
      // mode switch, is how those live lines end.
      hint:
        summary.sendCount > 0 || summary.incomingCount > 0
          ? summary.hint
          : idleSelectionHint(
              this.dispatchMode,
              this.fronts !== null,
              lines.length
            ),
      stopLabel: summary.stopLabel,
      stopLabelRed: redTargets ? redTargets.stopLabel : null,
      linesAvailable: this.fronts !== null,
      speedLabel: this.speedHudLabel(),
    };
  }

  /** Small HUD chip: the live pace plus whether the match is still comparable. */
  private speedHudLabel(): string | null {
    if (!this.speedRecord) return null;
    return speedStatusText(this.speedRecord, this.speedLocked);
  }

  /** Live accumulator scale; 1 when no match is running. */
  private currentSpeed(): MatchSpeed {
    return this.speedRecord ? this.speedRecord.current : 1;
  }

  /**
   * Applies a speed change from the pause overlay. Any change makes this match
   * practice-only for challenge codes and leaderboard ranking; it never
   * silently restarts or mutates the running simulation.
   */
  /**
   * Applies a speed change from the pause overlay. Any change makes this match
   * practice-only for challenge codes and leaderboard ranking; it never
   * silently restarts or mutates the running simulation.
   *
   * A challenge's pace is locked by the code, so a mid-challenge adjustment is
   * a property of THIS match only: it must not rewrite the player's normal
   * solo preference. A normal match's pick is remembered for the next match.
   */
  private setMatchSpeed(speed: GameSpeed): void {
    if (!this.speedRecord) return;
    if (applySpeedChange(this.speedRecord, speed)) {
      if (!this.activeChallenge) this.store.setGameSpeed(speed);
      if (this.gameScreen) {
        this.gameScreen.showNotice(
          '速度已切换为 ' + speedLabel(speed) + ' · 本局不计排名',
          'info'
        );
      }
      this.updateGameUI();
    }
  }

  /**
   * Re-evaluates at most once per core revision and selection. The adapter's
   * revision bumps on every tick and accepted command, so a same-tick upgrade
   * or move can never reuse stale cost/troop budgets, while a plain render
   * frame (live hold, camera pan) does zero upgrade previews.
   */
  private upgradeStates(): Record<UpgradeKind, UpgradeEvaluationDetail | null> {
    if (!this.game || !this.selectedId) {
      this.upgradeCacheRevision = this.game ? this.game.revision() : -1;
      this.upgradeCacheSelected = null;
      return NO_UPGRADE_STATES;
    }
    // Versus mounts no upgrade row, so never spend preview work on it.
    if (this.game.view().mode === 'versus') {
      this.upgradeCacheRevision = this.game.revision();
      this.upgradeCacheSelected = this.selectedId;
      return NO_UPGRADE_STATES;
    }
    const revision = this.game.revision();
    if (
      revision === this.upgradeCacheRevision &&
      this.selectedId === this.upgradeCacheSelected
    ) {
      return this.upgradeCache;
    }
    const view = this.game.view();
    const selected = findTerritory(view, this.selectedId);
    if (!selected) return NO_UPGRADE_STATES;
    const states: Record<UpgradeKind, UpgradeEvaluationDetail | null> = {
      production: null,
      march: null,
      defense: null,
    };
    const kinds: UpgradeKind[] = ['production', 'march', 'defense'];
    for (let i = 0; i < kinds.length; i += 1) {
      states[kinds[i]] = this.game.evaluateUpgrade(selected.id, kinds[i]);
    }
    this.upgradeCache = states;
    this.upgradeCacheRevision = revision;
    this.upgradeCacheSelected = this.selectedId;
    return states;
  }

  /** Reachability for one selected source, cached by the adapter revision. */
  private sourceReachableIds(owner: PlayerId, sourceId: string | null): string[] {
    if (!this.game || !sourceId) return [];
    return this.game.sourceReachableTargets(owner, sourceId);
  }

  /** Live pointer slots from both panes; empty in solo idle. */
  private gestureStates(): GestureState[] {
    const states: GestureState[] = [];
    if (this.gesture) {
      const blue = this.gesture.getStates();
      for (let i = 0; i < blue.length; i += 1) states.push(blue[i]);
    }
    if (this.redGesture) {
      const red = this.redGesture.getStates();
      for (let i = 0; i < red.length; i += 1) states.push(red[i]);
    }
    return states;
  }

  /**
   * Each highlighted target is derived from the selected source's frozen-route
   * planner. A global owner set would mark targets that another owned cell can
   * reach and make a cross-border drag look legal when this source cannot.
   */
  private reachabilityFor(gestures: readonly GestureState[]): {
    ids: string[];
    alliedFrontierIds: string[];
    byOwner: Partial<Record<'player' | 'ai1', readonly string[]>>;
  } {
    if (!this.game) return { ids: [], alliedFrontierIds: [], byOwner: {} };
    const playerSource =
      this.activeGestureSource(gestures, 'player') || this.selectedId;
    const routes = playerSource && this.game.sourceReachability
      ? this.game.sourceReachability('player', playerSource) : null;
    const ids = routes ? routes.targetIds : this.sourceReachableIds('player', playerSource);
    const alliedFrontierIds = routes ? routes.alliedFrontierIds : [];
    if (this.game.view().mode !== 'versus') {
      return { ids: ids, alliedFrontierIds: alliedFrontierIds, byOwner: {} };
    }
    const redSource =
      this.activeGestureSource(gestures, 'ai1') || this.selectedRedId;
    const byOwner: Partial<Record<'player' | 'ai1', readonly string[]>> = {
      player: ids,
    };
    byOwner.ai1 = this.sourceReachableIds('ai1', redSource);
    return { ids: ids, alliedFrontierIds: [], byOwner: byOwner };
  }

  private activeGestureSource(
    gestures: readonly GestureState[],
    owner: 'player' | 'ai1'
  ): string | null {
    for (let i = 0; i < gestures.length; i += 1) {
      const gesture = gestures[i];
      if (gesture.owner === owner && gesture.phase !== 'idle' && gesture.sourceId) {
        return gesture.sourceId;
      }
    }
    return null;
  }

  /**
   * Input/adapter ownership gate. The gesture machine has already frozen the
   * owner of the pressed source, but the world may have changed during the
   * drag, so the source is re-checked here before the core sees the command.
   * A cross-side attempt only flashes in versus (no shared toast).
   */
  private commitMove(
    sourceId: string,
    targetId: string,
    ratio: number,
    owner: PlayerId = 'player'
  ): boolean {
    if (!this.game || !this.gameScreen) return false;
    const view = this.game.view();
    const territory = findTerritory(view, sourceId);
    if (!territory || territory.owner !== owner) {
      if (view.mode === 'versus') {
        this.versusRejectFeedback(sourceId);
      } else {
        this.gameScreen.showNotice('该领地不属于当前一方', 'bad');
      }
      return false;
    }

    // Continuous mode hands the drag to the core's front API, which owns
    // start/replace/stop. A core refusal stays a refusal (never silently turned
    // into a one-shot dispatch); only an adapter without a front API falls back
    // to the legacy single order, and the HUD says so.
    if (this.dispatchMode === 'continuous' && owner !== 'ai2' && this.fronts) {
      return this.commitFront(sourceId, targetId, ratio, owner as LineOwner);
    }

    const plan = this.game.plan(sourceId, ratio);
    const accepted =
      owner === 'player'
        ? this.game.issueMove(sourceId, targetId, ratio)
        : this.game.issueMoveForOwner(owner, sourceId, targetId, ratio);
    this.logCommand({
      at: Math.round(clockNow()),
      type: 'MOVE',
      source: sourceId,
      target: targetId,
      ratio: Math.round(ratio * 1000) / 1000,
      sent: plan.sent,
      accepted: accepted,
    });
    if (accepted) {
      if (owner === 'player') this.selectedId = sourceId;
      else if (view.mode === 'versus') this.selectedRedId = sourceId;
      if (this.tutorialSession && this.tutorial) {
        // Only the core's real return value; a rejected drag never advances.
        // Reporting normalizes the owner, but human input can only ever be the
        // player pane or the versus ai1 pane — ai2/ai3 are AI seats.
        this.tutorial.reportMove({
          accepted: true,
          sourceId: sourceId,
          targetId: targetId,
          owner:
            owner === 'ai1'
              ? 'ai1'
              : owner === 'ai2'
                ? 'ai2'
                : owner === 'ai3'
                  ? 'ai3'
                  : 'player',
          sent: plan.sent,
        });
      }
      const prefix =
        view.mode === 'versus'
          ? (owner === 'player' ? VERSUS_BLUE_NAME : VERSUS_RED_NAME) + ' · '
          : '';
      this.playSound('march', owner);
      this.gameScreen.showNotice(
        prefix + '已派出 ' + plan.sent + ' 兵 · 留守 ' + plan.remaining,
        'good'
      );
      this.updateGameUI();
    }
    return accepted;
  }

  /**
   * One continuous-mode drag. Returns false when the core cannot take it, so
   * the caller falls back to the legacy one-shot dispatch instead of dropping
   * the player's order.
   */
  private commitFront(
    sourceId: string,
    targetId: string,
    ratio: number,
    owner: LineOwner
  ): boolean {
    if (!this.game || !this.gameScreen) return false;
    const port = this.fronts;
    if (!port) {
      this.gameScreen.showNotice(plainLineNotice('continuous'), 'info');
      return false;
    }
    const result = port.issueFront(owner, sourceId, targetId, ratio);
    this.logCommand({
      at: Math.round(clockNow()),
      type: 'FRONT',
      source: sourceId,
      target: targetId,
      ratio: Math.round(ratio * 1000) / 1000,
      accepted: result.ok,
    });
    if (!result.ok) {
      // A real refusal names its rule (ownership, route, status); `no_troops`
      // must never appear here because a line waits for troops by design.
      if (this.game.view().mode !== 'versus' && result.reason) {
        this.gameScreen.showNotice(
          result.reason === 'no_troops'
            ? '兵线已记录 · 待兵力恢复后自动增援'
            : moveReasonText(result.reason, playerHasActiveAlly(this.game.view())),
          result.reason === 'no_troops' ? 'info' : 'bad'
        );
      }
      return false;
    }

    if (owner === 'player') this.selectedId = sourceId;
    else if (this.game.view().mode === 'versus') this.selectedRedId = sourceId;
    const prefix =
      this.game.view().mode === 'versus'
        ? (owner === 'player' ? VERSUS_BLUE_NAME : VERSUS_RED_NAME) + ' · '
        : '';
    const copy =
      result.action === 'stop'
        ? '兵线已停止'
        : result.action === 'replace'
          ? '兵线已改道 · 持续增援'
          : '兵线已建立 · 再拖同目标可停止';
    // The core's own `front` event (drained on the next tick) is the single
    // sound source for start/replace/stop; playing here would double the cue.
    this.gameScreen.showNotice(prefix + copy, 'good');
    if (
      this.tutorialSession &&
      this.tutorial &&
      result.action !== 'stop' &&
      owner === 'player'
    ) {
      // Continuous mode is still a real accepted order; the capture step waits
      // for the actual ownership event, not for this receipt.
      this.tutorial.reportMove({
        accepted: true,
        sourceId: sourceId,
        targetId: targetId,
        owner: 'player',
        sent: this.game.plan(sourceId, ratio).sent,
      });
    }
    this.updateGameUI();
    return true;
  }

  /** Selection-driven stop: every line leaving (or hitting) the selection. */
  private stopLinesForOwner(owner: VersusSide): void {
    if (!this.game || !this.gameScreen) return;
    const selected = owner === 'ai1' ? this.selectedRedId : this.selectedId;
    if (!selected) {
      this.gameScreen.showNotice('请先选择一块己方领地', 'bad');
      return;
    }
    const lines = this.currentLines();
    const targets = lineStopTargets(lines, owner, selected);
    let outgoing = 0;
    for (let i = 0; i < targets.length; i += 1) {
      if (targets[i].role === 'source') outgoing += 1;
    }
    if (targets.length === 0) {
      this.gameScreen.showNotice('该领地当前没有兵线', 'info');
      return;
    }
    if (outgoing === 0) {
      this.gameScreen.showNotice('来袭兵线由敌方控制，无法从被攻领地停止', 'info');
      return;
    }
    const port = this.fronts;
    if (!port) return;
    let stopped = 0;
    // Every line leaving this source is owned by it; the core stops by source.
    if (port.stopFront(selected, owner)) stopped += 1;
    this.logCommand({
      at: Math.round(clockNow()),
      type: 'FRONT-STOP',
      source: selected,
      accepted: stopped > 0,
    });
    if (stopped > 0) {
      // No direct cue here: the core emits a `front`/`stop` event for the same
      // removal, and drainCoreEvents owns every sound. Playing here as well
      // would double the tap in the same frame.
      this.gameScreen.showNotice('已停止该领地的兵线', 'info');
      this.updateGameUI();
    }
  }

  private currentLines(): FrontLineView[] {
    if (!this.fronts || !this.game) return [];
    // The adapter returns the same snapshot-backed array until the next core
    // revision; caching the normalized copy keeps the per-frame HUD cheap.
    const revision = this.game.revision();
    if (revision === this.linesRevision && this.linesCache) return this.linesCache;
    this.linesCache = this.fronts.lines();
    this.linesRevision = revision;
    return this.linesCache;
  }

  /**
   * Light per-side feedback; never a shared toast that interrupts the other.
   * The refused origin cell gets a short red outline from the effect layer.
   */
  private versusRejectFeedback(sourceId?: string | null): void {
    this.forEachRenderer(function (renderer) {
      renderer.flashReject(sourceId || null);
    });
  }

  private handleUpgrade(kind: UpgradeKind): void {
    if (!this.game || !this.gameScreen) return;
    // Versus has no battlefield upgrades for either side: ignore the call
    // entirely (the row is hidden upstream, this is the command gate).
    if (this.game.view().mode === 'versus') return;
    const now = clockNow();
    if (now - this.lastUpgradeAt < 220) return;
    this.lastUpgradeAt = now;

    const view = this.game.view();
    // A guided upgrade always acts on the highlighted home, even if a stray
    // selection (or none) reached this command; the lesson only accepts that
    // cell, so the receipt and the highlight can never disagree.
    const guidedUpgradeId = this.tutorialUpgradeTargetId();
    if (guidedUpgradeId) this.selectedId = guidedUpgradeId;
    const territory = findTerritory(view, guidedUpgradeId || this.selectedId);
    if (!territory) {
      this.gameScreen.showNotice('请先选择一块己方领地', 'bad');
      return;
    }
    if (territory.owner !== 'player') {
      this.gameScreen.showNotice('该领地已被敌方占领', 'bad');
      return;
    }
    const evaluation = this.game.evaluateUpgrade(territory.id, kind);
    if (!evaluation.ok) {
      if (evaluation.reason === 'no_troops') {
        this.gameScreen.showNotice(
          UPGRADE_FEEDBACK[kind] + '需 ' + evaluation.cost + ' 兵，并至少留下 1 兵',
          'bad'
        );
      } else if (evaluation.currentLevel >= UPGRADE_MAX_LEVEL[kind]) {
        this.gameScreen.showNotice('该领地已满级', 'info');
      } else {
        this.gameScreen.showNotice('当前不能升级', 'bad');
      }
      return;
    }

    const accepted = this.game.upgrade(territory.id, kind);
    this.logCommand({
      at: Math.round(clockNow()),
      type: 'UPGRADE',
      territory: territory.id,
      accepted: accepted,
    });
    if (accepted) {
      if (this.tutorialSession && this.tutorial) {
        this.tutorial.reportUpgrade({
          accepted: true,
          territoryId: territory.id,
          kind: kind,
        });
      }
      this.gameScreen.showNotice(
        UPGRADE_FEEDBACK[kind] +
          ' · 消耗 ' +
          evaluation.cost +
          ' 兵 · 余 ' +
          evaluation.remaining,
        'good'
      );
      this.updateGameUI();
    } else {
      this.gameScreen.showNotice('升级未通过校验，请稍后再试', 'bad');
    }
  }

  /**
   * Player active skill. The core owns target selection and legality; the
   * shell only forwards the receipt to the HUD/effects. A rejected cast always
   * surfaces its reason, so a tap can never be silently ignored.
   */
  private handleBetrayal(): void {
    // The core rejects ready/paused matches with `not_playing`, so the button
    // is never a silent no-op; we only guard against a torn-down session.
    if (!this.game || !this.gameScreen) return;
    const now = clockNow();
    if (now - this.lastBetrayalAt < 400) return;
    this.lastBetrayalAt = now;

    // Locked and fair-mode states are explained by the UI without sending a
    // command: a Lv.0 tap must point at the out-of-match upgrade, and a
    // challenge must name its fairness rule.
    if (this.activeChallenge) {
      this.gameScreen.showNotice(betrayalReasonText('fair_mode', 0), 'bad');
      return;
    }
    if (this.game.hudState().skill.betrayalLevel < 1) {
      this.gameScreen.showNotice(betrayalReasonText('locked', 0), 'bad');
      this.updateGameUI();
      return;
    }

    const beforeView = this.game.view();
    const result = this.game.issueBetrayal();
    this.logCommand({
      at: Math.round(now),
      type: 'BETRAYAL',
      target: result.targetId,
      accepted: result.ok,
    });
    if (!result.ok) {
      const hud = this.game.hudState();
      const seconds = Math.max(
        0,
        Math.ceil((hud.skill.readyTick - hud.tick) / TICKS_PER_SECOND)
      );
      this.gameScreen.showNotice(betrayalReasonText(result.reason, seconds), 'bad');
      this.updateGameUI();
      return;
    }

    const target = result.targetId ? findTerritory(beforeView, result.targetId) : null;
    if (this.renderer && result.targetId) {
      // The immediate post-command view is the only after-frame: no extra tick
      // is advanced for visuals. Both sides of the receipt are real core data.
      const afterView = this.game.view();
      const afterTarget = findTerritory(afterView, result.targetId);
      const receipt = {
        targetId: result.targetId,
        previousOwner: target ? target.owner : null,
        beforeTroops: target ? target.troops : 0,
        beforeShield: target ? target.shield : 0,
        captured: result.captured,
        removed: result.removed,
        survivors: result.survivors,
        afterOwner: afterTarget ? afterTarget.owner : null,
        afterTroops: afterTarget ? afterTarget.troops : 0,
        afterShield: afterTarget ? afterTarget.shield : 0,
        seed: this.game.rawSnapshot().seed,
      };
      this.renderer.playBetrayal(receipt);
    }
    this.gameScreen.showNotice(
      result.captured
        ? '策反成功 · 敌军倒戈，领地易主'
        : '策反发动 · 削减守军 ' + result.removed + ' 兵',
      result.captured ? 'good' : 'info'
    );
    this.lastBetrayalNoticeAt = now;
    // The command runs synchronously inside this click, so the core already
    // emitted its real `capture` (or nothing on a mere troop cut) and the view
    // is ALREADY post-command: the cell has its new owner and defenseLevel 0.
    // Draining here consumes that exact event once, in the same frame as the
    // colour change, so the honest capture collapse/失守 floater starts before
    // the next painted frame instead of arriving a tick late. Nothing else is
    // queued ahead of it and no extra tick is advanced; the sound bus dedupes
    // by frame token, so the cue still plays exactly once.
    this.drainCoreEvents();
    // The core has already charged the cooldown; refreshing the HUD in the
    // same click handler makes a second tap see "冷却" immediately.
    this.updateGameUI();
  }

  /**
   * Fires once when the core flips `disaster.struck`. Losses are derived from
   * the pre-tick and post-tick views, so the UI never recomputes disaster math
   * and the epicentre stays deterministic for a given seed.
   */
  private syncDisasterStrike(before: MatchView, after: MatchView): void {
    if (!this.game || !this.gameScreen || !this.renderer) return;
    const hud = this.game.hudState();
    if (!this.disasterInitialized) {
      this.disasterInitialized = true;
      this.disasterStruckSeen = hud.disaster.struck;
      return;
    }
    if (!hud.disaster.struck || this.disasterStruckSeen) return;
    this.disasterStruckSeen = true;
    const strike = collectDisasterStrike(
      before.territories,
      after.territories,
      after.mapWidth,
      after.mapHeight,
      after.seed
    );
    this.forEachRenderer(function (renderer) {
      renderer.playDisaster(strike);
    });
    this.gameScreen.showNotice('天灾降临 · 全境损兵', 'bad');
  }

  private onGestureCancel(
    reason: GestureCancelReason,
    detail?: string,
    sourceId?: string | null
  ): void {
    if (!this.gameScreen) return;
    if (reason === 'pause' || reason === 'blur' || reason === 'status' || reason === 'superseded') {
      return;
    }
    // Versus shares one screen: a rejected drag gets a per-side flash instead
    // of a global toast that would interrupt the other player.
    if (this.game && this.game.view().mode === 'versus') {
      this.versusRejectFeedback(sourceId);
      return;
    }
    if (reason === 'multi-touch') {
      this.gameScreen.showNotice('检测到多指操作，本次派兵已取消', 'bad');
    } else if (reason === 'source-lost') {
      this.gameScreen.showNotice('来源领地已失守，本次派兵已取消', 'bad');
    } else if (reason === 'blank') {
      this.gameScreen.showNotice('松手在空白处，本次派兵已取消', 'info');
    } else if (reason === 'illegal') {
      this.gameScreen.showNotice(
        detail
          ? moveReasonText(
              detail,
              !!this.game && playerHasActiveAlly(this.game.view())
            )
          : '目标不可操作',
        'bad'
      );
    } else if (reason === 'rejected') {
      // In continuous mode commitFront already surfaced the core's exact
      // reason; a generic follow-up toast would just repeat it.
      if (this.dispatchMode !== 'continuous' || !this.fronts) {
        this.gameScreen.showNotice('指令未通过校验，可能领地已变化', 'bad');
      }
    } else if (reason === 'resize') {
      this.gameScreen.showNotice('屏幕尺寸变化，本次派兵已取消', 'info');
    } else if (reason === 'pointer-cancel') {
      this.gameScreen.showNotice('触摸已取消，未派兵', 'info');
    }
  }

  /**
   * Versus starts with a compact two-player briefing. It never touches the
   * solo tutorial flag and dismisses on tap, button, Escape or after 3 seconds.
   */
  private showVersusIntro(): void {
    this.matchStarted = false;
    const overlay = el('div', 'overlay versus-intro-overlay');
    const card = el('div', 'versus-intro-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '双人对战说明');
    card.appendChild(el('span', 'versus-intro-tag', VERSUS_TAGLINE));
    card.appendChild(el('h2', 'versus-intro-title', VERSUS_INTRO_TITLE));
    const sides = el('div', 'versus-intro-sides');
    const blue = el('div', 'versus-intro-side versus-intro-blue');
    blue.appendChild(el('b', 'versus-intro-name', VERSUS_BLUE_NAME));
    blue.appendChild(el('span', 'versus-intro-role', '玩家 1'));
    const red = el('div', 'versus-intro-side versus-intro-red');
    red.appendChild(el('b', 'versus-intro-name', VERSUS_RED_NAME));
    red.appendChild(el('span', 'versus-intro-role', '玩家 2'));
    sides.appendChild(blue);
    sides.appendChild(el('span', 'versus-intro-vs', 'VS'));
    sides.appendChild(red);
    card.appendChild(sides);
    card.appendChild(el('p', 'versus-intro-body', VERSUS_INTRO_BODY));
    const view = this.game ? this.game.view() : null;
    card.appendChild(
      el(
        'p',
        'versus-intro-duration',
        '本局时长 · ' +
          (view ? durationLabel(view.durationTicks / 10) : '标准') +
          '（沿用上次设置）'
      )
    );
    card.appendChild(el('p', 'versus-intro-hint', VERSUS_INTRO_HINT));
    // Neither side can buy battlefield upgrades in a shared-economy match;
    // reusing the hint style keeps the card compact without new CSS.
    card.appendChild(el('p', 'versus-intro-hint versus-intro-note', VERSUS_NO_UPGRADE_NOTE));
    const start = button('开始对战', 'btn btn-primary versus-intro-start', () => finish());
    card.appendChild(start);
    overlay.appendChild(card);

    const self = this;
    let done = false;
    const finish = (): void => {
      if (done || overlay.parentNode === null) return;
      done = true;
      if (self.versusIntroTimer !== null) {
        window.clearTimeout(self.versusIntroTimer);
        self.versusIntroTimer = null;
      }
      self.closeOverlay(overlay);
      self.beginCountdown();
    };
    overlay.addEventListener('click', finish);
    this.openOverlay(overlay, { focus: true, escape: finish });
    this.versusIntroTimer = window.setTimeout(
      finish,
      VERSUS_INTRO_AUTO_DISMISS_MS
    );
  }

  /** The controller's own skip button; routes like an active skip. */
  private handleTutorialSkip(): void {
    const destination = this.tutorialEntry === 'onboarding' ? 'setup' : 'home';
    this.exitTutorial(destination);
  }

  /**
   * Explicit skip and the HUD's own skip are the only active choices that
   * clear the first-run marker. An ordinary "leave for now" never reaches
   * this method: it goes through leaveTutorialForHome, which keeps the marker.
   */
  private exitTutorial(destination: 'home' | 'setup'): void {
    this.settleOnboarding();
    this.teardownGame();
    this.closeAllOverlays();
    this.tutorialEntry = 'replay';
    if (destination === 'setup') this.showSetup();
    else this.showHome();
  }

  /**
   * Ordinary pause exit: stop the lesson and go home without settling the
   * first-run marker. The next launch (or the home "重玩教学" entry) can still
   * find the lesson; `onboardingPromptShown` is reset only *after* the home
   * screen is rendered so no invite pops up over the return itself.
   */
  private leaveTutorialForHome(): void {
    this.showHome();
    this.onboardingPromptShown = false;
  }

  /**
   * The only settlement a tutorial may reach. It never calls finishMatch, so
   * no record, leaderboard row, gold award or challenge code is produced.
   */
  private finishTutorialSession(
    view: MatchView | null,
    reason: 'complete' | 'ended'
  ): void {
    if (this.tutorialResultShown) return;
    this.tutorialResultShown = true;
    this.matchStarted = false;
    this.resultShown = true;
    this.endHoldSince = null;
    this.stopLoop();
    this.closeAllOverlays();

    const state: TutorialState | null = this.tutorial ? this.tutorial.getState() : null;
    const progress = state
      ? Math.min(state.stepCount, state.stepIndex) + ' / ' + state.stepCount
      : '—';
    const outcome =
      reason === 'complete'
        ? '完成'
        : view && view.result === 'win'
          ? '胜利'
          : view && view.result === 'lose'
            ? '战败'
            : '结束';
    const elapsed = view ? durationLabel(Math.floor(view.tick / 10)) : '—';

    // Clearing the first-run marker is the only persistent effect, and only a
    // genuinely completed lesson may do it. An early end (the match ended
    // before the free-play clock, including a loss) is not a completed lesson:
    // keep onboardingPending so the entry can be retried on a later launch,
    // while still settling independently (no record/gold/leaderboard/code).
    const completed = reason === 'complete';
    if (completed) this.settleOnboarding();
    const onboardingPending = this.profiles.isOnboardingPending();
    this.teardownGame();

    const root = el('section', 'screen result-screen tutorial-result-screen');
    root.setAttribute('aria-labelledby', 'tutorial-result-title');
    root.setAttribute('data-result', 'tutorial');
    root.setAttribute('data-tutorial-outcome', reason);

    const top = el('div', 'result-top');
    top.appendChild(el('p', 'result-kicker', 'TUTORIAL REPORT · 新手战场'));
    const stamp = el('div', 'result-stamp');
    stamp.appendChild(
      el(
        'span',
        'result-stamp-char',
        reason === 'complete'
          ? '成'
          : view && view.result === 'win'
            ? '胜'
            : view && view.result === 'lose'
              ? '败'
              : '和'
      )
    );
    stamp.setAttribute('aria-hidden', 'true');
    const title = el(
      'h1',
      'result-title',
      completed ? '教学完成' : '教学未完成'
    );
    title.id = 'tutorial-result-title';
    top.appendChild(stamp);
    top.appendChild(title);
    top.appendChild(
      el(
        'p',
        'result-subtitle',
        completed
          ? '真实操作已记录为教学演练：不计战绩、金币和排行榜，也不生成挑战码。'
          : onboardingPending
            ? '本次演练未判定为完成：不计战绩、金币和排行榜，新手引导入口仍会保留。'
            : '本次演练未判定为完成：不计战绩、金币和排行榜，也不生成挑战码。'
      )
    );

    const details = el('div', 'result-detail');
    const rows: Array<[string, string]> = [
      ['教学进度', progress],
      ['演练结果', outcome],
      ['本局用时', elapsed],
      [
        '档案影响',
        completed
          ? '无战绩 · 无金币 · 无榜单'
          : onboardingPending
            ? '教学未完成 · 入口保留'
            : '教学未完成 · 无战绩',
      ],
    ];
    for (let i = 0; i < rows.length; i += 1) {
      const cell = el('div', 'result-detail-cell');
      cell.appendChild(el('span', 'result-detail-label', rows[i][0]));
      cell.appendChild(el('b', 'result-detail-value', rows[i][1]));
      details.appendChild(cell);
    }

    if (view) {
      const board = el('div', 'result-scoreboard');
      const playerSide = el('div', 'result-side result-player');
      playerSide.appendChild(el('span', 'result-side-label', '我方'));
      playerSide.appendChild(el('b', 'result-side-score', String(view.scores.player)));
      playerSide.appendChild(
        el('em', 'result-side-land', view.territoryCounts.player + ' 块领地')
      );
      const center = el('div', 'result-vs');
      center.appendChild(el('span', 'result-vs-label', '控地分值'));
      center.appendChild(el('span', 'result-vs-line', ''));
      const enemySide = el('div', 'result-side result-enemy');
      enemySide.appendChild(el('span', 'result-side-label', '教学敌军'));
      enemySide.appendChild(
        el(
          'b',
          'result-side-score',
          String(view.scores.ai1 + view.scores.ai2)
        )
      );
      enemySide.appendChild(
        el(
          'em',
          'result-side-land',
          view.territoryCounts.ai1 + view.territoryCounts.ai2 + ' 块领地'
        )
      );
      board.appendChild(playerSide);
      board.appendChild(center);
      board.appendChild(enemySide);
      root.appendChild(top);
      root.appendChild(board);
    } else {
      root.appendChild(top);
    }
    root.appendChild(details);

    const actions = el('div', 'result-actions');
    const retry = button('重试教学', 'btn btn-primary btn-wide', () => {
      this.startTutorial(onboardingPending ? 'onboarding' : 'replay', true);
    });
    retry.setAttribute('aria-label', '重新开始新手教学');
    actions.appendChild(retry);

    if (!completed && onboardingPending) {
      // An unfinished lesson keeps its first-run entry. Offer the explicit
      // skip here too, but never pretend the early end completed the lesson.
      const skip = button('跳过教学并进入设置', 'btn btn-secondary btn-wide', () => {
        this.exitTutorial('setup');
      });
      skip.setAttribute('aria-label', '跳过新手教学，进入单人设置');
      const home = button('返回首页（下次继续教学）', 'btn btn-ghost-danger btn-wide', () => {
        this.leaveTutorialForHome();
      });
      home.setAttribute('aria-label', '返回首页，保留新手教学入口');
      actions.appendChild(skip);
      actions.appendChild(home);
    } else {
      const formal = button('开始正式局', 'btn btn-secondary btn-wide', () => {
        this.showSetup();
      });
      formal.setAttribute('aria-label', '开始正式单人游戏');
      const home = button('返回首页', 'btn btn-ghost-danger btn-wide', () => {
        this.showHome();
      });
      home.setAttribute('aria-label', '返回首页');
      actions.appendChild(formal);
      actions.appendChild(home);
    }
    root.appendChild(actions);
    root.appendChild(
      el('p', 'result-foot', '新手教学 · 仅演练，不写入本机档案与本机榜单')
    );

    this.tutorialEntry = 'replay';
    this.setMode('result');
    this.setScreen(root);
    // The pending-clear write is asynchronous. Never claim the state was saved
    // when the platform only kept it in memory. An unfinished lesson wrote no
    // marker, so it has nothing to confirm.
    if (!completed) return;
    const self = this;
    void this.profiles.flushWrites().then(function () {
      if (self.currentScreen !== root) return;
      if (self.profiles.lastWriteOk()) return;
      root.appendChild(
        self.saveWarningNode(
          'tutorial-result-save-warning',
          '当前环境未能保存教学完成状态，下次启动可能再次显示新手入口。'
        )
      );
    });
  }

  private beginCountdown(): void {
    if (!this.game || !this.gameScreen) return;
    this.matchStarted = false;
    // A hidden page must never count down or kick off a match in the
    // background; the visibility return path re-enters this method.
    if (!countdownStartAllowed(typeof document !== 'undefined' && document.hidden)) {
      this.countdownPending = true;
      return;
    }
    this.countdownPending = false;
    if (this.countdownTimer !== null) {
      window.clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.countdownOverlay) {
      this.closeOverlay(this.countdownOverlay);
      this.countdownOverlay = null;
    }
    const token = (this.countdownToken += 1);
    const view = this.game.view();
    const region =
      (view.geog && view.geog.regionLabel) ||
      (view.geography && view.geography.regionLabel) ||
      view.mapName;
    const overlay = el('div', 'overlay countdown-overlay');
    const card = el('div', 'countdown-card');
    const number = el('div', 'countdown-number', '3');
    number.setAttribute('aria-live', 'assertive');
    const label = el('p', 'countdown-label', region);
    const hint = el(
      'p',
      'countdown-hint',
      this.matchMode === 'versus'
        ? VERSUS_BLUE_NAME + '/' + VERSUS_RED_NAME + ' 各自长按出兵'
        : this.dispatchMode === 'continuous'
          ? '拖向接壤目标建立兵线 · 同目标再拖可停止'
          : '按住蓄力 · 拖向接壤 · 选中升级'
    );
    card.appendChild(number);
    card.appendChild(label);
    card.appendChild(hint);
    overlay.appendChild(card);
    this.openOverlay(overlay, { focus: false, escape: null });
    this.countdownOverlay = overlay;

    let count = 3;
    const tick = (): void => {
      if (token !== this.countdownToken || !this.game) {
        this.closeOverlay(overlay);
        if (this.countdownOverlay === overlay) this.countdownOverlay = null;
        return;
      }
      if (count > 1) {
        count -= 1;
        setText(number, String(count));
        number.classList.remove('is-pop');
        void number.offsetWidth;
        number.classList.add('is-pop');
        this.countdownTimer = window.setTimeout(tick, 680);
        return;
      }

      this.countdownTimer = null;
      this.closeOverlay(overlay);
      if (this.countdownOverlay === overlay) this.countdownOverlay = null;
      if (!this.game || !this.gameScreen) return;
      // Hidden exactly at the last step: defer the kick-off, never start a
      // match that the player cannot see or control.
      if (countdownFinishAction(document.hidden) === 'defer') {
        this.countdownPending = true;
        return;
      }
      this.game.start();
      this.matchStarted = true;
      this.lastFrameTime = clockNow();
      this.accumulator = 0;
      this.gameScreen.showNotice('开战 · 抢占中立领地', 'good');
      this.startLoop();
    };

    number.classList.add('is-pop');
    this.countdownTimer = window.setTimeout(tick, 680);
  }

  /** Cancels the running 3-2-1 (hiding) and leaves a pending restart marker. */
  private cancelCountdown(): void {
    this.countdownToken += 1;
    if (this.countdownTimer !== null) {
      window.clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    // Close the tracked overlay BEFORE dropping the reference, otherwise the
    // overlay stack keeps the old 3-2-1 card on top of the battlefield forever.
    this.countdownPending = false;
    this.countdownOverlay = closeCountdownOverlay(
      this.countdownOverlay,
      (overlay) => this.closeOverlay(overlay)
    );
  }

  private pauseGame(autoPaused: boolean, showMenu = true): void {
    if (!this.game || !this.gameScreen || !this.matchStarted || this.resultShown) return;
    const view = this.game.view();
    if (view.status !== 'playing') return;
    this.game.pause();
    if (this.gesture) this.gesture.cancel('pause');
    if (this.redGesture) this.redGesture.cancel('pause');
    this.stopAllCameraPans();
    this.stopLoop();
    // A live fort collapse is wall-clock based: freeze it here so the pause
    // card never resumes into a skipped or already-finished animation.
    this.forEachRenderer(function (renderer) {
      renderer.pauseDefenseCollapses();
    });
    if (this.soundBus) void this.soundBus.suspend();
    this.updateGameUI();
    if (showMenu) this.showPauseMenu(autoPaused);
  }

  private showPauseMenu(autoPaused: boolean): void {
    if (!this.game || !this.gameScreen) return;
    const view = this.game.view();
    const tutorialMode = this.tutorialSession;
    const diplomacyEnabled =
      !!view.diplomacy && view.diplomacy.enabled === true;
    const overlay = createPauseOverlay(
      view,
      autoPaused,
      tutorialMode
        ? {
            onResume: () => this.resumeGame(),
            onRestart: () => this.confirmRestart(),
            // Ordinary leave keeps the first-run marker; explicit skip clears
            // it. Keeping these as two buttons avoids the old trap where the
            // only exit silently counted as a completed lesson.
            onHome: () => this.confirmLeaveTutorial(),
            onSkipTutorial: () => this.confirmSkipTutorial(),
            onRules: () => this.showRules(),
            mode: 'tutorial',
          }
        : {
            onResume: () => this.resumeGame(),
            onRestart: () => this.confirmRestart(),
            onHome: () => this.confirmHome(),
            onResign: () => this.confirmResign(),
            pendingOffer: pendingOfferForPlayer(view),
            // Diplomacy is a normal solo rule only. Challenges and versus pass
            // false through to the core and therefore omit this control.
            onDiplomacy: diplomacyEnabled
              ? () => this.showDiplomacy()
              : undefined,
            onRules: () => this.showRules(),
            // A challenge starts at the code's own pace, but the player may
            // still adjust it while paused; doing so makes it practice-only.
            getGameSpeed: () =>
              this.speedRecord ? this.speedRecord.current : this.store.getGameSpeed(),
            setGameSpeed: (speed) => this.setMatchSpeed(speed),
          }
    );
    this.pauseOverlay = overlay as PauseOverlayElement;
    if (!tutorialMode) {
      (overlay as PauseOverlayElement).setGameSpeed(
        this.speedRecord ? this.speedRecord.current : this.store.getGameSpeed()
      );
    }
    this.openOverlay(overlay, { focus: true, escape: () => this.resumeGame() });
  }

  private resumeGame(): void {
    if (!this.game || this.resultShown || this.truceOfferOverlay) return;
    this.pauseOverlay = null;
    this.closeAllOverlays();
    // A pending invitation deferred behind another modal gets a safe decision
    // surface before any resume. Its answer preserves the existing pause.
    if (this.maybeShowTruceOffer()) return;
    this.game.resume();
    this.lastFrameTime = clockNow();
    this.accumulator = 0;
    // Discard exactly the frozen gap so the collapse continues where it was.
    this.forEachRenderer(function (renderer) {
      renderer.resumeDefenseCollapses();
    });
    this.startLoop();
    this.updateGameUI();
    this.redrawMap();
    // Resume only reports what really happened; a rejected resume leaves audio
    // suspended and the next gesture tries again from unlock().
    if (this.soundBus) {
      const bus = this.soundBus;
      void bus.resume().then(function (ok) {
        if (!ok) bus.setEnabled(bus.isEnabled());
      });
    }
  }

  private confirmRestart(): void {
    const tutorialMode = this.tutorialSession;
    const overlay = createConfirmOverlay({
      title: tutorialMode ? '重新开始教学？' : '重新开始本局？',
      body: tutorialMode
        ? '当前教学进度会立即重置，并从主城重新开始；新手引导状态保持不变。'
        : this.activeChallenge
          ? '当前战局与在途部队会立即丢弃，并以相同的挑战参数重新开局。'
          : '当前战局与在途部队会立即丢弃，并重新抽取一场随机战场。',
      confirmLabel: tutorialMode ? '重新开始教学' : '重新开始',
      cancelLabel: '继续本局',
      danger: false,
      onConfirm: () => {
        this.closeOverlay(overlay);
        if (tutorialMode) this.startTutorial(this.tutorialEntry, true);
        else this.startMatch();
      },
      onCancel: () => this.closeOverlay(overlay),
    });
    this.openOverlay(overlay, {
      focus: true,
      escape: () => this.closeOverlay(overlay),
    });
  }

  /** Tutorial pause: "leave for now", keeping the first-run lesson entry. */
  private confirmLeaveTutorial(): void {
    const overlay = createConfirmOverlay({
      title: '暂时离开教学？',
      body: '本次演练进度不会保留，但新手引导仍会保留：下次启动或从首页「重玩教学」可以继续。',
      confirmLabel: '返回首页（保留教学）',
      cancelLabel: '继续教学',
      danger: false,
      onConfirm: () => {
        this.closeOverlay(overlay);
        this.leaveTutorialForHome();
      },
      onCancel: () => this.closeOverlay(overlay),
    });
    this.openOverlay(overlay, {
      focus: true,
      escape: () => this.closeOverlay(overlay),
    });
  }

  /** Tutorial pause: explicit skip, the only pause action that clears pending. */
  private confirmSkipTutorial(): void {
    const entry = this.tutorialEntry;
    const overlay = createConfirmOverlay({
      title: '跳过新手教学？',
      body:
        '跳过后本次演练进度不会保留，也不再自动出现；' +
        (entry === 'onboarding'
          ? '将直接进入单人设置。'
          : '将返回首页。'),
      confirmLabel: '跳过教学',
      cancelLabel: '继续教学',
      danger: true,
      onConfirm: () => {
        this.closeOverlay(overlay);
        this.exitTutorial(entry === 'onboarding' ? 'setup' : 'home');
      },
      onCancel: () => this.closeOverlay(overlay),
    });
    this.openOverlay(overlay, {
      focus: true,
      escape: () => this.closeOverlay(overlay),
    });
  }

  /** Only a clear game surface may take focus for a newly received invitation. */
  private maybeShowTruceOffer(): boolean {
    if (!this.game || !this.gameScreen || this.mode !== 'game' ||
        !this.matchStarted || this.resultShown || this.tutorialSession || document.hidden) return false;
    const game = this.game;
    const view = game.view();
    if (view.status !== 'playing' && view.status !== 'paused') return false;
    if (this.truceOfferOverlay) return true;
    if (this.overlayStack.length > 0) return false;
    const pending = pendingOfferForPlayer(view);
    if (!pending || this.shownTruceOfferIds.has(pending.offer.id) ||
        game.truceOfferActionsAvailable === false ||
        typeof game.acceptTruceOffer !== 'function' ||
        typeof game.rejectTruceOffer !== 'function') return false;

    const resumeAfterAnswer = view.status === 'playing';
    this.shownTruceOfferIds.add(pending.offer.id);
    if (resumeAfterAnswer) this.pauseGame(false, false);
    this.stopLoop();

    const parts = createOverlay('truce-offer-overlay');
    parts.card.className = 'overlay-card truce-offer-card';
    parts.card.setAttribute('role', 'dialog');
    parts.card.setAttribute('aria-modal', 'true');
    parts.card.setAttribute('aria-labelledby', 'truce-offer-title');
    parts.card.setAttribute('aria-describedby', 'truce-offer-description');
    parts.card.setAttribute('data-offer-id', pending.offer.id);
    const scroll = el('div', 'truce-offer-scroll');
    scroll.appendChild(el('p', 'overlay-kicker', 'COOPERATION · 合作邀请'));
    const title = el('h2', 'overlay-title', pending.proposerName + '邀请你停战');
    title.id = 'truce-offer-title';
    scroll.appendChild(title);
    scroll.appendChild(el('p', 'diplomacy-offer-motivation', pending.motivation));
    scroll.appendChild(el('p', 'diplomacy-offer-factors', '具体因素：' + pending.factorsText));
    const description = el(
      'p',
      'confirm-body diplomacy-copy',
      '接受后建立 60 游戏秒停战，双方不能互相攻击，可沿相连的己方或盟友领地借道；' +
      '领地与部队仍各自独立。接受属于使用外交，本局将按练习处理，不计排行榜、不生成公平挑战码。' +
      '拒绝不会建立盟约，也不增加外交使用次数。'
    );
    description.id = 'truce-offer-description';
    scroll.appendChild(description);
    scroll.appendChild(el(
      'p', 'diplomacy-offer-expiry',
      '对局与邀请计时已暂停 · 邀请剩余 ' + pending.secondsLeft + ' 游戏秒' +
      (resumeAfterAnswer ? ' · 答复后继续对局' : ' · 答复后保持暂停')
    ));
    const status = el('p', 'diplomacy-status');
    status.setAttribute('role', 'status');
    scroll.appendChild(status);
    parts.card.appendChild(scroll);

    const finishResponse = (message: string, tone: 'good' | 'info' | 'bad'): void => {
      this.updateGameUI();
      this.refreshPausePendingOffer();
      const latest = pendingOfferForPlayer(game.view());
      if (latest && latest.offer.id === pending.offer.id &&
          (game.view().status === 'playing' || game.view().status === 'paused')) {
        setText(status, message);
        return;
      }
      this.truceOfferOverlay = null;
      this.closeOverlay(parts.root);
      if (resumeAfterAnswer && game.view().status === 'paused' && !document.hidden) {
        this.resumeGame();
      } else if (game.view().status === 'paused') {
        this.showPauseMenu(document.hidden);
      } else if (game.view().status === 'ended') {
        this.startLoop();
      }
      if (this.gameScreen) this.gameScreen.showNotice(message, tone);
    };
    const actions = el('div', 'diplomacy-offer-actions truce-offer-actions');
    const accept = button('接受合作', 'btn btn-primary diplomacy-offer-action', () => {
      if (this.game !== game || this.truceOfferOverlay !== parts.root) return;
      const result = game.acceptTruceOffer!(pending.offer.id);
      if (result && result.ok && result.accepted) {
        finishResponse('你接受了' + pending.proposerName + '的合作邀请', 'good');
      } else {
        finishResponse(truceOfferFailureText(result ? String(result.reason) : ''), 'bad');
      }
    });
    accept.setAttribute('aria-label', '接受合作');
    accept.setAttribute('data-action', 'accept-cooperation');
    const reject = button('拒绝', 'btn btn-secondary diplomacy-offer-action', () => {
      if (this.game !== game || this.truceOfferOverlay !== parts.root) return;
      const handled = game.rejectTruceOffer!(pending.offer.id);
      finishResponse(
        handled === true
          ? '你拒绝了' + pending.proposerName + '的合作邀请'
          : '合作邀请已过期或失效，未记为拒绝。',
        handled === true ? 'info' : 'bad'
      );
    });
    reject.setAttribute('aria-label', '拒绝');
    reject.setAttribute('data-action', 'reject-cooperation');
    reject.setAttribute('data-autofocus', 'true');
    actions.appendChild(accept);
    actions.appendChild(reject);
    parts.card.appendChild(actions);
    // Two explicit choices only: Tab stays in the decision, Escape/backdrop
    // have no dismiss action, and initial focus never implies acceptance.
    parts.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      if (document.activeElement === reject) accept.focus();
      else reject.focus();
    });
    this.truceOfferOverlay = parts.root;
    this.openOverlay(parts.root, { focus: true, escape: null });
    return true;
  }

  private refreshPausePendingOffer(): void {
    if (!this.game || !this.pauseOverlay) return;
    const panel = deriveDiplomacyPanel(this.game.view());
    this.pauseOverlay.refreshPendingOffer(panel.pendingOffer);
  }

  private showDiplomacy(
    initialStatus?: string,
    initialStatusClass?: 'is-good' | 'is-info'
  ): void {
    if (!this.game) return;
    const view = this.game.view();
    // One pure derivation owns ally/enemy/cooldown/pending-offer reasoning; the
    // sheet only renders it. Every response below uses the captured offer id.
    const panel = deriveDiplomacyPanel(view);
    const enabled = panel.enabled;
    const uses = panel.uses;
    const parts = createOverlay('diplomacy-overlay');
    parts.card.className = 'overlay-card diplomacy-card';
    parts.card.setAttribute('role', 'dialog');
    parts.card.setAttribute('aria-modal', 'true');
    parts.card.setAttribute('aria-labelledby', 'diplomacy-title');
    parts.card.setAttribute('data-enabled', enabled ? 'true' : 'false');
    parts.card.setAttribute('data-uses', String(uses));
    parts.card.appendChild(el('p', 'overlay-kicker', 'DIPLOMACY'));
    const title = el('h2', 'overlay-title', '外交与停战');
    title.id = 'diplomacy-title';
    parts.card.appendChild(title);
    const diplomacyScroll = el('div', 'diplomacy-scroll');
    diplomacyScroll.appendChild(
      el(
        'p',
        'confirm-body diplomacy-copy',
        enabled
          ? '本页打开时对局保持暂停；停战双方不能互相攻击，各自保留自己的控地分。' +
            '每方最多1个盟友；对方可能拒绝；只剩两方时自动解盟。'
          : '本模式不开放外交。'
      )
    );
    const self = this;
    // Inline feedback stays inside the sheet so a stale/expired offer is
    // explained without turning it into an AI rejection.
    const status = el('p', 'diplomacy-status');
    status.setAttribute('role', 'status');
    if (initialStatus) {
      if (initialStatusClass) status.className = 'diplomacy-status ' + initialStatusClass;
      setText(status, initialStatus);
    }
    if (enabled && panel.pendingOffer) {
      const pending = panel.pendingOffer;
      const offerActionsAvailable =
        self.game !== null &&
        self.game.truceOfferActionsAvailable !== false &&
        typeof self.game.acceptTruceOffer === 'function' &&
        typeof self.game.rejectTruceOffer === 'function';
      const offerBlock = el('section', 'diplomacy-offer');
      offerBlock.setAttribute('data-offer-id', pending.offer.id);
      const offerTitle = el(
        'h3',
        'diplomacy-offer-title',
        pending.proposerName + '提出合作邀请'
      );
      offerBlock.appendChild(offerTitle);
      offerBlock.appendChild(
        el('p', 'diplomacy-offer-motivation', pending.motivation)
      );
      offerBlock.appendChild(
        el('p', 'diplomacy-offer-factors', '具体因素：' + pending.factorsText)
      );
      offerBlock.appendChild(
        el(
          'p',
          'diplomacy-offer-expiry',
          '邀请有效期：剩余 ' + pending.secondsLeft + ' 游戏秒'
        )
      );
      const offerActions = el('div', 'diplomacy-offer-actions');
      const accept = button('接受合作', 'btn btn-primary diplomacy-offer-action', function () {
        if (!self.game) return;
        const respond = self.game.acceptTruceOffer;
        if (typeof respond !== 'function') {
          status.removeAttribute('hidden');
          setText(status, '当前版本不支持处理合作邀请。');
          return;
        }
        const result = respond(pending.offer.id);
        self.updateGameUI();
        if (!result) {
          const message = '合作邀请未生效，未记为拒绝。';
          self.refreshPausePendingOffer();
          self.closeOverlay(parts.root);
          self.showDiplomacy(message);
          return;
        }
        if (result.ok && result.accepted) {
          const message = '你接受了' + pending.proposerName + '的合作邀请';
          self.refreshPausePendingOffer();
          self.closeOverlay(parts.root);
          self.showDiplomacy(message, 'is-good');
          return;
        }
        const message = truceOfferFailureText(String(result.reason));
        self.refreshPausePendingOffer();
        self.closeOverlay(parts.root);
        self.showDiplomacy(message);
      });
      accept.setAttribute('aria-label', '接受合作');
      accept.setAttribute('data-action', 'accept-cooperation');
      accept.disabled = !offerActionsAvailable;
      const reject = button('拒绝', 'btn btn-secondary diplomacy-offer-action', function () {
        if (!self.game) return;
        const respond = self.game.rejectTruceOffer;
        if (typeof respond !== 'function') {
          status.removeAttribute('hidden');
          setText(status, '当前版本不支持处理合作邀请。');
          return;
        }
        const handled = respond(pending.offer.id);
        self.updateGameUI();
        const message = handled === true
          ? '你拒绝了' + pending.proposerName + '的合作邀请'
          : '合作邀请已过期或失效，未记为拒绝。';
        self.refreshPausePendingOffer();
        self.closeOverlay(parts.root);
        self.showDiplomacy(message, handled === true ? 'is-info' : undefined);
      });
      reject.setAttribute('aria-label', '拒绝');
      reject.setAttribute('data-action', 'reject-cooperation');
      reject.disabled = !offerActionsAvailable;
      if (!offerActionsAvailable) {
        status.removeAttribute('hidden');
        setText(status, '当前版本不支持处理合作邀请。');
      }
      offerActions.appendChild(accept);
      offerActions.appendChild(reject);
      offerBlock.appendChild(offerActions);
      parts.card.appendChild(offerBlock);
    }
    if (enabled && (panel.ally !== null || panel.targets.length > 0)) {
      const context = el('div', 'diplomacy-context');
      if (panel.ally !== null) {
        const allyRow = el('p', 'diplomacy-context-row');
        setText(
          allyRow,
          '当前盟友：' +
            panel.allyName +
            '（剩余 ' +
            panel.allySecondsLeft +
            ' 秒）'
        );
        context.appendChild(allyRow);
        if (panel.allyDecisionText) {
          const allyWhy = el('p', 'diplomacy-context-row');
          setText(allyWhy, '结盟原因：' + panel.allyDecisionText);
          context.appendChild(allyWhy);
        }
        if (panel.commonEnemyNames.length > 0) {
          const enemyRow = el('p', 'diplomacy-context-row is-enemy');
          setText(enemyRow, '共同敌人：' + panel.commonEnemyNames.join('、'));
          context.appendChild(enemyRow);
        }
      }
      if (panel.passageNote) {
        const note = el('p', 'diplomacy-context-note');
        setText(note, panel.passageNote);
        context.appendChild(note);
      }
      diplomacyScroll.appendChild(context);
    }
    parts.card.appendChild(diplomacyScroll);
    const list = el('div', 'diplomacy-list');
    list.setAttribute('data-uses', String(uses));
    let visibleRows = 0;
    for (let i = 0; i < panel.rows.length; i += 1) {
      const rowView = panel.rows[i];
      visibleRows += 1;
      const owner = rowView.owner;
      const active = rowView.state === 'active';
      const row = el('div', 'diplomacy-row');
      row.setAttribute('data-owner', owner);
      row.setAttribute('data-state', rowView.state);
      row.appendChild(el('span', 'diplomacy-name', rowView.name));
      const detail = el('span', 'diplomacy-detail', rowView.detail);
      detail.setAttribute('data-state', rowView.state);
      row.appendChild(detail);
      const action = button(
        rowView.actionLabel,
        'btn btn-secondary diplomacy-action',
        function () {
          if (!self.game) return;
          if (active) {
            const broken = self.game.breakTruce(owner);
            if (!broken) {
              status.removeAttribute('hidden');
              setText(
                status,
                '本次解除未生效：对局状态刚发生变化，请关闭本页后重新查看。'
              );
              return;
            }
            self.closeOverlay(parts.root);
            self.showDiplomacy();
            self.updateGameUI();
            return;
          }
          // Legality refusal (ok:false) and AI verdict (ok:true) are
          // distinct outcomes and must never read as one generic failure.
          const proposal = self.game.proposeTruce(owner);
          if (!proposal.ok) {
            status.removeAttribute('hidden');
            setText(
              status,
              '提议未生效：' + truceLegalityText(proposal.reason)
            );
            return;
          }
          // Both verdicts land in the snapshot (accepted -> active truce;
          // rejected -> lastDecision='rejected' cooldown record), so
          // rebuilding the sheet renders the row honestly: the rejected row
          // becomes a disabled cooldown with its full reason, never a stale
          // still-clickable offer.
          self.closeOverlay(parts.root);
          self.showDiplomacy();
          self.updateGameUI();
        }
      );
      action.setAttribute('aria-label', rowView.actionAria);
      action.setAttribute('data-owner', owner);
      action.setAttribute('data-state', rowView.state);
      if (!rowView.actionable) {
        action.disabled = true;
        if (rowView.disabledReason) {
          action.setAttribute('aria-describedby', 'diplomacy-status-line');
        }
      }
      row.appendChild(action);
      list.appendChild(row);
    }
    if (visibleRows === 0) {
      list.appendChild(
        el(
          'p',
          'diplomacy-empty',
          enabled ? '当前没有存活的 AI 可提议停战。' : '本模式不开放外交。'
        )
      );
    }
    diplomacyScroll.appendChild(list);
    status.id = 'diplomacy-status-line';
    if (status.textContent === '') status.setAttribute('hidden', '');
    parts.card.appendChild(status);
    const close = button('返回暂停页', 'btn btn-primary btn-wide', function () {
      self.closeOverlay(parts.root);
    });
    close.setAttribute('data-action', 'close-diplomacy');
    parts.card.appendChild(close);
    this.openOverlay(parts.root, {
      focus: true,
      escape: () => self.closeOverlay(parts.root),
    });
  }

  private confirmResign(): void {
    if (!this.game || !this.matchStarted || this.resultShown) return;
    const overlay = createConfirmOverlay({
      title: '认输并结束本局？',
      body: '本局将按负局记录，不获得金币与经验；当前领地与在途部队会立即停止。',
      confirmLabel: '确认认输',
      cancelLabel: '继续对局',
      danger: true,
      onConfirm: () => {
        this.closeOverlay(overlay);
        if (!this.game) return;
        if (!this.game.resign()) return;
        this.matchStarted = false;
        this.stopLoop();
        this.updateGameUI();
        this.startLoop();
      },
      onCancel: () => this.closeOverlay(overlay),
    });
    this.openOverlay(overlay, {
      focus: true,
      escape: () => this.closeOverlay(overlay),
    });
  }

  private confirmHome(): void {
    const tutorialMode = this.tutorialSession;
    const overlay = createConfirmOverlay({
      title: tutorialMode ? '返回首页？' : '退出当前对局？',
      body: tutorialMode
        ? '返回首页后本局进度不会保留；新手引导会保留，下次可以继续。'
        : this.activeChallenge
          ? '返回首页即视为放弃本次挑战，比分与奖励都不会记录。'
          : '返回首页后，本局进度不会保留。',
      confirmLabel: tutorialMode ? '返回首页' : '退出对局',
      cancelLabel: '继续本局',
      danger: true,
      onConfirm: () => {
        this.closeOverlay(overlay);
        if (tutorialMode) {
          this.leaveTutorialForHome();
        } else {
          this.showHome();
        }
      },
      onCancel: () => this.closeOverlay(overlay),
    });
    this.openOverlay(overlay, {
      focus: true,
      escape: () => this.closeOverlay(overlay),
    });
  }

  private showRules(): void {
    const overlay = createRulesOverlay(() => this.closeOverlay(overlay));
    this.openOverlay(overlay, {
      focus: true,
      escape: () => this.closeOverlay(overlay),
    });
  }

  /**
   * Author support overlay. Opening only queries follow status; the platform
   * follow call happens on the player's explicit "关注作者" tap. Both the close
   * control and Escape destroy the overlay before removing it, so a late
   * status/follow response cannot paint into a detached node.
   */
  private showAuthor(): void {
    const handle = createAuthorOverlay({
      author: this.platform.author,
      onClose: () => {
        handle.destroy();
        this.closeOverlay(handle.el);
      },
    });
    this.openOverlay(handle.el, {
      focus: true,
      escape: () => {
        handle.destroy();
        this.closeOverlay(handle.el);
      },
    });
  }

  /** Home settings sheet: local leaderboard preference + the destructive reset. */
  private showSettings(): void {
    const self = this;
    const stored = this.store.current();
    const handle = createSettingsOverlay({
      leaderboardOptIn: stored.leaderboardOptIn,
      onLeaderboardChange: (value) => {
        self.store.update({ leaderboardOptIn: value });
        handle.setLeaderboardOptIn(value);
        handle.setStatus('正在保存设置…', 'info');
        void self.store.flushWrites().then(function () {
          if (self.store.lastWriteOk()) handle.setStatus('', 'info');
          else handle.setStatus('当前环境无法保存设置，仅本次会话内有效。', 'error');
        });
      },
      onResetRequest: () => {
        if (self.resetInProgress || self.pendingDeletion) return;
        self.showResetConfirm();
      },
      soundEnabled: this.store.getSoundEnabled(),
      soundStatus: this.soundBus ? this.soundBus.statusText() : '音效不可用',
      onSoundChange: (enabled) => {
        const persisted = self.store.setSoundEnabled(enabled);
        if (self.soundBus) {
          self.soundBus.setEnabled(persisted);
          // A freshly enabled service still needs a gesture to start; say so
          // instead of implying that sound is already playing.
          handle.setSoundStatus && handle.setSoundStatus(self.soundBus.statusText());
        }
        handle.setStatus('正在保存设置…', 'info');
        void self.store.flushWrites().then(function () {
          if (self.store.lastWriteOk()) handle.setStatus('', 'info');
          else handle.setStatus('当前环境无法保存设置，仅本次会话内有效。', 'error');
        });
      },
      onClose: () => self.closeOverlay(handle.el),
    });
    this.openOverlay(handle.el, {
      focus: true,
      escape: () => self.closeOverlay(handle.el),
    });
  }

  /** Second, explicit confirmation before touching storage. */
  private showResetConfirm(): void {
    if (this.resetInProgress || this.pendingDeletion) return;
    const top = this.overlayStack[this.overlayStack.length - 1];
    // A rapid second tap must not stack two confirmations.
    if (top && top.el.className.indexOf('confirm-overlay') >= 0) return;
    const self = this;
    const overlay = createResetConfirmOverlay({
      onConfirm: () => {
        if (self.resetInProgress || self.pendingDeletion) return;
        self.closeOverlay(overlay);
        self.startReset();
      },
      onCancel: () => self.closeOverlay(overlay),
    });
    this.openOverlay(overlay, {
      focus: true,
      escape: () => self.closeOverlay(overlay),
    });
  }

  /**
   * Runs the wipe behind a non-interactive progress overlay. The participants
   * block writes and drain their queues first; one storage.removeMany call then
   * deletes every owned key across SDK/local/memory/cache. Resident state is
   * cleared only after the structured report says every medium succeeded.
   */
  private startReset(): void {
    if (this.resetInProgress || this.pendingDeletion) return;
    this.closeAllOverlays();
    const self = this;
    const progress = this.createResetProgressOverlay();
    this.openOverlay(progress.el, { focus: false, escape: null });
    void this.performReset(progress.message).then(function (result) {
      self.closeOverlay(progress.el);
      if (result.ok) {
        const notice = result.report.persistent
          ? undefined
          : '当前环境没有可用的持久化存储，已清除本次会话中的存档数据。';
        self.showProfileCreate(notice);
        return;
      }
      self.showResetFailure(result.report, result.error);
    });
  }

  /**
   * The deletion promise is retained even after the UI marks the result
   * unknown: a late success completes the reset, a late failure aborts it.
   * A retry is refused while it is unresolved, so two wipes never race.
   */
  private async performReset(messageNode: HTMLElement): Promise<
    | { ok: true; report: StorageRemoveReport }
    | { ok: false; report: StorageRemoveReport | null; error: string }
  > {
    this.resetInProgress = true;
    this.resetPhase = 'running';
    // Any hydration callback or queued challenge write captured the old epoch
    // and is now ignored, so it cannot resurrect pre-wipe data after success.
    this.resetEpoch += 1;
    const participants: ResetParticipant[] = [
      this.profiles,
      this.store,
      this.leaderboard,
    ];
    try {
      const drains: Array<Promise<void>> = [this.flushChallengeWrites()];
      for (let i = 0; i < participants.length; i += 1) {
        drains.push(participants[i].beginReset());
      }
      this.armResetUnknown(
        messageNode,
        '正在等待在途写入，结果尚未确定。请勿关闭、操作或开始新对局。'
      );
      await Promise.all(drains);
      // Every pre-wipe challenge write has landed; later tasks (if any slipped
      // through) must start from a fresh epoch.
      this.challengeWriteEpoch += 1;
      this.armResetUnknown(
        messageNode,
        '删除请求仍在处理中，结果未知。请勿关闭、操作或开始新对局；完成后会显示结果。'
      );
      const deletion = this.platform.storage.removeMany(RESET_STORAGE_KEYS);
      this.pendingDeletion = deletion;
      let report: StorageRemoveReport;
      try {
        report = await deletion;
      } finally {
        if (this.pendingDeletion === deletion) this.pendingDeletion = null;
        this.disarmResetDeadline();
      }
      if (!report.ok) {
        for (let i = 0; i < participants.length; i += 1) participants[i].abortReset();
        this.resetPhase = 'failed';
        this.recoverResidentState(false);
        return { ok: false, report: report, error: '' };
      }

      for (let i = 0; i < participants.length; i += 1) participants[i].completeReset();
      this.firstRunDefaultsPending = false;
      // Pre-wipe intents and the prompt decision belong to the old archive.
      this.settingsWaiters = [];
      this.settingsSettledWaiters = [];
      this.onboardingPromptShown = false;
      this.onboardingPromptOpen = false;
      if (this.settingsLoadingOverlay) {
        this.closeOverlay(this.settingsLoadingOverlay);
        this.settingsLoadingOverlay = null;
      }
      this.applyStoredSettings();
      this.profile = null;
      this.syncPlayerColorVars();
      this.profileCorrupted = false;
      this.lastChallengeCode = null;
      this.lastResultView = null;
      this.commandLog = [];
      this.activeChallenge = null;
      this.selectedId = null;
      this.matchMode = 'solo';
      this.resetPhase = 'idle';
      return { ok: true, report: report };
    } catch (error) {
      this.disarmResetDeadline();
      for (let i = 0; i < participants.length; i += 1) participants[i].abortReset();
      this.resetPhase = 'failed';
      this.recoverResidentState(false);
      return {
        ok: false,
        report: null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.disarmResetDeadline();
      this.resetInProgress = false;
    }
  }

  /**
   * Only the message changes on timeout. The reset promise keeps running so a
   * late deletion result can still finish or fail the wipe safely.
   */
  private armResetUnknown(messageNode: HTMLElement, text: string): void {
    this.disarmResetDeadline();
    const self = this;
    this.resetDeadlineTimer = window.setTimeout(function () {
      self.resetDeadlineTimer = null;
      if (!self.resetInProgress) return;
      self.resetPhase = 'unknown';
      setText(messageNode, text);
    }, RESET_DEADLINE_MS);
  }

  private disarmResetDeadline(): void {
    if (this.resetDeadlineTimer === null) return;
    window.clearTimeout(this.resetDeadlineTimer);
    this.resetDeadlineTimer = null;
  }

  /**
   * After an aborted wipe, a store that had not finished its first load must
   * not stay at null/default forever. Silent recovery keeps the failure dialog
   * on top; navigating recovery re-reads both stores and the challenge code.
   */
  private recoverResidentState(navigate: boolean): void {
    if (navigate) {
      this.hydrateSettings(true);
      this.hydrateProfile(true, true);
      this.hydrateChallengeCode();
      return;
    }
    if (!this.store.isLoaded()) this.hydrateSettings(false);
    if (!this.profiles.isLoaded()) this.hydrateProfile(false, false);
    this.hydrateChallengeCode();
  }

  private createResetProgressOverlay(): { el: HTMLElement; message: HTMLElement } {
    const parts = createOverlay('reset-progress-overlay');
    parts.card.className = 'overlay-card overlay-card-compact';
    parts.card.setAttribute('role', 'alertdialog');
    parts.card.setAttribute('aria-modal', 'true');
    parts.card.setAttribute('aria-busy', 'true');
    const kicker = el('p', 'overlay-kicker', 'RESETTING LOCAL DATA');
    const title = el('h2', 'overlay-title settings-reset-title', '正在清除本机存档');
    title.id = 'reset-progress-title';
    parts.card.setAttribute('aria-labelledby', title.id);
    const message = el(
      'p',
      'confirm-body settings-reset-progress',
      '正在等待在途写入并删除本机存档，请勿关闭、操作或开始新对局。'
    );
    parts.card.appendChild(kicker);
    parts.card.appendChild(title);
    parts.card.appendChild(message);
    return { el: parts.root, message: message };
  }

  private showResetFailure(report: StorageRemoveReport | null, error: string): void {
    const self = this;
    const detail = report ? this.describeResetFailures(report) : error || '清理过程中发生错误';
    const overlay = createConfirmOverlay({
      title: '清除未完成',
      body: detail,
      confirmLabel: '重试清除',
      cancelLabel: '取消',
      danger: false,
      onConfirm: () => {
        if (self.resetInProgress || self.pendingDeletion) return;
        self.closeOverlay(overlay);
        self.startReset();
      },
      onCancel: () => {
        self.closeOverlay(overlay);
        self.recoverResidentState(true);
      },
    });
    this.openOverlay(overlay, {
      focus: true,
      escape: () => {
        self.closeOverlay(overlay);
        self.recoverResidentState(true);
      },
    });
  }

  private describeResetFailures(report: StorageRemoveReport): string {
    const sdk: string[] = [];
    const local: string[] = [];
    for (let i = 0; i < report.failures.length; i += 1) {
      const failure = report.failures[i];
      const target = failure.medium === 'sdk' ? sdk : local;
      const label = RESET_KEY_LABELS[failure.key] || failure.key;
      if (target.indexOf(label) < 0) target.push(label);
    }
    const parts: string[] = [];
    if (sdk.length > 0) {
      parts.push(
        report.sdk === 'unknown'
          ? '平台存储（SDK，客户端版本未知，未能确认是否清除）：' + sdk.join('、')
          : '平台存储（SDK）：' + sdk.join('、')
      );
    }
    if (local.length > 0) parts.push('本地存储：' + local.join('、'));
    if (parts.length === 0) return '未能完全清除本机存档，请重试。';
    return (
      (report.sdk === 'unknown' ? '以下位置未能确认清除：' : '以下位置未能删除：') +
      parts.join('；') +
      '。为避免误报，未显示清除成功。其他应用的数据未受影响，请重试清除。'
    );
  }

  private async flushChallengeWrites(): Promise<void> {
    await this.challengeWriteChain;
  }

  /** Session memory + best-effort persistence; a failed write keeps the code. */
  private rememberChallengeCode(code: string): void {
    this.lastChallengeCode = code;
    // A new write cannot start once the wipe owns the screen; queued writes
    // from before it are drained (and then deleted) by performReset().
    if (this.resetInProgress) return;
    const storage = this.platform.storage;
    const self = this;
    const epoch = this.challengeWriteEpoch;
    this.challengeWriteChain = this.challengeWriteChain
      .then(function () {
        if (epoch !== self.challengeWriteEpoch) return false;
        return storage.write(LAST_CHALLENGE_KEY, code).catch(function () {
          return false;
        });
      })
      .then(
        function () {
          return undefined;
        },
        function () {
          return undefined;
        }
      );
  }

  private showFatal(message: string, retry?: () => void): void {
    const overlay = createConfirmOverlay({
      title: '无法开始对局',
      body: '战场配置未能载入：' + message,
      confirmLabel: '重新尝试',
      cancelLabel: '返回首页',
      danger: false,
      onConfirm: () => {
        this.closeOverlay(overlay);
        if (retry) retry();
        else this.startMatch();
      },
      onCancel: () => {
        this.closeOverlay(overlay);
        this.showHome();
      },
    });
    this.openOverlay(overlay, {
      focus: true,
      escape: () => this.closeOverlay(overlay),
    });
  }

  private finishMatch(view: MatchView): void {
    // Settlement is a single transition even if a queued frame or a manual
    // end signal reaches the shell twice.
    if (this.resultShown) return;
    this.matchStarted = false;
    this.resultShown = true;
    this.endHoldSince = null;
    this.stopLoop();
    this.closeAllOverlays();
    // The engine verdict/score share is the only source for the fanfare: a
    // versus draw plays neither cue rather than guessing a winner.
    const playerWon =
      view.mode === 'versus'
        ? view.scores.player > view.scores.ai1
        : view.result === 'win';
    const playerLost =
      view.mode === 'versus'
        ? view.scores.player < view.scores.ai1
        : view.result === 'lose';
    if (this.soundBus) {
      // The bus dedupes by the current frame token, so two versus panes can
      // never double-play the same ending cue.
      if (playerWon) this.soundBus.play('victory');
      else if (playerLost) this.soundBus.play('defeat');
    }
    // Read the real skill level before the session is torn down. A missing
    // skill is not treated as a successful Lv.0 record; the archive is skipped.
    const matchSkill = this.game ? this.game.hudState().skill : null;
    const matchBetrayalLevel =
      matchSkill &&
      typeof matchSkill.betrayalLevel === 'number' &&
      isFinite(matchSkill.betrayalLevel)
        ? matchSkill.betrayalLevel
        : null;
    this.lastResultView = {
      status: view.status,
      tick: view.tick,
      durationTicks: view.durationTicks,
      endReason: view.endReason,
      lastProgressTick: view.lastProgressTick,
      stalemateWarned: view.stalemateWarned,
      diplomacy: view.diplomacy,
      mapId: view.mapId,
      mapName: view.mapName,
      mapWidth: view.mapWidth,
      mapHeight: view.mapHeight,
      difficulty: view.difficulty,
      mode: view.mode,
      seed: view.seed,
      territories: view.territories,
      edges: view.edges,
      armies: view.armies,
      result: view.result,
      scores: view.scores,
      territoryCounts: view.territoryCounts,
      stats: view.stats,
      // v1.4.0 seating metadata travels with the retained result view.
      factionCount: view.factionCount,
      activeOwners: view.activeOwners,
      aliveOwners: view.aliveOwners,
      boundaries: view.boundaries,
      geography: view.geography,
      geog: view.geog,
    };

    const mode: MatchMode = view.mode === 'versus' ? 'versus' : 'solo';
    const settlement = settlementPolicy(mode);
    // Total seated factions of the finished match (old views read as 2).
    const matchFactionCount = normalizeFactionCount(view.factionCount, 2);
    // "Enemy score" keeps its historical meaning per family: the posted target
    // for a challenge, and for a plain match the STRONGEST single opponent —
    // identical to the old ai1+ai2 sum in a 2-faction match, and the honest
    // per-faction comparison for 3/4 factions (the AIs never pool their score).
    const enemyScore =
      Math.max(view.scores.ai1 || 0, view.scores.ai2 || 0, view.scores.ai3 || 0);
    const challenge = mode === 'versus' ? null : this.activeChallenge;
    const challengeContext = mode === 'versus' ? null : this.activeChallengeContext;
    const speedAtStart: MatchSpeed = this.speedRecord ? this.speedRecord.initial : 1;
    const speedChanged = this.speedRecord ? this.speedRecord.changed : false;
    const speedNow: MatchSpeed = this.speedRecord ? this.speedRecord.current : 1;
    const betrayalLevel = matchBetrayalLevel === null ? 0 : matchBetrayalLevel;
    const diplomacyUsed = !!view.diplomacy && (view.diplomacy.uses || 0) > 0;
    const resigned = view.endReason === 'resign';

    // Two independent questions:
    //   1. May THIS match be judged against the accepted code's score?
    //   2. May THIS match mint a new (fair) code?
    // (1) requires the code itself to be comparable AND the match to have kept
    // that code's rules: same fixed speed, no mid-match change, current rules
    // version, no skill use. Anything else is settled as an ordinary solo game.
    const codeSpeed =
      challengeContext && typeof challengeContext.speed === 'number'
        ? challengeContext.speed
        : null;
    const codeVersion =
      challengeContext && typeof challengeContext.rulesVersion === 'number'
        ? challengeContext.rulesVersion
        : null;
    // Seat-count agreement: a code is only comparable when the match actually
    // ran with the count the accepted code stated. A v3 context that lost its
    // count is NEVER promoted to comparable (no silent "treat as 2"); a v1.2
    // context without the optional field keeps its historical comparability.
    const contextCountStated =
      challengeContext && challengeContext.factionCount !== undefined
        ? normalizeFactionCount(challengeContext.factionCount, 2)
        : null;
    const factionCountAgrees =
      challengeContext !== null &&
      challengeContext.family === 'v3'
        ? contextCountStated !== null && contextCountStated === matchFactionCount
        : contextCountStated === null || contextCountStated === matchFactionCount;
    const comparableChallenge =
      challenge !== null &&
      !!challengeContext &&
      challengeContext.comparable === true &&
      challengeContext.fairness === 'fair' &&
      (challengeContext.family === 'v2' || challengeContext.family === 'v3') &&
      codeVersion === CHALLENGE_RULES_VERSION &&
      codeSpeed !== null &&
      isMatchSpeed(codeSpeed) &&
      codeSpeed === speedAtStart &&
      !speedChanged &&
      speedNow === speedAtStart &&
      betrayalLevel === 0 &&
      !diplomacyUsed &&
      !resigned &&
      factionCountAgrees;
    // In challenge mode the AI match still runs to completion, but only a
    // comparable code takes its verdict from the posted score. Versus keeps the
    // engine verdict on the blue (player) side: win = blue, lose = red.
    const resultKind = resigned
      ? 'lose'
      : comparableChallenge
        ? compareChallengeScore(view.scores.player, challenge.score)
        : view.result || 'draw';

    // One settlement decision for the whole result: what this match may publish
    // and whether it may be ranked. Pure inputs only (mode, skill, speed).
    const eligibility: CodeEligibility = evaluateCodeEligibility(
      {
        mode: mode,
        betrayalLevel: betrayalLevel,
        speedChanged: speedChanged,
        initialSpeed: speedAtStart,
        challengeScore: challenge ? challenge.score : null,
        finished: !resigned,
        diplomacyUsed: diplomacyUsed,
        // v1.4.0: the minted code must carry the same seat count the match ran.
        factionCount: matchFactionCount,
      },
      { rulesVersion: CHALLENGE_RULES_VERSION, currentRulesVersion: CHALLENGE_RULES_VERSION }
    );
    const record: MatchRecord = {
      at: new Date().toISOString(),
      result: resultKind,
      mapName: view.mapName,
      themeId: view.mapId,
      difficulty: view.difficulty,
      durationSeconds: Math.round(view.durationTicks / 10),
      playerScore: view.scores.player,
      enemyScore: challenge ? challenge.score : enemyScore,
      elapsedSeconds: Math.floor(view.tick / 10),
      territories: view.territoryCounts.player,
      mode: mode,
      // v1.4.0 per-faction settlement: the match size plus every faction's
      // final score. playerScore/enemyScore keep their historical meanings
      // (enemyScore = strongest single opponent for a plain match).
      factionCount: matchFactionCount,
      factionScores: {
        player: view.scores.player,
        ai1: view.scores.ai1 || 0,
        ai2: view.scores.ai2 || 0,
        ai3: view.scores.ai3 || 0,
      },
      endReason: view.endReason,
      diplomacyUsed: diplomacyUsed ? true : undefined,
    };
    this.store.addRecord(record);

    // Local leaderboard settlement. Versus is never ranked; a challenge is
    // identified only by the accepted activeChallenge and carries its target.
    let leaderboardRecorded = false;
    let leaderboardRetained: boolean | undefined;
    let leaderboardWarning: string | null = null;
    if (mode !== 'versus' && matchBetrayalLevel !== null && !resigned && !diplomacyUsed) {
      // This match may only rank as a comparable challenge when BOTH hold:
      //   - the code itself was fair and accepted as comparable;
      //   - this run kept that code's rules (checked above).
      // A legacy SC / practice code can never be promoted to a fixed row even
      // when the player changed nothing, so `fairness` is the intersection.
      const submissionFairness: 'fair' | 'practice' =
        challenge !== null
          ? comparableChallenge
            ? 'fair'
            : 'practice'
          : eligibility.fairness;
      const entry = this.leaderboard.record(view, {
        nickname: this.profile ? this.profile.nickname : '',
        avatarId: this.profile ? this.profile.avatarId : undefined,
        matchKind: challenge ? 'challenge' : 'solo',
        betrayalLevel: matchBetrayalLevel,
        challengeScore: challenge ? challenge.score : undefined,
        speed: speedAtStart,
        speedChanged: speedChanged,
        rulesVersion: CHALLENGE_RULES_VERSION,
        fairness: submissionFairness,
        // v1.4.0: rows are grouped by seat count; the store refuses a record
        // when this value and the match view disagree, so a lost count can
        // never be silently settled as a two-faction row.
        factionCount: matchFactionCount,
      });
      if (entry.ok) {
        leaderboardRecorded = true;
        leaderboardRetained = entry.retained !== false && entry.evicted !== true;
        if (!leaderboardRetained) {
          leaderboardWarning =
            entry.evicted === true
              ? '本局成绩已完成，但本机榜单容量已满，本局未能保留在榜单中（仍保留在最近战绩）。'
              : '本局成绩已完成，但未进入本机榜单前列（同组记录已满），仅保留在最近战绩中。';
        }
      } else if (
        entry.reason === 'storage_unavailable' ||
        entry.reason === 'storage_corrupt'
      ) {
        leaderboardWarning = '本机排行榜当前不可用，本局未入榜。';
      }
    }
    // Rewards are applied once per finished match, before the result screen is
    // built so the card can show both the gain and the new balance. Versus earns
    // no gold and never touches the solo win/loss archive, so it skips the
    // award entirely (ProfileStore.awardGold always recounts stats). A speed
    // change voids a challenge verdict: the match is practice, so it awards as
    // an ordinary solo result rather than against the posted score. A voluntary
    // resign (solo or challenge) still records the loss but earns nothing;
    // elimination/timeout/stalemate results keep the ordinary reward path.
    const progression = settlement.awardGold
      ? this.profiles.settleMatch(
          comparableChallenge ? resultKind : view.result || 'draw',
          view.difficulty,
          'solo',
          { rewardable: !resigned }
        )
      : {
          gold: 0,
          experience: 0,
          totalExperience: this.profile ? this.profile.experience || 0 : 0,
          level: this.profile ? this.profile.commanderLevel || 1 : 1,
          levelsGained: 0,
        };
    // New ProfileStore settlements expose ok; the structural fallback keeps
    // older stores compatible while never claiming a blocked reward as saved.
    const progressionSettled =
      (progression as unknown as { ok?: boolean }).ok !== false;
    const goldEarned = progressionSettled ? progression.gold : 0;
    this.profile = this.profiles.current();
    const totalGold = this.profile ? this.profile.gold : 0;

    let challengeCode = '';
    if (settlement.issueChallengeCode && eligibility.codeAllowed && !resigned) {
      try {
        // v1.4.0 families: a 2-faction match mints the historical v2 (SV) code;
        // a 3/4-faction match mints the SM code, which states its own count so
        // the receiving client seats the same battlefield shape. Both stamp the
        // fixed speed, rules version and comparability; a practice match still
        // gets a code so it can be replayed, but never a comparable one.
        const codeFields = {
          seed: view.seed,
          durationSeconds: Math.round(view.durationTicks / 10),
          difficulty: view.difficulty,
          score: view.scores.player,
          result: resultKind,
          speed: speedAtStart,
          rulesVersion: CHALLENGE_RULES_VERSION,
          fairness: eligibility.fairness,
        };
        challengeCode =
          eligibility.factionCount >= 3
            ? encodeChallengeV3({
                ...codeFields,
                factionCount: matchFactionCount,
              })
            : encodeChallengeV2(codeFields);
        this.rememberChallengeCode(challengeCode);
      } catch (error) {
        // Encoding can only reject engine-impossible values; never block the
        // result screen over a shareable-code convenience.
        challengeCode = '';
      }
    }

    const share = this.platform.share;
    const result = createResultScreen(view, {
      onRestart: () => this.startMatch(),
      onHome: () => this.showHome(),
      share: {
        renderPoster: function (model) {
          return share.renderPoster(model);
        },
        saveImage: function (dataUrl) {
          return share.saveImage(dataUrl);
        },
        postNote: function (dataUrl, title, text) {
          return share.postNote(dataUrl, title, text);
        },
        capabilities: function () {
          return share.capabilities();
        },
      },
      mapView: view,
      dateLabel: isoDateLabel(new Date()),
      playerColorId: this.matchPlayerColorId,
      challenge: challenge
        ? {
            playerScore: view.scores.player,
            challengeScore: challenge.score,
            verdict: resultKind,
            gold: goldEarned,
            // v1.2: a legacy/practice code, or a run that broke the code's
            // rules, is settled as an ordinary solo match and never claims a
            // verdict against the challenger.
            comparable: comparableChallenge,
            family: challengeContext ? challengeContext.family : 'legacy',
            speed:
              challengeContext && typeof challengeContext.speed === 'number'
                ? challengeContext.speed
                : speedAtStart,
            rulesVersion:
              challengeContext && typeof challengeContext.rulesVersion === 'number'
                ? challengeContext.rulesVersion
                : 0,
            // The intersection, never just the code's own claim: a fair code
            // played at another pace is a practice result here.
            fairness: comparableChallenge ? 'fair' : 'practice',
            practiceReason: comparableChallenge
              ? null
              : this.practiceReason(
                  challengeContext,
                  speedChanged,
                  matchBetrayalLevel,
                  diplomacyUsed,
                  resigned
                ),
            notice: challengeContext ? challengeContext.notice : null,
          }
        : null,
      challengeCode: challengeCode || null,
      challengeCodeFairness: challengeCode ? eligibility.fairness : null,
      challengeCodeNotice: challengeCode ? eligibility.notice || null : null,
      reward: {
        gold: goldEarned,
        totalGold: totalGold,
        experience: progressionSettled ? progression.experience : 0,
        totalExperience: progression.totalExperience,
        level: progression.level,
        levelsGained: progressionSettled ? progression.levelsGained : 0,
        settled: progressionSettled,
        mode: mode,
      },
    });
    this.teardownGame();
    this.setMode('result');
    this.setScreen(result);
    if (!this.profiles.lastWriteOk()) {
      result.appendChild(this.saveWarningNode('result-save-warning'));
    }
    if (leaderboardWarning) {
      result.appendChild(
        this.saveWarningNode('result-leaderboard-warning', leaderboardWarning)
      );
    }
    if (leaderboardRecorded) {
      const self = this;
      const showLeaderboardWarning = function (): void {
        if (self.leaderboard.lastWriteOk()) return;
        if (self.currentScreen !== result) return;
        result.appendChild(
          self.saveWarningNode(
            'result-leaderboard-warning',
            '本机排行榜未能写入存储，本局排名仅在本次会话内可见。'
          )
        );
      };
      void this.leaderboard.flushWrites().then(
        showLeaderboardWarning,
        showLeaderboardWarning
      );
    }
  }

  /** Why a challenge was settled as practice (never shown for a fair code). */
  private practiceReason(
    context: ChallengeStartContext | null,
    speedChanged: boolean,
    betrayalLevel: number | null,
    diplomacyUsed: boolean,
    resigned: boolean
  ): string | null {
    if (resigned) return '本局已认输，按负局结算，不与挑战分数比较。';
    if (diplomacyUsed) return '本局使用过外交，按练习处理，不比较比分。';
    if (!context) return '挑战码信息不完整，按练习处理。';
    if (context.family === 'legacy') {
      return '旧版挑战码未记录速度与规则版本，本局按同图练习处理，不比较比分。';
    }
    if (speedChanged) return '本局中途切换过速度，按练习处理，不比较比分。';
    if (betrayalLevel !== null && betrayalLevel > 0) {
      return '本局启用策反，规则与公平挑战不同，按练习处理。';
    }
    if (
      typeof context.rulesVersion === 'number' &&
      context.rulesVersion !== CHALLENGE_RULES_VERSION
    ) {
      return '挑战码规则版本与本机不一致，按练习处理。';
    }
    return context.notice || '本局按练习处理，不比较比分。';
  }

  private openOverlay(
    overlay: HTMLElement,
    options: { focus: boolean; escape: (() => void) | null }
  ): void {
    if (this.overlayStack.length === 0) {
      this.lastFocused = document.activeElement as HTMLElement | null;
    }
    this.overlayHost.appendChild(overlay);
    const entry: OverlayEntry = {
      el: overlay,
      escape: options.escape,
      focus: options.focus,
    };
    this.overlayStack.push(entry);
    void overlay.offsetWidth;
    overlay.classList.add('is-visible');
    if (options.focus) this.focusFirst(overlay);
  }

  private closeOverlay(overlay: HTMLElement): void {
    let index = -1;
    for (let i = 0; i < this.overlayStack.length; i += 1) {
      if (this.overlayStack[i].el === overlay) {
        index = i;
        break;
      }
    }
    if (index < 0) return;
    this.overlayStack.splice(index, 1);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    const top = this.overlayStack[this.overlayStack.length - 1];
    if (top) {
      if (top.focus) this.focusFirst(top.el);
      return;
    }
    if (this.lastFocused && this.lastFocused.isConnected) {
      try {
        this.lastFocused.focus();
      } catch (error) {
        // Focus restoration is best effort.
      }
    }
    this.lastFocused = null;
  }

  private closeAllOverlays(): void {
    this.pauseOverlay = null;
    this.truceOfferOverlay = null;
    for (let i = 0; i < this.overlayStack.length; i += 1) {
      const overlay = this.overlayStack[i].el;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    this.overlayStack = [];
    this.lastFocused = null;
  }

  private focusFirst(overlay: HTMLElement): void {
    const preferred = overlay.querySelector('[data-autofocus]') as HTMLElement | null;
    const fallback = overlay.querySelector('button:not([disabled])') as HTMLElement | null;
    const target = preferred || fallback;
    if (!target) return;
    try {
      target.focus();
    } catch (error) {
      // Focus is best effort.
    }
  }

  private logCommand(entry: CommandLogEntry): void {
    this.commandLog.push(entry);
    if (this.commandLog.length > 120) this.commandLog.shift();
  }
}
