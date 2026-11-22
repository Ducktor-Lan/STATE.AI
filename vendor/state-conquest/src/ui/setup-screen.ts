import '../styles/casual-setup.css';
import { button, clear, el } from './dom';
import {
  FACTION_COUNTS,
  factionNoteText,
  factionOptionSub,
  isFactionCount,
  normalizeFactionCount,
} from './factions';
import type { FactionCount } from './factions';
import {
  DIFFICULTY_LABEL,
  SETUP_DIFFICULTY_ORDER,
  SETUP_DIFFICULTY_SUB,
} from './format';
import {
  DEFAULT_GAME_SPEED,
  GAME_SPEED_OPTIONS,
  gameSpeedDurationNote,
  isGameSpeed,
  normalizeGameSpeed,
} from './settings-store';
import type { GameSpeed } from './settings-store';
import { RANDOM_MAP_ID } from './view-model';
import type { Difficulty, GameSettings } from './view-model';

export interface SetupCallbacks {
  onBack: () => void;
  /**
   * `speed` is appended rather than added to GameSettings so the core-facing
   * settings shape (and every existing one-argument implementation) stays
   * compatible.
   *
   * `settings.difficulty` is passed through unchanged; 'casual' is a real
   * Difficulty member, so the shell persists it and the core creates a casual
   * match with its own AI tuning and settlement tier.
   */
  onStart: (settings: GameSettings, speed?: GameSpeed) => void;
  /** Optional v1.2 wiring: read the persisted speed when the screen opens. */
  getGameSpeed?: () => GameSpeed;
  /** Optional v1.2 wiring: persist a speed the player picked here. */
  setGameSpeed?: (speed: GameSpeed) => void;
  /**
   * Optional v1.4 wiring: read the persisted match size (2/3/4 factions) when
   * the screen opens. The pick itself is carried on `GameSettings.factionCount`
   * (optional, default 2), which is what the shell forwards to the core.
   */
  getFactionCount?: () => FactionCount;
  /** Optional v1.4 wiring: persist a match size the player picked here. */
  setFactionCount?: (count: FactionCount) => void;
}

const DURATIONS: number[] = [180, 300, 480];

function minutesLabel(seconds: number): string {
  return Math.round(seconds / 60) + ' 分';
}

/** Easiest-first ladder; the constant also drives the rendered DOM order. */
const DIFFICULTIES: Difficulty[] = SETUP_DIFFICULTY_ORDER;

/**
 * Deliberately small: three compact choice rows (duration, difficulty, speed)
 * and one random-map note. The map itself is drawn by the seeded core library
 * when the match starts, so there is no theme list or preview to scroll
 * through. The speed row is always rendered; the callbacks only decide whether
 * the shell also hears about the pick.
 */
export class SetupScreen {
  readonly el: HTMLElement;

  private durationSeconds: number;
  private difficulty: Difficulty;
  private readonly callbacks: SetupCallbacks;
  private readonly durationRow: HTMLElement;
  private readonly difficultyRow: HTMLElement;
  private readonly factionRow: HTMLElement;
  private readonly factionNote: HTMLElement | null;
  private readonly speedRow: HTMLElement | null;
  private readonly speedNote: HTMLElement | null;
  private speed: GameSpeed;
  private factionCount: FactionCount;
  /** Set by destroy(); late callbacks must not touch a removed tree. */
  private destroyed = false;

