import { STALEMATE_END_TICKS, STALEMATE_WARNING_TICKS } from '../game-api';
import { idleGestureState } from '../input/gesture-controller';
import type { GestureState } from '../input/gesture-controller';
import {
  BETRAYAL_COOLDOWN_TICKS,
  BETRAYAL_INITIAL_DELAY_TICKS,
  BETRAYAL_LEVEL_PRICES,
  BETRAYAL_SOLDIERS_PER_LEVEL,
  TICKS_PER_SECOND,
  VERSUS_BLUE_NAME,
  VERSUS_RED_NAME,
} from '../config/balance';
import { button, el, setAttr, setText } from './dom';
import {
  TERRAIN_LABEL,
  forecastText,
  formatClock,
  formatPercent,
  pad2,
  productionText,
  reasonText,
  terrainDefenseLabel,
} from './format';
import {
  FACTION_NAME,
  activeFactions,
  aiScoreOf,
  aiTerritoriesOf,
  factionDisplayName,
  factionScoreOf,
  factionTerritoriesOf,
  isFactionAlive,
  isFactionOwner,
} from './factions';
import type { FactionOwner } from './factions';
import { playerHasActiveAlly } from './diplomacy-view';
import { routeFailureText, routePassageText } from './route-feedback';
import { findTerritory, remainingSeconds } from './view-model';
import type {
  MatchMode,
  MatchStatus,
  MatchView,
  TerritoryView,
  UpgradeEvaluationDetail,
  UpgradeKind,
} from './view-model';
import type { CameraState } from '../rendering/viewport';
import {
  DEFAULT_DISPATCH_MODE,
  dispatchModeHint,
  dispatchModeLabel,
} from './v120-fronts';
import type { DispatchMode } from './v120-fronts';
import { VersusPane, versusPaneOrientation } from './versus-pane';
import type {
  VersusPaneInfo,
  VersusPaneOrientation,
  VersusPaneSet,
  VersusSide,
} from './versus-pane';

export interface GameScreenCallbacks {
  onPause: () => void;
  onUpgrade: (kind: UpgradeKind) => void;
  onRules: () => void;
  /** Solo calls omit `side`; versus pane controls pass their owner. */
  onZoomIn: (side?: VersusSide) => void;
  onZoomOut: (side?: VersusSide) => void;
  onZoomReset: (side?: VersusSide) => void;
  /** Active skill; GameScreen never decides legality itself. */
  onBetrayal: () => void;
  /** 'versus' hides the betrayal control and shows the shared compare bar. */
  mode?: MatchMode;
  /** Challenge matches force the skill off; the control explains the rule. */
  fairMode?: boolean;
  /**
   * Portrait/landscape flip. The App must cancel both gesture controllers here:
   * pane viewports and their pointer mapping change together with the layout.
   */
  onVersusLayoutChange?: (orientation: VersusPaneOrientation) => void;
  /** v1.2: switch between continuous lines and one-shot dispatch. */
  onDispatchModeChange?: (mode: DispatchMode) => void;
  /** v1.2: stop every line of the selected territory (owner-scoped). */
  onStopLines?: (owner: VersusSide) => void;
  /** v1.2: live speed chip in the solo HUD. */
  getSpeedLabel?: () => string | null;
}

/** Panel copy the shell feeds in every frame (lines + dispatch mode). */
export interface DispatchPanelState {
  mode: DispatchMode;
  /** Selection summary from `summarizeSelectionLines`. */
  sendCount: number;
  incomingCount: number;
  hint: string;
  stopLabel: string | null;
  /** Versus only: the red pane's own stop label (blue uses `stopLabel`). */
  stopLabelRed?: string | null;
  /** False when the core has no front API: the toggle explains that. */
  linesAvailable: boolean;
  speedLabel: string | null;
}

/** HUD slice the shell forwards from the frozen snapshot (skill + disaster). */
export interface HudSkillSnapshot {
  betrayalLevel: number;
  readyTick: number;
  uses: number;
}

export interface HudDisasterSnapshot {
  scheduledAtTick: number | null;
  struck: boolean;
  warned: boolean;
}

export interface HudSnapshot {
  tick: number;
  skill: HudSkillSnapshot;
  disaster: HudDisasterSnapshot;
}

export type BetrayalPhase = 'locked' | 'cooldown' | 'ready' | 'blocked';
export type BetrayalBlockReason =
  | 'none'
  | 'no_enemy'
  | 'paused'
  | 'ended'
  | 'waiting'
  | 'locked'
  | 'fair_mode';

export interface BetrayalHudInput {
  level: number;
  tick: number;
  readyTick: number;
  /** 0 before the first cast (initial delay), >0 after (full cooldown). */
  uses: number;
  status: MatchStatus;
  enemyTerritories: number;
  /** Challenge/versus: no side may use the skill, regardless of archive level. */
  fairMode?: boolean;
}

export interface BetrayalHudState {
  visible: boolean;
  phase: BetrayalPhase;
  level: number;
  levelLabel: string;
  /** Converted troops allowed this cast (level * 10); 0 while locked. */
  quota: number;
  cooldownSeconds: number;
  /** 0 at the start of the cooldown, 1 when ready; drives the ring. */
  readyProgress: number;
  reason: BetrayalBlockReason;
  /** Right-side status chip: 未解锁 / 冷却 27s / 可发动 / 暂停 … */
  stateLabel: string;
  /** Second line: quota, unlock price, or the fair-mode explanation. */
  detailLabel: string;
  /** Full accessible name; always carries the current state and reason. */
  ariaLabel: string;
}

/** Ring geometry shared by the SVG arc and the state signature. */
const SKILL_RING_RADIUS = 10;
const SKILL_RING_CIRCUMFERENCE = 2 * Math.PI * SKILL_RING_RADIUS;

/**
 * Read-only placeholder for "no blue finger is active". Reused so a frame with
 * only the red hand charging allocates nothing for the shared action panel.
 */
const IDLE_GESTURE = idleGestureState();

function activeGestureList(
  gesture: GestureState,
  gestures?: readonly GestureState[]
): GestureState[] {
  const all = gestures && gestures.length > 0 ? gestures : [gesture];
  const out: GestureState[] = [];
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].phase !== 'idle') out.push(all[i]);
  }
  return out;
}

function gestureForOwner(
  gestures: readonly GestureState[],
  owner: 'player' | 'ai1'
): GestureState | null {
  for (let i = 0; i < gestures.length; i += 1) {
    if (gestures[i].owner === owner) return gestures[i];
  }
  return null;
}

/** Compact "蓝 82% · 红 45%" line; frozen slots are marked instead of pulsing. */
function versusRatioText(gestures: readonly GestureState[]): string {
  const parts: string[] = [];
  for (let i = 0; i < gestures.length; i += 1) {
    const gesture = gestures[i];
    const name =
      gesture.owner === 'player' ? '蓝' : gesture.owner === 'ai1' ? '红' : '';
    parts.push(
      (name ? name + ' ' : '') +
        formatPercent(gesture.ratio) +
        (gesture.frozen ? ' 锁' : '')
    );
  }
  return parts.join(' · ');
}

