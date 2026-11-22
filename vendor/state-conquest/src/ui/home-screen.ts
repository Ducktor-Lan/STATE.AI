import type { MatchRecord } from './settings-store';
import type { CommanderProfile } from './profile-store';
import { normalizeGrowthState } from './progression';
import { BETRAYAL_MAX_LEVEL } from '../config/balance';
import { avatarNode } from './avatar';
import { button, el } from './dom';
import { formatClock } from './format';

export interface HomeOptions {
  records: MatchRecord[];
  /** Null while the archive has not loaded or before it is created. */
  profile: CommanderProfile | null;
}

export interface HomeCallbacks {
  onStart: () => void;
  onVersus: () => void;
  onChallenge: () => void;
  onRules: () => void;
  onProfile: () => void;
  onUpgrade: () => void;
  onProgress?: () => void;
  onLeaderboard: () => void;
  onSettings: () => void;
  onAuthor: () => void;
  /** Replay the interactive tutorial; only rendered when an archive exists. */
  onTutorial: () => void;
}

function resultWord(result: MatchRecord['result']): string {
  if (result === 'win') return '胜';
  if (result === 'lose') return '负';
  return '平';
}

function recentResultLabel(record: MatchRecord): string {
  if (record.mode !== 'versus') return resultWord(record.result);
  // Versus reuses win/lose for the blue/red perspective; the chip says which
  // colour actually won instead of a generic 胜/负.
  if (record.result === 'win') return '蓝胜';
  if (record.result === 'lose') return '红胜';
  return '平';
}

export class HomeScreen {
  readonly el: HTMLElement;

