import { button, el } from './dom';
import { formatClock } from './format';
import {
  activeFactions,
  factionDisplayName,
  factionTerritoriesOf,
  isFactionAlive,
} from './factions';
import { createOverlay } from './overlay';
import {
  DEFAULT_GAME_SPEED,
  GAME_SPEED_OPTIONS,
  formatDurationText,
  isGameSpeed,
  normalizeGameSpeed,
} from './settings-store';
import type { GameSpeed } from './settings-store';
import type { MatchView } from './view-model';
import type { PendingOfferView } from './diplomacy-view';

export interface PauseCallbacks {
  onResume: () => void;
  onRestart: () => void;
  /**
   * Match mode: leave the match for home. Tutorial mode: leave the lesson for
   * home while keeping the first-run marker so it can be resumed later. This
   * is deliberately separate from `onSkipTutorial`, which is an explicit
   * "never show this lesson again" choice.
   */
  onHome: () => void;
  onResign?: () => void;
  onDiplomacy?: () => void;
  /** Snapshot-derived invitation deferred while a pause/modal was already open. */
  pendingOffer?: PendingOfferView | null;
  onRules: () => void;
  /**
   * Tutorial-only explicit skip: clears the first-run marker and routes to
   * setup/home. When omitted, tutorial mode falls back to the previous single
   * "skip and leave" button so an old caller keeps its exact behaviour.
   */
  onSkipTutorial?: () => void;
  /**
   * Optional v1.2 wiring. When either callback is provided the overlay renders
   * the three-speed row; omitting both keeps the v1.1 pause card unchanged.
   */
  getGameSpeed?: () => GameSpeed;
  setGameSpeed?: (speed: GameSpeed) => void;
  /**
   * Optional: a challenge match carries its speed inside the code, so the shell
   * can render the row read-only instead of letting a tap turn the match into
   * practice. Defaults to editable.
   */
  speedLocked?: boolean;
  /**
   * The tutorial keeps the same pause mechanics but names every action after
   * the lesson. It also never renders the speed row: the teaching/free-play
   * clock is fixed and changing pace would make the lesson non-reproducible.
   */
  mode?: 'match' | 'tutorial';
}

/**
 * The overlay root doubles as a small handle: `getGameSpeed` reads the local
 * pick, `setGameSpeed` syncs it from outside (no callback echo), and `destroy`
 * makes late listeners inert. It stays a plain HTMLElement, so the shell's
 * `openOverlay(overlay)` and every existing call site typecheck unchanged.
 */
export type PauseOverlayElement = HTMLElement & {
  getGameSpeed: () => GameSpeed;
  setGameSpeed: (speed: GameSpeed) => void;
  refreshPendingOffer: (pendingOffer: PendingOfferView | null) => void;
  destroy: () => void;
};

/** Remaining wall-clock seconds for the current speed (ceiling, never 0). */
function wallClockRemaining(view: MatchView, speed: GameSpeed): number {
  const ticksLeft = Math.max(0, view.durationTicks - view.tick);
  return Math.ceil(ticksLeft / 10 / (isGameSpeed(speed) ? speed : 1));
}

/** Same sentence shape as setup, but about the time actually left on the clock. */
function pauseSpeedNote(view: MatchView, speed: GameSpeed): string {
  const left = '剩余约 ' + formatDurationText(wallClockRemaining(view, speed));
  if (speed === 0.75) return left + '，慢速下整局耗时更长';
  if (speed === 1.25) return left + '，节奏更快';
  return left + ' · 标准速度';
}