function clamp01(value: number): number {
  if (!isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Pure state machine for the betrayal button. Keeping it out of the DOM makes
 * every transition (locked/CD/ready/blocked) unit-testable without a browser.
 */
export function betrayalHudState(input: BetrayalHudInput): BetrayalHudState {
  const level = isFinite(input.level) ? Math.max(0, Math.floor(input.level)) : 0;
  const levelLabel = 'Lv.' + level;
  const quota = level * BETRAYAL_SOLDIERS_PER_LEVEL;
  const quotaDetail = '单次最多策反 ' + quota + ' 人';
  const unlockPrice = BETRAYAL_LEVEL_PRICES[1];

  if (input.fairMode) {
    return {
      visible: true,
      phase: 'locked',
      level: level,
      levelLabel: levelLabel,
      quota: quota,
      cooldownSeconds: 0,
      readyProgress: 0,
      reason: 'fair_mode',
      stateLabel: '公平模式',
      detailLabel: '挑战赛双方禁用',
      ariaLabel: '策反，挑战赛公平模式，双方均不可使用',
    };
  }

  if (level < 1) {
    return {
      // Level 0 is a real, always-visible entry: it explains the out-of-match
      // unlock instead of disappearing from the match screen.
      visible: true,
      phase: 'locked',
      level: level,
      levelLabel: levelLabel,
      quota: 0,
      cooldownSeconds: 0,
      readyProgress: 0,
      reason: 'locked',
      stateLabel: '未解锁',
      detailLabel: '胜局金币可解锁 · ' + unlockPrice + ' 金币',
      ariaLabel:
        '策反未解锁，可用 ' +
        unlockPrice +
        ' 金币解锁；结束本局后回大厅「策反升级」',
    };
  }

  const statusNote =
    input.status === 'paused'
      ? '，对局暂停'
      : input.status === 'ended'
        ? '，对局已结束'
        : input.status === 'playing'
          ? ''
          : '，等待开局';
  const remainingTicks = Math.max(0, input.readyTick - input.tick);
  if (remainingTicks > 0) {
    const totalTicks =
      input.uses > 0 ? BETRAYAL_COOLDOWN_TICKS : BETRAYAL_INITIAL_DELAY_TICKS;
    const cooldownSeconds = Math.ceil(remainingTicks / TICKS_PER_SECOND);
    return {
      visible: true,
      phase: 'cooldown',
      level: level,
      levelLabel: levelLabel,
      quota: quota,
      cooldownSeconds: cooldownSeconds,
      readyProgress: clamp01(1 - remainingTicks / totalTicks),
      reason: 'none',
      stateLabel: '冷却 ' + cooldownSeconds + 's',
      detailLabel: quotaDetail,
      ariaLabel:
        '策反 ' +
        levelLabel +
        '，' +
        quotaDetail +
        '，冷却 ' +
        cooldownSeconds +
        ' 秒' +
        statusNote,
    };
  }

  if (input.status === 'ended') {
    return {
      visible: true,
      phase: 'blocked',
      level: level,
      levelLabel: levelLabel,
      quota: quota,
      cooldownSeconds: 0,
      readyProgress: 1,
      reason: 'ended',
      stateLabel: '已结束',
      detailLabel: quotaDetail,
      ariaLabel: '策反 ' + levelLabel + '，对局已结束，不可发动',
    };
  }
  if (input.status === 'paused') {
    return {
      visible: true,
      phase: 'blocked',
      level: level,
      levelLabel: levelLabel,
      quota: quota,
      cooldownSeconds: 0,
      readyProgress: 1,
      reason: 'paused',
      stateLabel: '暂停',
      detailLabel: quotaDetail,
      ariaLabel: '策反 ' + levelLabel + '，对局暂停，不可发动',
    };
  }
  if (input.status !== 'playing') {
    return {
      visible: true,
      phase: 'blocked',
      level: level,
      levelLabel: levelLabel,
      quota: quota,
      cooldownSeconds: 0,
      readyProgress: 1,
      reason: 'waiting',
      stateLabel: '待战',
      detailLabel: quotaDetail,
      ariaLabel: '策反 ' + levelLabel + '，等待开局，不可发动',
    };
  }
  if (input.enemyTerritories <= 0) {
    return {
      visible: true,
      phase: 'blocked',
      level: level,
      levelLabel: levelLabel,
      quota: quota,
      cooldownSeconds: 0,
      readyProgress: 1,
      reason: 'no_enemy',
      stateLabel: '无敌方',
      detailLabel: quotaDetail,
      ariaLabel: '策反 ' + levelLabel + '，没有敌方领地，不可发动',
    };
  }
  return {
    visible: true,
    phase: 'ready',
    level: level,
    levelLabel: levelLabel,
    quota: quota,
    cooldownSeconds: 0,
    readyProgress: 1,
    reason: 'none',
    stateLabel: '可发动',
    detailLabel: quotaDetail,
    ariaLabel: '策反 ' + levelLabel + '，' + quotaDetail + '，可发动',
  };
}

/** Explicit toast copy for every core rejection reason (never silent). */
export function betrayalReasonText(
  reason: string | undefined,
  cooldownSeconds: number
): string {
  if (reason === 'cooldown') {
    return '策反冷却中 · 还需 ' + Math.max(0, Math.ceil(cooldownSeconds)) + ' 秒';
  }
  if (reason === 'locked') {
    return (
      '策反未解锁 · 结束本局后回大厅「策反升级」用 ' +
      BETRAYAL_LEVEL_PRICES[1] +
      ' 金币解锁'
    );
  }
  if (reason === 'fair_mode') return '挑战赛公平模式 · 双方均不可使用策反';
  if (reason === 'no_target') return '没有可策反的敌方领地';
  if (reason === 'not_playing') return '对局暂停或已结束，无法发动策反';
  return '策反发动失败，请稍后再试';
}

const UPGRADE_KINDS: UpgradeKind[] = ['production', 'march', 'defense'];
const UPGRADE_LABEL: Record<UpgradeKind, string> = {
  production: '产兵',
  march: '行军',
  defense: '城防',
};
const UPGRADE_MAX: Record<UpgradeKind, number> = {
  production: 3,
  march: 3,
  defense: 2,
};

interface UpgradeButton {
  root: HTMLButtonElement;
  main: HTMLElement;
  sub: HTMLElement;
  iconHost: HTMLElement;
  /** Defense level backing the mounted SVG; -1 for fixed icons. */
  iconLevel: number;
  /** Last values written, so steady ticks never touch the DOM again. */
  className: string;
  disabled: boolean;
  subText: string;
  ariaLabel: string;
}

function svgIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('class', 'upgrade-icon');
  svg.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < paths.length; i += 1) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[i]);
    svg.appendChild(path);
  }
  return svg;
}

function iconFor(kind: UpgradeKind, level: number): SVGSVGElement {
  if (kind === 'production') {
    return svgIcon([
      'M5 15.5h10',
      'M6.5 12.5 10 9l3.5 3.5',
      'M6.5 9 10 5.5 13.5 9',
    ]);
  }
  if (kind === 'march') {
    return svgIcon(['M3.5 10h11', 'M10.5 5.5 15 10l-4.5 4.5', 'M3.5 6.5h4', 'M3.5 13.5h4']);
  }
  if (level >= 2) {
    return svgIcon([
      'M4 15.5h8.5',
      'M5.5 15.5a4.5 4.5 0 0 1 9 0',
      'M12 11.5 17 6.5',
      'M14.5 5.5h2.5V8',
    ]);
  }
  if (level >= 1) {
    return svgIcon(['M4 16V9h3V6h2v3h2V6h2v3h3v7z', 'M8 16v-3h4v3']);
  }
  return svgIcon(['M10 3.5 16 5.5v5.2c0 3.1-2.7 5.1-6 6.3-3.3-1.2-6-3.2-6-6.3V5.5z']);
}

function marchSpeedText(level: number): string {
  if (level >= 3) return '1.4×';
  if (level === 2) return '1.2×';
  return '1×';
}

function defenseLevelText(level: number): string {
  if (level >= 2) return '炮台';
  if (level === 1) return '城墙';
  return '无';
}

function upgradeProgressText(kind: UpgradeKind, level: number): string {
  if (kind === 'march') return 'Lv' + level + ' · ' + marchSpeedText(level);
  if (kind === 'defense') return '城防 ' + level + ' · ' + defenseLevelText(level);
  return 'Lv' + level;
}

/**
 * Always-present three-track summary. Values are fixed to one line and the
 * row keeps a constant height, so selecting a walled territory (or nothing at
 * all) can never resize the action card under the canvas.
 */
function skillValueText(kind: UpgradeKind, source: TerritoryView | null): string {
  if (!source) return '--';
  if (kind === 'production') {
    return 'Lv' + source.productionLevel + ' · ' + productionText(source.productionLevel);
  }
  if (kind === 'march') {
    return 'Lv' + source.marchLevel + ' · ' + marchSpeedText(source.marchLevel);
  }
  if (source.defenseLevel <= 0) return '无';
  return (
    'Lv' +
    source.defenseLevel +
    ' · 盾 ' +
    source.shield +
    (source.shield < source.shieldCapacity ? '/' + source.shieldCapacity : '')
  );
}

function sourceMetaText(source: TerritoryView | null): string {
  if (!source) return '按住蓄力，拖向己方接壤的领地';
  return TERRAIN_LABEL[source.terrain] + ' · 按住蓄力，拖向接壤领地';
}

/**
 * Seconds left on the player's active truce with one faction, 0 otherwise.
 * Only player-to-faction records count: an AI-to-AI truce must never paint a
 * chip as the player's ally. Pure snapshot derivation (view.diplomacy + tick),
 * frozen while paused and cleared on break/expire/elimination.
 */
function playerAllySecondsLeft(view: MatchView, owner: FactionOwner): number {
  const diplomacy = view.diplomacy;
  if (!diplomacy || !diplomacy.enabled) return 0;
  const truces = diplomacy.truces;
  for (let i = 0; i < truces.length; i += 1) {
    const record = truces[i];
    const isPair =
      (record.a === 'player' && record.b === owner) ||
      (record.a === owner && record.b === 'player');
    if (!isPair) continue;
    if (record.pendingOffer) return 0;
    if (record.expiresTick > view.tick) {
      return Math.max(0, Math.ceil((record.expiresTick - view.tick) / 10));
    }
    return 0; // cooldown-only record: the ally relation has ended
  }
  return 0;
}

/** UI copy distinguishes a target frontier gap from a generic invalid move. */
function moveReasonText(
  reason: string | null | undefined,
  hasAlly: boolean
): string {
  if (reason === 'not_adjacent') {
    // The routing rule is real: reachability already lets a passage cross the
    // ally's land, and modes without allies route through own land only.
    return hasAlly
      ? '未接通前线 · 须沿相连的己方或盟友领地借道'
      : '未接通前线 · 须沿相连的己方领地出兵';
  }
  if (reason === 'truce') return '停战期间不能互相攻击';
  return reasonText(reason);
}

function upgradeSubText(
  kind: UpgradeKind,
  evaluation: UpgradeEvaluationDetail | null,
  selected: TerritoryView | null,
  view: MatchView
): string {
  if (!selected) return '选地';
  if (selected.owner !== 'player') return '敌方';
  if (view.status !== 'playing') return '暂停';
  if (!evaluation) return '不可';
  if (evaluation.currentLevel >= UPGRADE_MAX[kind]) {
    return '已满 · ' + upgradeProgressText(kind, evaluation.currentLevel);
  }
  if (!evaluation.ok) {
    if (evaluation.reason === 'no_troops') return '缺兵 · ' + evaluation.cost;
    if (evaluation.reason === 'not_own') return '敌方';
    if (evaluation.reason === 'not_playing') return '暂停';
    return '不可 · ' + evaluation.cost;
  }
  const next =
    kind === 'defense'
      ? defenseLevelText(evaluation.nextLevel)
      : kind === 'march'
        ? marchSpeedText(evaluation.nextLevel)
        : 'Lv' + evaluation.nextLevel;
  return '-' + evaluation.cost + ' → ' + next;
}

/**
 * Compact HUD plus the three explicit upgrade tracks. All displayed numbers
 * come from the core snapshot/evaluator; this class never spends troops or
 * derives capacity itself.
 */
export class GameScreen {
  readonly el: HTMLElement;
  /**
   * Primary canvas. Solo keeps the original single battlefield; versus points
   * this at the blue pane so existing callers (`new CanvasRenderer(screen.canvas)`)
   * keep compiling while the App is wired pane-by-pane.
   */
  readonly canvas: HTMLCanvasElement;
  readonly mapWrap: HTMLElement;
  /**
   * Normal-flow slot between the dispatch bar and the map. Empty in every
   * normal match; the tutorial mounts its prompt banner here so the canvas
   * keeps its full width and no overlay covers the cells.
   */
  readonly tutorialBannerHost: HTMLElement;
  /** Both split canvases in versus; null in solo. */
  readonly panes: VersusPaneSet | null;

