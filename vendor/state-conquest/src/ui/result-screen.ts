import {
  CHALLENGE_CASUAL_NOTICE,
  CHALLENGE_RULES_VERSION,
  CHALLENGE_V2_CODE_PREFIX,
} from '../core/challenge';
import type { ShareCapabilities, WarReportModel } from '../platform/share';
import { VERSUS_BLUE_NAME, VERSUS_RED_NAME } from '../config/balance';
import { button, el } from './dom';
import {
  challengeRulesetLabel,
  copyChallengeCode,
} from './challenge-screen';
import type { ChallengeCodeFamily } from './challenge-screen';
import {
  DIFFICULTY_LABEL,
  RESULT_LABEL,
  durationLabel,
  formatClock,
  modeName,
} from './format';
import {
  activeFactions,
  aiScoreOf,
  aiTerritoriesOf,
  factionDisplayName,
  factionRankOf,
  factionScoreOf,
  factionTerritoriesOf,
  isFactionAlive,
  neutralTerritoriesOf,
} from './factions';
import { paintMapThumbnail } from '../rendering/poster-thumbnail';
import type { MatchView, ResultKind } from './view-model';

export interface ResultShare {
  renderPoster(model: WarReportModel): string;
  saveImage(dataUrl: string): Promise<boolean>;
  postNote(dataUrl: string, title: string, text: string): Promise<boolean>;
  capabilities(): ShareCapabilities;
}

export interface ResultReward {
  /** Gold earned this match (0 in versus mode). */
  gold: number;
  /** Archive balance after this match. */
  totalGold: number;
  /** v2 progression reward; optional for old callers and versus. */
  experience?: number;
  totalExperience?: number;
  level?: number;
  levelsGained?: number;
  /** False when the archive barrier refused settlement; no reward is claimed. */
  settled?: boolean;
  mode: 'solo' | 'versus';
}

/**
 * Optional settlement outcome of the local leaderboard write. v1.2 shells pass
 * the `LeaderboardRecordResult` fields they received; a row that was accepted
 * but not retained (over the per-group or total cap) must be reported here
 * instead of looking like a normal ranking entry.
 */
export interface ResultLeaderboard {
  recorded: boolean;
  /** False when the accepted row fell outside the caps at once. */
  retained?: boolean;
  /** 1-based rank when retained. */
  rank?: number;
  /** Shell-provided wording, e.g. a storage failure explanation. */
  notice?: string | null;
}

/**
 * One line explaining what happened to this match in the local archive.
 * Empty when the row was retained normally or the shell passed nothing.
 */
export function resultLeaderboardNote(
  info: ResultLeaderboard | null | undefined
): string {
  if (!info || info.recorded !== true) return '';
  if (info.retained === false) {
    return info.notice || '本局成绩已记录但未保留：组内或整库已满，低分记录先被淘汰。';
  }
  if (typeof info.rank === 'number' && info.rank > 0) {
    return (
      (info.notice ? info.notice + ' · ' : '') +
      '本机排行：本组第 ' +
      info.rank +
      ' 名（仅本机）'
    );
  }
  return info.notice || '';
}

/**
 * Async challenge settlement shown above the normal reward card.
 *
 * v1.1 callers pass only the five required fields and get the v1.1 comparison
 * card. v1.2 callers add the fairness fields: `comparable: false` (or
 * `fairness: 'practice'`, or `family: 'legacy'`) turns the match into an
 * ordinary solo settlement that never claims a challenge verdict.
 */
export interface ResultChallenge {
  playerScore: number;
  challengeScore: number;
  verdict: ResultKind;
  gold: number;
  /** False for legacy codes and for matches whose rules changed mid-game. */
  comparable?: boolean;
  /**
   * Code family. `v3` is reserved for the upcoming multi-faction codec
   * (SM family, payload.factionCount 3|4); this screen tolerates it before
   * that codec lands by treating an unknown-ruleset code as practice.
   */
  family?: ChallengeCodeFamily | 'v3';
  /** Speed the challenge was played at; omitted for legacy codes. */
  speed?: number | null;
  /** Ruleset version recorded in the code; omitted for legacy codes. */
  rulesVersion?: number | null;
  fairness?: 'fair' | 'practice';
  /** Why the match is practice-only (shown verbatim above the reward). */
  practiceReason?: string | null;
  /** Decoder notice, e.g. a changed-speed explanation. */
  notice?: string | null;
}

