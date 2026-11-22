import { TICKS_PER_SECOND } from '../config/balance';
import { button, clear, el, setText } from './dom';
import { createOverlay } from './overlay';

interface TutorialStep {
  kicker: string;
  title: string;
  body: string;
  visual: () => HTMLElement;
}

function chargeVisual(): HTMLElement {
  const wrap = el('div', 'tut-visual');
  const ring = el('div', 'tut-ring');
  ring.appendChild(el('span', 'tut-ring-value', '60%'));
  ring.appendChild(el('span', 'tut-ring-note', '按住 0.5 秒'));
  wrap.appendChild(ring);
  return wrap;
}

function dragVisual(): HTMLElement {
  const wrap = el('div', 'tut-visual tut-visual-tiles');
  const source = el('span', 'tut-tile tut-tile-source', '38');
  const arrow = el('span', 'tut-arrow', '');
  arrow.setAttribute('aria-hidden', 'true');
  const good = el('span', 'tut-tile tut-tile-good', '26');
  const bad = el('span', 'tut-tile tut-tile-bad', '35');
  wrap.appendChild(source);
  wrap.appendChild(arrow);
  wrap.appendChild(good);
  wrap.appendChild(bad);
  return wrap;
}

function holdVisual(): HTMLElement {
  const wrap = el('div', 'tut-visual tut-visual-stats');
  const production = el('div', 'tut-stat');
  production.appendChild(el('b', '', '产兵'));
  production.appendChild(el('span', '', '10'));
  const march = el('div', 'tut-stat');
  march.appendChild(el('b', '', '行军'));
  march.appendChild(el('span', '', '1.2×'));
  const defense = el('div', 'tut-stat is-accent');
  defense.appendChild(el('b', '', '城防'));
  defense.appendChild(el('span', '', '城墙'));
  wrap.appendChild(production);
  wrap.appendChild(march);
  wrap.appendChild(defense);
  return wrap;
}

const STEPS: TutorialStep[] = [
  {
    kicker: 'STEP 01 · 蓄力',
    title: '按住己方领地',
    body: '按得越久，派得越多；系统自动留下驻军。',
    visual: chargeVisual,
  },
  {
    kicker: 'STEP 02 · 拖动',
    title: '拖向己方接壤的领地',
    body: '拖动锁定比例，松手出兵；空白处取消不扣兵。',
    visual: dragVisual,
  },
  {
    kicker: 'STEP 03 · 升级',
    title: '产兵 / 行军 / 城防',
    body: '选中己方领地，用驻军三选一升级；城防可挡兵，炮台自动炮击。',
    visual: holdVisual,
  },
];

export interface TutorialParts {
  el: HTMLElement;
  destroy(): void;
}

export function createTutorialOverlay(onDone: () => void): TutorialParts {
  const parts = createOverlay('tutorial-overlay');
  parts.card.setAttribute('role', 'dialog');
  parts.card.setAttribute('aria-modal', 'true');
  parts.card.setAttribute('aria-labelledby', 'tutorial-title');

  const top = el('div', 'tutorial-top');
  const count = el('span', 'tutorial-count', '01 / 03');
  const skip = button('跳过教学', 'text-link tutorial-skip', finish);
  top.appendChild(count);
  top.appendChild(skip);

  const visualHost = el('div', 'tutorial-visual-host');
  const kicker = el('p', 'tutorial-kicker', STEPS[0].kicker);
  const title = el('h2', 'tutorial-title', STEPS[0].title);
  title.id = 'tutorial-title';
  const body = el('p', 'tutorial-body', STEPS[0].body);

  const dots = el('div', 'tutorial-dots');
  for (let i = 0; i < STEPS.length; i += 1) {
    dots.appendChild(el('span', 'tutorial-dot' + (i === 0 ? ' is-active' : '')));
  }

  const footer = el('footer', 'tutorial-footer');
  const next = button('下一步', 'btn btn-primary tutorial-next', advance);

  parts.card.appendChild(top);
  parts.card.appendChild(visualHost);
  parts.card.appendChild(kicker);
  parts.card.appendChild(title);
  parts.card.appendChild(body);
  parts.card.appendChild(dots);
  parts.card.appendChild(footer);
  footer.appendChild(next);

  let step = 0;
  let finished = false;

  function render(): void {
    const current = STEPS[step];
    parts.card.setAttribute('data-step', String(step + 1));
    setText(count, '0' + (step + 1) + ' / 03');
    setText(kicker, current.kicker);
    setText(title, current.title);
    setText(body, current.body);
    setText(next, step === STEPS.length - 1 ? '开始对战' : '下一步');
    next.setAttribute('aria-label', step === STEPS.length - 1 ? '开始对战' : '下一步');
    clear(visualHost);
    visualHost.appendChild(current.visual());
    const dotNodes = dots.children;
    for (let i = 0; i < dotNodes.length; i += 1) {
      const dot = dotNodes[i] as HTMLElement;
      dot.className = 'tutorial-dot' + (i === step ? ' is-active' : '');
    }
  }

  function advance(): void {
    if (step < STEPS.length - 1) {
      step += 1;
      render();
      return;
    }
    finish();
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    onDone();
  }

  render();

  return {
    el: parts.root,
    destroy: function () {
      finished = true;
    },
  };
}

/*
 * -------------------------------------------------------------------------
 * Interactive tutorial controller (v1.3)
 * -------------------------------------------------------------------------
 *
 * The legacy `createTutorialOverlay` above is a three-card briefing and cannot
 * observe a real match. The controller below is the replacement: it only
 * advances on receipts produced by real commands/events, never on a "next"
 * button. The shell owns the simulation and tells the controller:
 *
 *   - accepted command receipts (`reportMove`, `reportUpgrade`);
 *   - real ownership events (`reportCapture`);
 *   - real elapsed simulation ticks (`notifyTick`);
 *   - a no-AI gate (`getGate()` / `onGate`) so it can decide whether to call
 *     `game.tick()` on a frame and whether that tick may run the AI.
 *
 * `frozen` means "do not advance simulation ticks on this frame". It NEVER
 * means `game.pause()`: a paused core rejects the player's moves. Keeping the
 * match `playing` while the shell skips `tick()` is what lets a real drag
 * complete while the tutorial waits for the player.
 */

export const TUTORIAL_STEPS = [
  'dispatch',
  'capture',
  'upgrade',
  'attack',
  'freeplay',
  'complete',
] as const;

export type TutorialStepId = (typeof TUTORIAL_STEPS)[number];
export const TUTORIAL_STEP_COUNT = TUTORIAL_STEPS.length;

export type TutorialPhase =
  | 'idle'
  | 'intro'
  | 'active'
  | 'freeplay'
  | 'complete'
  | 'skipped'
  | 'done'
  | 'destroyed';

/** Owners a real core event can report; only `player` advances the tutorial. */
export type TutorialOwner = 'player' | 'ai1' | 'ai2' | 'ai3' | 'neutral';

/**
 * `hold`   - do not tick (match may already be playing; status is untouched)
 * `guided` - tick the real simulation, but suppress AI
 * `live`   - normal match tick, AI enabled
 */
export type TutorialGateMode = 'hold' | 'guided' | 'live';

export type TutorialGateReason =
  | 'idle'
  | 'intro'
  | 'dispatch'
  | 'capture'
  | 'upgrade-wait'
  | 'upgrade-ready'
  | 'attack-wait'
  | 'attack-ready'
  | 'attack-pending'
  | 'reinforcement-pending'
  | 'freeplay'
  | 'complete'
  | 'released';

/**
 * Scenario-specific ids and copy. Every id comes from the caller (normally the
 * map/spawn config); this module never contains a real map id.
 */