  private readonly versus: boolean;
  private readonly paneHost: HTMLElement | null;
  private paneResizeHandler: (() => void) | null = null;
  private readonly paneCameras: Record<VersusSide, CameraState>;
  private readonly onVersusLayoutChange:
    | ((orientation: VersusPaneOrientation) => void)
    | null;
  private paneOrientation: VersusPaneOrientation | null = null;
  private bodyVersusClass = false;
  private readonly timerValue: HTMLElement;
  private readonly playerScore: HTMLElement;
  private readonly enemyScore: HTMLElement;
  private readonly playerLand: HTMLElement;
  private readonly enemyLand: HTMLElement;
  private readonly versusBar: HTMLElement;
  private readonly versusFill: HTMLElement;
  private readonly versusBlueCopy: HTMLElement;
  private readonly versusRedCopy: HTMLElement;
  private versusSignature = '';
  /** Score strip root; re-classed when a 3/4-faction match needs more chips. */
  private readonly scoreStrip: HTMLElement;
  private readonly stripLabel: HTMLElement;
  /** Per-faction chip refs, built lazily on the first multi-faction update. */
  private factionChips: Array<{
    owner: FactionOwner;
    chip: HTMLElement;
    score: HTMLElement;
    land: HTMLElement;
    ally: HTMLElement;
  }> | null = null;
  private factionSignature = '';
  private factionRosterKey = '';
  private readonly sourceName: HTMLElement;
  private readonly sourceMeta: HTMLElement;
  private readonly garrisonValue: HTMLElement;
  private readonly skillValues: Record<UpgradeKind, HTMLElement>;
  private readonly ratioFill: HTMLElement;
  private readonly ratioLabel: HTMLElement;
  private readonly upgradeButtons: Record<UpgradeKind, UpgradeButton>;
  private readonly notice: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly battleStatus: HTMLElement;
  private readonly zoomBar: HTMLElement;
  private readonly skillButton: HTMLButtonElement;
  private readonly skillRing: SVGCircleElement;
  private readonly skillCenter: HTMLElement;
  private readonly skillName: HTMLElement;
  private readonly skillLevel: HTMLElement;
  private readonly skillDetail: HTMLElement;
  private readonly skillState: HTMLElement;
  private readonly fairMode: boolean;
  private readonly disasterBanner: HTMLElement;
  private readonly disasterCountdown: HTMLElement;
  private readonly stalemateBanner: HTMLElement;
  private readonly stalemateCountdown: HTMLElement;
  /** v1.2 continuous-dispatch controls (solo and versus). */
  private readonly dispatchToggle: HTMLButtonElement | null = null;
  /** One stop control per side (solo has only the blue entry). */
  private readonly stopButtons: Array<{
    side: VersusSide;
    node: HTMLButtonElement;
  }> = [];
  private readonly lineHint: HTMLElement | null = null;
  private hintText: Text | null = null;
  private readonly speedChip: HTMLElement | null = null;
  private readonly onDispatchModeChange:
    | ((mode: DispatchMode) => void)
    | null;
  private readonly onStopLines: ((owner: VersusSide) => void) | null;
  private dispatchMode: DispatchMode = DEFAULT_DISPATCH_MODE;
  private dispatchSignature = '';
  private signature = '';
  private upgradeSignature = '';
  private canvasLabelSignature = '';
  private battleSignature = '';
  private skillSignature = '';
  private disasterSignature = '';
  private stalemateSignature = '';
  private noticeTimer: number | null = null;