  constructor(callbacks: HomeCallbacks, options: HomeOptions) {
    const root = el('section', 'screen home-screen');
    root.setAttribute('aria-labelledby', 'home-title');

    const top = el('div', 'home-top');
    const badge = el('span', 'brand-chip', '离线单人 · 原创战场');
    top.appendChild(badge);

    const hero = el('div', 'home-hero');
    const mark = el('div', 'hero-mark');
    mark.appendChild(el('span', 'hero-mark-char', '寸'));
    mark.setAttribute('aria-hidden', 'true');

    const mosaic = el('div', 'hero-mosaic');
    mosaic.setAttribute('aria-hidden', 'true');
    const tiles = [
      ['t1', '38'],
      ['t2', '12'],
      ['t3', '57'],
      ['t4', '24'],
      ['t5', '09'],
      ['t6', '46'],
    ];
    for (let i = 0; i < tiles.length; i += 1) {
      const tile = el('span', 'mosaic-tile ' + tiles[i][0], tiles[i][1]);
      mosaic.appendChild(tile);
    }

    const kicker = el('p', 'hero-kicker', 'STATE CONQUEST');
    const title = el('h1', 'hero-title', '寸土必争');
    title.id = 'home-title';
    const desc = el(
      'p',
      'hero-desc',
      '长按蓄力，拖向己方接壤的领地。守住后方，抢下每一片土地。'
    );

    hero.appendChild(mark);
    hero.appendChild(mosaic);
    hero.appendChild(kicker);
    hero.appendChild(title);
    hero.appendChild(desc);

    const actions = el('div', 'home-actions');

    if (options.profile) {
      const profile = options.profile;
      const growth = normalizeGrowthState(profile);
      const card = el('button', 'home-profile-card');
      card.type = 'button';
      card.setAttribute(
        'aria-label',
          '指挥官档案：' +
          profile.nickname +
          '，金币 ' +
          profile.gold +
          '，指挥官等级 ' +
          growth.commanderLevel +
          '，策反等级 ' +
          profile.betrayalLevel
      );
      card.appendChild(avatarNode(profile.avatarId, 'avatar-md'));
      const info = el('span', 'home-profile-info');
      info.appendChild(el('span', 'home-profile-name', profile.nickname));
      info.appendChild(
        el(
          'span',
          'home-profile-meta',
          '金币 ' + profile.gold +
            ' · 指挥官 Lv.' + growth.commanderLevel +
            ' · 策反 Lv.' + profile.betrayalLevel
        )
      );
      card.appendChild(info);
      card.appendChild(el('span', 'home-profile-hint', '档案'));
      card.addEventListener('click', callbacks.onProfile);
      actions.appendChild(card);
    }

    if (options.records.length > 0) {
      const recent = el('div', 'home-recent');
      recent.appendChild(el('span', 'home-recent-label', '最近战绩'));
      const list = el('div', 'home-recent-list');
      const shown = Math.min(3, options.records.length);
      for (let i = 0; i < shown; i += 1) {
        const record = options.records[i];
        const chip = el(
          'span',
          'recent-chip recent-' + record.result,
          (record.mode === 'versus' ? '双人 · ' : '') +
            // v1.4: a 3/4-faction match says so; old records stay unchanged.
            (record.factionCount && record.factionCount > 2
              ? record.factionCount + '方 · '
              : '') +
            recentResultLabel(record) +
            ' · ' +
            record.mapName +
            ' · ' +
            formatClock(record.elapsedSeconds)
        );
        list.appendChild(chip);
      }
      recent.appendChild(list);
      actions.appendChild(recent);
    }

    const start = button('开始游戏', 'btn btn-primary btn-start', callbacks.onStart);
    start.setAttribute('aria-label', '开始游戏');
    actions.appendChild(start);

    const versus = button(
      '双人对战',
      'btn btn-secondary home-versus-link',
      callbacks.onVersus
    );
    versus.setAttribute('aria-label', '双人对战，同一设备双人各控一色');

    const challenge = button(
      '挑战赛',
      'btn btn-secondary home-challenge-link home-upgrade-link',
      callbacks.onChallenge
    );
    challenge.setAttribute('aria-label', '挑战赛，输入好友的挑战码');

    const versusRow = el('div', 'home-pair');
    versusRow.appendChild(versus);
    versusRow.appendChild(challenge);
    actions.appendChild(versusRow);

    const leaderboard = button(
      '本机战绩',
      'btn btn-secondary home-upgrade-link home-leaderboard-link',
      callbacks.onLeaderboard
    );
    leaderboard.setAttribute(
      'aria-label',
      '本机战绩，本机记录不与其他设备互通'
    );

    const progressRow = el('div', 'home-pair');
    progressRow.appendChild(leaderboard);
    if (options.profile && callbacks.onProgress) {
      const progress = button(
        '成长与签到',
        'btn btn-secondary home-upgrade-link home-progress-link',
        callbacks.onProgress
      );
      progress.setAttribute('aria-label', '成长与签到，领取每日奖励');
      progressRow.appendChild(progress);
    }
    if (options.profile) {
      const upgradeText =
        '策反升级 · Lv.' + options.profile.betrayalLevel + ' → Lv.' + (options.profile.betrayalLevel + 1);
      const upgrade = button(
        options.profile.betrayalLevel >= BETRAYAL_MAX_LEVEL ? '策反升级 · 已满级' : upgradeText,
        'btn btn-secondary home-upgrade-link',
        callbacks.onUpgrade
      );
      upgrade.setAttribute(
        'aria-label',
        '策反升级，当前等级 ' + options.profile.betrayalLevel
      );
      progressRow.appendChild(upgrade);
    }
    // Without an archive the upgrade entry is conditional; let the remaining
    // entry span the full row instead of leaving an empty half.
    if (progressRow.children.length === 1) progressRow.className += ' is-single';
    actions.appendChild(progressRow);

    const settings = button(
      '设置',
      'btn btn-ghost home-settings-link',
      callbacks.onSettings
    );
    settings.setAttribute('aria-label', '设置，本机排行榜开关与重置存档');
    const author = button(
      '关注作者',
      'btn btn-ghost home-author-link',
      callbacks.onAuthor
    );
    author.setAttribute('aria-label', '关注作者，查看本工具作者关注状态');

    const utilityRow = el('div', 'home-pair');
    utilityRow.appendChild(settings);
    utilityRow.appendChild(author);
    actions.appendChild(utilityRow);

    // One rules entry only: a full-height button is easier to hit than the
    // old tiny text link that repeated the same action at the top. Replaying
    // the tutorial lives next to it and is available only with an archive:
    // the lesson writes to that archive's first-run marker.
    const helpRow = el('div', 'home-pair');
    if (options.profile) {
      const tutorial = button(
        '重玩教学',
        'btn btn-ghost home-tutorial-link',
        callbacks.onTutorial
      );
      tutorial.setAttribute('aria-label', '重玩新手教学，随时可以跳过');
      helpRow.appendChild(tutorial);
    }
    const rules = button('玩法说明', 'btn btn-ghost home-rules-link', callbacks.onRules);
    helpRow.appendChild(rules);
    if (helpRow.children.length === 1) helpRow.className += ' is-single';
    const foot = el('p', 'home-foot', '原创矢量战场 · 无需联网 · 竖屏优先');

    actions.appendChild(helpRow);
    actions.appendChild(foot);

    root.appendChild(top);
    root.appendChild(hero);
    root.appendChild(actions);
    this.el = root;
  }
}