export interface TutorialScenario {
  /** Owned territory the first drag starts from (for example the home cell). */
  initialSourceId: string;
  /** Neutral/frontier cell the first drag targets. */
  initialTargetId: string;
  /** Defaults to `initialTargetId`. */
  captureTargetId?: string;
  /** Defaults to `initialSourceId`. */
  upgradeTerritoryId?: string;
  /** Defaults to `captureTargetId` (the newly captured front cell). */
  attackSourceId?: string;
  /** The only enemy target that satisfies the attack step (never the rear). */
  enemyTargetId: string;
  /** Optional readable names used in copy and accessible labels. */
  initialSourceName?: string;
  initialTargetName?: string;
  upgradeTerritoryName?: string;
  attackSourceName?: string;
  enemyTargetName?: string;
  /**
   * Optional minimum accepted `sent` for the attack receipt. A lower receipt
   * is acknowledged (the order is real) but does not complete the step; the
   * controller asks the shell to keep ticking without AI until enough troops
   * exist, so a player who drags too little is never hard-stuck.
   */
  minimumAttackSent?: number;
}

export interface TutorialMoveReceipt {
  /** Must be the core's real return value. */
  accepted: boolean;
  sourceId: string;
  targetId: string;
  owner?: TutorialOwner;
  /** Real sent troops, when available (used for the attack readiness guard). */
  sent?: number;
}

export interface TutorialCaptureReceipt {
  targetId: string;
  owner: TutorialOwner;
}

export interface TutorialUpgradeReceipt {
  accepted: boolean;
  territoryId: string;
  kind?: string;
}

/** Screen-space box relative to the controller layer's top-left corner. */
export interface TutorialAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Optional real outline (ring order, same coordinate space). When present
   * the highlight follows these vertices instead of the bounding box, so an
   * irregular territory is never approximated by a rectangle.
   */
  points?: Array<[number, number]>;
}

export interface TutorialGate {
  mode: TutorialGateMode;
  /** When true the shell's frame step must not call `game.tick()`. */
  frozen: boolean;
  /** When true the shell should advance the simulation with AI disabled. */
  aiSuppressed: boolean;
  reason: TutorialGateReason;
}

export interface TutorialState {
  phase: TutorialPhase;
  step: TutorialStepId;
  /** 1-based index in `TUTORIAL_STEPS` (complete is the sixth entry). */
  stepIndex: number;
  stepCount: number;
  targetId: string | null;
  sourceId: string | null;
  canSkip: boolean;
  frozen: boolean;
  aiSuppressed: boolean;
  mode: TutorialGateMode;
  freePlayRemainingTicks: number | null;
  upgradeReady: boolean;
  attackReady: boolean;
  /** True after an accepted attack order, until the real capture arrives. */
  attackIssued: boolean;
  /** True after an accepted home -> front reinforcement order. */
  reinforcementIssued: boolean;
}

export interface TutorialCallbacks {
  /** Called once when the player leaves the intro and starts the tutorial. */
  onStart?: () => void;
  /** Called at most once per run; the shell should cancel any live drag. */
  onSkip?: () => void;
  /** Called at most once per run when the completion page is confirmed. */
  onComplete?: () => void;
  /** Called on phase/step/readiness changes (not every free-play tick). */
  onStep?: (state: TutorialState) => void;
  /** Called whenever the simulation gate changes. */
  onGate?: (gate: TutorialGate) => void;
  /** Called when the highlighted target changes; focus/pan there if needed. */
  onFocus?: (targetId: string | null) => void;
}

export interface TutorialOptions {
  /** Optional mount host. The shell can also call `mount(root)` later. */
  root?: HTMLElement;
  /**
   * Optional document-flow host for the active-step banner. The shell mounts it
   * between the dispatch bar and the map wrapper, so the prompt never covers
   * the canvas. Without a host the card keeps the legacy in-layer fallback.
   */
  bannerHost?: HTMLElement;
  scenario: TutorialScenario;
  callbacks?: TutorialCallbacks;
  /** Real simulation ticks of free play. Defaults to 8 seconds. */
  freePlayTicks?: number;
  /**
   * Optional convenience resolver. The shell may instead push a box with
   * `setTargetAnchor()` whenever its camera/viewport changes.
   */
  resolveAnchor?: (targetId: string) => TutorialAnchor | null;
  /** Real upgrade affordability probe used while the upgrade step waits. */
  isUpgradeAffordable?: (territoryId: string) => boolean;
  /** Real attack readiness probe used while the attack step waits. */
  isAttackReady?: (sourceId: string, targetId: string) => boolean;
  /**
   * Real in-flight probe. Return true while any player army from the given
   * source to target is still travelling. The controller keeps the gate
   * unfrozen while this is true, so a reinforcement or attack can never be
   * paused halfway. When it turns false, the controller can return to the
   * attack guidance (or expose the retry path after a failed attack).
   *
   * The controller always asks about one concrete route; implement it from
   * `view().armies` (owner === 'player', matching source/target).
   */
  hasOngoingArmies?: (sourceId: string, targetId: string) => boolean;
}

export const DEFAULT_FREE_PLAY_SECONDS = 8;
export const DEFAULT_FREE_PLAY_TICKS = Math.round(
  DEFAULT_FREE_PLAY_SECONDS * TICKS_PER_SECOND
);

const STEP_LABEL: Record<TutorialStepId, string> = {
  dispatch: '拖动出兵',
  capture: '确认占领',
  upgrade: '升级领地',
  attack: '攻击敌人',
  freeplay: '自由实战',
  complete: '完成',
};

let nextTutorialUid = 1;

function tutorialStepIndex(step: TutorialStepId): number {
  const index = TUTORIAL_STEPS.indexOf(step);
  return index < 0 ? 1 : index + 1;
}

function readId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('TutorialScenario.' + field + ' must be a non-empty id');
  }
  return value.trim();
}

function readName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeScenario(raw: TutorialScenario): TutorialScenario {
  if (!raw || typeof raw !== 'object') {
    throw new Error('TutorialScenario is required');
  }
  const initialSourceId = readId(raw.initialSourceId, 'initialSourceId');
  const initialTargetId = readId(raw.initialTargetId, 'initialTargetId');
  const enemyTargetId = readId(raw.enemyTargetId, 'enemyTargetId');
  const captureTargetId =
    raw.captureTargetId === undefined
      ? initialTargetId
      : readId(raw.captureTargetId, 'captureTargetId');
  const upgradeTerritoryId =
    raw.upgradeTerritoryId === undefined
      ? initialSourceId
      : readId(raw.upgradeTerritoryId, 'upgradeTerritoryId');
  const attackSourceId =
    raw.attackSourceId === undefined
      ? captureTargetId
      : readId(raw.attackSourceId, 'attackSourceId');
  if (initialSourceId === initialTargetId) {
    throw new Error('TutorialScenario source and target must differ');
  }
  if (attackSourceId === enemyTargetId) {
    throw new Error('TutorialScenario attack source and enemy target must differ');
  }
  let minimumAttackSent: number | undefined;
  if (raw.minimumAttackSent !== undefined) {
    if (
      typeof raw.minimumAttackSent !== 'number' ||
      !isFinite(raw.minimumAttackSent) ||
      raw.minimumAttackSent <= 0
    ) {
      throw new Error('TutorialScenario.minimumAttackSent must be positive');
    }
    minimumAttackSent = Math.floor(raw.minimumAttackSent);
  }
  return {
    initialSourceId: initialSourceId,
    initialTargetId: initialTargetId,
    captureTargetId: captureTargetId,
    upgradeTerritoryId: upgradeTerritoryId,
    attackSourceId: attackSourceId,
    enemyTargetId: enemyTargetId,
    initialSourceName: readName(raw.initialSourceName),
    initialTargetName: readName(raw.initialTargetName),
    upgradeTerritoryName: readName(raw.upgradeTerritoryName),
    attackSourceName: readName(raw.attackSourceName),
    enemyTargetName: readName(raw.enemyTargetName),
    minimumAttackSent: minimumAttackSent,
  };
}

function normalizeFreePlayTicks(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FREE_PLAY_TICKS;
  const ticks = Math.floor(value);
  if (!isFinite(ticks) || ticks < 1) {
    throw new Error('freePlayTicks must be a positive integer');
  }
  return ticks;
}