  constructor(callbacks: GameScreenCallbacks) {
    this.versus = callbacks.mode === 'versus';
    this.fairMode = callbacks.fairMode === true;
    this.paneCameras = {
      player: { zoom: 1, panX: 0, panY: 0 },
      ai1: { zoom: 1, panX: 0, panY: 0 },
    };
    this.onVersusLayoutChange = callbacks.onVersusLayoutChange || null;
    if (
      this.versus &&
      typeof document !== 'undefined' &&
      document.body &&
      document.body.classList
    ) {
      // Lets CSS expand the 560px app frame into the real landscape viewport
      // without touching the App. Solo never receives this body class.
      document.body.classList.add('is-versus-mode');
      this.bodyVersusClass = true;
    }
    const root = el(
      'section',
      'screen game-screen' + (this.versus ? ' versus-screen' : '')
    );
    root.setAttribute('aria-label', '对局');

    const hud = el('header', 'game-hud');
    const hudTop = el('div', 'hud-top');
    const pause = button('暂停', 'hud-btn pause-btn', callbacks.onPause);
    pause.setAttribute('aria-label', '暂停游戏');

    const timer = el('div', 'timer');
    timer.appendChild(el('span', 'timer-label', '剩余'));
    this.timerValue = el('span', 'timer-value', '03:00');
    timer.appendChild(this.timerValue);

    const rules = button('规则', 'hud-btn rules-btn', callbacks.onRules);
    rules.setAttribute('aria-label', '玩法说明');

    // Dedicated active-skill row under the map (top of the action panel). It is
    // independent of territory selection and stays on screen at level 0, where
    // it explains how to unlock. The root stays clickable while cooling/blocked
    // or locked so a tap always yields an explicit reason toast.
    const skill = button('', 'hud-skill is-locked', callbacks.onBetrayal);
    skill.setAttribute('data-skill', 'betrayal');
    skill.setAttribute('aria-label', '策反');
    const ringWrap = el('span', 'hud-skill-ring');
    const ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ringSvg.setAttribute('viewBox', '0 0 26 26');
    ringSvg.setAttribute('aria-hidden', 'true');
    const ringTrack = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ringTrack.setAttribute('cx', '13');
    ringTrack.setAttribute('cy', '13');
    ringTrack.setAttribute('r', String(SKILL_RING_RADIUS));
    ringTrack.setAttribute('class', 'hud-skill-track');
    this.skillRing = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    this.skillRing.setAttribute('cx', '13');
    this.skillRing.setAttribute('cy', '13');
    this.skillRing.setAttribute('r', String(SKILL_RING_RADIUS));
    this.skillRing.setAttribute('class', 'hud-skill-progress');
    this.skillRing.setAttribute('stroke-dasharray', SKILL_RING_CIRCUMFERENCE.toFixed(2));
    this.skillRing.setAttribute('stroke-dashoffset', SKILL_RING_CIRCUMFERENCE.toFixed(2));
    ringSvg.appendChild(ringTrack);
    ringSvg.appendChild(this.skillRing);
    ringWrap.appendChild(ringSvg);
    this.skillCenter = el('b', 'hud-skill-center', '锁');
    ringWrap.appendChild(this.skillCenter);
    const skillCopy = el('span', 'hud-skill-copy');
    const skillTitle = el('span', 'hud-skill-title');
    this.skillName = el('b', 'hud-skill-name', '策反');
    this.skillLevel = el('i', 'hud-skill-level', 'Lv.0');
    this.skillDetail = el('em', 'hud-skill-detail', '');
    this.skillState = el('span', 'hud-skill-state', '未解锁');
    skillTitle.appendChild(this.skillName);
    skillTitle.appendChild(this.skillLevel);
    skillCopy.appendChild(skillTitle);
    skillCopy.appendChild(this.skillDetail);
    skill.appendChild(ringWrap);
    skill.appendChild(skillCopy);
    skill.appendChild(this.skillState);
    this.skillButton = skill;

    hudTop.appendChild(pause);
    hudTop.appendChild(timer);
    hudTop.appendChild(rules);

    // v1.2 speed chip: always visible in the top row so a player can read the
    // current pace without opening pause. Copy comes from the shell callback.
    const speedChip = el('span', 'speed-chip');
    speedChip.setAttribute('role', 'status');
    speedChip.setAttribute('aria-live', 'polite');
    speedChip.textContent = callbacks.getSpeedLabel ? callbacks.getSpeedLabel() || '' : '';
    hudTop.appendChild(speedChip);
    this.speedChip = speedChip;

    const strip = el('div', 'score-strip');
    const playerChip = el('div', 'score-chip score-player');
    playerChip.appendChild(el('i', 'dot dot-player'));
    playerChip.appendChild(
      el('span', 'score-name', this.versus ? VERSUS_BLUE_NAME : '我方')
    );
    this.playerScore = el('b', 'score-value', '0');
    playerChip.appendChild(this.playerScore);
    this.playerLand = el('em', 'score-land', '0 地');
    playerChip.appendChild(this.playerLand);

    const stripLabel = el('span', 'score-strip-label', '控地分值');

    const enemyChip = el('div', 'score-chip score-enemy');
    enemyChip.appendChild(el('i', 'dot dot-enemy'));
    enemyChip.appendChild(
      el('span', 'score-name', this.versus ? VERSUS_RED_NAME : '敌方')
    );
    this.enemyScore = el('b', 'score-value', '0');
    enemyChip.appendChild(this.enemyScore);
    this.enemyLand = el('em', 'score-land', '0 地');
    enemyChip.appendChild(this.enemyLand);

    strip.appendChild(playerChip);
    strip.appendChild(stripLabel);
    strip.appendChild(enemyChip);
    this.scoreStrip = strip;
    this.stripLabel = stripLabel;
    hud.appendChild(hudTop);
    hud.appendChild(strip);

    // Shared comparison bar: score share plus live force/land totals. Hidden
    // in solo, where the two-chip strip is the established layout.
    this.versusBar = el(
      'div',
      'versus-bar' + (this.versus ? '' : ' is-hidden')
    );
    this.versusBar.setAttribute('role', 'group');
    this.versusBar.setAttribute('aria-label', '双方对比');
    const blueSide = el('div', 'versus-side versus-side-blue');
    blueSide.appendChild(el('span', 'versus-name', VERSUS_BLUE_NAME));
    this.versusBlueCopy = el('em', 'versus-copy', '0 分 · 0 地 · 兵 0');
    blueSide.appendChild(this.versusBlueCopy);
    const versusTrack = el('div', 'versus-track');
    this.versusFill = el('div', 'versus-fill');
    versusTrack.appendChild(this.versusFill);
    const redSide = el('div', 'versus-side versus-side-red');
    redSide.appendChild(el('span', 'versus-name', VERSUS_RED_NAME));
    this.versusRedCopy = el('em', 'versus-copy', '0 分 · 0 地 · 兵 0');
    redSide.appendChild(this.versusRedCopy);
    this.versusBar.appendChild(blueSide);
    this.versusBar.appendChild(versusTrack);
    this.versusBar.appendChild(redSide);
    hud.appendChild(this.versusBar);

    // Warning banner: absolutely positioned under the HUD so showing/hiding it
    // never resizes the map or the action card. It slides in when the core
    // flips `disaster.warned` and stays until `disaster.struck`.
    this.disasterBanner = el('div', 'disaster-banner');
    this.disasterBanner.setAttribute('role', 'status');
    this.disasterBanner.setAttribute('aria-live', 'polite');
    this.disasterBanner.appendChild(el('span', 'disaster-icon', '⚠'));
    this.disasterBanner.appendChild(el('b', 'disaster-title', '天灾来袭'));
    this.disasterCountdown = el('span', 'disaster-count', '');
    this.disasterBanner.appendChild(this.disasterCountdown);
    hud.appendChild(this.disasterBanner);

    this.stalemateBanner = el('div', 'stalemate-banner');
    this.stalemateBanner.setAttribute('role', 'status');
    this.stalemateBanner.setAttribute('aria-live', 'polite');
    this.stalemateBanner.appendChild(el('span', 'stalemate-icon', '⏳'));
    this.stalemateBanner.appendChild(el('b', 'stalemate-title', '战局僵局'));
    this.stalemateCountdown = el('span', 'stalemate-count', '');
    this.stalemateBanner.appendChild(this.stalemateCountdown);
    hud.appendChild(this.stalemateBanner);

    const mapWrap = el('div', 'map-wrap');
    this.mapWrap = mapWrap;
    let canvas: HTMLCanvasElement;
    let panes: VersusPaneSet | null = null;
    let paneHost: HTMLElement | null = null;
    if (this.versus) {
      // Two independent canvases share the engine. DOM order is red then blue
      // so the portrait column reads red-top/blue-bottom; the landscape layout
      // uses row-reverse to put blue left and red right.
      const host = el('div', 'versus-panes');
      const red = new VersusPane({
        side: 'ai1',
        rotation: 180,
        canvasLabel:
          '红方领土战场地图。按住己方红色领地蓄力，拖向己方接壤的领地派兵。',
        onZoomIn: function (): void {
          callbacks.onZoomIn('ai1');
        },
        onZoomOut: function (): void {
          callbacks.onZoomOut('ai1');
        },
        onZoomReset: function (): void {
          callbacks.onZoomReset('ai1');
        },
      });
      const blue = new VersusPane({
        side: 'player',
        rotation: 0,
        canvasLabel:
          '蓝方领土战场地图。按住己方领地蓄力，拖向己方接壤的领地派兵。',
        onZoomIn: function (): void {
          callbacks.onZoomIn('player');
        },
        onZoomOut: function (): void {
          callbacks.onZoomOut('player');
        },
        onZoomReset: function (): void {
          callbacks.onZoomReset('player');
        },
      });
      host.appendChild(red.el);
      host.appendChild(blue.el);
      mapWrap.className = 'map-wrap versus-map';
      mapWrap.appendChild(host);
      panes = { blue: blue, red: red };
      paneHost = host;
      canvas = blue.canvas;
    } else {
      canvas = el('canvas', 'battle-canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute(
        'aria-label',
        '领土战场地图。按住己方领地蓄力，拖向己方接壤的领地派兵；选中领地可升级产兵、行军或城防。'
      );
      canvas.appendChild(
        document.createTextNode('当前浏览器不支持 Canvas，无法显示战场地图。')
      );
      mapWrap.appendChild(canvas);
    }
    this.canvas = canvas;
    this.panes = panes;
    this.paneHost = paneHost;
    if (panes) {
      panes.blue.setCamera(this.paneCameras.player);
      panes.red.setCamera(this.paneCameras.ai1);
    }
    this.applyPaneOrientation();
    if (
      this.versus &&
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
      const self = this;
      this.paneResizeHandler = function () {
        self.applyPaneOrientation();
      };
      window.addEventListener('resize', this.paneResizeHandler);
    }
    this.hint = el('div', 'map-hint');
    this.hint.appendChild(el('span', 'hint-dot'));
    // The text node is kept so the drag hint can follow the dispatch mode
    // (single/continuous) instead of repeating the seed copy forever.
    this.hintText = document.createTextNode(
      dispatchModeHint(DEFAULT_DISPATCH_MODE)
    );
    this.hint.appendChild(this.hintText);
    this.notice = el('div', 'notice');
    this.notice.setAttribute('role', 'status');
    this.notice.setAttribute('aria-live', 'polite');

    // v1.2 dispatch controls sit directly above the map so the mode and the
    // selected territory's lines are discoverable before any drag happens.
    this.onDispatchModeChange = callbacks.onDispatchModeChange || null;
    this.onStopLines = callbacks.onStopLines || null;
    const dispatchBar = el('div', 'dispatch-bar');
    dispatchBar.setAttribute('role', 'group');
    dispatchBar.setAttribute('aria-label', '派兵方式');
    const toggle = button('', 'dispatch-toggle', () => {
      this.toggleDispatchMode();
    });
    toggle.setAttribute('aria-label', '切换派兵方式');
    toggle.setAttribute('data-mode', DEFAULT_DISPATCH_MODE);
    dispatchBar.appendChild(toggle);
    this.dispatchToggle = toggle;

    if (!this.versus) {
      const stop = button('停止兵线', 'dispatch-stop is-hidden', () => {
        if (this.onStopLines) this.onStopLines('player');
      });
      stop.setAttribute('aria-label', '停止选中领地的兵线');
      dispatchBar.appendChild(stop);
      this.stopButtons.push({ side: 'player', node: stop });
    } else {
      // Versus: one stop control per pane, so each side stops only its own
      // lines and neither can reach across the divider.
      const blueStop = button('停止兵线', 'dispatch-stop is-hidden', () => {
        if (this.onStopLines) this.onStopLines('player');
      });
      blueStop.setAttribute('aria-label', VERSUS_BLUE_NAME + '停止选中领地的兵线');
      blueStop.setAttribute('data-side', 'player');
      dispatchBar.appendChild(blueStop);
      this.stopButtons.push({ side: 'player', node: blueStop });
      const redStop = button('停止兵线', 'dispatch-stop is-hidden', () => {
        if (this.onStopLines) this.onStopLines('ai1');
      });
      redStop.setAttribute('aria-label', VERSUS_RED_NAME + '停止选中领地的兵线');
      redStop.setAttribute('data-side', 'ai1');
      dispatchBar.appendChild(redStop);
      this.stopButtons.push({ side: 'ai1', node: redStop });
    }
    this.lineHint = el(
      'p',
      'dispatch-hint',
      dispatchModeHint(DEFAULT_DISPATCH_MODE)
    );
    dispatchBar.appendChild(this.lineHint);

    this.tutorialBannerHost = el('div', 'tutorial-banner-host');

    const zoomBar = el('div', 'map-zoom is-hidden');
    zoomBar.setAttribute('role', 'group');
    zoomBar.setAttribute('aria-label', '地图缩放');
    const zoomIn = button('+', 'map-zoom-btn', callbacks.onZoomIn);
    zoomIn.setAttribute('aria-label', '放大地图');
    const zoomOut = button('−', 'map-zoom-btn', callbacks.onZoomOut);
    zoomOut.setAttribute('aria-label', '缩小地图');
    const zoomReset = button('复位', 'map-zoom-reset', callbacks.onZoomReset);
    zoomReset.setAttribute('aria-label', '地图恢复全图');
    zoomBar.appendChild(zoomIn);
    zoomBar.appendChild(zoomOut);
    zoomBar.appendChild(zoomReset);
    this.zoomBar = zoomBar;

    if (!this.versus) {
      mapWrap.appendChild(zoomBar);
      mapWrap.appendChild(this.hint);
    }
    mapWrap.appendChild(this.notice);

    const panel = el('section', 'action-panel');
    panel.setAttribute('aria-label', '驻军与升级操作卡');
    // Always first in the panel: the skill never depends on the selection and
    // never collapses when the action head shows "未选择领地".
    panel.appendChild(skill);

    const head = el('div', 'action-head');
    const sourceBlock = el('div', 'source-block');
    this.sourceName = el('p', 'source-name', '未选择领地');
    this.sourceMeta = el('p', 'source-meta', sourceMetaText(null));
    sourceBlock.appendChild(this.sourceName);
    sourceBlock.appendChild(this.sourceMeta);

    const garrison = el('div', 'garrison-block');
    garrison.appendChild(el('span', 'garrison-label', '驻军'));
    this.garrisonValue = el('b', 'garrison-value', '--/--');
    garrison.appendChild(this.garrisonValue);
    head.appendChild(sourceBlock);
    head.appendChild(garrison);

    // Three always-present tracks. The row has a fixed height and every value
    // is one ellipsized line, so it cannot push the canvas when the selection
    // or its wall level changes.
    const skillRow = el('div', 'skill-row');
    skillRow.setAttribute('role', 'group');
    skillRow.setAttribute('aria-label', '领地属性');
    this.skillValues = {} as Record<UpgradeKind, HTMLElement>;
    for (let i = 0; i < UPGRADE_KINDS.length; i += 1) {
      const kind = UPGRADE_KINDS[i];
      const cell = el('div', 'skill-cell skill-' + kind);
      cell.appendChild(el('span', 'skill-label', UPGRADE_LABEL[kind]));
      const value = el('b', 'skill-value', '--');
      cell.appendChild(value);
      skillRow.appendChild(cell);
      this.skillValues[kind] = value;
    }

    const ratioRow = el('div', 'ratio-row');
    const ratioTrack = el('div', 'ratio-track');
    this.ratioFill = el('div', 'ratio-fill');
    ratioTrack.appendChild(this.ratioFill);
    this.ratioLabel = el('span', 'ratio-label', '按住蓄力');
    ratioRow.appendChild(ratioTrack);
    ratioRow.appendChild(this.ratioLabel);

    const foot = el('div', 'action-foot upgrade-row');    foot.setAttribute('role', 'group');
    foot.setAttribute('aria-label', '升级选项');
    this.upgradeButtons = {} as Record<UpgradeKind, UpgradeButton>;
    for (let i = 0; i < UPGRADE_KINDS.length; i += 1) {
      const kind = UPGRADE_KINDS[i];
      const upgrade = button('', 'upgrade-btn upgrade-btn-track', function () {
        callbacks.onUpgrade(kind);
      });
      upgrade.disabled = true;
      upgrade.setAttribute('data-kind', kind);
      const iconHost = el('span', 'upgrade-icon-host');
      const main = el('span', 'upgrade-main', UPGRADE_LABEL[kind]);
      const sub = el('span', 'upgrade-sub', '选地');
      upgrade.appendChild(iconHost);
      upgrade.appendChild(main);
      upgrade.appendChild(sub);
      foot.appendChild(upgrade);
      // Build each icon once. Only the defense track swaps its SVG later, and
      // only when the selected territory's level actually changes.
      iconHost.appendChild(iconFor(kind, 0));
      this.upgradeButtons[kind] = {
        root: upgrade,
        main: main,
        sub: sub,
        iconHost: iconHost,
        iconLevel: kind === 'defense' ? 0 : -1,
        className: '',
        disabled: true,
        subText: '选地',
        ariaLabel: '',
      };
    }

    panel.appendChild(head);
    panel.appendChild(skillRow);
    panel.appendChild(ratioRow);
    // Local versus has no battlefield economy: the row stays in the tree for
    // stable diagnostics/tests but is hidden and unreachable. `.upgrade-row`
    // sets `display: grid`, so a hidden attribute alone would not win; the
    // inline display is the in-component lock. handleUpgrade is guarded too.
    if (this.versus) {
      foot.className = 'action-foot upgrade-row is-hidden';
      foot.style.display = 'none';
      foot.setAttribute('aria-hidden', 'true');
    }
    panel.appendChild(foot);

    this.battleStatus = el('div', 'sr-only battle-status');
    this.battleStatus.setAttribute('aria-live', 'off');

    root.appendChild(hud);
    root.appendChild(dispatchBar);
    root.appendChild(this.tutorialBannerHost);
    root.appendChild(mapWrap);
    // Versus replaces the single blue action panel with the two pane strips;
    // the panel stays built (and detached) for the solo path only.
    if (!this.versus) root.appendChild(panel);
    root.appendChild(this.battleStatus);
    this.el = root;
  }