  /**
   * `initialGameSpeed` is optional: callers on the v1.1 signature keep working
   * and fall back to `callbacks.getGameSpeed()`, then to the recommended 0.75×.
   */
  constructor(
    callbacks: SetupCallbacks,
    initial: GameSettings,
    initialGameSpeed?: GameSpeed
  ) {
    const self = this;
    this.callbacks = callbacks;
    this.durationSeconds =
      DURATIONS.indexOf(initial.durationSeconds) >= 0 ? initial.durationSeconds : 300;
    // Unknown values keep the historical 'normal' fallback. A persisted
    // 'casual' is honored (it is a first-class Difficulty), so the default
    // itself is never changed here: the shell decides what a fresh archive
    // starts on.
    this.difficulty =
      DIFFICULTIES.indexOf(initial.difficulty) >= 0 ? initial.difficulty : 'normal';
    this.speed = isGameSpeed(initialGameSpeed)
      ? initialGameSpeed
      : normalizeGameSpeed(
          callbacks.getGameSpeed ? callbacks.getGameSpeed() : undefined,
          DEFAULT_GAME_SPEED
        );
    // v1.4 match size. The persisted store value is authoritative; a caller on
    // the old signature (or an old archive) keeps the historical 2-faction row.
    this.factionCount = normalizeFactionCount(
      callbacks.getFactionCount ? callbacks.getFactionCount() : initial.factionCount
    );

    const root = el('section', 'screen setup-screen');
    root.setAttribute('aria-labelledby', 'setup-title');

    const header = el('header', 'setup-header');
    const back = button('返回', 'back-btn', callbacks.onBack);
    back.setAttribute('aria-label', '返回首页');
    const titles = el('div', 'setup-titles');
    const title = el('h1', 'setup-title', '对局设置');
    title.id = 'setup-title';
    const subtitle = el('p', 'setup-subtitle', '单局 · 随机战场');
    titles.appendChild(title);
    titles.appendChild(subtitle);
    header.appendChild(back);
    header.appendChild(titles);

    const body = el('div', 'setup-body setup-body-compact');
    const panel = el('div', 'setup-panel');
    const randomCard = el('div', 'setup-random-card');
    randomCard.appendChild(el('span', 'setup-random-mark', '随'));
    const randomText = el('div', 'setup-random-text');
    randomText.appendChild(el('p', 'setup-random-title', '每局随机地形'));
    randomText.appendChild(el('p', 'setup-random-note', '州界底图'));
    randomCard.appendChild(randomText);
    panel.appendChild(randomCard);

    this.durationRow = el('div', 'option-row option-row-compact');
    const durationField = el('div', 'setup-field');
    durationField.appendChild(el('span', 'setup-field-label', '时长'));
    durationField.appendChild(this.durationRow);

    // Four-up setup-only row. The extra class lets src/styles/casual-setup.css
    // keep four comfortable targets visible on a narrow portrait phone without
    // touching the shared main.css rules used by other screens.
    this.difficultyRow = el(
      'div',
      'option-row option-row-compact setup-difficulty-row'
    );
    this.difficultyRow.setAttribute('role', 'group');
    this.difficultyRow.setAttribute('aria-label', '难度');
    const difficultyField = el('div', 'setup-field');
    difficultyField.appendChild(el('span', 'setup-field-label', '难度'));
    difficultyField.appendChild(this.difficultyRow);

    panel.appendChild(durationField);
    panel.appendChild(difficultyField);

    // v1.4 faction-count row (2/3/4). Reuses the compact option-row pattern;
    // the note line states the "1 player + N AI" consequence in plain words.
    this.factionRow = el('div', 'option-row option-row-compact setup-faction-row');
    this.factionRow.setAttribute('role', 'group');
    this.factionRow.setAttribute('aria-label', '阵营数');
    const factionField = el('div', 'setup-field');
    factionField.appendChild(el('span', 'setup-field-label', '阵营'));
    factionField.appendChild(this.factionRow);

    const factionNoteRow = el('div', 'setup-field setup-speed-note-row');
    const factionSpacer = el('span', 'setup-field-label');
    factionSpacer.setAttribute('aria-hidden', 'true');
    factionNoteRow.appendChild(factionSpacer);
    this.factionNote = el('p', 'setup-random-note setup-faction-note');
    this.factionNote.setAttribute('role', 'status');
    factionNoteRow.appendChild(this.factionNote);

    panel.appendChild(factionField);
    panel.appendChild(factionNoteRow);

    // v1.2 speed row. Reuses the duration/difficulty compact pattern so the
    // shared stylesheet (owned by the shell integration) needs no new rules.
    this.speedRow = el('div', 'option-row option-row-compact');
    const speedField = el('div', 'setup-field');
    const speedLabel = el('span', 'setup-field-label', '速度');
    speedLabel.setAttribute('aria-hidden', 'true');
    speedField.appendChild(speedLabel);
    speedField.appendChild(this.speedRow);

    // The note sits on its own line, indented past the field label.
    const speedNoteRow = el('div', 'setup-field setup-speed-note-row');
    const noteSpacer = el('span', 'setup-field-label');
    noteSpacer.setAttribute('aria-hidden', 'true');
    speedNoteRow.appendChild(noteSpacer);
    this.speedNote = el('p', 'setup-random-note setup-speed-note');
    this.speedNote.setAttribute('role', 'status');
    this.speedNote.setAttribute('aria-live', 'polite');
    speedNoteRow.appendChild(this.speedNote);

    panel.appendChild(speedField);
    panel.appendChild(speedNoteRow);

    body.appendChild(panel);

    const footer = el('footer', 'setup-footer setup-footer-compact');
    const start = button('开始', 'btn btn-primary btn-wide btn-start-battle', function () {
      if (self.destroyed) return;
      callbacks.onStart(
        {
          durationSeconds: self.durationSeconds,
          // Passed through unchanged, including the casual tier.
          difficulty: self.difficulty,
          mapId: RANDOM_MAP_ID,
          // v1.4: optional match size (2 default); the shell forwards it to
          // the core, which seats 1 player + (count-1) AI factions.
          factionCount: self.factionCount,
        },
        self.speed
      );
    });
    start.setAttribute('aria-label', '开始对局，随机战场');
    footer.appendChild(start);
    footer.appendChild(el('p', 'setup-foot-note', '开局即生成战场 · 无需选图'));

    root.appendChild(header);
    root.appendChild(body);
    root.appendChild(footer);
    this.el = root;

    this.render();
  }

