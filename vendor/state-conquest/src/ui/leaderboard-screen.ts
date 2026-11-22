/**
 * Local leaderboard screen.
 *
 * The archive is grouped, never pooled: the player first picks one rule group
 * (rank class + map + seed + difficulty + duration + skill rule + speed + rules
 * version), then sees the records inside it. Random seeds make most groups
 * small, which is expected and is exactly why a cross-map total board would be
 * misleading.
 *
 * v1.2 rank classes are rendered as three different things:
 *   fixed     a comparable fixed-speed group: ruleset version and speed shown
 *   practice  explicitly unranked; rows carry "练" instead of a rank number
 *   legacy    v1.1 history with no recorded speed; kept, never mixed with fixed
 * A group without a recorded class (older store stub) renders exactly as v1.1.
 *
 * All copy is explicit that this is this device only, not a global ranking.
 * The screen renders no sample rows: with no records it shows an empty state.
 */
import type {
  LeaderboardGroup,
  LeaderboardGroupSummary,
  LeaderboardLoadState,
  LeaderboardRecord,
  LeaderboardStore,
} from './leaderboard-store';
import {
  LEADERBOARD_CURRENT_RULES_VERSION,
  LEADERBOARD_MAX_LEGACY_RECORDS,
  LEADERBOARD_MAX_RECORDS,
  LEADERBOARD_MAX_RECORDS_PER_GROUP,
} from '../config/leaderboard';
import { button, clear, el } from './dom';
import {
  DIFFICULTY_LABEL,
  RESULT_LABEL,
  durationLabel,
  formatClock,
  modeName,
} from './format';
import { normalizeFactionCount } from './factions';
import type { Difficulty } from './view-model';

/** Required wording: local records never travel between devices. */
export const LEADERBOARD_LOCAL_DISCLAIMER = '本机记录，不与其他设备互通';
export const LEADERBOARD_NOT_GLOBAL_NOTE =
  '仅本机成绩，不是全网排行，不能与其他设备比较。';

export type LeaderboardScreenState =
  | 'loading'
  | 'corrupt'
  | 'error'
  | 'disabled'
  | 'empty'
  | 'ready';

export interface LeaderboardStateInput {
  loaded: boolean;
  optIn: boolean;
  loadState: LeaderboardLoadState;
  groupCount: number;
}

export interface LeaderboardStateCopy {
  title: string;
  note: string;
}

export function leaderboardScreenState(input: LeaderboardStateInput): LeaderboardScreenState {
  if (!input.loaded) return 'loading';
  if (input.loadState === 'error') return 'error';
  if (input.loadState === 'corrupt') return 'corrupt';
  if (!input.optIn) return 'disabled';
  if (input.groupCount === 0) return 'empty';
  return 'ready';
}

export function leaderboardStateCopy(
  state: LeaderboardScreenState,
  recordCount: number
): LeaderboardStateCopy | null {
  if (state === 'loading') {
    return { title: '正在读取本机记录…', note: '排行数据只读取本机存储。' };
  }
  if (state === 'corrupt') {
    return {
      title: '本机排行数据无法识别',
      note: '未载入任何记录，也不会把未知历史补造为排名。',
    };
  }
  if (state === 'error') {
    return {
      title: '本机存储读取失败',
      note: '当前无法刷新本机排行，请稍后重试。',
    };
  }
  if (state === 'disabled') {
    if (recordCount > 0) {
      return {
        title: '记录已关闭',
        note: '历史本机记录仍保留在本机，重新开启后可查看；当前不显示榜单，也不再新增。默认关闭，不补录历史。',
      };
    }
    return {
      title: '本机排行已关闭',
      note: '默认关闭，不补录历史对局。开启后只记录之后完成的单人/挑战赛。',
    };
  }
  if (state === 'empty') {
    return {
      title: '暂无本机排行',
      note: '完成一局单人模式或挑战赛后自动记录；双人对战不参与排行。',
    };
  }
  return null;
}

/** Skill-rule wording; challenge fairness must read differently from solo Lv.0. */
export function leaderboardRuleLabel(
  mode: LeaderboardGroupSummary['mode'],
  betrayalLevel: number
): string {
  if (mode === 'challenge') return '挑战赛 · 公平锁定（策反关闭）';
  if (betrayalLevel < 1) return '单人 · 策反未解锁';
  return '单人 · 策反 Lv.' + betrayalLevel;
}