  update(
    view: MatchView,
    gesture: GestureState,
    selectedId: string | null,
    upgrades?: Record<UpgradeKind, UpgradeEvaluationDetail | null>,
    hud?: HudSnapshot,
    gestures?: readonly GestureState[],
    paneSelections?: Partial<Record<VersusSide, string | null>>,
    dispatch?: DispatchPanelState
  ): void {
    const activeGestures = activeGestureList(gesture, gestures);
    // Versus has two hands but one action panel owned by blue: the panel and
    // the ratio bar mirror blue's slot, while the canvas draws every slot.
    const panelGesture = this.versus
      ? gestureForOwner(activeGestures, 'player') || IDLE_GESTURE
      : gesture;
    const active = panelGesture.phase !== 'idle';
    const gestureSource = active ? findTerritory(view, panelGesture.sourceId) : null;
    const selected = findTerritory(view, selectedId);
    const source = gestureSource || selected;
    const ratio = active ? panelGesture.ratio : 0;
    const remaining = remainingSeconds(view);
    const playerLand = view.territoryCounts.player;
    // AI totals span every seated AI faction; ai3 contributes 0 in a 2/3-way
    // match, so the legacy two-side numbers are unchanged.
    const enemyLand = aiTerritoriesOf(view);
    const enemyScore = aiScoreOf(view);
    const blueForce = forceForOwner(view, 'player');
    const redForce = forceForOwner(view, 'ai1');
    if (!this.versus) {
      const wideMap = view.mapWidth > view.mapHeight * 0.85;
      const zoomClass = 'map-zoom' + (wideMap ? '' : ' is-hidden');
      if (this.zoomBar.className !== zoomClass) this.zoomBar.className = zoomClass;
    }

    const evaluationSignature = UPGRADE_KINDS.map(function (kind) {
      const evaluation = upgrades ? upgrades[kind] : null;
      return evaluation
        ? [
            evaluation.ok ? '1' : '0',
            evaluation.currentLevel,
            evaluation.nextLevel,
            evaluation.cost,
            evaluation.reason || '',
          ].join(':')
        : '-';
    }).join(',');

    // Every live slot feeds the HUD signature, so the red hand charging alone
    // still refreshes the shared ratio line even though blue owns the panel.
    const gestureSignature = activeGestures
      .map(function (slot) {
        return [
          slot.owner || '',
          slot.phase,
          Math.round(slot.ratio * 100),
          slot.frozen ? '1' : '0',
          slot.targetId || '',
          slot.targetOk ? '1' : '0',
          slot.sent,
          slot.remaining,
        ].join(':');
      })
      .join(';');

    const signature = [
      view.tick,
      view.status,
      view.result || '',
      selectedId || '',
      panelGesture.phase,
      gestureSignature,
      Math.round(ratio * 100),
      active ? panelGesture.sent : 0,
      active ? panelGesture.remaining : source ? source.troops : 0,
      panelGesture.targetId || '',
      panelGesture.targetOk ? '1' : '0',
      source
        ? [
            source.id,
            source.troops,
            source.capacity,
            source.productionLevel,
            source.marchLevel,
            source.defenseLevel,
            source.shield,
            source.shieldCapacity,
          ].join(':')
        : '',
      playerLand,
      enemyLand,
      view.scores.player,
      enemyScore,
      blueForce,
      redForce,
      remaining,
      evaluationSignature,
    ].join('|');

    if (signature !== this.signature) {
      this.signature = signature;
      setText(this.timerValue, formatClock(remaining));
      const timerClass =
        'timer-value' + (remaining <= 30 && view.status === 'playing' ? ' is-low' : '');
      if (this.timerValue.className !== timerClass) this.timerValue.className = timerClass;
      setText(this.playerScore, String(view.scores.player));
      setText(this.enemyScore, String(enemyScore));
      setText(this.playerLand, playerLand + ' 地');
      setText(this.enemyLand, enemyLand + ' 地');
      setAttr(this.playerScore, 'data-score', String(view.scores.player));
      setAttr(this.enemyScore, 'data-score', String(enemyScore));
      this.updateVersusBar(view, blueForce, redForce);

      const fillWidth = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
      this.ratioFill.style.width = fillWidth + '%';
      this.ratioFill.className =
        'ratio-fill' + (panelGesture.frozen && active ? ' is-frozen' : '');

      if (source) {
        const index = territoryIndex(view, source.id);
        setText(
          this.sourceName,
          pad2(index + 1) + ' · ' + (source.name || TERRAIN_LABEL[source.terrain])
        );
        let meta = sourceMetaText(source);
        if (source.owner === 'player' && playerHasActiveAlly(view)) {
          meta += ' · 从己方直接拖向盟友前沿后的绿色目标';
        }
        if (active && panelGesture.phase === 'dragging' && panelGesture.targetId) {
          const target = findTerritory(view, panelGesture.targetId);
          if (panelGesture.targetOk && target) {
            meta =
              forecastText(panelGesture.targetForecast) +
              ' · 目标 ' +
              pad2(territoryIndex(view, target.id) + 1);
            const movement = panelGesture.targetPlannedMovement;
            // The shared plan owns the actual crossed frontier and route. The
            // copy names that frozen frontier so a cross-border drag never
            // looks like a straight-line source-to-target shortcut.
            const passage = routePassageText(view, movement);
            if (passage) meta += ' · ' + passage;
            if (movement && !movement.direct && !passage) {
              const frontier = findTerritory(view, movement.frontierId);
              meta +=
                ' · 经前线 ' +
                (frontier ? frontier.name || frontier.shortName || movement.frontierId : movement.frontierId);
            }
            if (movement && movement.bridgeFactor > 1.0001) {
              meta += ' · 桥梁 ×' + movement.bridgeFactor.toFixed(2);
            }
            const shield = target.shield > 0 ? ' · 城防 ' + target.shield : '';
            meta +=
              ' · ' + TERRAIN_LABEL[target.terrain] + ' ' + terrainDefenseLabel(target.terrain) + shield;
          } else {
            meta = routeFailureText(panelGesture.targetRoute) || moveReasonText(
              panelGesture.targetReason,
              playerHasActiveAlly(view)
            );
          }
        } else if (active) {
          meta = '蓄力 ' + formatPercent(ratio) + ' · 留守 ' + panelGesture.remaining;
        }
        setText(this.sourceMeta, meta);
        setText(this.garrisonValue, source.troops + '/' + source.capacity);
      } else {
        setText(this.sourceName, '未选择领地');
        setText(this.sourceMeta, sourceMetaText(null));
        setText(this.garrisonValue, '--/--');
      }
      for (let i = 0; i < UPGRADE_KINDS.length; i += 1) {
        const kind = UPGRADE_KINDS[i];
        setText(this.skillValues[kind], skillValueText(kind, source));
      }

      if (this.versus && activeGestures.length > 0) {
        // Both hands share one line: each slot keeps its own ratio, so neither
        // player has to read the other's charge from the other's panel.
        setText(this.ratioLabel, versusRatioText(activeGestures));
      } else if (active) {
        setText(
          this.ratioLabel,
          panelGesture.frozen
            ? '已锁定 ' + formatPercent(ratio)
            : '蓄力 ' + formatPercent(ratio) + ' · ' + (panelGesture.holdMs / 1000).toFixed(1) + '秒'
        );
      } else {
        setText(this.ratioLabel, '按住蓄力');
      }

    }

    // Both pane strips update independently of the shared score signature, so
    // a red-only selection or charge still reaches the red HUD this frame.
    if (this.panes) {
      this.updateVersusPanes(
        view,
        activeGestures,
        selectedId,
        paneSelections,
        blueForce,
        redForce
      );
    }

    // The faction strip also updates independently of the shared signature:
    // an aliveOwners/armies-only change (troops in flight deciding survival)
    // must still reach the chips. Self-guarded by its own signature.
    this.updateFactionStrip(view);

    // Upgrade buttons only re-evaluate when their inputs change. A plain tick
    // or a live hold animation leaves all three SVGs/text untouched.
    const upgradeUiSignature = [
      view.status,
      selected ? selected.id : '',
      selected ? selected.owner : '',
      selected ? selected.defenseLevel : 0,
      selected ? selected.troops : 0,
      evaluationSignature,
    ].join('|');
    if (!this.versus && upgradeUiSignature !== this.upgradeSignature) {
      this.upgradeSignature = upgradeUiSignature;
      for (let i = 0; i < UPGRADE_KINDS.length; i += 1) {
        const kind = UPGRADE_KINDS[i];
        const evaluation = upgrades ? upgrades[kind] : null;
        this.renderUpgrade(kind, evaluation, selected, view);
      }
    }

    // Canvas label changes only with map/status/land, never with a charging
    // ratio. Battle narration is throttled to one second plus real events.
    // The label speaks per-faction land in a 3/4-way match, so every faction
    // count joins the signature: an AI-vs-AI flip leaves the player total,
    // the AI aggregate and the neutral pool untouched, and without these
    // entries the aria-label would freeze on the pre-flip distribution.
    const neutral = Math.max(0, view.territories.length - playerLand - enemyLand);
    const canvasLabelSignature = [
      view.mapName,
      view.geog ? view.geog.regionLabel : '',
      view.geography ? view.geography.regionLabel : '',
      view.status,
      playerLand,
      enemyLand,
      neutral,
      view.territoryCounts.ai1,
      view.territoryCounts.ai2,
      view.territoryCounts.ai3 === undefined ? 0 : view.territoryCounts.ai3,
    ].join('|');
    if (canvasLabelSignature !== this.canvasLabelSignature) {
      this.canvasLabelSignature = canvasLabelSignature;
      this.updateCanvasLabel(view, playerLand, enemyLand);
    }

    const battleSignature =
      Math.floor(view.tick / 10) +
      '|' +
      view.status +
      '|' +
      (view.result || '') +
      '|' +
      view.armies.length +
      '|' +
      playerLand +
      '|' +
      enemyLand;
    if (battleSignature !== this.battleSignature) {
      this.battleSignature = battleSignature;
      this.battleStatus.textContent = this.describeBattle(view, remaining);
      setAttr(this.el, 'data-status', view.status);
      setAttr(this.el, 'data-tick', String(view.tick));
      setAttr(this.el, 'data-player-land', String(playerLand));
      setAttr(this.el, 'data-enemy-land', String(enemyLand));
    }

    this.updateSkill(view, hud);
    this.updateDisasterBanner(hud);
    this.updateStalemateBanner(view);
    if (dispatch) this.renderDispatchPanel(dispatch);
  }