export interface ResultCallbacks {
  onRestart: () => void;
  onHome: () => void;
  share: ResultShare;
  mapView: MatchView;
  dateLabel: string;
  /** Frozen swatch used by this match's battlefield and report. */
  playerColorId?: string | null;
  reward: ResultReward;
  /** Present only when the match was accepted from a challenge code. */
  challenge?: ResultChallenge | null;
  /** This match's own shareable challenge code (when policy allows it). */
  challengeCode?: string | null;
  /** Fairness of this match's issued code; practice codes never rank. */
  challengeCodeFairness?: 'fair' | 'practice' | null;
  /** Policy copy for a practice code, shown beside the code itself. */
  challengeCodeNotice?: string | null;
  /** Optional local-leaderboard settlement outcome (v1.2 shells). */
  leaderboard?: ResultLeaderboard | null;
}

/** A practice challenge is settled as a normal solo match, never a verdict. */
export function isPracticeChallenge(
  challenge: ResultChallenge | null | undefined
): boolean {
  if (!challenge) return false;
  if (challenge.comparable === false) return true;
  if (challenge.fairness === 'practice') return true;
  if (challenge.family === 'legacy') return true;
  // A comparable verdict also requires the code's ruleset to be this build's:
  // a fixed result from another known version is history, never a fair win.
  if (
    typeof challenge.rulesVersion === 'number' &&
    challenge.rulesVersion !== CHALLENGE_RULES_VERSION
  ) {
    return true;
  }
  return false;
}

/** One-line ruleset label; empty for v1.1 calls that pass no v1.2 fields. */
function challengeFairnessMeta(challenge: ResultChallenge): string {
  if (challenge.rulesVersion === undefined && challenge.speed === undefined) {
    return '';
  }
  return challengeRulesetLabel({
    family: challenge.family,
    comparable: !isPracticeChallenge(challenge),
    speed: challenge.speed,
    rulesVersion: challenge.rulesVersion,
  });
}

/** Practice copy shown above the reward; the reason is never invented. */
export function challengePracticeNotice(challenge: ResultChallenge): string {
  if (!isPracticeChallenge(challenge)) return '';
  if (challenge.notice) return challenge.notice;
  if (challenge.practiceReason) return challenge.practiceReason;
  return challenge.family === 'legacy'
    ? '旧版挑战码未记录速度与规则版本，本局只作同图练习。'
    : '本局规则与挑战码不一致，按练习处理，不计挑战胜负。';
}

function verdictWord(verdict: ResultKind): string {
  if (verdict === 'win') return '胜';
  if (verdict === 'lose') return '负';
  return '平';
}

function versusTitle(result: ResultKind): string {
  if (result === 'win') return VERSUS_BLUE_NAME + '获胜';
  if (result === 'lose') return VERSUS_RED_NAME + '获胜';
  return '平局';
}

function endReasonLabel(view: MatchView): string {
  if (view.endReason === 'resign') return '认输 · 按负局记录';
  if (view.endReason === 'stalemate') return '僵局 · 按当前比分结算';
  if (view.endReason === 'elimination') return '淘汰结算';
  if (view.endReason === 'timeout') return '倒计时结算';
  return '结算原因未知';
}