/**
 * v1.2 ranking class. Fixed groups are compared inside one ruleset + speed;
 * practice groups are explicitly not ranked against anything; legacy groups
 * are v1.1 history that never recorded a speed.
 */
export type LeaderboardRankClass = 'fixed' | 'practice' | 'legacy';

/** Optional v1.2 fields the store may attach to a group/record. */
export interface LeaderboardRankMeta {
  rankClass?: string | null;
  speed?: number | null;
  rulesVersion?: number | null;
}

/** Normalized rank class; null means a v1.1 group with no class recorded. */
export function leaderboardRankClass(
  meta: LeaderboardRankMeta
): LeaderboardRankClass | null {
  if (meta.rankClass === 'fixed') return 'fixed';
  if (meta.rankClass === 'practice') return 'practice';
  if (meta.rankClass === 'legacy') return 'legacy';
  return null;
}

/** `1×`, `0.75×`, `1.25×`, or `未记录速度` when the class never carried one. */
function speedText(speed: number | null | undefined): string {
  if (typeof speed !== 'number' || !isFinite(speed) || speed <= 0) return '未记录速度';
  return String(Math.round(speed * 100) / 100) + '×';
}

/**
 * A fixed group is comparable only when it was played under this build's
 * current rules version. A valid older version stays visible as history but is
 * never presented as the comparable fixed board.
 */
export function leaderboardGroupComparable(meta: LeaderboardRankMeta): boolean {
  return (
    leaderboardRankClass(meta) === 'fixed' &&
    meta.rulesVersion === LEADERBOARD_CURRENT_RULES_VERSION
  );
}

/**
 * Class badge copy: current fixed shows ruleset version and speed, older fixed
 * is explicitly history-only, practice says it is unranked, legacy says no
 * speed was recorded. Empty for a group without a recorded class (v1.1 stub).
 */
export function leaderboardGroupRankLabel(meta: LeaderboardRankMeta): string {
  const rankClass = leaderboardRankClass(meta);
  const version =
    typeof meta.rulesVersion === 'number' && isFinite(meta.rulesVersion)
      ? 'v' + meta.rulesVersion
      : '未记录';
  if (rankClass === 'fixed') {
    if (leaderboardGroupComparable(meta)) {
      return '固定榜 · 规则 ' + version + ' · 速度 ' + speedText(meta.speed);
    }
    return (
      '其他规则版本 · 不可比 · 规则 ' +
      version +
      ' · 速度 ' +
      speedText(meta.speed)
    );
  }
  if (rankClass === 'practice') {
    const differentVersion =
      typeof meta.rulesVersion === 'number' &&
      isFinite(meta.rulesVersion) &&
      meta.rulesVersion !== LEADERBOARD_CURRENT_RULES_VERSION;
    return (
      '练习 · 不计排名' +
      (differentVersion ? ' · 规则 ' + version : '') +
      (meta.speed !== null && meta.speed !== undefined
        ? ' · 速度 ' + speedText(meta.speed)
        : '')
    );
  }
  if (rankClass === 'legacy') return '历史 · 未记录速度';
  return '';
}

function rankMetaOf(group: unknown): LeaderboardRankMeta {
  const raw = (group || {}) as LeaderboardRankMeta;
  return {
    rankClass: typeof raw.rankClass === 'string' ? raw.rankClass : null,
    speed: typeof raw.speed === 'number' ? raw.speed : null,
    rulesVersion: typeof raw.rulesVersion === 'number' ? raw.rulesVersion : null,
  };
}

/**
 * v1.4.0 seat-count wording. A two-faction group keeps its exact pre-v1.4
 * condition string (empty suffix); a 3/4-faction group names its size so
 * counts are never silently mixed in one visible line.
 */
export function leaderboardFactionSuffix(count: unknown): string {
  const value = normalizeFactionCount(count, 2);
  if (value === 3) return ' · 三方混战';
  if (value === 4) return ' · 四方混战';
  return '';
}