  /**
   * Mirrors the shell's dispatch state into the always-visible bar. The stop
   * control only appears when the selected territory owns a line, so the
   * button can never be a no-op that looks broken.
   */
  private renderDispatchPanel(state: DispatchPanelState): void {
    this.dispatchMode = state.mode;
    const signature = [
      state.mode,
      state.sendCount,
      state.incomingCount,
      state.stopLabel || '',
      state.linesAvailable ? '1' : '0',
      state.speedLabel || '',
    ].join('|');
    const toggle = this.dispatchToggle;
    if (toggle) {
      const className =
        'dispatch-toggle' + (state.mode === 'continuous' ? ' is-continuous' : ' is-single');
      if (toggle.className !== className) toggle.className = className;
      const label = dispatchModeLabel(state.mode);
      setText(toggle, label);
      setAttr(toggle, 'aria-pressed', String(state.mode === 'continuous'));
      setAttr(toggle, 'data-mode', state.mode);
      const aria =
        label + '，' +
        dispatchModeHint(state.mode) +
        (state.linesAvailable ? '' : '（当前核心不支持兵线）');
      if (toggle.getAttribute('aria-label') !== aria) toggle.setAttribute('aria-label', aria);
    }
    if (this.lineHint) setText(this.lineHint, state.hint);
    this.setMapHint(state.mode);
    // Versus has one stop control per side; solo has a single blue control.
    for (let i = 0; i < this.stopButtons.length; i += 1) {
      const entry = this.stopButtons[i];
      const label = entry.side === 'ai1' ? state.stopLabelRed || null : state.stopLabel;
      const visible = label !== null;
      const className = 'dispatch-stop' + (visible ? '' : ' is-hidden');
      if (entry.node.className !== className) entry.node.className = className;
      setAttr(entry.node, 'aria-hidden', visible ? 'false' : 'true');
      if (visible) {
        setText(
          entry.node,
          this.versus
            ? (entry.side === 'ai1' ? VERSUS_RED_NAME : VERSUS_BLUE_NAME) + '停止兵线'
            : (label as string)
        );
      }
      entry.node.disabled = !visible;
    }
    if (this.speedChip && state.speedLabel !== null) {
      setText(this.speedChip, state.speedLabel);
    }
    this.dispatchSignature = signature;
  }

  /** Changes the local mode immediately; the shell owns persistence. */
  toggleDispatchMode(): DispatchMode {
    const next: DispatchMode =
      this.dispatchMode === 'continuous' ? 'single' : 'continuous';
    this.dispatchMode = next;
    if (this.dispatchToggle) {
      const className =
        'dispatch-toggle' + (next === 'continuous' ? ' is-continuous' : ' is-single');
      this.dispatchToggle.className = className;
      setText(this.dispatchToggle, dispatchModeLabel(next));
      setAttr(this.dispatchToggle, 'aria-pressed', String(next === 'continuous'));
      setAttr(this.dispatchToggle, 'data-mode', next);
    }
    if (this.lineHint) setText(this.lineHint, dispatchModeHint(next));
    this.setMapHint(next);
    if (this.onDispatchModeChange) this.onDispatchModeChange(next);
    return next;
  }

  /** Current local mode (the shell's persisted value wins at next start). */
  getDispatchMode(): DispatchMode {
    return this.dispatchMode;
  }

  /** Re-syncs the toggle from the shell (restart/pause changes). */
  setDispatchMode(mode: DispatchMode): void {
    if (mode === this.dispatchMode) return;
    this.dispatchMode = mode;
    if (this.dispatchToggle) {
      const className =
        'dispatch-toggle' + (mode === 'continuous' ? ' is-continuous' : ' is-single');
      this.dispatchToggle.className = className;
      setText(this.dispatchToggle, dispatchModeLabel(mode));
      setAttr(this.dispatchToggle, 'aria-pressed', String(mode === 'continuous'));
      setAttr(this.dispatchToggle, 'data-mode', mode);
    }
    if (this.lineHint) setText(this.lineHint, dispatchModeHint(mode));
    this.setMapHint(mode);
  }

  /**
   * The map-bottom drag hint must state the current mode's real gesture:
   * single = one charged dispatch, continuous = establish/stop a line. The
   * seed copy never updates itself, which is exactly the stale-hint bug this
   * method fixes on toggle, shell re-sync and per-frame panel renders.
   */
  private setMapHint(mode: DispatchMode): void {
    if (!this.hintText) return;
    const text = dispatchModeHint(mode);
    if (this.hintText.textContent !== text) this.hintText.textContent = text;
  }

  /** Portrait: red top / blue bottom. Landscape: blue left / red right. */
  private applyPaneOrientation(): void {
    if (!this.paneHost) return;
    // Prefer the real pane area once attached; fall back to the viewport only
    // before layout exists. Never guess orientation from a stale global flag.
    let width = 0;
    let height = 0;
    if (typeof this.paneHost.getBoundingClientRect === 'function') {
      const rect = this.paneHost.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
    }
    if (
      (width <= 0 || height <= 0) &&
      typeof window !== 'undefined' &&
      typeof window.innerWidth === 'number' &&
      typeof window.innerHeight === 'number'
    ) {
      width = window.innerWidth;
      height = window.innerHeight;
    }
    const orientation = versusPaneOrientation(width, height);
    const previous = this.paneOrientation;
    this.paneOrientation = orientation;
    this.paneHost.setAttribute('data-orientation', orientation);
    if (this.panes) {
      // Portrait red is upside-down for the top player; landscape keeps both
      // boards upright. Pointer bindings read pane.rotation every event.
      this.panes.blue.setRotation(0);
      this.panes.red.setRotation(orientation === 'portrait' ? 180 : 0);
    }
    if (previous !== null && previous !== orientation && this.onVersusLayoutChange) {
      // The App cancels both gesture controllers here; pane rects changed.
      this.onVersusLayoutChange(orientation);
    }
  }

  /** Reflects one side's camera; the App owns the actual renderer camera. */
  setPaneCamera(side: VersusSide, camera: CameraState): void {
    const next: CameraState = {
      zoom: isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1,
      panX: isFinite(camera.panX || 0) ? camera.panX || 0 : 0,
      panY: isFinite(camera.panY || 0) ? camera.panY || 0 : 0,
    };
    this.paneCameras[side] = next;
    if (!this.panes) return;
    const pane = side === 'player' ? this.panes.blue : this.panes.red;
    pane.setCamera(next);
  }

  /**
   * Each side reads its own owner-bound gesture and selection. The shared
   * selectedId remains the blue fallback so the old App call still works.
   */
  private updateVersusPanes(
    view: MatchView,
    gestures: readonly GestureState[],
    selectedId: string | null,
    selections: Partial<Record<VersusSide, string | null>> | undefined,
    blueForce: number,
    redForce: number
  ): void {
    if (!this.panes) return;
    const blueSelected =
      selections && selections.player !== undefined
        ? selections.player
        : selectedId;
    const redSelected =
      selections && selections.ai1 !== undefined ? selections.ai1 : null;
    this.panes.blue.update(
      this.versusPaneInfo(
        view,
        gestureForOwner(gestures, 'player'),
        blueSelected,
        view.scores.player,
        view.territoryCounts.player,
        blueForce
      )
    );
    this.panes.red.update(
      this.versusPaneInfo(
        view,
        gestureForOwner(gestures, 'ai1'),
        redSelected,
        view.scores.ai1,
        view.territoryCounts.ai1,
        redForce
      )
    );
  }