export function createPauseOverlay(
  view: MatchView,
  autoPaused: boolean,
  callbacks: PauseCallbacks
): PauseOverlayElement {
  const parts = createOverlay('pause-overlay');
  const tutorialMode = callbacks.mode === 'tutorial';
  parts.card.setAttribute('role', 'dialog');
  parts.card.setAttribute('aria-modal', 'true');
  parts.card.setAttribute('aria-labelledby', 'pause-title');

  const header = el('div', 'pause-header');
  header.appendChild(el('p', 'overlay-kicker', tutorialMode ? 'TUTORIAL PAUSED' : 'PAUSED'));
  const title = el(
    'h2',
    'overlay-title pause-title',
    autoPaused
      ? tutorialMode
        ? '教学已自动暂停'
        : '已自动暂停'
      : tutorialMode
        ? '教学已暂停'
        : '战场已暂停'
  );
  title.id = 'pause-title';
  header.appendChild(title);
  header.appendChild(
    el(
      'p',
      'pause-copy',
      autoPaused
        ? tutorialMode
          ? '离开页面时教学不会偷偷推进；回来后从这里继续。'
          : '页面切换或失焦时不会偷偷推进战局。准备好后再继续。'
        : tutorialMode
          ? '教学进度已保留，随时继续或重新开始。'
          : '时间与产兵都已停止，调整呼吸后再回到战场。'
    )
  );

  const stats = el('div', 'pause-stats');
  // v1.4 multi-faction: one tile per seated faction from the match-fixed
  // roster, so a purple/gold holding is never folded into an "enemy"
  // aggregate that misses ai3. The versus / legacy 2-faction pause keeps its
  // exact three-tile card.
  const factions = activeFactions(view);
  const multiFaction = view.mode !== 'versus' && factions.length > 2;
  const cells: Array<[string, string]> = [
    ['用时', formatClock(Math.floor(view.tick / 10))],
  ];
  if (multiFaction) {
    for (let i = 0; i < factions.length; i += 1) {
      const owner = factions[i];
      const alive = isFactionAlive(view, owner);
      cells.push([
        factionDisplayName(owner) + '控地',
        String(factionTerritoriesOf(view, owner)) + (alive ? '' : '（已淘汰）'),
      ]);
    }
  } else {
    cells.push(['我方控地', String(view.territoryCounts.player)]);
    cells.push(['敌方控地', String(view.territoryCounts.ai1 + view.territoryCounts.ai2)]);
  }
  for (let i = 0; i < cells.length; i += 1) {
    const cell = el('div', 'pause-stat');
    cell.appendChild(el('span', 'pause-stat-label', cells[i][0]));
    cell.appendChild(el('b', 'pause-stat-value', cells[i][1]));
    stats.appendChild(cell);
  }

  const actions = el('div', 'pause-actions');
  const resume = button(
    tutorialMode ? '继续教学' : '继续对局',
    'btn btn-primary btn-wide',
    callbacks.onResume
  );
  resume.setAttribute('aria-label', tutorialMode ? '继续教学' : '继续对局');
  const restart = button(
    tutorialMode ? '重新开始教学' : '重新开始',
    'btn btn-secondary btn-wide',
    callbacks.onRestart
  );
  const rules = button('玩法说明', 'text-link pause-rules', callbacks.onRules);
  actions.appendChild(resume);
  actions.appendChild(restart);

  if (tutorialMode && callbacks.onSkipTutorial) {
    // Two distinct choices. "Leave for now" must stay visually and textually
    // separate from "skip for good": only the latter drops the first-run
    // marker, so a player who just wants to stop for today can come back.
    const leave = button(
      '返回首页（下次继续教学）',
      'btn btn-secondary btn-wide',
      callbacks.onHome
    );
    leave.setAttribute('aria-label', '返回首页，下次继续新手教学');
    const skip = button(
      '跳过教学',
      'btn btn-ghost-danger btn-wide',
      callbacks.onSkipTutorial
    );
    skip.setAttribute('aria-label', '跳过新手教学，以后不再自动出现');
    skip.setAttribute('data-action', 'skip-tutorial');
    actions.appendChild(leave);
    actions.appendChild(skip);
  } else {
    const home = button(
      tutorialMode ? '跳过教学并返回' : '返回首页',
      'btn btn-ghost-danger btn-wide',
      callbacks.onHome
    );
    actions.appendChild(home);
  }
  let pendingOfferSummary: HTMLElement | null = null;
  let pendingOfferButton: HTMLButtonElement | null = null;
  let diplomacyButton: HTMLButtonElement | null = null;

  function renderPendingOffer(pendingOffer: PendingOfferView | null): void {
    if (pendingOfferSummary && pendingOfferSummary.parentNode === actions) {
      actions.removeChild(pendingOfferSummary);
    }
    if (pendingOfferButton && pendingOfferButton.parentNode === actions) {
      actions.removeChild(pendingOfferButton);
    }
    pendingOfferSummary = null;
    pendingOfferButton = null;
    if (!pendingOffer || tutorialMode || !callbacks.onDiplomacy) return;

    const offerSummary = el('div', 'pause-offer-summary');
    offerSummary.appendChild(
      el('b', 'pause-offer-title', pendingOffer.proposerName + '的合作邀请')
    );
    offerSummary.appendChild(el('span', 'pause-offer-copy', pendingOffer.motivation));
    offerSummary.appendChild(
      el('span', 'pause-offer-expiry', '剩余 ' + pendingOffer.secondsLeft + ' 游戏秒')
    );
    const viewOffer = button(
      '查看合作邀请',
      'btn btn-primary btn-wide pause-offer-button',
      callbacks.onDiplomacy
    );
    viewOffer.setAttribute('aria-label', '查看合作邀请');
    viewOffer.setAttribute('data-action', 'view-cooperation-offer');
    if (diplomacyButton && diplomacyButton.parentNode === actions) {
      actions.insertBefore(offerSummary, diplomacyButton);
      actions.insertBefore(viewOffer, diplomacyButton);
    } else {
      actions.appendChild(offerSummary);
      actions.appendChild(viewOffer);
    }
    pendingOfferSummary = offerSummary;
    pendingOfferButton = viewOffer;
  }

  renderPendingOffer(callbacks.pendingOffer || null);
  if (!tutorialMode && callbacks.onDiplomacy) {
    diplomacyButton = button(
      '外交与停战',
      'btn btn-secondary btn-wide',
      callbacks.onDiplomacy
    );
    diplomacyButton.setAttribute('data-action', 'diplomacy');
    actions.appendChild(diplomacyButton);
  }
  if (!tutorialMode && callbacks.onResign) {
    const resign = button('认输并结束本局', 'btn btn-ghost-danger btn-wide', callbacks.onResign);
    resign.setAttribute('aria-label', '认输并结束本局');
    resign.setAttribute('data-action', 'resign');
    actions.appendChild(resign);
  }
  actions.appendChild(rules);

  // v2.0 short-screen layout: header/stats/speed live inside .pause-scroll
  // (the card's scroll region) while .pause-actions is an independent footer,
  // so 外交/认输 never stack behind long stats on 640/720-height viewports.
  // The card keeps its own overflow-y only as the whole-card fallback for
  // extreme short landscape; the action footer never scrolls away.
  const scroll = el('div', 'pause-scroll');
  scroll.appendChild(header);
  scroll.appendChild(stats);

  // v1.2 speed control: only when the shell supplies speed wiring, so an
  // un-updated caller keeps the exact v1.1 card. Existing classes are reused
  // (setup-field/option-row/option/option.is-locked/pause-copy) because
  // main.css is owned by the shell integration work; no new rules are needed.
  // `pause-header` is reused below only for its 22px side padding, so the row
  // lines up with the stat tiles inside a card that has none of its own.
  const wantsSpeed =
    !tutorialMode && !!(callbacks.getGameSpeed || callbacks.setGameSpeed);
  const speedLocked = callbacks.speedLocked === true;
  // Without a getter the shell cannot tell us the live pace; fall back to the
  // same 0.75× recommendation the setup screen and a fresh profile use, instead
  // of silently showing 1× on a new player's first pause.
  let speed: GameSpeed = normalizeGameSpeed(
    callbacks.getGameSpeed ? callbacks.getGameSpeed() : undefined,
    DEFAULT_GAME_SPEED
  );
  let destroyed = false;
  const speedRow = wantsSpeed ? el('div', 'option-row option-row-compact') : null;
  const speedNote = wantsSpeed ? el('p', 'pause-copy pause-speed-note') : null;

  function renderSpeedRow(): void {
    if (!speedRow || !speedNote || destroyed) return;
    while (speedRow.firstChild) speedRow.removeChild(speedRow.firstChild);
    for (let i = 0; i < GAME_SPEED_OPTIONS.length; i += 1) {
      const entry = GAME_SPEED_OPTIONS[i];
      const active = entry.speed === speed;
      const option = el(
        'button',
        'option option-compact' + (active ? ' is-active' : '') + (speedLocked ? ' is-locked' : '')
      );
      option.type = 'button';
      option.setAttribute('aria-pressed', active ? 'true' : 'false');
      option.setAttribute('data-speed', String(entry.speed));
      const remaining = wallClockRemaining(view, entry.speed);
      option.setAttribute(
        'aria-label',
        entry.label + '速度，' + entry.name +
          (speedLocked
            ? '，挑战局速度由挑战码决定，不可更改'
            : '，剩余约 ' + formatDurationText(remaining))
      );
      option.appendChild(el('span', 'option-label', entry.label));
      // Each option states its own real remaining time, so the slow row is
      // visibly longer without needing an extra explanatory paragraph.
      option.appendChild(
        el('span', 'option-sub', entry.name + ' · ' + formatClock(remaining))
      );
      if (speedLocked) {
        option.disabled = true;
        option.setAttribute('aria-disabled', 'true');
      } else {
        option.addEventListener('click', function () {
          if (destroyed || speed === entry.speed) return;
          speed = entry.speed;
          renderSpeedRow();
          if (callbacks.setGameSpeed) callbacks.setGameSpeed(entry.speed);
        });
      }
      speedRow.appendChild(option);
    }
    const note = speedLocked
      ? '挑战局速度由挑战码决定，暂停中不可更改'
      : pauseSpeedNote(view, speed);
    if (speedNote.textContent !== note) speedNote.textContent = note;
  }

  if (wantsSpeed && speedRow && speedNote) {
    const field = el('div', 'setup-field pause-speed-field');
    const label = el('span', 'setup-field-label', '速度');
    label.setAttribute('aria-hidden', 'true');
    field.appendChild(label);
    field.appendChild(speedRow);
    // `pause-header` supplies nothing here but its 22px side padding: the pause
    // card has none of its own, and this row must line up with the stat tiles.
    const speedBlock = el('div', 'pause-header pause-speed');
    speedBlock.appendChild(field);
    speedBlock.appendChild(speedNote);
    scroll.appendChild(speedBlock);
    renderSpeedRow();
  }

  parts.card.appendChild(scroll);
  parts.card.appendChild(actions);

  const overlay = parts.root as PauseOverlayElement;
  overlay.getGameSpeed = function () {
    return speed;
  };
  overlay.setGameSpeed = function (next: GameSpeed) {
    if (destroyed || !isGameSpeed(next) || next === speed) return;
    speed = next;
    renderSpeedRow();
  };
  overlay.refreshPendingOffer = function (pendingOffer: PendingOfferView | null) {
    if (destroyed) return;
    renderPendingOffer(pendingOffer);
  };
  overlay.destroy = function () {
    destroyed = true;
  };
  return overlay;
}