function resultSubtitle(
  view: MatchView,
  result: ResultKind,
  enemyLand: number,
  challenge: ResultChallenge | null,
  practice: boolean
): string {
  if (view.mode === 'versus') {
    if (result === 'win') return VERSUS_BLUE_NAME + '控地分值领先，赢得本局。';
    if (result === 'lose') return VERSUS_RED_NAME + '控地分值领先，赢得本局。';
    return VERSUS_BLUE_NAME + '与' + VERSUS_RED_NAME + '控地分值相同，战成平局。';
  }
  // Resignation owns the outcome even when the match came from a challenge
  // code. The result must never read as a win against the posted target, and
  // the v2 reward policy pays nothing for a voluntary resign: the subtitle
  // states the loss record and the missing gold/experience in one sentence.
  if (view.endReason === 'resign') return '本局已主动认输，按负局记录，不获得金币与经验。';
  if (challenge && !practice) {
    if (result === 'win') return '挑战赛 · 你的控地分值高于挑战者。';
    if (result === 'lose') return '挑战赛 · 你的控地分值低于挑战者。';
    return '挑战赛 · 与挑战者的控地分值相同。';
  }
  if (practice) {
    if (view.endReason === 'stalemate') {
      return '练习局 · 战局僵持，按当前控地分值结算。';
    }
    if (result === 'win') {
      return enemyLand === 0 ? '练习局 · 敌军已被全部逐出战场。' : '练习局 · 倒计时结束，你的控地分值领先。';
    }
    if (result === 'lose') {
      return view.territoryCounts.player === 0
        ? '练习局 · 最后一块领地失守，战线崩解。'
        : '练习局 · 倒计时结束，控地分值落后。';
    }
    return '练习局 · 双方控地分值相同，战成平局。';
  }
  if (view.endReason === 'stalemate') {
    return '战局进入僵局，按当前控地分值结算。';
  }
  if (result === 'win') {
    return enemyLand === 0 ? '敌军已被全部逐出战场。' : '倒计时结束，你的控地分值领先。';
  }
  if (result === 'lose') {
    return view.territoryCounts.player === 0
      ? '最后一块领地失守，战线崩解。'
      : '倒计时结束，控地分值落后。';
  }
  return '双方控地分值完全相同，战成平局。';
}

/**
 * Result screen. A v1.1 challenge call (five fields only) renders the v1.1
 * comparison untouched. v1.2 adds the fairness fields: a legacy code, a
 * practice code, or a match whose speed changed mid-game settles as an ordinary
 * solo result that never displays a verdict against the author.
 */