  private versusPaneInfo(
    view: MatchView,
    gesture: GestureState | null,
    selectedId: string | null,
    score: number,
    land: number,
    force: number
  ): VersusPaneInfo {
    const gestureSource =
      gesture && gesture.phase !== 'idle'
        ? findTerritory(view, gesture.sourceId)
        : null;
    const selected = findTerritory(view, selectedId);
    const source = gestureSource || selected;
    let selection = '未选择领地';
    let troops = '--/--';
    let charge = '点按己方领地';
    if (source) {
      selection =
        pad2(territoryIndex(view, source.id) + 1) +
        ' · ' +
        (source.name || TERRAIN_LABEL[source.terrain]);
      troops = source.troops + '/' + source.capacity;
      charge = '按住蓄力';
    }
    if (gesture && gesture.phase !== 'idle') {
      charge =
        (gesture.frozen ? '已锁定 ' : '蓄力 ') + formatPercent(gesture.ratio);
      if (gesture.targetId) {
        const target = findTerritory(view, gesture.targetId);
        if (gesture.targetOk && target) {
          charge += ' → ' + pad2(territoryIndex(view, target.id) + 1);
        } else if (gesture.targetReason) {
          charge +=
            ' · ' + moveReasonText(gesture.targetReason, playerHasActiveAlly(view));
        }
      }
    }
    return {
      score: score,
      land: land,
      force: force,
      selection: selection,
      troops: troops,
      charge: charge,
    };
  }

  /**
   * Score share drives the fill; force and land totals sit on each side so the
   * shared HUD answers "who is ahead" for both players without a third panel.
   */
  private updateVersusBar(view: MatchView, blueForce: number, redForce: number): void {
    if (!this.versus) return;
    const blueScore = view.scores.player;
    const redScore = view.scores.ai1;
    const total = blueScore + redScore;
    const share = total > 0 ? blueScore / total : 0.5;
    const signature = [
      blueScore,
      redScore,
      view.territoryCounts.player,
      view.territoryCounts.ai1,
      blueForce,
      redForce,
    ].join('|');
    if (signature === this.versusSignature) return;
    this.versusSignature = signature;
    this.versusFill.style.width =
      Math.round(Math.max(0, Math.min(1, share)) * 100) + '%';
    setText(
      this.versusBlueCopy,
      blueScore +
        ' 分 · ' +
        view.territoryCounts.player +
        ' 地 · 兵 ' +
        blueForce
    );
    setText(
      this.versusRedCopy,
      redScore +
        ' 分 · ' +
        view.territoryCounts.ai1 +
        ' 地 · 兵 ' +
        redForce
    );
  }

  /**
   * Per-faction HUD (v1.4). In a 3/4-faction free-for-all the two-chip strip
   * cannot answer "who is ahead", so it is rebuilt once into one compact chip
   * per seated faction (score / land / eliminated). The roster comes from the
   * match-fixed `activeOwners` via ui/factions.ts and never shrinks when a
   * faction holds no territory. A 2-faction solo or versus match keeps the
   * established legacy layout untouched.
   */
  private updateFactionStrip(view: MatchView): void {
    if (this.versus) return;
    const factions = activeFactions(view);
    if (factions.length <= 2) return;

    const rosterKey = factions.join('>');
    const allySeconds: number[] = [];
    const parts: string[] = [rosterKey];
    for (let i = 0; i < factions.length; i += 1) {
      const owner = factions[i];
      const seconds = playerAllySecondsLeft(view, owner);
      allySeconds.push(seconds);
      parts.push(
        factionScoreOf(view, owner) +
          ':' +
          factionTerritoriesOf(view, owner) +
          ':' +
          (isFactionAlive(view, owner) ? '1' : '0') +
          ':' +
          seconds
      );
    }
    const signature = parts.join('|');
    if (signature === this.factionSignature && this.factionRosterKey === rosterKey) return;
    this.factionSignature = signature;
    this.factionRosterKey = rosterKey;

    if (!this.factionChips) this.buildFactionStrip(factions);

    const chips = this.factionChips as NonNullable<typeof this.factionChips>;
    for (let i = 0; i < chips.length; i += 1) {
      const entry = chips[i];
      const alive = isFactionAlive(view, entry.owner);
      const score = factionScoreOf(view, entry.owner);
      const land = factionTerritoriesOf(view, entry.owner);
      // The ally badge counts down only while the faction is still alive and
      // the player-to-faction truce is active; break/expire/elimination clear
      // it, and a paused match freezes it (the tick stops moving).
      const seconds = allySeconds[i];
      const allyActive = alive && seconds > 0;
      setText(entry.score, String(score));
      setText(entry.land, alive ? land + ' 地' : '已淘汰');
      setAttr(entry.score, 'data-score', String(score));
      setAttr(entry.chip, 'data-faction', entry.owner);
      setAttr(entry.chip, 'data-alive', alive ? 'true' : 'false');
      setAttr(entry.chip, 'data-ally', allyActive ? 'true' : 'false');
      if (allyActive) {
        setText(entry.ally, '盟友 · ' + seconds + 's');
        entry.ally.className = 'score-ally';
      } else {
        // Clear the text too, so narrators and DOM reads never see a stale
        // countdown after break/expire/elimination.
        setText(entry.ally, '');
        entry.ally.className = 'score-ally is-hidden';
      }
      const chipClass =
        'score-chip score-faction' +
        (alive ? '' : ' is-out') +
        (allyActive ? ' is-ally' : '');
      if (entry.chip.className !== chipClass) entry.chip.className = chipClass;
      setAttr(
        entry.chip,
        'aria-label',
        factionDisplayName(entry.owner) +
          '，控地分值 ' +
          score +
          '，' +
          (alive ? '领地 ' + land : '已淘汰') +
          (allyActive ? '，盟友剩余 ' + seconds + ' 秒' : '')
      );
    }
    setAttr(this.scoreStrip, 'data-faction-count', String(factions.length));
  }

  /** One-time rebuild of the strip DOM for a multi-faction roster. */
  private buildFactionStrip(factions: readonly FactionOwner[]): void {
    const strip = this.scoreStrip;
    strip.className = 'score-strip score-strip-multi';
    while (strip.firstChild) strip.removeChild(strip.firstChild);
    const chips: NonNullable<typeof this.factionChips> = [];
    for (let i = 0; i < factions.length; i += 1) {
      const owner = factions[i];
      const chip = el('div', 'score-chip score-faction');
      chip.appendChild(el('i', 'dot dot-faction-' + owner));
      chip.appendChild(el('span', 'score-name', factionDisplayName(owner)));
      const score = el('b', 'score-value', '0');
      chip.appendChild(score);
      const land = el('em', 'score-land', '0 地');
      chip.appendChild(land);
      // Ally badge: shown only for the player's active truce partner; the
      // faction dot, colour, score and land stay independent and untouched.
      const ally = el('em', 'score-ally is-hidden');
      chip.appendChild(ally);
      strip.appendChild(chip);
      chips.push({
        owner: owner,
        chip: chip,
        score: score,
        land: land,
        ally: ally,
      });
    }
    // Kept for screen readers and future layouts; hidden by CSS in multi mode.
    strip.appendChild(this.stripLabel);
    this.factionChips = chips;
  }

  private updateSkill(view: MatchView, hud?: HudSnapshot): void {
    const state = betrayalHudState({
      level: hud ? hud.skill.betrayalLevel : 0,
      tick: hud ? hud.tick : view.tick,
      readyTick: hud ? hud.skill.readyTick : 0,
      uses: hud ? hud.skill.uses : 0,
      status: view.status,
      enemyTerritories: aiTerritoriesOf(view),
      fairMode: this.fairMode,
    });
    // Versus has no AI rival to betray: keep the core skill state untouched but
    // never show its control to either player.
    const visible = this.versus ? false : state.visible;
    // The ring advances every simulation tick (10 Hz); text and classes only
    // change when their own values do, so a steady frame never touches the DOM
    // beyond this signature comparison.
    const signature = [
      visible ? '1' : '0',
      state.phase,
      state.reason,
      state.level,
      state.cooldownSeconds,
      state.stateLabel,
      state.detailLabel,
      Math.round(state.readyProgress * 1000),
    ].join('|');
    if (signature === this.skillSignature) return;
    this.skillSignature = signature;

    const className =
      'hud-skill' +
      (visible ? '' : ' is-hidden') +
      ' is-' +
      state.phase;
    if (this.skillButton.className !== className) this.skillButton.className = className;
    setAttr(this.skillButton, 'aria-hidden', visible ? 'false' : 'true');
    setAttr(this.skillButton, 'data-phase', state.phase);
    setAttr(this.skillButton, 'data-reason', state.reason);
    setAttr(this.skillButton, 'data-level', String(state.level));
    setAttr(this.skillButton, 'data-quota', String(state.quota));
    setAttr(this.skillButton, 'data-cooldown', String(state.cooldownSeconds));
    setAttr(
      this.skillButton,
      'aria-disabled',
      state.phase === 'ready' ? 'false' : 'true'
    );
    // Level 0 names the missing unlock in the title; a real level keeps its
    // Lv badge next to the skill name.
    const title =
      state.reason === 'fair_mode'
        ? '策反 · 公平模式'
        : state.reason === 'locked'
          ? '策反 · 未解锁'
          : '策反';
    setText(this.skillName, title);
    setText(this.skillLevel, state.level > 0 ? state.levelLabel : '');
    setText(this.skillDetail, state.detailLabel);
    setText(this.skillState, state.stateLabel);
    setText(
      this.skillCenter,
      state.phase === 'cooldown'
        ? state.cooldownSeconds > 99
          ? '99+'
          : String(state.cooldownSeconds)
        : state.reason === 'fair_mode'
          ? '禁'
          : state.reason === 'locked'
            ? '锁'
            : '策'
    );
    setAttr(
      this.skillRing,
      'stroke-dashoffset',
      (SKILL_RING_CIRCUMFERENCE * (1 - state.readyProgress)).toFixed(2)
    );
    this.skillButton.setAttribute('aria-label', state.ariaLabel);
  }