function normalizeAnchor(anchor: TutorialAnchor | null): TutorialAnchor | null {
  if (!anchor) return null;
  const x = Number(anchor.x);
  const y = Number(anchor.y);
  const width = Number(anchor.width);
  const height = Number(anchor.height);
  if (
    !isFinite(x) ||
    !isFinite(y) ||
    !isFinite(width) ||
    !isFinite(height)
  ) {
    return null;
  }
  let points: Array<[number, number]> | undefined;
  if (Array.isArray(anchor.points)) {
    const valid: Array<[number, number]> = [];
    for (let i = 0; i < anchor.points.length; i += 1) {
      const point = anchor.points[i];
      if (!Array.isArray(point) || point.length < 2) continue;
      const px = Number(point[0]);
      const py = Number(point[1]);
      if (!isFinite(px) || !isFinite(py)) continue;
      valid.push([px, py]);
    }
    if (valid.length >= 3) points = valid;
  }
  return {
    x: x,
    y: y,
    width: Math.max(0, width),
    height: Math.max(0, height),
    points: points,
  };
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Creates an SVG node in the real namespace, while still working with the
 * minimal `document.createElement`-only stub the unit tests install.
 */
function svgElement(tag: string): Element {
  if (typeof document.createElementNS === 'function') {
    return document.createElementNS(SVG_NAMESPACE, tag);
  }
  return document.createElement(tag);
}

/**
 * `SVGElement.className` is a read-only animated string in browsers, so the
 * class attribute is authoritative; a plain-string className is mirrored for
 * the Node DOM stubs used by the tests.
 */
function setNodeClass(node: Element, value: string): void {
  node.setAttribute('class', value);
  const current = (node as unknown as { className?: unknown }).className;
  if (typeof current === 'string') {
    (node as unknown as { className: string }).className = value;
  }
}

/** Space-separated `x,y` pairs, rounded to one decimal for stable markup. */
function formatPoints(points: Array<[number, number]>): string {
  const out: string[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const x = Math.round(points[i][0] * 10) / 10;
    const y = Math.round(points[i][1] * 10) / 10;
    out.push(x + ',' + y);
  }
  return out.join(' ');
}

function safeCall<T extends unknown[]>(fn: ((...args: T) => void) | undefined, args: T): void {
  if (!fn) return;
  try {
    fn.apply(undefined, args);
  } catch (error) {
    // UI callbacks must never leave the tutorial state machine half-updated.
  }
}

function safeProbe<T extends unknown[]>(fn: ((...args: T) => boolean) | undefined, args: T, fallback: boolean): boolean {
  if (!fn) return fallback;
  try {
    return fn.apply(undefined, args) === true;
  } catch (error) {
    return fallback;
  }
}

export class TutorialController {
  readonly el: HTMLElement;

  private readonly callbacks: TutorialCallbacks;
  private readonly freePlayTicks: number;
  private readonly bannerHost: HTMLElement | null;
  private readonly resolveAnchorFn:
    | ((targetId: string) => TutorialAnchor | null)
    | null;
  private readonly upgradeAffordableFn:
    | ((territoryId: string) => boolean)
    | null;
  private readonly attackReadyFn:
    | ((sourceId: string, targetId: string) => boolean)
    | null;
  private readonly hasOngoingArmiesFn:
    | ((sourceId: string, targetId: string) => boolean)
    | null;
  private scenario: TutorialScenario;

  private readonly progressCount: HTMLElement;
  private readonly progressStep: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly banner: HTMLElement;
  private readonly bannerBody: HTMLElement;
  private readonly bannerSide: HTMLElement;
  private readonly highlight: Element;
  private readonly highlightShape: Element;
  private readonly card: HTMLElement;
  private readonly kickerNode: HTMLElement;
  private readonly titleNode: HTMLElement;
  private readonly bodyNode: HTMLElement;
  private readonly feedbackNode: HTMLElement;
  private readonly countdownNode: HTMLElement;
  private readonly footer: HTMLElement;
  private readonly liveStatus: HTMLElement;
  private readonly titleId: string;
  private readonly bodyId: string;

  private phase: TutorialPhase = 'idle';
  private step: TutorialStepId = 'dispatch';
  private hint: { text: string; tone: 'info' | 'warn' } | null = null;
  private manualAnchor: TutorialAnchor | null = null;

  private dispatchAchieved = false;
  private captureAchieved = false;
  private upgradeAchieved = false;
  private enemyAttackAchieved = false;

  private upgradeReady = false;
  private attackReady = false;
  private attackOrdered = false;
  private reinforcementOrdered = false;
  private freePlayRemaining = 0;
  private lastTick: number | null = null;

  private startFired = false;
  private skipFired = false;
  private completeFired = false;

  private destroyed = false;
  private emittedStateKey = '';
  private emittedGateKey = '';
  private emittedFocusKey = '';
  private footerKey = '';
  private lastFocusKey = '';

  constructor(options: TutorialOptions) {
    if (!options) throw new Error('TutorialOptions is required');
    this.scenario = normalizeScenario(options.scenario);
    this.callbacks = options.callbacks || {};
    this.freePlayTicks = normalizeFreePlayTicks(options.freePlayTicks);
    this.bannerHost = options.bannerHost || null;
    this.resolveAnchorFn = options.resolveAnchor || null;
    this.upgradeAffordableFn = options.isUpgradeAffordable || null;
    this.attackReadyFn = options.isAttackReady || null;
    this.hasOngoingArmiesFn = options.hasOngoingArmies || null;

    const uid = nextTutorialUid;
    nextTutorialUid += 1;
    this.titleId = 'tutorial-live-title-' + uid;
    this.bodyId = 'tutorial-live-body-' + uid;

    const root = el('div', 'tutorial-layer is-hidden');
    this.progress = el('div', 'tutorial-progress-row');
    const progress = this.progress;
    const progressCopy = el('div', 'tutorial-progress-copy');
    this.progressCount = el('span', 'tutorial-progress-count', '');
    this.progressStep = el('span', 'tutorial-progress-step', '');
    progressCopy.appendChild(this.progressCount);
    progressCopy.appendChild(this.progressStep);

    const self = this;
    this.skipButton = button(
      '跳过教学',
      'tutorial-skip tutorial-live-skip',
      function () {
        self.skip();
      }
    );
    this.skipButton.setAttribute(
      'aria-label',
      '跳过新手教学，直接进入对战'
    );
    progress.appendChild(progressCopy);
    progress.appendChild(this.skipButton);

    // The highlight is one SVG cover with a real polygon: an irregular
    // territory is outlined along its own ring instead of its bounding box.
    this.highlight = svgElement('svg');
    setNodeClass(this.highlight, 'tutorial-highlight is-hidden');
    this.highlight.setAttribute('aria-hidden', 'true');
    this.highlight.setAttribute('focusable', 'false');
    this.highlightShape = svgElement('polygon');
    setNodeClass(this.highlightShape, 'tutorial-highlight-shape');
    this.highlight.appendChild(this.highlightShape);

    this.card = el('div', 'tutorial-live-card');
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-labelledby', this.titleId);
    this.card.setAttribute('aria-describedby', this.bodyId);

    this.kickerNode = el('p', 'tutorial-live-kicker', '');
    this.titleNode = el('h2', 'tutorial-live-title', '');
    this.titleNode.id = this.titleId;
    this.bodyNode = el('p', 'tutorial-live-body', '');
    this.bodyNode.id = this.bodyId;
    this.feedbackNode = el('p', 'tutorial-live-feedback', '');
    this.feedbackNode.setAttribute('role', 'note');
    this.countdownNode = el('p', 'tutorial-live-countdown is-hidden', '');
    this.footer = el('footer', 'tutorial-live-footer');
    this.liveStatus = el('p', 'sr-only tutorial-live-status', '');
    this.liveStatus.setAttribute('role', 'status');
    this.liveStatus.setAttribute('aria-live', 'polite');
    this.liveStatus.setAttribute('aria-atomic', 'true');

    this.card.appendChild(this.kickerNode);
    this.card.appendChild(this.titleNode);
    this.card.appendChild(this.bodyNode);
    this.card.appendChild(this.feedbackNode);
    this.card.appendChild(this.countdownNode);
    this.card.appendChild(this.footer);

    // The active-step banner lives in normal document flow above the canvas;
    // the card and the progress/skip column are moved into it while the lesson
    // is running, and moved back into the layer for the centered reading pages.
    this.bannerBody = el('div', 'tutorial-banner-body');
    this.bannerSide = el('div', 'tutorial-banner-side');
    this.banner = el('div', 'tutorial-banner is-hidden');
    this.banner.appendChild(this.bannerBody);
    this.banner.appendChild(this.bannerSide);

    root.appendChild(progress);
    root.appendChild(this.highlight);
    root.appendChild(this.card);
    root.appendChild(this.liveStatus);
    this.el = root;

    this.el.addEventListener('keydown', function (event: Event) {
      if ((event as KeyboardEvent).key === 'Escape') self.skip();
    });

    if (options.root) this.mount(options.root);
  }

  /** Show the intro page (start / skip). Does not start the tutorial yet. */
  start(): boolean {
    if (this.destroyed) return false;
    if (this.phase === 'skipped' || this.phase === 'done') return false;
    if (this.phase === 'idle') {
      this.phase = 'intro';
      this.step = 'dispatch';
      this.setLayerVisible(true);
      this.syncPresentation();
    }
    return true;
  }

  /** Leave the intro and enter the first real step. */
  begin(): boolean {
    if (this.destroyed) return false;
    if (this.phase === 'idle' && !this.start()) return false;
    if (this.phase !== 'intro') return false;
    this.phase = 'active';
    this.step = 'dispatch';
    this.hint = null;
    this.manualAnchor = null;
    const fireStart = !this.startFired;
    this.startFired = true;
    this.syncPresentation();
    if (fireStart) safeCall(this.callbacks.onStart, []);
    return true;
  }

  getState(): TutorialState {
    const gate = this.getGate();
    return {
      phase: this.phase,
      step: this.step,
      stepIndex: tutorialStepIndex(this.step),
      stepCount: TUTORIAL_STEP_COUNT,
      targetId: this.getTargetId(),
      sourceId: this.getSourceId(),
      canSkip:
        !this.destroyed &&
        (this.phase === 'idle' ||
          this.phase === 'intro' ||
          this.phase === 'active' ||
          this.phase === 'freeplay'),
      frozen: gate.frozen,
      aiSuppressed: gate.aiSuppressed,
      mode: gate.mode,
      freePlayRemainingTicks:
        this.phase === 'freeplay' ? this.freePlayRemaining : null,
      upgradeReady: this.step === 'upgrade' ? this.upgradeReady : false,
      attackReady: this.step === 'attack' ? this.attackReady : false,
      attackIssued: this.step === 'attack' ? this.attackOrdered : false,
      reinforcementIssued:
        this.step === 'attack' ? this.reinforcementOrdered : false,
    };
  }

  getGate(): TutorialGate {
    if (
      this.destroyed ||
      this.phase === 'skipped' ||
      this.phase === 'done'
    ) {
      return {
        mode: 'live',
        frozen: false,
        aiSuppressed: false,
        reason: 'released',
      };
    }
    if (this.phase === 'idle') {
      return {
        mode: 'hold',
        frozen: true,
        aiSuppressed: true,
        reason: 'idle',
      };
    }
    if (this.phase === 'intro') {
      return {
        mode: 'hold',
        frozen: true,
        aiSuppressed: true,
        reason: 'intro',
      };
    }
    if (this.phase === 'freeplay') {
      return {
        mode: 'live',
        frozen: false,
        aiSuppressed: false,
        reason: 'freeplay',
      };
    }
    if (this.phase === 'complete') {
      // The completion page is a reading surface: hold the real match while
      // it is open, then release it in `confirmCompletion()`.
      return {
        mode: 'hold',
        frozen: true,
        aiSuppressed: false,
        reason: 'complete',
      };
    }
    if (this.step === 'dispatch') {
      return {
        mode: 'guided',
        frozen: true,
        aiSuppressed: true,
        reason: 'dispatch',
      };
    }
    if (this.step === 'capture') {
      return {
        mode: 'guided',
        frozen: false,
        aiSuppressed: true,
        reason: 'capture',
      };
    }
    if (this.step === 'upgrade') {
      return {
        mode: 'guided',
        frozen: this.upgradeReady,
        aiSuppressed: true,
        reason: this.upgradeReady ? 'upgrade-ready' : 'upgrade-wait',
      };
    }
    if (this.step === 'attack') {
      if (this.attackOrdered || this.reinforcementOrdered) {
        // A real order is in flight. Keep the clock moving without AI so the
        // army can actually arrive and the core can emit its real capture (or
        // its real failure) instead of freezing the reinforcement halfway.
        return {
          mode: 'guided',
          frozen: false,
          aiSuppressed: true,
          reason: this.attackOrdered ? 'attack-pending' : 'reinforcement-pending',
        };
      }
      return {
        mode: 'guided',
        frozen: this.attackReady,
        aiSuppressed: true,
        reason: this.attackReady ? 'attack-ready' : 'attack-wait',
      };
    }
    return {
      mode: 'live',
      frozen: false,
      aiSuppressed: false,
      reason: 'released',
    };
  }

  getScenario(): TutorialScenario {
    const copy: TutorialScenario = {
      initialSourceId: this.scenario.initialSourceId,
      initialTargetId: this.scenario.initialTargetId,
      captureTargetId: this.scenario.captureTargetId,
      upgradeTerritoryId: this.scenario.upgradeTerritoryId,
      attackSourceId: this.scenario.attackSourceId,
      enemyTargetId: this.scenario.enemyTargetId,
      minimumAttackSent: this.scenario.minimumAttackSent,
    };
    if (this.scenario.initialSourceName !== undefined) {
      copy.initialSourceName = this.scenario.initialSourceName;
    }
    if (this.scenario.initialTargetName !== undefined) {
      copy.initialTargetName = this.scenario.initialTargetName;
    }
    if (this.scenario.upgradeTerritoryName !== undefined) {
      copy.upgradeTerritoryName = this.scenario.upgradeTerritoryName;
    }
    if (this.scenario.attackSourceName !== undefined) {
      copy.attackSourceName = this.scenario.attackSourceName;
    }
    if (this.scenario.enemyTargetName !== undefined) {
      copy.enemyTargetName = this.scenario.enemyTargetName;
    }
    return copy;
  }

  mount(root: HTMLElement): boolean {
    if (this.destroyed || !root) return false;
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
    root.appendChild(this.el);
    this.mountBanner();
    return true;
  }

  unmount(): boolean {
    if (this.destroyed || !this.el.parentNode) return false;
    this.el.parentNode.removeChild(this.el);
    this.unmountBanner();
    return true;
  }

  /**
   * Push the highlighted cell's screen box. Coordinates are relative to the
   * controller layer (normally the game map wrapper). Passing `null` hides the
   * highlight; the prompt stays usable without any coordinates.
   */
  setTargetAnchor(anchor: TutorialAnchor | null): boolean {
    if (this.destroyed) return false;
    this.manualAnchor = normalizeAnchor(anchor);
    this.renderTarget();
    return this.manualAnchor !== null;
  }

  /** Re-run `resolveAnchor` after a camera/resize change. */
  refreshTargetAnchor(): void {
    if (this.destroyed) return;
    this.manualAnchor = null;
    this.renderTarget();
  }

  /**
   * A real accepted move. Handles both the first drag and the enemy attack; the
   * current step decides which scenario pair is required.
   */
  reportMove(receipt: TutorialMoveReceipt): boolean {
    if (!this.canAcceptReceipt()) return false;
    if (!receipt || receipt.accepted !== true) {
      this.setHint('指令未通过校验，请再试一次。', 'warn');
      return false;
    }
    if (receipt.owner !== undefined && receipt.owner !== 'player') {
      return false;
    }
    const sourceId = receipt.sourceId;
    const targetId = receipt.targetId;
    const dispatchMatch =
      sourceId === this.scenario.initialSourceId &&
      targetId === this.scenario.initialTargetId;
    const attackMatch =
      sourceId === this.scenario.attackSourceId &&
      targetId === this.scenario.enemyTargetId;

    if (this.step === 'dispatch') {
      if (!dispatchMatch) {
        this.setHint('这一步只认高亮的中立领地；请按提示拖动。', 'warn');
        return false;
      }
      this.dispatchAchieved = true;
      this.advanceEligible();
      return true;
    }

    if (this.step === 'attack') {
      if (attackMatch) {
        const minimum = this.scenario.minimumAttackSent;
        this.attackOrdered = true;
        if (
          minimum !== undefined &&
          (typeof receipt.sent !== 'number' || receipt.sent < minimum)
        ) {
          const sentText =
            typeof receipt.sent === 'number' ? String(receipt.sent) : '未知';
          this.setHint(
            '本次只派出 ' +
              sentText +
              ' 兵，至少需要 ' +
              minimum +
              ' 兵；部队已出发，未成功就从主城拖向前线增援，补够后再满比例攻击。',
            'warn'
          );
          this.syncPresentation();
          return false;
        }
        this.setHint(
          '攻击已发出，等待真实占领；未成功就从主城拖向前线增援，再满比例攻击。',
          'info'
        );
        this.syncPresentation();
        return true;
      }

      if (dispatchMatch) {
        // A real order from the home city to the captured front. It is the
        // intended recovery path when both sides produce at the same rate and
        // the front can never outgrow the enemy on its own.
        this.reinforcementOrdered = true;
        this.setHint(
          '援军已从主城出发，正在增援前线；抵达后再把出兵比例拉满攻击敌前哨。',
          'info'
        );
        this.syncPresentation();
        return true;
      }

      this.setHint(
        '这一步只认高亮的敌前哨；兵力不足时，从主城拖向前线增援，不要打后方敌城。',
        'warn'
      );
      return false;
    }

    // Capture/upgrade steps may receive a real reinforcement order. It is
    // acknowledged but cannot advance the current lesson.
    if (dispatchMatch) {
      this.dispatchAchieved = true;
      this.setHint(
        this.step === 'capture'
          ? '援军已出发，继续等待真实占领。'
          : '出兵已完成，先完成当前升级。',
        'info'
      );
      return true;
    }
    if (attackMatch) {
      this.setHint('攻击已记录，先完成当前步骤。', 'info');
      return true;
    }
    this.setHint('这一步只认高亮目标；请按提示拖动。', 'warn');
    return false;
  }

  /** Explicit alias for the attack receipt; only valid during that step. */
  reportEnemyAttack(receipt: TutorialMoveReceipt): boolean {
    if (this.phase !== 'active' || this.step !== 'attack') {
      this.setHint('先完成当前步骤，再攻击敌前哨。', 'info');
      return false;
    }
    return this.reportMove(receipt);
  }

  /** A real ownership event from the core (`capture`), never a UI guess. */
  reportCapture(receipt: TutorialCaptureReceipt): boolean {
    if (!this.canAcceptReceipt()) return false;
    if (!receipt || typeof receipt.targetId !== 'string' || receipt.targetId === '') {
      return false;
    }
    if (receipt.owner !== 'player') {
      if (
        receipt.targetId === this.scenario.captureTargetId ||
        receipt.targetId === this.scenario.enemyTargetId
      ) {
        this.setHint('敌方占领不计入教学，等待你的部队。', 'warn');
      }
      return false;
    }

    let relevant = false;
    if (receipt.targetId === this.scenario.captureTargetId) {
      this.captureAchieved = true;
      relevant = true;
    }
    if (receipt.targetId === this.scenario.enemyTargetId) {
      // A real capture is stronger than a mere accepted order: it satisfies
      // the attack step even if the player found the enemy target early.
      this.enemyAttackAchieved = true;
      relevant = true;
    }
    if (!relevant) {
      this.setHint('这不是当前高亮目标。', 'warn');
      return false;
    }
    const changed = this.advanceEligible();
    if (
      !changed &&
      this.phase === 'active' &&
      this.step === 'capture' &&
      receipt.targetId === this.scenario.enemyTargetId
    ) {
      // A real enemy capture is recorded for the later attack lesson, but it
      // does not mean the current front-village capture is done.
      this.setHint('敌前哨已占领，但当前先完成高亮前线村庄的真实占领。', 'info');
    }
    return true;
  }

  /** A real accepted upgrade from the core. */
  reportUpgrade(receipt: TutorialUpgradeReceipt): boolean {
    if (!this.canAcceptReceipt()) return false;
    if (!receipt || receipt.accepted !== true) {
      this.setHint('升级未通过校验，请再试一次。', 'warn');
      return false;
    }
    if (receipt.territoryId !== this.scenario.upgradeTerritoryId) {
      this.setHint('先升级高亮的己方领地。', 'warn');
      return false;
    }
    this.upgradeAchieved = true;
    if (this.step !== 'upgrade') {
      this.setHint('升级已记录；先完成当前步骤。', 'info');
      return true;
    }
    const changed = this.advanceEligible();
    if (!changed && this.phase === 'active' && this.step === 'upgrade') {
      this.setHint('升级已完成，正在进入下一步。', 'info');
    }
    return true;
  }

  /**
   * Real simulation tick. Used for two things only: re-checking affordability
   * while no-AI production catches up, and counting down free play. A click
   * can never substitute for these ticks.
   */
  notifyTick(tick: number): void {
    if (this.destroyed || typeof tick !== 'number' || !isFinite(tick)) return;
    const safeTick = Math.max(0, Math.floor(tick));

    if (this.phase === 'freeplay') {
      if (this.lastTick === null || safeTick < this.lastTick) {
        this.lastTick = safeTick;
        return;
      }
      const delta = safeTick - this.lastTick;
      if (delta <= 0) return;
      this.lastTick = safeTick;
      this.freePlayRemaining = Math.max(0, this.freePlayRemaining - delta);
      this.updateFreeplayCountdown();
      if (this.freePlayRemaining === 0) this.showCompletion();
      return;
    }

    if (this.phase === 'active' && this.step === 'attack') {
      const readinessChanged = this.refreshReadiness();
      const progressed = this.refreshAttackProgress();
      if (progressed || readinessChanged) {
        if (!progressed) this.hint = null;
        this.syncPresentation();
      }
      return;
    }

    if (this.phase === 'active' && this.step === 'upgrade') {
      const changed = this.refreshReadiness();
      if (changed) {
        this.hint = null;
        this.syncPresentation();
      }
    }
  }

  /** Skip at any point before the completion page. Callback fires at most once. */
  skip(): boolean {
    if (this.destroyed || !this.getState().canSkip) return false;
    this.phase = 'skipped';
    this.hint = null;
    this.freePlayRemaining = 0;
    this.lastTick = null;
    this.manualAnchor = null;
    this.setLayerVisible(false);
    this.hideTarget();
    this.syncPresentation();
    const fire = !this.skipFired;
    this.skipFired = true;
    if (fire) safeCall(this.callbacks.onSkip, []);
    return true;
  }

  /** Confirm the completion page. Cannot be called before free play ends. */
  confirmCompletion(): boolean {
    if (this.destroyed || this.phase !== 'complete') return false;
    this.phase = 'done';
    this.step = 'complete';
    this.freePlayRemaining = 0;
    this.lastTick = null;
    this.manualAnchor = null;
    this.setLayerVisible(false);
    this.hideTarget();
    this.syncPresentation();
    const fire = !this.completeFired;
    this.completeFired = true;
    if (fire) safeCall(this.callbacks.onComplete, []);
    return true;
  }

  /**
   * Reopen this controller on the intro page. One-shot callback latches reset,
   * so a new run may report again; the DOM node is reused.
   */
  reset(scenario?: TutorialScenario): boolean {
    if (this.destroyed) return false;
    if (scenario !== undefined) this.scenario = normalizeScenario(scenario);
    this.phase = 'intro';
    this.step = 'dispatch';
    this.hint = null;
    this.manualAnchor = null;
    this.dispatchAchieved = false;
    this.captureAchieved = false;
    this.upgradeAchieved = false;
    this.enemyAttackAchieved = false;
    this.upgradeReady = false;
    this.attackReady = false;
    this.attackOrdered = false;
    this.reinforcementOrdered = false;
    this.freePlayRemaining = 0;
    this.lastTick = null;
    this.startFired = false;
    this.skipFired = false;
    this.completeFired = false;
    this.emittedStateKey = '';
    this.emittedGateKey = '';
    this.footerKey = '';
    this.lastFocusKey = '';
    this.setLayerVisible(true);
    this.syncPresentation();
    return true;
  }

  /** Remove the layer and stop accepting receipts. Callbacks are not fired. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.phase = 'destroyed';
    this.manualAnchor = null;
    this.setLayerVisible(false);
    this.hideTarget();
    this.setBannerVisible(false);
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.unmountBanner();
  }

  private canAcceptReceipt(): boolean {
    return !this.destroyed && this.phase === 'active';
  }

  private setLayerVisible(visible: boolean): void {
    this.el.className = 'tutorial-layer' + (visible ? '' : ' is-hidden');
  }

  private mountBanner(): void {
    if (!this.bannerHost) return;
    if (this.banner.parentNode !== this.bannerHost) {
      this.bannerHost.appendChild(this.banner);
    }
  }

  private unmountBanner(): void {
    if (this.banner.parentNode) this.banner.parentNode.removeChild(this.banner);
  }

  private setBannerVisible(visible: boolean): void {
    this.banner.className = 'tutorial-banner' + (visible ? '' : ' is-hidden');
  }

  /**
   * Active steps read from the flow banner above the canvas; intro/complete
   * keep the centered reading card inside the overlay. Both move the same
   * nodes, so the dialog roles, ids and live copy never fork.
   */
  private syncBannerPlacement(): void {
    const inBanner =
      this.bannerHost !== null &&
      (this.phase === 'active' || this.phase === 'freeplay');
    if (inBanner) {
      if (this.card.parentNode !== this.bannerBody) {
        this.bannerBody.appendChild(this.card);
      }
      if (this.progress.parentNode !== this.bannerSide) {
        this.bannerSide.appendChild(this.progress);
      }
      this.setBannerVisible(true);
      return;
    }
    if (this.card.parentNode !== this.el) this.el.appendChild(this.card);
    if (this.progress.parentNode !== this.el) this.el.appendChild(this.progress);
    this.setBannerVisible(false);
  }

  private getTargetId(): string | null {
    if (
      this.phase === 'idle' ||
      this.phase === 'intro' ||
      this.phase === 'complete' ||
      this.phase === 'skipped' ||
      this.phase === 'done' ||
      this.phase === 'destroyed'
    ) {
      return null;
    }
    if (this.step === 'dispatch') return this.scenario.initialTargetId;
    if (this.step === 'capture') return this.scenario.captureTargetId || null;
    if (this.step === 'upgrade') return this.scenario.upgradeTerritoryId || null;
    if (this.step === 'attack') return this.scenario.enemyTargetId;
    return null;
  }

  private getSourceId(): string | null {
    if (
      this.phase === 'idle' ||
      this.phase === 'intro' ||
      this.phase === 'complete' ||
      this.phase === 'skipped' ||
      this.phase === 'done' ||
      this.phase === 'destroyed'
    ) {
      return null;
    }
    if (this.step === 'dispatch' || this.step === 'capture') {
      return this.scenario.initialSourceId;
    }
    if (this.step === 'upgrade') {
      return this.scenario.upgradeTerritoryId || null;
    }
    if (this.step === 'attack') {
      return this.scenario.attackSourceId || null;
    }
    return null;
  }

  private enterStep(step: TutorialStepId): void {
    this.step = step;
    this.hint = null;
    this.manualAnchor = null;
    this.attackOrdered = false;
    this.reinforcementOrdered = false;
    if (step === 'freeplay') {
      this.phase = 'freeplay';
      this.freePlayRemaining = this.freePlayTicks;
      this.lastTick = null;
      this.upgradeReady = false;
      this.attackReady = false;
      return;
    }
    if (step === 'complete') {
      this.phase = 'complete';
      this.freePlayRemaining = 0;
      this.lastTick = null;
      this.upgradeReady = false;
      this.attackReady = false;
      return;
    }
    this.phase = 'active';
    this.freePlayRemaining = 0;
    this.lastTick = null;
    this.upgradeReady =
      step === 'upgrade' ? this.computeUpgradeReady() : false;
    this.attackReady = step === 'attack' ? this.computeAttackReady() : false;
  }

  private advanceEligible(): boolean {
    const before = this.phase + ':' + this.step;
    let guard = 0;
    while (guard < 8) {
      guard += 1;
      if (this.phase !== 'active') break;
      if (this.step === 'dispatch' && this.dispatchAchieved) {
        this.enterStep('capture');
        continue;
      }
      if (this.step === 'capture' && this.captureAchieved) {
        this.enterStep('upgrade');
        continue;
      }
      if (this.step === 'upgrade' && this.upgradeAchieved) {
        this.enterStep('attack');
        continue;
      }
      if (this.step === 'attack' && this.enemyAttackAchieved) {
        this.enterStep('freeplay');
        continue;
      }
      break;
    }
    const changed = before !== this.phase + ':' + this.step;
    if (changed) {
      this.hint = null;
      this.syncPresentation();
    }
    return changed;
  }

  private computeUpgradeReady(): boolean {
    if (!this.upgradeAffordableFn) return true;
    const territoryId =
      this.scenario.upgradeTerritoryId || this.scenario.initialSourceId;
    return safeProbe(
      this.upgradeAffordableFn,
      [territoryId],
      true
    );
  }

  private computeAttackReady(): boolean {
    if (!this.attackReadyFn) return true;
    const source = this.scenario.attackSourceId || this.scenario.captureTargetId;
    if (!source) return true;
    return safeProbe(
      this.attackReadyFn,
      [source, this.scenario.enemyTargetId],
      true
    );
  }

  private refreshReadiness(): boolean {
    if (this.step === 'upgrade') {
      const next = this.computeUpgradeReady();
      if (next === this.upgradeReady) return false;
      this.upgradeReady = next;
      return true;
    }
    if (this.step === 'attack') {
      const next = this.computeAttackReady();
      if (next === this.attackReady) return false;
      this.attackReady = next;
      return true;
    }
    return false;
  }

  /**
   * A route still counts as in flight unless the shell proves otherwise. When
   * `hasOngoingArmies` is omitted the controller deliberately keeps the gate
   * open: freezing on a guess could pause a reinforcement halfway.
   */
  private isMoveOngoing(sourceId: string, targetId: string): boolean {
    if (!this.hasOngoingArmiesFn) return true;
    return safeProbe(this.hasOngoingArmiesFn, [sourceId, targetId], true);
  }

  /**
   * Called once per real tick during the attack step. Clears the pending
   * markers only after the shell can prove the armies are no longer travelling.
   */
  private refreshAttackProgress(): boolean {
    if (this.phase !== 'active' || this.step !== 'attack') return false;
    let changed = false;

    if (this.attackOrdered) {
      const attackSource =
        this.scenario.attackSourceId ||
        this.scenario.captureTargetId ||
        this.scenario.initialTargetId;
      if (!this.isMoveOngoing(attackSource, this.scenario.enemyTargetId)) {
        this.attackOrdered = false;
        this.hint = this.attackReady
          ? {
              text:
                '攻击未成功；兵力已够，可再次满比例攻击，或先从主城拖向前线增援。',
              tone: 'warn',
            }
          : {
              text:
                '攻击未成功；兵力不足，继续无 AI 补兵，或从主城拖向前线增援。',
              tone: 'warn',
            };
        changed = true;
      }
    }

    if (this.reinforcementOrdered) {
      const front = this.scenario.captureTargetId || this.scenario.initialTargetId;
      if (!this.isMoveOngoing(this.scenario.initialSourceId, front)) {
        this.reinforcementOrdered = false;
        this.hint = this.attackReady
          ? {
              text: '援军已抵达前线；兵力足够，满比例拖向敌前哨。',
              tone: 'info',
            }
          : {
              text:
                '援军已抵达前线，但兵力仍不足；继续无 AI 补兵，或再次从主城增援。',
              tone: 'warn',
            };
        changed = true;
      }
    }

    return changed;
  }

  private showCompletion(): void {
    this.enterStep('complete');
    this.setLayerVisible(true);
    this.syncPresentation();
  }

  private setHint(text: string, tone: 'info' | 'warn'): void {
    this.hint = { text: text, tone: tone };
    if (!this.destroyed) this.renderPresentation();
  }

  private stepCopy(): {
    kicker: string;
    label: string;
    title: string;
    body: string;
  } {
    const sourceName = this.scenario.initialSourceName || '主城';
    const targetName = this.scenario.initialTargetName || '高亮中立领地';
    const upgradeName =
      this.scenario.upgradeTerritoryName || this.scenario.initialSourceName || '主城';
    const attackSourceName = this.scenario.attackSourceName || '前沿领地';
    const enemyName = this.scenario.enemyTargetName || '敌方前哨';

    if (this.step === 'dispatch') {
      return {
        kicker: 'STEP 01 · 出兵',
        label: STEP_LABEL.dispatch,
        title: '拖向高亮的中立领地',
        body:
          '按住' +
          sourceName +
          '约 0.5 秒，拖向' +
          targetName +
          '；拖动到 60% 以上再松手。',
      };
    }
    if (this.step === 'capture') {
      return {
        kicker: 'STEP 02 · 占领',
        label: STEP_LABEL.capture,
        title: '等待部队真实抵达',
        body:
          '占领不是点按钮：等' +
          targetName +
          '真正变成我方。兵力不足时，再从' +
          sourceName +
          '补派一次。',
      };
    }
    if (this.step === 'upgrade') {
      return {
        kicker: 'STEP 03 · 升级',
        label: STEP_LABEL.upgrade,
        title: '升级' + upgradeName,
        body:
          '先选中' +
          upgradeName +
          '，再在下方选择产兵、行军或城防中的一项完成一次真实升级。',
      };
    }
    if (this.step === 'attack') {
      return {
        kicker: 'STEP 04 · 进攻',
        label: STEP_LABEL.attack,
        title: '满比例攻击' + enemyName,
        body:
          '选中' +
          attackSourceName +
          '，按住拖向' +
          enemyName +
          '，把出兵比例拉到 100% 再松手。兵力不足时，先从' +
          sourceName +
          '拖向' +
          attackSourceName +
          '增援；只认高亮的敌前哨，后方敌城不算通过。',
      };
    }
    if (this.step === 'freeplay') {
      return {
        kicker: 'STEP 05 · 实战',
        label: STEP_LABEL.freeplay,
        title: '自由实战',
        body:
          'AI 已恢复，按正常节奏推演 ' +
          Math.round(this.freePlayTicks / TICKS_PER_SECOND) +
          ' 秒；时间到后显示完成页。',
      };
    }
    return {
      kicker: '完成',
      label: STEP_LABEL.complete,
      title: '教学完成',
      body:
        '你已经完成真实出兵、占领、升级和攻击。点击“完成教学”后，AI 与计时恢复正常。',
    };
  }

  private defaultFeedback(): { text: string; tone: 'info' | 'warn' } {
    if (this.phase === 'intro') {
      return {
        text: '第一次玩？跟着高亮做一遍即可，随时可以跳过。',
        tone: 'info',
      };
    }
    if (this.step === 'dispatch') {
      return {
        text: '等待真实出兵：按住并拖向高亮目标。',
        tone: 'info',
      };
    }
    if (this.step === 'capture') {
      return {
        text: '等待真实占领事件，不会自动跳过。',
        tone: 'info',
      };
    }
    if (this.step === 'upgrade') {
      if (this.upgradeReady) {
        return {
          text: '兵员已够：选中高亮领地，在下方完成一次升级。',
          tone: 'info',
        };
      }
      return {
        text: '兵员不足：正在无 AI 教学补兵，补够后自动提示。',
        tone: 'warn',
      };
    }
    if (this.step === 'attack') {
      if (this.attackOrdered) {
        if (this.attackReady) {
          return {
            text: '攻击已发出；若未占领，现在可再次满比例攻击高亮前哨。',
            tone: 'info',
          };
        }
        return {
          text: '攻击已发出；兵力不足，正在无 AI 教学补兵。若迟迟未占领，从主城拖向前线增援。',
          tone: 'warn',
        };
      }
      if (this.reinforcementOrdered) {
        return {
          text: '援军正在从主城开往前线；抵达后再把出兵比例拉满，攻击敌前哨。',
          tone: 'info',
        };
      }
      if (this.attackReady) {
        return {
          text: '兵力已够：满比例拖向高亮的敌前哨。',
          tone: 'info',
        };
      }
      return {
        text: '前沿兵力不足：从主城拖向前线增援，或等无 AI 教学补兵；不要打后方敌城。',
        tone: 'warn',
      };
    }
    if (this.phase === 'freeplay') {
      return {
        text: 'AI 已恢复，正常推演中。',
        tone: 'info',
      };
    }
    return {
      text: '点击“完成教学”回到对局。',
      tone: 'info',
    };
  }

  private renderPresentation(): void {
    if (
      this.phase === 'skipped' ||
      this.phase === 'done' ||
      this.phase === 'destroyed'
    ) {
      return;
    }
    this.el.setAttribute('data-phase', this.phase);
    this.el.setAttribute('data-step', this.step);
    this.syncBannerPlacement();

    const isIntro = this.phase === 'intro';
    const isComplete = this.phase === 'complete';
    const isFreeplay = this.phase === 'freeplay';
    const copy = this.stepCopy();
    const introTitle = '先走一遍流程';
    const introBody =
      '拖动出兵 → 确认占领 → 升级领地 → 攻击敌前哨 → 短暂自由实战。全部只认真实操作，随时可以跳过。';

    setText(
      this.progressCount,
      isIntro
        ? '新手教学'
        : isComplete
          ? '6 / 6 完成'
          : '步骤 ' + tutorialStepIndex(this.step) + ' / ' + TUTORIAL_STEP_COUNT
    );
    setText(
      this.progressStep,
      isIntro ? '开始前' : isComplete ? '教学完成' : copy.label
    );
    setText(this.kickerNode, isIntro ? '新手教学 · 跟着做一遍' : copy.kicker);
    setText(this.titleNode, isIntro ? introTitle : copy.title);
    setText(this.bodyNode, isIntro ? introBody : copy.body);

    const feedback = this.hint || this.defaultFeedback();
    setText(this.feedbackNode, feedback.text);
    this.feedbackNode.className =
      'tutorial-live-feedback' + (feedback.tone === 'warn' ? ' is-warn' : '');
    // The compact banner shows one line of guidance: the normal body copy, or
    // the warning that replaced it when the last real action was rejected.
    this.banner.setAttribute('data-tone', feedback.tone);

    this.countdownNode.className =
      'tutorial-live-countdown' + (isFreeplay ? '' : ' is-hidden');
    if (isFreeplay) this.updateFreeplayCountdown();

    const state = this.getState();
    this.skipButton.className =
      'tutorial-skip tutorial-live-skip' + (state.canSkip ? '' : ' is-hidden');
    this.skipButton.setAttribute('aria-hidden', state.canSkip ? 'false' : 'true');
    this.skipButton.setAttribute('tabindex', state.canSkip ? '0' : '-1');

    const footerKey =
      this.phase +
      ':' +
      this.step +
      ':' +
      (this.upgradeReady ? '1' : '0') +
      (this.attackReady ? '1' : '0');
    if (footerKey !== this.footerKey) {
      this.footerKey = footerKey;
      this.renderFooter();
    }

    setText(
      this.liveStatus,
      isIntro
        ? '新手教学。' + introTitle + '。' + introBody
        : isComplete
          ? '教学完成。' + copy.body
          : '步骤 ' +
            tutorialStepIndex(this.step) +
            ' / ' +
            TUTORIAL_STEP_COUNT +
            '：' +
            copy.label +
            '。' +
            copy.title +
            '。' +
            copy.body +
            '。' +
            feedback.text
    );
    this.renderTarget();
  }

  private renderFooter(): void {
    clear(this.footer);
    const self = this;
    if (this.phase === 'intro') {
      const start = button(
        '开始教学',
        'btn btn-primary tutorial-live-start',
        function () {
          self.begin();
        }
      );
      start.setAttribute('aria-label', '开始新手教学');
      this.footer.appendChild(start);
      this.focusOnce(start, 'intro');
      return;
    }
    if (this.phase === 'complete') {
      const finish = button(
        '完成教学',
        'btn btn-primary tutorial-live-finish',
        function () {
          self.confirmCompletion();
        }
      );
      finish.setAttribute('aria-label', '完成新手教学，回到对局');
      this.footer.appendChild(finish);
      this.focusOnce(finish, 'complete');
    }
    // Active and free-play steps keep an empty footer: their guidance is the
    // banner's one body line, so no extra note is rendered at all.
  }

  private focusOnce(node: HTMLButtonElement, key: string): void {
    if (this.lastFocusKey === key) return;
    this.lastFocusKey = key;
    if (typeof node.focus === 'function') {
      try {
        node.focus();
      } catch (error) {
        // Focus is an enhancement; a detached layer may refuse it.
      }
    }
  }

  private updateFreeplayCountdown(): void {
    const seconds = Math.max(
      0,
      Math.ceil(this.freePlayRemaining / TICKS_PER_SECOND)
    );
    setText(this.countdownNode, '剩余 ' + seconds + ' 秒');
  }

  private renderTarget(): void {
    if (
      this.phase === 'skipped' ||
      this.phase === 'done' ||
      this.phase === 'destroyed' ||
      this.phase === 'idle' ||
      this.phase === 'intro' ||
      this.phase === 'complete'
    ) {
      this.hideTarget();
      return;
    }
    const targetId = this.getTargetId();
    if (!targetId) {
      this.hideTarget();
      return;
    }
    const anchor = this.manualAnchor || this.resolveAnchor(targetId);
    if (!anchor) {
      this.hideTarget();
      return;
    }

    const points = this.clampHighlightPoints(this.highlightPoints(anchor));
    this.highlightShape.setAttribute(
      'points',
      formatPoints(points)
    );
    this.highlight.setAttribute('data-target-id', targetId);
    setNodeClass(this.highlight, 'tutorial-highlight');
  }

  /**
   * Ring vertices for the highlight. A resolver that supplies the real
   * territory outline wins; a box-only anchor (the legacy `setTargetAnchor`
   * path) becomes a padded rectangle so small targets stay touchable.
   */
  private highlightPoints(anchor: TutorialAnchor): Array<[number, number]> {
    if (anchor.points && anchor.points.length >= 3) {
      const out: Array<[number, number]> = [];
      for (let i = 0; i < anchor.points.length; i += 1) {
        out.push([anchor.points[i][0], anchor.points[i][1]]);
      }
      return out;
    }
    const width = Math.max(56, Math.round(anchor.width));
    const height = Math.max(56, Math.round(anchor.height));
    const left = Math.round(anchor.x + anchor.width / 2 - width / 2);
    const top = Math.round(anchor.y + anchor.height / 2 - height / 2);
    return [
      [left, top],
      [left + width, top],
      [left + width, top + height],
      [left, top + height],
    ];
  }

  /**
   * Translates the whole ring when its bounding box leaves the layer. The
   * shape is never clipped and never resized, so the outline keeps matching
   * the territory; only out-of-bounds points are brought back as a group.
   */
  private clampHighlightPoints(
    points: Array<[number, number]>
  ): Array<[number, number]> {
    const layerWidth =
      typeof this.el.clientWidth === 'number' ? this.el.clientWidth : 0;
    const layerHeight =
      typeof this.el.clientHeight === 'number' ? this.el.clientHeight : 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const x = points[i][0];
      const y = points[i][1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const pad = 4;
    let shiftX = 0;
    let shiftY = 0;
    if (layerWidth > 0) {
      if (maxX - minX <= layerWidth - pad * 2) {
        if (minX < pad) shiftX = pad - minX;
        else if (maxX > layerWidth - pad) shiftX = layerWidth - pad - maxX;
      } else {
        shiftX = -minX;
      }
    }
    if (layerHeight > 0) {
      if (maxY - minY <= layerHeight - pad * 2) {
        if (minY < pad) shiftY = pad - minY;
        else if (maxY > layerHeight - pad) shiftY = layerHeight - pad - maxY;
      } else {
        shiftY = -minY;
      }
    }
    if (shiftX === 0 && shiftY === 0) return points;
    const out: Array<[number, number]> = [];
    for (let i = 0; i < points.length; i += 1) {
      out.push([points[i][0] + shiftX, points[i][1] + shiftY]);
    }
    return out;
  }

  private resolveAnchor(targetId: string): TutorialAnchor | null {
    if (!this.resolveAnchorFn) return null;
    try {
      return normalizeAnchor(this.resolveAnchorFn(targetId));
    } catch (error) {
      return null;
    }
  }

  private hideTarget(): void {
    setNodeClass(this.highlight, 'tutorial-highlight is-hidden');
    this.highlight.setAttribute('data-target-id', '');
  }

  private syncPresentation(): void {
    const visible =
      this.phase !== 'skipped' &&
      this.phase !== 'done' &&
      this.phase !== 'destroyed';
    this.setLayerVisible(visible);
    if (visible) this.renderPresentation();
    else {
      this.hideTarget();
      this.setBannerVisible(false);
    }
    this.emitChanges();
  }

  private emitChanges(): void {
    const state = this.getState();
    const stateKey = [
      state.phase,
      state.step,
      state.upgradeReady ? '1' : '0',
      state.attackReady ? '1' : '0',
      state.attackIssued ? '1' : '0',
      state.reinforcementIssued ? '1' : '0',
      state.targetId || '',
      state.sourceId || '',
      state.canSkip ? '1' : '0',
    ].join('|');
    if (stateKey !== this.emittedStateKey) {
      this.emittedStateKey = stateKey;
      safeCall(this.callbacks.onStep, [state]);
    }

    const gate = this.getGate();
    const gateKey =
      gate.mode +
      '|' +
      (gate.frozen ? '1' : '0') +
      '|' +
      (gate.aiSuppressed ? '1' : '0') +
      '|' +
      gate.reason;
    if (gateKey !== this.emittedGateKey) {
      this.emittedGateKey = gateKey;
      safeCall(this.callbacks.onGate, [gate]);
    }

    const focusKey = state.targetId || '';
    if (focusKey !== this.emittedFocusKey) {
      this.emittedFocusKey = focusKey;
      safeCall(this.callbacks.onFocus, [state.targetId]);
    }
  }
}

export function createTutorialController(
  options: TutorialOptions
): TutorialController {
  return new TutorialController(options);
}