export function createResultScreen(
  view: MatchView,
  callbacks: ResultCallbacks
): HTMLElement {
  const challenge = callbacks.challenge || null;
  const versus = view.mode === 'versus';
  // A practice challenge (legacy code, or speed changed mid-match) settles as
  // an ordinary solo match: it has no verdict against the author at all.
  const practice = isPracticeChallenge(challenge);
  const compared = challenge !== null && !practice;
  const result: ResultKind = compared
    ? (challenge as ResultChallenge).verdict
    : view.result || 'draw';
  const factions = activeFactions(view);
  const multiFaction = !versus && factions.length > 2;
  // AI totals span every seated AI faction; ai3 contributes 0 in a 2/3-way
  // match, so the legacy two-side numbers are unchanged.
  const enemyLand = aiTerritoriesOf(view);
  const enemyScore = aiScoreOf(view);
  const root = el('section', 'screen result-screen result-' + result);
  root.setAttribute('aria-labelledby', 'result-title');
  root.setAttribute('data-result', result);
  root.setAttribute('data-end-reason', view.endReason || 'unknown');
  root.setAttribute(
    'data-diplomacy-used',
    view.diplomacy && (view.diplomacy.uses || 0) > 0 ? 'true' : 'false'
  );
  if (challenge) {
    root.setAttribute('data-challenge', compared ? 'comparable' : 'practice');
    root.setAttribute('data-challenge-family', challenge.family || 'v1');
  }

  const geography = view.geography;
  const regionLabel =
    (view.geog && view.geog.regionLabel) ||
    (geography && geography.regionLabel) ||
    view.mapName;

  const top = el('div', 'result-top');
  top.appendChild(
    el(
      'p',
      'result-kicker',
      (compared
        ? 'CHALLENGE REPORT · '
        : practice
          ? 'PRACTICE REPORT · '
          : versus
            ? 'VERSUS REPORT · '
            : 'BATTLE REPORT · ') + regionLabel
    )
  );
  const stamp = el('div', 'result-stamp');
  stamp.appendChild(
    el(
      'span',
      'result-stamp-char',
      versus
        ? result === 'win'
          ? '蓝'
          : result === 'lose'
            ? '红'
            : '和'
        : result === 'win'
          ? '胜'
          : result === 'lose'
            ? '败'
            : '和'
    )
  );
  stamp.setAttribute('aria-hidden', 'true');
  const title = el(
    'h1',
    'result-title',
    versus ? versusTitle(result) : RESULT_LABEL[result]
  );
  title.id = 'result-title';
  const subtitle = el(
    'p',
    'result-subtitle',
    resultSubtitle(view, result, enemyLand, challenge, practice)
  );
  top.appendChild(stamp);
  top.appendChild(title);
  top.appendChild(subtitle);

  const board = el('div', 'result-scoreboard');
  let multiNote: HTMLElement | null = null;
  if (multiFaction) {
    // One card per seated faction, roster order preserved. Rank is computed by
    // the honest score → land → force rule from ui/factions.ts and explained
    // in the note below, so no card invents a misleading winner.
    board.setAttribute('data-faction-count', String(factions.length));
    for (let i = 0; i < factions.length; i += 1) {
      const owner = factions[i];
      const alive = isFactionAlive(view, owner);
      const score = factionScoreOf(view, owner);
      const land = factionTerritoriesOf(view, owner);
      const rank = factionRankOf(view, owner);
      const side = el('div', 'result-side result-faction');
      side.setAttribute('data-faction', owner);
      side.setAttribute('data-alive', alive ? 'true' : 'false');
      side.setAttribute('data-rank', String(rank));
      side.setAttribute(
        'aria-label',
        factionDisplayName(owner) +
          '，控地分值 ' +
          score +
          '，' +
          (alive ? '领地 ' + land + '，第 ' + rank + ' 名' : '已淘汰')
      );
      side.appendChild(el('span', 'result-side-label', factionDisplayName(owner)));
      side.appendChild(el('b', 'result-side-score', String(score)));
      side.appendChild(
        el(
          'em',
          'result-side-land',
          alive ? land + ' 块领地 · 第 ' + rank + ' 名' : '已淘汰'
        )
      );
      board.appendChild(side);
    }
    multiNote = el(
      'p',
      'result-multi-note',
      '排名按控地分值，同分依次比较领地数与总兵力；各阵营独立互攻，中立领地不计入任何一方。'
    );
  } else {
    const playerSide = el('div', 'result-side result-player');
    playerSide.appendChild(
      el('span', 'result-side-label', versus ? VERSUS_BLUE_NAME : '我方')
    );
    playerSide.appendChild(el('b', 'result-side-score', String(view.scores.player)));
    playerSide.appendChild(el('em', 'result-side-land', view.territoryCounts.player + ' 块领地'));
    const center = el('div', 'result-vs');
    center.appendChild(el('span', 'result-vs-label', '控地分值'));
    center.appendChild(el('span', 'result-vs-line', ''));
    // A comparable challenge has no live opponent: the right column is the
    // posted target, never this match's unrelated AI score. A practice match has
    // no comparison at all and keeps the ordinary solo right column.
    const enemySide = el('div', 'result-side result-enemy');
    enemySide.appendChild(
      el(
        'span',
        'result-side-label',
        compared ? '挑战者' : versus ? VERSUS_RED_NAME : '敌方'
      )
    );
    enemySide.appendChild(
      el(
        'b',
        'result-side-score',
        String(compared ? (challenge as ResultChallenge).challengeScore : enemyScore)
      )
    );
    enemySide.appendChild(
      el(
        'em',
        'result-side-land',
        compared ? '目标分数' : enemyLand + ' 块领地'
      )
    );
    board.appendChild(playerSide);
    board.appendChild(center);
    board.appendChild(enemySide);
  }

  let challengeCard: HTMLElement | null = null;
  let practiceCard: HTMLElement | null = null;
  if (compared && challenge) {
    challengeCard = el('div', 'result-detail result-challenge');
    challengeCard.setAttribute('data-verdict', challenge.verdict);
    const cells: Array<[string, string]> = [
      ['我的分', String(challenge.playerScore)],
      ['挑战分', String(challenge.challengeScore)],
      ['挑战结果', verdictWord(challenge.verdict)],
      ['获得金币', (challenge.gold > 0 ? '+' : '') + challenge.gold],
    ];
    const fairness = challengeFairnessMeta(challenge);
    if (fairness) {
      challengeCard.setAttribute('data-fairness', 'fixed');
      cells.push(['规则', fairness]);
    }
    for (let i = 0; i < cells.length; i += 1) {
      const cell = el('div', 'result-detail-cell challenge-cell');
      cell.appendChild(el('span', 'result-detail-label', cells[i][0]));
      cell.appendChild(el('b', 'result-detail-value', cells[i][1]));
      challengeCard.appendChild(cell);
    }
  } else if (practice && challenge) {
    // Practice: one explicit note, no verdict, no challenge-vs-you columns.
    practiceCard = el('div', 'result-detail result-practice');
    practiceCard.setAttribute('data-practice', 'true');
    const cell = el('div', 'result-detail-cell result-practice-cell');
    cell.appendChild(el('span', 'result-detail-label', '练习说明'));
    cell.appendChild(
      el('b', 'result-detail-value', challengePracticeNotice(challenge))
    );
    practiceCard.appendChild(cell);
  }

  const reward = el('div', 'result-reward');
  const rewardSettled = callbacks.reward.settled !== false;
  reward.setAttribute('data-settled', rewardSettled ? 'true' : 'false');
  const rewardMain = el('div', 'result-reward-main');
  rewardMain.appendChild(el('span', 'result-reward-label', '本局金币'));
  rewardMain.appendChild(
    el(
      'b',
      'result-reward-value',
      rewardSettled
        ? (callbacks.reward.gold > 0 ? '+' : '') + callbacks.reward.gold
        : '—'
    )
  );
  reward.appendChild(rewardMain);
  if (!rewardSettled) {
    reward.appendChild(
      el('span', 'result-reward-progress', '奖励未结算 · 本机档案当前不可写入')
    );
  } else if (callbacks.reward.experience !== undefined && callbacks.reward.experience > 0) {
    reward.appendChild(
      el(
        'span',
        'result-reward-progress',
        '+' + callbacks.reward.experience +
          ' XP · 指挥官 Lv.' + (callbacks.reward.level || 1) +
          (callbacks.reward.levelsGained && callbacks.reward.levelsGained > 0
            ? ' · 升级 +' + callbacks.reward.levelsGained
            : '')
      )
    );
  }
  reward.appendChild(
    el(
      'span',
      'result-reward-note',
      !rewardSettled
        ? '本局战绩已展示，金币与成长未保存。'
        : compared
          ? '挑战赛 · ' +
              DIFFICULTY_LABEL[view.difficulty] +
              '难度 · ' +
              verdictWord(result) +
              ' · 余额 ' +
              callbacks.reward.totalGold
          : callbacks.reward.mode === 'solo'
            ? view.endReason === 'resign'
              ? // v2 reward policy: a voluntary resign records the loss but
                // pays nothing. The note states that policy in user-readable
                // words; the amounts themselves stay callback-driven and are
                // never faked to zero here. Natural defeats keep the ordinary
                // wording below; versus never pays and keeps its own line.
                '主动认输 · 无金币与经验 · 余额 ' + callbacks.reward.totalGold
              : DIFFICULTY_LABEL[view.difficulty] +
                '难度 · ' +
                (practice ? '练习局 · ' : '') +
                RESULT_LABEL[result] +
                '奖励 · 余额 ' +
                callbacks.reward.totalGold
            : '双人同屏 · 本局不计金币 · 余额 ' + callbacks.reward.totalGold
    )
  );

  const details = el('div', 'result-detail');
  // Versus has no per-side "troops sent" stat for red, so the shared row is
  // omitted rather than showing a blue-only number.
  let rows: Array<[string, string]>;
  if (versus) {
    rows = [
      ['模式', '双人对战'],
      ['结局', endReasonLabel(view)],
      ['单局', durationLabel(view.durationTicks / 10)],
      ['用时', formatClock(Math.floor(view.tick / 10))],
      [VERSUS_BLUE_NAME + '领地', String(view.territoryCounts.player)],
      [VERSUS_RED_NAME + '领地', String(view.territoryCounts.ai1)],
      ['剩余中立', String(Math.max(0, view.territories.length - view.territoryCounts.player - view.territoryCounts.ai1))],
    ];
  } else if (multiFaction) {
    rows = [
      ['难度', DIFFICULTY_LABEL[view.difficulty]],
      ['结局', endReasonLabel(view)],
      ['单局', durationLabel(view.durationTicks / 10)],
      ['用时', formatClock(Math.floor(view.tick / 10))],
      ['占领次数', String(view.stats.capturesByPlayer)],
      ['最高控地', view.stats.maxTerritoriesByPlayer + ' 块'],
      ['派出兵力', String(view.stats.troopsSentByPlayer)],
    ];
    // One land row per seated faction; the neutral remainder is what no
    // faction holds (charged against all of them together).
    for (let i = 0; i < factions.length; i += 1) {
      rows.push([
        factionDisplayName(factions[i]) + '领地',
        String(factionTerritoriesOf(view, factions[i])),
      ]);
    }
    rows.push(['剩余中立', String(neutralTerritoriesOf(view))]);
  } else {
    rows = [
      ['难度', DIFFICULTY_LABEL[view.difficulty]],
      ['结局', endReasonLabel(view)],
      ['单局', durationLabel(view.durationTicks / 10)],
      ['用时', formatClock(Math.floor(view.tick / 10))],
      ['占领次数', String(view.stats.capturesByPlayer)],
      ['最高控地', view.stats.maxTerritoriesByPlayer + ' 块'],
      ['派出兵力', String(view.stats.troopsSentByPlayer)],
      ['剩余领地', view.territoryCounts.player + ' / ' + view.territories.length],
    ];
  }
  for (let i = 0; i < rows.length; i += 1) {
    const cell = el('div', 'result-detail-cell');
    cell.appendChild(el('span', 'result-detail-label', rows[i][0]));
    cell.appendChild(el('b', 'result-detail-value', rows[i][1]));
    details.appendChild(cell);
  }

  // Versus is a local two-human match with no shareable challenge target, so
  // the code card and the note suffix are suppressed here as well as upstream.
  const challengeCode = versus ? '' : callbacks.challengeCode || '';
  const challengeCodeFairness = callbacks.challengeCodeFairness || 'fair';
  let codeBlock: HTMLElement | null = null;
  if (challengeCode) {
    codeBlock = el('div', 'setup-random-card result-challenge-code');
    codeBlock.setAttribute('data-fairness', challengeCodeFairness);
    codeBlock.appendChild(el('span', 'setup-random-mark', '码'));
    const codeText = el('div', 'setup-random-text challenge-code-text');
    codeText.appendChild(
      el(
        'p',
        'setup-random-title',
        challengeCodeFairness === 'practice' ? '练习挑战码' : '挑战码'
      )
    );
    const field = el('div', 'profile-name-field');
    const codeInput = el('input', 'profile-name-input challenge-code-input');
    codeInput.type = 'text';
    codeInput.value = challengeCode;
    codeInput.readOnly = true;
    codeInput.setAttribute('readonly', 'readonly');
    codeInput.setAttribute('aria-label', '本局挑战码');
    field.appendChild(codeInput);
    codeText.appendChild(field);
    const copyNote = el(
      'p',
      'profile-hint challenge-copy-note',
      '同图同难度再战：把挑战码发给好友即可。'
    );
    codeText.appendChild(copyNote);
    if (challengeCodeFairness === 'practice') {
      codeText.appendChild(
        el(
          'p',
          'profile-hint challenge-practice-notice',
          callbacks.challengeCodeNotice || '本局仅作练习，不参与排名。'
        )
      );
    }
    // A casual SV code can only be opened by a build with the fourth
    // difficulty index. Show the shared compatibility wording right where the
    // sender copies the code; other tiers and matches without a code are
    // untouched.
    if (
      view.difficulty === 'casual' &&
      challengeCode.slice(0, CHALLENGE_V2_CODE_PREFIX.length) ===
        CHALLENGE_V2_CODE_PREFIX
    ) {
      codeText.appendChild(
        el('p', 'profile-hint challenge-casual-notice', CHALLENGE_CASUAL_NOTICE)
      );
    }
    const copyActions = el('div', 'poster-actions');
    const copyButton = button(
      '复制挑战码',
      'btn btn-secondary poster-btn challenge-copy',
      function () {
        copyChallengeCode(challengeCode, codeInput, copyNote);
      }
    );
    copyButton.setAttribute('aria-label', '复制本局挑战码');
    copyActions.appendChild(copyButton);
    codeText.appendChild(copyActions);
    codeBlock.appendChild(codeText);
  }

  const shareBlock = el('div', 'result-share');
  const caps = callbacks.share.capabilities();
  const posterWrap = el('div', 'poster-wrap');
  const posterHost = el('div', 'poster-host');
  const posterNote = el('p', 'poster-note', '');
  posterWrap.appendChild(posterHost);
  posterWrap.appendChild(posterNote);
  shareBlock.appendChild(posterWrap);

  let posterUrl = '';
  const shareActions = el('div', 'poster-actions');
  const saveBtn = button('保存战报', 'btn btn-secondary poster-btn', function () {
    if (!posterUrl) return;
    if (!caps.canSaveImage) {
      setPosterNote(posterNote, '当前环境不支持保存到相册，可长按预览图手动保存。');
      return;
    }
    setPosterNote(posterNote, '正在保存…');
    callbacks.share
      .saveImage(posterUrl)
      .then(function (ok) {
        setPosterNote(posterNote, ok ? '已保存到相册' : '保存未完成，可稍后再试。');
      })
      .catch(function () {
        setPosterNote(posterNote, '保存未完成，可稍后再试。');
      });
  });
  const noteBtn = button('分享笔记', 'btn btn-secondary poster-btn', function () {
    if (!posterUrl) return;
    if (!caps.canPostNote) {
      setPosterNote(posterNote, '当前环境不支持发布笔记，可先保存预览图。');
      return;
    }
    setPosterNote(posterNote, '正在打开发布页…');
    const summary = versus
      ? versusTitle(result) +
        ' · ' +
        view.mapName +
        ' · ' +
        VERSUS_BLUE_NAME +
        ' ' +
        view.scores.player +
        ' : ' +
        VERSUS_RED_NAME +
        ' ' +
        enemyScore
      : RESULT_LABEL[result] +
        ' · ' +
        view.mapName +
        ' · ' +
        view.scores.player +
        ':' +
        (compared ? (challenge as ResultChallenge).challengeScore : enemyScore) +
        (practice ? ' · 练习局（未与挑战者比较）' : '') +
        // The note carries this match's own code so a reader can replay the same
        // battlefield; matches without one (encode failed) keep the old text.
        (challengeCode ? ' · 挑战码 ' + challengeCode : '');
    callbacks.share
      .postNote(
        posterUrl,
        '寸土必争 · ' + (versus ? versusTitle(result) : RESULT_LABEL[result]),
        summary
      )
      .then(function (ok) {
        setPosterNote(posterNote, ok ? '已打开发布页' : '发布页未打开，可稍后再试。');
      })
      .catch(function () {
        setPosterNote(posterNote, '发布页未打开，可稍后再试。');
      });
  });

  if (!caps.platform) {
    setPosterNote(posterNote, '本地预览模式：未检测到小红书容器，保存与发布已关闭。');
  } else if (!caps.canWriteTempFile) {
    setPosterNote(posterNote, '当前客户端版本较低，可直接预览战报图。');
  } else {
    setPosterNote(
      posterNote,
      '战报图使用州界地理底图（架空地形），可保存到相册或发布笔记。'
    );
  }

  if (!caps.canSaveImage) saveBtn.disabled = true;
  if (!caps.canPostNote) noteBtn.disabled = true;
  shareActions.appendChild(saveBtn);
  shareActions.appendChild(noteBtn);
  shareBlock.appendChild(shareActions);

  try {
    const model: WarReportModel = {
      resultLabel: versus ? versusTitle(result) : RESULT_LABEL[result],
      resultKind: result,
      mapName: regionLabel,
      difficultyLabel: DIFFICULTY_LABEL[view.difficulty],
      modeLabel: compared
        ? '挑战赛'
        : versus
          ? '双人对战'
          : practice
            ? '练习赛 · 未比较'
            : modeName(view.durationTicks / 10),
      durationLabel: durationLabel(view.durationTicks / 10),
      elapsedLabel: formatClock(Math.floor(view.tick / 10)),
      score: view.scores.player,
      territoryCount: view.territoryCounts.player,
      // In versus both sides are human-scored; red is ai1 (ai2 never spawns).
      opponentScore: versus ? view.scores.ai1 : undefined,
      opponentTerritories: versus ? view.territoryCounts.ai1 : undefined,
      maxTerritories: view.stats.maxTerritoriesByPlayer,
      captures: view.stats.capturesByPlayer,
      dateLabel: callbacks.dateLabel,
      playerColorId: callbacks.playerColorId,
      challengeCode: challengeCode || undefined,
      thumbnail: function (ctx, x, y, width, height, palette) {
        paintMapThumbnail(view, ctx, x, y, width, height, palette);
      },
    };
    posterUrl = callbacks.share.renderPoster(model);
    const image = document.createElement('img');
    image.setAttribute('class', 'poster-image');
    image.setAttribute(
      'alt',
      '本局战报预览，包含' + regionLabel + '州界地理底图与架空战场缩略图'
    );
    image.setAttribute('src', posterUrl);
    posterHost.appendChild(image);
  } catch (error) {
    setPosterNote(posterNote, '战报图生成失败，不影响继续游戏。');
  }

  const actions = el('div', 'result-actions');
  const restart = button('再来一局', 'btn btn-primary btn-wide', callbacks.onRestart);
  restart.setAttribute('aria-label', '再来一局');
  const home = button('返回首页', 'btn btn-secondary btn-wide', callbacks.onHome);
  home.setAttribute('aria-label', '返回首页');
  actions.appendChild(restart);
  actions.appendChild(home);

  const recent = el(
    'p',
    'result-foot',
    '寸土必争 · ' + callbacks.dateLabel + ' · 战场 #' + view.seed
  );

  // Optional leaderboard settlement line: never claims a rank for a row that
  // was accepted but trimmed by the caps.
  const boardNote = resultLeaderboardNote(callbacks.leaderboard);
  let leaderboardNode: HTMLElement | null = null;
  if (boardNote) {
    leaderboardNode = el(
      'p',
      'section-note result-leaderboard-note',
      boardNote
    );
    const info = callbacks.leaderboard as ResultLeaderboard;
    leaderboardNode.setAttribute(
      'data-retained',
      info.retained === false ? 'false' : 'true'
    );
  }

  // v2.0 short-screen layout: the report content (top/board/reward/details/
  // share/foot) scrolls inside .result-scroll while .result-actions stays an
  // independent footer, so 再来一局/返回首页 are reachable without scrolling
  // on 640/720-height viewports. The root keeps its own overflow-y as the
  // whole-screen fallback for extreme short landscape.
  const scroll = el('div', 'result-scroll');
  scroll.appendChild(top);
  scroll.appendChild(board);
  if (multiNote) scroll.appendChild(multiNote);
  if (challengeCard) scroll.appendChild(challengeCard);
  scroll.appendChild(reward);
  scroll.appendChild(details);
  if (practiceCard) scroll.appendChild(practiceCard);
  if (codeBlock) scroll.appendChild(codeBlock);
  if (leaderboardNode) scroll.appendChild(leaderboardNode);
  scroll.appendChild(shareBlock);
  scroll.appendChild(recent);
  root.appendChild(scroll);
  root.appendChild(actions);

  return root;
}

function setPosterNote(node: HTMLElement, text: string): void {
  node.textContent = text;
}