  private updateDisasterBanner(hud?: HudSnapshot): void {
    const warned =
      !!hud && hud.disaster.warned && !hud.disaster.struck && hud.disaster.scheduledAtTick !== null;
    const seconds =
      warned && hud && hud.disaster.scheduledAtTick !== null
        ? Math.max(
            0,
            Math.ceil((hud.disaster.scheduledAtTick - hud.tick) / TICKS_PER_SECOND)
          )
        : 0;
    const signature = (warned ? '1' : '0') + '|' + seconds;
    if (signature === this.disasterSignature) return;
    this.disasterSignature = signature;
    const className = 'disaster-banner' + (warned ? ' is-visible' : '');
    if (this.disasterBanner.className !== className) this.disasterBanner.className = className;
    setText(this.disasterCountdown, warned ? seconds + ' 秒后降临' : '');
  }

  private updateStalemateBanner(view: MatchView): void {
    const last =
      typeof view.lastProgressTick === 'number' ? view.lastProgressTick : view.tick;
    const elapsed = Math.max(0, view.tick - last);
    const warned =
      view.status === 'playing' &&
      view.stalemateWarned === true &&
      elapsed >= STALEMATE_WARNING_TICKS;
    const seconds = warned
      ? Math.max(0, Math.ceil((STALEMATE_END_TICKS - elapsed) / TICKS_PER_SECOND))
      : 0;
    const signature = (warned ? '1' : '0') + '|' + seconds;
    if (signature === this.stalemateSignature) return;
    this.stalemateSignature = signature;
    const className = 'stalemate-banner' + (warned ? ' is-visible' : '');
    if (this.stalemateBanner.className !== className) {
      this.stalemateBanner.className = className;
    }
    setText(
      this.stalemateCountdown,
      warned ? '无进展，约 ' + seconds + ' 秒后按当前比分结算' : ''
    );
  }

  private renderUpgrade(
    kind: UpgradeKind,
    evaluation: UpgradeEvaluationDetail | null,
    selected: TerritoryView | null,
    view: MatchView
  ): void {
    const button = this.upgradeButtons[kind];
    const maxed =
      !!selected && evaluation !== null && evaluation.currentLevel >= UPGRADE_MAX[kind];
    const ready =
      !!selected &&
      selected.owner === 'player' &&
      view.status === 'playing' &&
      !!evaluation &&
      evaluation.ok &&
      !maxed;

    const className =
      'upgrade-btn upgrade-btn-track' +
      (ready ? ' is-ready' : '') +
      (maxed ? ' is-max' : '') +
      (!ready && !maxed ? ' is-disabled' : '');
    if (button.className !== className) {
      button.className = className;
      button.root.className = className;
    }
    const nextDisabled = !ready;
    if (button.disabled !== nextDisabled) {
      button.disabled = nextDisabled;
      button.root.disabled = nextDisabled;
    }

    const subText = upgradeSubText(kind, evaluation, selected, view);
    if (button.subText !== subText) {
      button.subText = subText;
      setText(button.sub, subText);
    }

    if (kind === 'defense') {
      const level = selected ? selected.defenseLevel : 0;
      if (button.iconLevel !== level) {
        button.iconLevel = level;
        const icon = iconFor(kind, level);
        while (button.iconHost.firstChild) button.iconHost.removeChild(button.iconHost.firstChild);
        button.iconHost.appendChild(icon);
      }
    }

    const cost = evaluation ? evaluation.cost : 0;
    const ariaLabel =
      UPGRADE_LABEL[kind] +
      '，' +
      (ready
        ? '消耗 ' + cost + ' 兵'
        : maxed
          ? '已满级'
          : selected
            ? '当前不可升级'
            : '请先选择领地');
    if (button.ariaLabel !== ariaLabel) {
      button.ariaLabel = ariaLabel;
      button.root.setAttribute('aria-label', ariaLabel);
    }
  }

  showNotice(text: string, tone?: 'info' | 'good' | 'bad'): void {
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.notice.textContent = text;
    this.notice.className = 'notice is-visible' + (tone ? ' is-' + tone : '');
    const self = this;
    this.noticeTimer = window.setTimeout(function () {
      self.notice.className = 'notice';
      self.noticeTimer = null;
    }, 2300);
  }

  setHintVisible(visible: boolean): void {
    this.hint.className = 'map-hint' + (visible ? '' : ' is-hidden');
  }

  destroy(): void {
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    if (this.paneResizeHandler !== null) {
      if (
        typeof window !== 'undefined' &&
        typeof window.removeEventListener === 'function'
      ) {
        window.removeEventListener('resize', this.paneResizeHandler);
      }
      this.paneResizeHandler = null;
    }
    if (
      this.bodyVersusClass &&
      typeof document !== 'undefined' &&
      document.body &&
      document.body.classList
    ) {
      document.body.classList.remove('is-versus-mode');
    }
    this.bodyVersusClass = false;
  }

  private updateCanvasLabel(view: MatchView, playerLand: number, enemyLand: number): void {
    // The AI aggregate stays only as the shared neutral-pool remainder; the
    // narration itself is per faction in a multi-faction match.
    const neutral = Math.max(0, view.territories.length - playerLand - enemyLand);
    const state =
      view.status === 'ended'
        ? '对局结束'
        : view.status === 'paused'
          ? '对局暂停'
          : '对局进行中';
    const regionLabel =
      (view.geog && view.geog.regionLabel) ||
      (view.geography && view.geography.regionLabel) ||
      '';
    const mapLabel = regionLabel ? regionLabel + ' · ' + view.mapName : view.mapName;
    const blueName = this.versus ? VERSUS_BLUE_NAME : '我方';
    const redName = this.versus ? VERSUS_RED_NAME : '敌方';
    const factions = activeFactions(view);
    const multiFaction = !this.versus && factions.length > 2;
    let sideText: string;
    if (multiFaction) {
      const segments: string[] = [];
      for (let i = 0; i < factions.length; i += 1) {
        segments.push(
          factionDisplayName(factions[i]) +
            ' ' +
            factionTerritoriesOf(view, factions[i]) +
            ' 块'
        );
      }
      sideText = segments.join('，') + '，中立 ' + neutral + ' 块。';
    } else {
      sideText =
        blueName + ' ' + playerLand + ' 块，' + redName + ' ' + enemyLand + ' 块，中立 ' + neutral + ' 块。';
    }
    const label =
      mapLabel +
      '战场，' +
      state +
      '。' +
      sideText +
      '按住己方领地蓄力，拖向己方接壤的领地派兵；选中领地可升级产兵、行军或城防。';
    this.canvas.setAttribute('aria-label', label);
  }

  private describeBattle(view: MatchView, remaining: number): string {
    const statusText =
      view.status === 'playing'
        ? '进行中'
        : view.status === 'paused'
          ? '已暂停'
          : view.status === 'ended'
            ? '已结束'
            : '准备中';
    const parts: string[] = [];
    const regionLabel =
      (view.geog && view.geog.regionLabel) ||
      (view.geography && view.geography.regionLabel) ||
      '';
    parts.push(
      (regionLabel ? regionLabel + ' · ' : '') +
        view.mapName +
        '，' +
        statusText +
        '，剩余 ' +
        formatClock(remaining) +
        '。'
    );
    const factions = activeFactions(view);
    const multiFaction = !this.versus && factions.length > 2;
    if (multiFaction) {
      // Per-faction narration: a purple garrison is never folded into an
      // "enemy" aggregate that the seated roster does not have.
      const segments: string[] = [];
      for (let i = 0; i < factions.length; i += 1) {
        const owner = factions[i];
        const alive = isFactionAlive(view, owner);
        segments.push(
          factionDisplayName(owner) +
            '控地 ' +
            factionTerritoriesOf(view, owner) +
            ' 块，分值 ' +
            factionScoreOf(view, owner) +
            (alive ? '' : '（已淘汰）')
        );
      }
      parts.push(segments.join('；') + '。');
    } else {
      parts.push(
        (this.versus ? VERSUS_BLUE_NAME : '我方') +
          '控地 ' +
          view.territoryCounts.player +
          ' 块，分值 ' +
          view.scores.player +
          '；' +
          (this.versus ? VERSUS_RED_NAME : '敌方') +
          '控地 ' +
          (view.territoryCounts.ai1 + view.territoryCounts.ai2) +
          ' 块，分值 ' +
          (view.scores.ai1 + view.scores.ai2) +
          '。'
      );
    }
    const territories: string[] = [];
    for (let i = 0; i < view.territories.length; i += 1) {
      const territory = view.territories[i];
      territories.push(
        pad2(i + 1) +
          ' ' +
          ownerName(territory, this.versus, multiFaction) +
          ' ' +
          territory.troops +
          '/' +
          territory.capacity +
          ' 产兵' +
          territory.productionLevel +
          ' 行军' +
          territory.marchLevel +
          ' 城防' +
          territory.defenseLevel +
          ' ' +
          TERRAIN_LABEL[territory.terrain]
      );
    }
    parts.push('领地：' + territories.join('；') + '。');
    parts.push('在途部队 ' + view.armies.length + ' 支。');
    return parts.join('');
  }
}

function territoryIndex(view: MatchView, id: string): number {
  for (let i = 0; i < view.territories.length; i += 1) {
    if (view.territories[i].id === id) return i;
  }
  return 0;
}

function ownerName(territory: TerritoryView, versus: boolean, multiFaction: boolean): string {
  if (territory.owner === 'player') return versus ? VERSUS_BLUE_NAME : '我方';
  if (territory.owner === 'neutral') return '中立';
  // v1.4 multi-faction: every AI keeps its own colour word (red/gold/purple),
  // so a per-territory narration never mislabels a faction as a generic enemy.
  // The versus and legacy 2-faction solo wordings stay byte-identical.
  if (multiFaction && isFactionOwner(territory.owner)) {
    return FACTION_NAME[territory.owner];
  }
  return versus ? VERSUS_RED_NAME : '敌方';
}

/** Garrison plus in-flight troops for one owner (shared versus compare bar). */
function forceForOwner(view: MatchView, owner: 'player' | 'ai1' | 'ai2'): number {
  let force = 0;
  for (let i = 0; i < view.territories.length; i += 1) {
    if (view.territories[i].owner === owner) force += view.territories[i].troops;
  }
  for (let i = 0; i < view.armies.length; i += 1) {
    if (view.armies[i].owner === owner) force += view.armies[i].troops;
  }
  return force;
}