export function leaderboardGroupCondition(
  group: Pick<
    LeaderboardGroupSummary,
    'difficulty' | 'durationSeconds' | 'mode' | 'betrayalLevel' | 'seed'
  > &
    LeaderboardRankMeta & { factionCount?: unknown }
): string {
  const condition =
    DIFFICULTY_LABEL[group.difficulty as Difficulty] +
    '难度 · ' +
    modeName(group.durationSeconds) +
    ' ' +
    durationLabel(group.durationSeconds) +
    ' · ' +
    leaderboardRuleLabel(group.mode, group.betrayalLevel) +
    leaderboardFactionSuffix(
      (group as { factionCount?: unknown }).factionCount
    ) +
    ' · 战场 #' +
    group.seed;
  const meta = leaderboardGroupRankLabel(group);
  return meta ? condition + ' · ' + meta : condition;
}

function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

/** Local completion label; only presentation, never a ranking input. */
export function formatLeaderboardTime(iso: string): string {
  const date = new Date(iso);
  if (!isFinite(date.getTime())) return iso;
  return (
    date.getFullYear() +
    '-' +
    pad2(date.getMonth() + 1) +
    '-' +
    pad2(date.getDate()) +
    ' ' +
    pad2(date.getHours()) +
    ':' +
    pad2(date.getMinutes())
  );
}

function groupMark(group: LeaderboardGroupSummary): string {
  const meta = rankMetaOf(group);
  const rankClass = leaderboardRankClass(meta);
  if (rankClass === 'practice') return '练';
  if (rankClass === 'legacy') return '史';
  if (rankClass === 'fixed' && !leaderboardGroupComparable(meta)) return '史';
  return group.mode === 'challenge' ? '挑' : '单';
}

function stateMark(state: LeaderboardScreenState): string {
  if (state === 'loading') return '读';
  if (state === 'corrupt' || state === 'error') return '!';
  if (state === 'disabled') return '关';
  return '空';
}

function detailMeta(record: LeaderboardRecord & LeaderboardRankMeta): string {
  const parts: string[] = [];
  // A challenge's engine result is a match against the built-in AI, which is
  // not the challenge verdict; the score/target pair is the real comparison.
  if (record.mode === 'solo') parts.push(RESULT_LABEL[record.result]);
  parts.push(record.mode === 'challenge' ? '挑战赛' : '单人');
  // v1.4.0: a 3/4-faction row states its size (old rows read as 2, no suffix).
  const factionPart = leaderboardFactionSuffix(
    (record as { factionCount?: unknown }).factionCount
  );
  if (factionPart) parts.push(factionPart.replace(/^ · /, ''));
  // v1.2 records carry the speed they were played at; legacy rows never do.
  const speed = rankMetaOf(record).speed;
  if (speed !== null) parts.push('速度 ' + speedText(speed));
  parts.push(formatLeaderboardTime(record.finishedAt));
  parts.push('用时 ' + formatClock(record.elapsedSeconds));
  if (record.challengeScore !== undefined) {
    parts.push('挑战目标 ' + record.challengeScore);
  }
  return parts.join(' · ');
}

export interface LeaderboardScreenOptions {
  /**
   * Live opt-in source; evaluated on every render/refresh so a settings change
   * takes effect without rebuilding the screen. The store independently
   * enforces the same flag on every record().
   */
  optIn: () => boolean;
  /** Optional group to open first, e.g. the group of the match just played. */
  initialGroupId?: string | null;
}

export interface LeaderboardScreenCallbacks {
  onBack: () => void;
}

export class LeaderboardScreen {
  readonly el: HTMLElement;

  private readonly store: LeaderboardStore;
  private readonly options: LeaderboardScreenOptions;
  private readonly body: HTMLElement;
  private selectedGroupId: string | null;
  private loadRequested = false;
  private groupButtons: Array<{ id: string; node: HTMLButtonElement }> = [];
  private detailHost: HTMLElement | null = null;

  constructor(
    store: LeaderboardStore,
    options: LeaderboardScreenOptions,
    callbacks: LeaderboardScreenCallbacks
  ) {
    this.store = store;
    this.options = options;
    this.selectedGroupId = options.initialGroupId || null;

    const root = el('section', 'screen setup-screen');
    root.setAttribute('aria-labelledby', 'leaderboard-title');
    root.setAttribute('data-leaderboard-state', 'loading');

    const header = el('header', 'setup-header');
    const back = button('返回', 'back-btn', callbacks.onBack);
    back.setAttribute('aria-label', '返回首页');
    const titles = el('div', 'setup-titles');
    const title = el('h1', 'setup-title', '本机排行榜');
    title.id = 'leaderboard-title';
    const subtitle = el('p', 'setup-subtitle', LEADERBOARD_LOCAL_DISCLAIMER);
    titles.appendChild(title);
    titles.appendChild(subtitle);
    header.appendChild(back);
    header.appendChild(titles);

    const body = el('div', 'setup-body');
    root.appendChild(header);
    root.appendChild(body);
    this.el = root;
    this.body = body;

    this.render();
    if (!this.store.isLoaded()) this.requestLoad();
  }