  /** Current pick; always one of the three supported speeds. */
  getGameSpeed(): GameSpeed {
    return this.speed;
  }

  /** External sync (e.g. the store changed in another sheet). No callback. */
  setGameSpeed(speed: GameSpeed): void {
    if (this.destroyed || !isGameSpeed(speed) || speed === this.speed) return;
    this.speed = speed;
    this.render();
  }

  /** Current pick; always one of the supported match sizes. */
  getFactionCount(): FactionCount {
    return this.factionCount;
  }

  /** External sync (e.g. the store changed in another sheet). No callback. */
  setFactionCount(count: FactionCount): void {
    if (this.destroyed || !isFactionCount(count) || count === this.factionCount) return;
    this.factionCount = count;
    this.render();
  }

  destroy(): void {
    this.destroyed = true;
  }

  private render(): void {
    const self = this;
    if (this.destroyed) return;
    clear(this.durationRow);
    for (let i = 0; i < DURATIONS.length; i += 1) {
      const seconds = DURATIONS[i];
      const active = seconds === this.durationSeconds;
      const option = el('button', 'option option-compact' + (active ? ' is-active' : ''));
      option.type = 'button';
      option.setAttribute('aria-pressed', active ? 'true' : 'false');
      option.setAttribute('aria-label', minutesLabel(seconds) + '单局');
      option.appendChild(el('span', 'option-label', minutesLabel(seconds)));
      option.addEventListener('click', function () {
        if (self.destroyed) return;
        self.durationSeconds = seconds;
        self.render();
      });
      this.durationRow.appendChild(option);
    }

    clear(this.difficultyRow);
    for (let i = 0; i < DIFFICULTIES.length; i += 1) {
      const difficulty = DIFFICULTIES[i];
      const active = difficulty === this.difficulty;
      const option = el('button', 'option option-compact' + (active ? ' is-active' : ''));
      option.type = 'button';
      option.setAttribute('data-difficulty', difficulty);
      option.setAttribute('aria-pressed', active ? 'true' : 'false');
      option.setAttribute(
        'aria-label',
        DIFFICULTY_LABEL[difficulty] + '难度，' + SETUP_DIFFICULTY_SUB[difficulty]
      );
      option.appendChild(el('span', 'option-label', DIFFICULTY_LABEL[difficulty]));
      option.appendChild(el('span', 'option-sub', SETUP_DIFFICULTY_SUB[difficulty]));
      option.addEventListener('click', function () {
        if (self.destroyed) return;
        self.difficulty = difficulty;
        self.render();
      });
      this.difficultyRow.appendChild(option);
    }

    clear(this.factionRow);
    for (let i = 0; i < FACTION_COUNTS.length; i += 1) {
      const count = FACTION_COUNTS[i];
      const active = count === this.factionCount;
      const option = el('button', 'option option-compact' + (active ? ' is-active' : ''));
      option.type = 'button';
      option.setAttribute('aria-pressed', active ? 'true' : 'false');
      option.setAttribute('data-faction-count', String(count));
      option.setAttribute('aria-label', count + ' 方对局，' + factionNoteText(count));
      option.appendChild(el('span', 'option-label', count + ' 方'));
      option.appendChild(el('span', 'option-sub', factionOptionSub(count)));
      option.addEventListener('click', function () {
        if (self.destroyed || self.factionCount === count) return;
        self.factionCount = count;
        self.render();
        if (self.callbacks.setFactionCount) self.callbacks.setFactionCount(count);
      });
      this.factionRow.appendChild(option);
    }
    if (this.factionNote) {
      const note = factionNoteText(this.factionCount);
      if (this.factionNote.textContent !== note) this.factionNote.textContent = note;
    }

    if (!this.speedRow || !this.speedNote) return;
    clear(this.speedRow);
    for (let i = 0; i < GAME_SPEED_OPTIONS.length; i += 1) {
      const entry = GAME_SPEED_OPTIONS[i];
      const active = entry.speed === this.speed;
      const option = el('button', 'option option-compact' + (active ? ' is-active' : ''));
      option.type = 'button';
      option.setAttribute('aria-pressed', active ? 'true' : 'false');
      option.setAttribute('data-speed', String(entry.speed));
      option.setAttribute(
        'aria-label',
        entry.label + '速度，' + entry.name + '，' +
          gameSpeedDurationNote(this.durationSeconds, entry.speed)
      );
      option.appendChild(el('span', 'option-label', entry.label));
      option.appendChild(el('span', 'option-sub', entry.name));
      option.addEventListener('click', function () {
        if (self.destroyed || self.speed === entry.speed) return;
        self.speed = entry.speed;
        self.render();
        if (self.callbacks.setGameSpeed) self.callbacks.setGameSpeed(entry.speed);
      });
      this.speedRow.appendChild(option);
    }
    const note = gameSpeedDurationNote(this.durationSeconds, this.speed);
    if (this.speedNote.textContent !== note) this.speedNote.textContent = note;
  }
}