  /** Re-render after a setting change or a newly recorded match. */
  refresh(): void {
    this.render();
  }

  private requestLoad(force?: boolean): void {
    if (this.loadRequested) return;
    if (!force && this.store.isLoaded()) return;
    this.loadRequested = true;
    const self = this;
    void this.store.load().then(
      function () {
        self.loadRequested = false;
        self.render();
      },
      function () {
        self.loadRequested = false;
        self.render();
      }
    );
  }

  private render(): void {
    const self = this;
    clear(this.body);
    this.groupButtons = [];
    this.detailHost = null;

    const groups = this.store.groups();
    let optedIn = false;
    try {
      optedIn = this.options.optIn() === true;
    } catch (error) {
      optedIn = false;
    }
    const state = leaderboardScreenState({
      loaded: this.store.isLoaded(),
      optIn: optedIn,
      loadState: this.store.loadState(),
      groupCount: groups.length,
    });
    this.el.setAttribute('data-leaderboard-state', state);

    const disclaimer = el('div', 'setup-random-card');
    const disclaimerMark = el('span', 'setup-random-mark', '本');
    disclaimerMark.setAttribute('aria-hidden', 'true');
    const disclaimerText = el('div', 'setup-random-text');
    disclaimerText.appendChild(el('p', 'setup-random-title', '仅本机记录'));
    disclaimerText.appendChild(
      el(
        'p',
        'setup-random-note',
        LEADERBOARD_LOCAL_DISCLAIMER + '。' + LEADERBOARD_NOT_GLOBAL_NOTE
      )
    );
    disclaimerText.appendChild(
      el(
        'p',
        'setup-random-note',
        '每组最多保留 ' +
          LEADERBOARD_MAX_RECORDS_PER_GROUP +
          ' 条；新成绩最多 ' +
          LEADERBOARD_MAX_RECORDS +
          ' 条，旧版迁移历史另最多 ' +
          LEADERBOARD_MAX_LEGACY_RECORDS +
          ' 条（历史不被新成绩挤占）；超限时组内低分先淘汰，各自预算内最早完成的记录先淘汰。'
      )
    );
    disclaimer.appendChild(disclaimerMark);
    disclaimer.appendChild(disclaimerText);
    this.body.appendChild(disclaimer);

    const copy = leaderboardStateCopy(state, this.store.recordCount());
    if (copy) {
      const card = el('div', 'setup-random-card');
      const mark = el('span', 'setup-random-mark', stateMark(state));
      mark.setAttribute('aria-hidden', 'true');
      const text = el('div', 'setup-random-text');
      text.appendChild(el('p', 'setup-random-title', copy.title));
      text.appendChild(el('p', 'setup-random-note', copy.note));
      card.appendChild(mark);
      card.appendChild(text);
      this.body.appendChild(card);
      if (state === 'error') {
        const retry = button('重新读取', 'btn btn-secondary btn-wide', function () {
          self.loadRequested = false;
          self.requestLoad(true);
        });
        retry.setAttribute('aria-label', '重新读取本机排行');
        this.body.appendChild(retry);
      }
    }

    const dropped = this.store.droppedRecords();
    if (dropped > 0) {
      const partial = el('div', 'setup-random-card');
      const partialMark = el('span', 'setup-random-mark', '!');
      partialMark.setAttribute('aria-hidden', 'true');
      const partialText = el('div', 'setup-random-text');
      partialText.appendChild(
        el('p', 'setup-random-title', '已忽略 ' + dropped + ' 条无法识别的记录')
      );
      partialText.appendChild(
        el('p', 'setup-random-note', '其余有效记录正常显示；不会补造缺失的名次。')
      );
      partial.appendChild(partialMark);
      partial.appendChild(partialText);
      this.body.appendChild(partial);
    }

    // Optional v1.2 store counters: migrated/evicted history and rows trimmed
    // by the caps are reported, never silently dropped. `trimNotice()` is
    // preferred because it also says whether the counters were persisted; the
    // separate readers keep a store stub without it rendering as before.
    const trim = this.trimInfo();
    const legacyMigrated = this.countStoreValue('migratedLegacyRecords');
    const legacyEvicted = trim.legacy;
    const modernEvicted = trim.modern;
    const unpersistedNote = trim.unpersisted
      ? '（计数未能写入存储，仅本次会话有效）'
      : '';
    if (legacyMigrated > 0 || legacyEvicted > 0) {
      const historyCard = el('div', 'setup-random-card leaderboard-history-note');
      const historyMark = el('span', 'setup-random-mark', '史');
      historyMark.setAttribute('aria-hidden', 'true');
      const historyText = el('div', 'setup-random-text');
      historyText.appendChild(
        el('p', 'setup-random-title', '旧版记录已保留为历史')
      );
      historyText.appendChild(
        el(
          'p',
          'setup-random-note',
          (legacyMigrated > 0
            ? '本机有 ' + legacyMigrated + ' 条 v1.1 记录已迁入，未记录速度，不参与固定速度比较。'
            : '') +
            (legacyEvicted > 0
              ? (legacyMigrated > 0 ? ' ' : '') +
                '存档超限时清理了 ' +
                legacyEvicted +
                ' 条历史记录；清理只发生在固定/练习记录之后。' +
                unpersistedNote
              : '')
        )
      );
      historyCard.appendChild(historyMark);
      historyCard.appendChild(historyText);
      this.body.appendChild(historyCard);
    }

    if (modernEvicted > 0) {
      const evictedCard = el('div', 'setup-random-card leaderboard-evicted-note');
      const evictedMark = el('span', 'setup-random-mark', '汰');
      evictedMark.setAttribute('aria-hidden', 'true');
      const evictedText = el('div', 'setup-random-text');
      evictedText.appendChild(
        el('p', 'setup-random-title', '有 ' + modernEvicted + ' 条新记录未保留')
      );
      evictedText.appendChild(
        el(
          'p',
          'setup-random-note',
          '组内或整库超过上限后，低分/最早完成的记录会先淘汰；被淘汰的记录已不在榜单中。' +
            unpersistedNote
        )
      );
      evictedCard.appendChild(evictedMark);
      evictedCard.appendChild(evictedText);
      this.body.appendChild(evictedCard);
    }

    // Turning recording off hides the board entirely (not just future rows);
    // the stored history is retained and returns when the switch is back on.
    // `!optedIn` is checked directly because an error/corrupt load state takes
    // precedence in the state enum, but a closed switch must still show no rows.
    if (
      !optedIn ||
      groups.length === 0 ||
      state === 'loading' ||
      state === 'corrupt' ||
      state === 'disabled'
    ) {
      return;
    }

    // Groups exist but none is a fixed-speed comparison: show the real reason
    // instead of letting history or practice rows pose as a ranking. A store
    // that reports no rank-class data at all keeps the older layout.
    const comparableCount = this.comparableGroupCount(groups);
    if (comparableCount === 0) {
      const noneCard = el('div', 'setup-random-card leaderboard-no-comparable');
      const noneMark = el('span', 'setup-random-mark', '备');
      noneMark.setAttribute('aria-hidden', 'true');
      const noneText = el('div', 'setup-random-text');
      noneText.appendChild(
        el('p', 'setup-random-title', '暂无固定速度可比成绩')
      );
      let legacyRows = 0;
      let practiceRows = 0;
      let oldRuleRows = 0;
      for (let i = 0; i < groups.length; i += 1) {
        const meta = rankMetaOf(groups[i]);
        const cls = leaderboardRankClass(meta);
        if (cls === 'legacy') legacyRows += groups[i].recordCount;
        else if (cls === 'practice') practiceRows += groups[i].recordCount;
        else if (cls === 'fixed' && !leaderboardGroupComparable(meta)) {
          oldRuleRows += groups[i].recordCount;
        }
      }
      noneText.appendChild(
        el(
          'p',
          'setup-random-note',
          (legacyRows > 0
            ? '本机有 ' + legacyRows + ' 条历史记录（未记录速度），仅作展示；'
            : '') +
            (oldRuleRows > 0
              ? '另有 ' +
                oldRuleRows +
                ' 条其他规则版本固定成绩（与当前 v' +
                LEADERBOARD_CURRENT_RULES_VERSION +
                ' 不同），仅作历史展示；'
              : '') +
            (practiceRows > 0
              ? '另有 ' + practiceRows + ' 条练习记录（切速或练习码）；'
              : '') +
            '它们都不参与固定速度比较。完成一局中途未切速的单人或挑战赛后会形成可比分组。'
        )
      );
      noneCard.appendChild(noneMark);
      noneCard.appendChild(noneText);
      this.body.appendChild(noneCard);
    }

    const groupSection = el('div', 'setup-section');
    groupSection.appendChild(el('span', 'section-index', '分组'));
    groupSection.appendChild(
      el(
        'p',
        'section-note',
        '同图同种子、同难度、同时长、同技能规则、同速度与规则版本才同组；异图、异种子或异速度不合并成总榜，练习组不排名，其他规则版本组仅作历史展示。'
      )
    );

    const list = el('div', 'map-list');
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      const meta = rankMetaOf(group);
      const rankClass = leaderboardRankClass(meta);
      const ranked =
        rankClass === 'fixed' && leaderboardGroupComparable(meta);
      const option = el('button', 'map-option');
      option.type = 'button';
      option.setAttribute('data-group', group.id);
      if (rankClass !== null) option.setAttribute('data-rank-class', rankClass);
      if (rankClass === 'fixed') {
        option.setAttribute('data-comparable', ranked ? 'true' : 'false');
      }
      option.setAttribute(
        'aria-label',
        group.mapName +
          '，' +
          leaderboardGroupCondition(group) +
          '，' +
          (rankClass === 'practice'
            ? '练习，不排名，'
            : rankClass === 'fixed' && !ranked
              ? '其他规则版本，不可比，'
              : '') +
          group.recordCount +
          ' 条，' +
          (ranked ? '最佳 ' : '最高分 ') +
          group.bestScore +
          ' 分'
      );
      const mark = el('span', 'setup-random-mark', groupMark(group));
      mark.setAttribute('aria-hidden', 'true');
      const info = el('div', 'map-info');
      info.appendChild(el('p', 'map-name', group.mapName));
      info.appendChild(
        el(
          'p',
          'map-meta',
          leaderboardGroupCondition(group) + ' · ' + group.recordCount + ' 条'
        )
      );
      const best = el('div', 'garrison-block');
      best.appendChild(
        el('span', 'garrison-label', ranked ? '最佳' : '最高分')
      );
      best.appendChild(el('span', 'garrison-value', String(group.bestScore)));
      option.appendChild(mark);
      option.appendChild(info);
      option.appendChild(best);
      option.addEventListener('click', function () {
        self.selectGroup(group.id);
      });
      list.appendChild(option);
      this.groupButtons.push({ id: group.id, node: option });
    }
    groupSection.appendChild(list);
    this.body.appendChild(groupSection);

    const rankingSection = el('div', 'setup-section');
    rankingSection.appendChild(el('span', 'section-index', '组内记录'));
    rankingSection.appendChild(
      el(
        'p',
        'section-note',
        '固定挑战按最终控地分值从高到低；同分先完成者在前，再按记录编号。用时仅展示，不参与排名；练习组不排名。'
      )
    );
    const detailHost = el('div', 'setup-panel');
    detailHost.setAttribute('role', 'region');
    detailHost.setAttribute('aria-label', '所选分组的组内排名');
    rankingSection.appendChild(detailHost);
    this.body.appendChild(rankingSection);
    this.detailHost = detailHost;

    let initial = this.selectedGroupId;
    if (!initial || !this.groupExists(initial)) {
      const preferred = this.options.initialGroupId;
      initial =
        preferred && this.groupExists(preferred) ? preferred : groups[0].id;
    }
    this.selectGroup(initial);
  }

  private groupExists(groupId: string): boolean {
    for (let i = 0; i < this.groupButtons.length; i += 1) {
      if (this.groupButtons[i].id === groupId) return true;
    }
    return false;
  }

  /**
   * Trim counters from the v1.2 store. `trimNotice()` is the cold-start-safe
   * source: its counters are persisted, and `unpersisted` marks a failed write
   * whose counts must not be presented as saved. Stores without it fall back to
   * the individual readers, which keep the old stub behaviour.
   */
  private trimInfo(): { legacy: number; modern: number; unpersisted: boolean } {
    const store = this.store as unknown as Record<string, unknown>;
    const reader = store.trimNotice;
    if (typeof reader === 'function') {
      try {
        const raw = (reader as () => unknown).call(this.store);
        if (raw && typeof raw === 'object') {
          const value = raw as {
            legacy?: unknown;
            modern?: unknown;
            unpersisted?: unknown;
          };
          return {
            legacy: this.positiveCount(value.legacy),
            modern: this.positiveCount(value.modern),
            unpersisted: value.unpersisted === true,
          };
        }
      } catch (error) {
        // Fall through to the individual readers below.
      }
    }
    return {
      legacy: this.countStoreValue('evictedLegacyRecords'),
      modern: this.countStoreValue('evictedRecords'),
      unpersisted: false,
    };
  }

  private positiveCount(value: unknown): number {
    return typeof value === 'number' && isFinite(value) && value > 0
      ? Math.floor(value)
      : 0;
  }

  /**
   * Reads one optional v1.2 store counter. A store that predates the field (or
   * throws) yields 0, so the screen never depends on the newer API to render.
   */
  private countStoreValue(
    name: 'migratedLegacyRecords' | 'evictedLegacyRecords' | 'evictedRecords'
  ): number {
    const store = this.store as unknown as Record<string, unknown>;
    const reader = store[name];
    if (typeof reader !== 'function') return 0;
    try {
      const value = (reader as () => unknown).call(this.store);
      return typeof value === 'number' && isFinite(value) && value > 0
        ? Math.floor(value)
        : 0;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Number of groups that may be compared, or -1 when the store exposes no
   * rank-class information at all (a v1.1 stub). `-1` keeps the older layout:
   * no "no comparable result yet" card is invented without evidence.
   */
  private comparableGroupCount(groups: LeaderboardGroupSummary[]): number {
    const store = this.store as unknown as Record<string, unknown>;
    const reader = store.comparableGroups;
    if (typeof reader === 'function') {
      try {
        const value = (reader as () => unknown).call(this.store);
        if (Array.isArray(value)) return value.length;
      } catch (error) {
        // Fall through to the structural count below.
      }
    }
    let known = false;
    let count = 0;
    for (let i = 0; i < groups.length; i += 1) {
      const meta = rankMetaOf(groups[i]);
      if (leaderboardRankClass(meta) !== null) known = true;
      if (leaderboardGroupComparable(meta)) count += 1;
    }
    return known ? count : -1;
  }

  private selectGroup(groupId: string): void {
    this.selectedGroupId = groupId;
    for (let i = 0; i < this.groupButtons.length; i += 1) {
      const entry = this.groupButtons[i];
      const active = entry.id === groupId;
      if (active) entry.node.classList.add('is-active');
      else entry.node.classList.remove('is-active');
      entry.node.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    const host = this.detailHost;
    if (!host) return;
    clear(host);
    const group = this.store.group(groupId);
    if (!group) {
      host.appendChild(
        el('p', 'section-note', '该分组已不存在，请重新选择。')
      );
      return;
    }
    this.renderGroupDetail(host, group);
  }

  private renderGroupDetail(host: HTMLElement, group: LeaderboardGroup): void {
    const meta = rankMetaOf(group);
    const rankClass = leaderboardRankClass(meta);
    const ranked = rankClass === 'fixed' && leaderboardGroupComparable(meta);
    const card = el('div', 'setup-random-card');
    card.setAttribute(
      'data-rank-class',
      rankClass === null ? 'v1' : rankClass
    );
    if (rankClass === 'fixed') {
      card.setAttribute('data-comparable', ranked ? 'true' : 'false');
    }
    const mark = el('span', 'setup-random-mark', groupMark(group));
    mark.setAttribute('aria-hidden', 'true');
    const text = el('div', 'setup-random-text');
    text.appendChild(
      el('p', 'setup-random-title', group.mapName + ' · 战场 #' + group.seed)
    );
    text.appendChild(
      el(
        'p',
        'setup-random-note',
        leaderboardGroupCondition(group) +
          ' · ' +
          group.recordCount +
          ' 条 · ' +
          (ranked ? '最佳 ' : '最高分 ') +
          group.bestScore +
          ' 分'
      )
    );
    if (rankClass === 'practice') {
      const practiceVersion =
        typeof meta.rulesVersion === 'number' &&
        isFinite(meta.rulesVersion) &&
        meta.rulesVersion !== LEADERBOARD_CURRENT_RULES_VERSION
          ? '（规则 v' +
            meta.rulesVersion +
            '，与当前 v' +
            LEADERBOARD_CURRENT_RULES_VERSION +
            ' 不同）'
          : '';
      text.appendChild(
        el(
          'p',
          'setup-random-note leaderboard-practice-note',
          '练习组' +
            practiceVersion +
            '：本组分数只作个人参考，不与固定挑战组混排或比较。'
        )
      );
    } else if (rankClass === 'legacy') {
      text.appendChild(
        el(
          'p',
          'setup-random-note leaderboard-legacy-note',
          '历史记录：旧版挑战码未记录速度与规则版本，已保留展示，不与新固定榜混排。'
        )
      );
    } else if (rankClass === 'fixed' && !ranked) {
      text.appendChild(
        el(
          'p',
          'setup-random-note leaderboard-legacy-note',
          '其他规则版本记录：规则 ' +
            (meta.rulesVersion === null ? '未记录' : 'v' + meta.rulesVersion) +
            ' 与当前 v' +
            LEADERBOARD_CURRENT_RULES_VERSION +
            ' 不同，仅作历史展示，不参与当前固定榜排名。'
        )
      );
    }
    card.appendChild(mark);
    card.appendChild(text);
    host.appendChild(card);

    // A group with no retained records is an honest empty state, never a
    // fabricated rank or a placeholder row.
    if (group.records.length === 0) {
      host.appendChild(
        el('p', 'section-note leaderboard-group-empty', '本组暂无记录。')
      );
      return;
    }

    for (let i = 0; i < group.records.length; i += 1) {
      const record = group.records[i];
      const row = el('div', 'setup-random-card');
      if (rankClass === null || ranked || rankClass === 'legacy') {
        row.setAttribute('data-rank', String(i + 1));
      }
      row.setAttribute('data-record-id', record.id);
      if (rankClass !== null) row.setAttribute('data-rank-class', rankClass);
      const rowLabel =
        rankClass === 'practice'
          ? '练习记录，不排名，'
          : rankClass === 'fixed' && !ranked
            ? '其他规则版本记录，不参与当前排名，'
            : '第 ' + (i + 1) + ' 名，';
      row.setAttribute(
        'aria-label',
        rowLabel + record.nickname + '，' + record.score + ' 分，' + detailMeta(record)
      );
      // Only current fixed (and v1.1 stub) rows show a rank number. Practice
      // rows show "练"; an older fixed version shows "史" as history-only.
      const rank = el(
        'span',
        'setup-random-mark',
        rankClass === 'practice'
          ? '练'
          : rankClass === 'fixed' && !ranked
            ? '史'
            : String(i + 1)
      );
      rank.setAttribute('aria-hidden', 'true');
      const info = el('div', 'map-info');
      info.appendChild(el('p', 'map-name', record.nickname));
      info.appendChild(el('p', 'map-meta', detailMeta(record)));
      if (rankClass === 'practice') {
        info.appendChild(
          el('p', 'map-meta leaderboard-practice-row', '练习 · 不计排名')
        );
      } else if (rankClass === 'fixed' && !ranked) {
        info.appendChild(
          el(
            'p',
            'map-meta leaderboard-legacy-row',
            '其他规则版本 · 不可比'
          )
        );
      }
      const score = el('div', 'garrison-block');
      score.appendChild(el('span', 'garrison-label', '控地分值'));
      score.appendChild(el('span', 'garrison-value', String(record.score)));
      row.appendChild(rank);
      row.appendChild(info);
      row.appendChild(score);
      host.appendChild(row);
    }

    host.appendChild(
      el(
        'p',
        'section-note',
        rankClass === 'practice'
          ? '只列本机练习记录；练习分数不参与任何名次。'
          : rankClass === 'legacy'
            ? '只列本机历史记录；旧记录无速度，仅在组内展示，不参与新固定榜比较。'
            : rankClass === 'fixed' && !ranked
              ? '只列本机其他规则版本记录；不等于当前固定榜，不显示当前规则名次。'
              : '只列本机记录；分数只在同一分组内可比。'
      )
    );
  }
}
