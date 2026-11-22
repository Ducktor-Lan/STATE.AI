import { button, el, setText } from './dom';
import type { CommanderProfile, CheckInResult } from './profile-store';
import {
  experienceToNextLevel,
  localDateKey,
  normalizeGrowthState,
} from './progression';

export interface ProgressCallbacks {
  onBack: () => void;
  getProfile: () => CommanderProfile | null;
  onCheckIn: () => CheckInResult;
  getSaveStatus?: () => boolean | 'pending';
}

/** Local commander progression, daily rewards and long-term match stats. */
export class ProgressScreen {
  readonly el: HTMLElement;

  private readonly callbacks: ProgressCallbacks;
  private profile: CommanderProfile;
  private readonly levelValue: HTMLElement;
  private readonly xpValue: HTMLElement;
  private readonly xpFill: HTMLElement;
  private readonly streakValue: HTMLElement;
  private readonly totalValue: HTMLElement;
  private readonly statsValue: HTMLElement;
  private readonly checkInButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  /** Keeps the reward receipt while sync() refreshes persistence state. */
  private checkInFeedback: { ok: boolean; message: string } | null = null;

  constructor(profile: CommanderProfile, callbacks: ProgressCallbacks) {
    this.profile = profile;
    this.callbacks = callbacks;

    const root = el('section', 'screen progress-screen');
    root.setAttribute('aria-labelledby', 'progress-title');
    const header = el('header', 'setup-header');
    const back = button('返回', 'back-btn', callbacks.onBack);
    back.setAttribute('aria-label', '返回首页');
    header.appendChild(back);
    const titles = el('div', 'setup-titles');
    const title = el('h1', 'setup-title', '成长与签到');
    title.id = 'progress-title';
    titles.appendChild(title);
    titles.appendChild(el('p', 'setup-subtitle', '每次出征都让指挥官更进一步'));
    header.appendChild(titles);

    const body = el('div', 'setup-body progress-body');
    const levelCard = el('section', 'progress-level-card');
    levelCard.appendChild(el('span', 'progress-kicker', 'COMMANDER PROGRESS'));
    this.levelValue = el('b', 'progress-level-value');
    levelCard.appendChild(this.levelValue);
    this.xpValue = el('p', 'progress-xp-value');
    levelCard.appendChild(this.xpValue);
    const track = el('div', 'progress-xp-track');
    this.xpFill = el('div', 'progress-xp-fill');
    track.appendChild(this.xpFill);
    levelCard.appendChild(track);
    body.appendChild(levelCard);

    const checkIn = el('section', 'progress-checkin-card');
    checkIn.appendChild(el('h2', 'progress-section-title', '每日签到'));
    this.streakValue = el('p', 'progress-streak');
    this.totalValue = el('p', 'progress-total');
    checkIn.appendChild(this.streakValue);
    checkIn.appendChild(this.totalValue);
    this.checkInButton = button('领取今日奖励', 'btn btn-primary btn-wide', () => {
      this.checkIn();
    });
    checkIn.appendChild(this.checkInButton);
    body.appendChild(checkIn);

    const stats = el('section', 'progress-stats-card');
    stats.appendChild(el('h2', 'progress-section-title', '出征统计'));
    this.statsValue = el('p', 'progress-stats-copy');
    stats.appendChild(this.statsValue);
    body.appendChild(stats);

    this.status = el('p', 'progress-status');
    this.status.setAttribute('role', 'status');
    body.appendChild(this.status);

    const footer = el('footer', 'setup-footer setup-footer-compact');
    footer.appendChild(
      el('p', 'progress-foot-note', '签到和成长数据只保存在本机，不读取平台账号。')
    );

    root.appendChild(header);
    root.appendChild(body);
    root.appendChild(footer);
    this.el = root;
    this.render();
  }

  /** Refreshes resident profile and the real persistence status after a write. */
  sync(): void {
    const updated = this.callbacks.getProfile();
    if (updated) this.profile = updated;
    this.render();
  }

  private render(): void {
    const profile = this.profile;
    const growth = normalizeGrowthState(profile);
    const xp = experienceToNextLevel(growth.experience);
    setText(this.levelValue, '指挥官 Lv.' + xp.level);
    setText(
      this.xpValue,
      xp.next === null
        ? '经验 ' + growth.experience + ' · 已达到最高等级'
        : '经验 ' + growth.experience + ' / ' + xp.next + ' · 还需 ' + xp.remaining
    );
    this.xpFill.style.width = Math.round(xp.progress * 100) + '%';
    setText(
      this.streakValue,
      growth.checkIn.streak > 0 ? '连续签到 ' + growth.checkIn.streak + ' 天' : '还没有连续签到'
    );
    setText(this.totalValue, '累计签到 ' + growth.checkIn.total + ' 次');
    const claimed = growth.checkIn.lastDate === localDateKey();
    this.checkInButton.disabled = claimed;
    this.checkInButton.textContent = claimed ? '今日已签到' : '领取今日奖励';
    this.checkInButton.setAttribute('aria-disabled', claimed ? 'true' : 'false');
    setText(
      this.statsValue,
      '胜 ' + profile.stats.wins + ' · 负 ' + profile.stats.losses + ' · 平 ' + profile.stats.draws
    );
    const saveStatus = this.callbacks.getSaveStatus
      ? this.callbacks.getSaveStatus()
      : undefined;
    let statusMessage: string;
    if (saveStatus === false) {
      this.status.className = 'progress-status is-bad';
      statusMessage = '当前环境无法保存成长数据，仅本次会话内有效。';
    } else if (saveStatus === 'pending') {
      this.status.className = 'progress-status is-info';
      statusMessage = '成长数据正在保存…';
    } else if (saveStatus === true) {
      this.status.className = this.checkInFeedback && !this.checkInFeedback.ok
        ? 'progress-status is-info'
        : 'progress-status is-good';
      statusMessage = '成长数据已保存到本机。';
    } else {
      this.status.className = 'progress-status is-info';
      statusMessage = '成长数据仅在本机记录。';
    }
    this.status.textContent = this.checkInFeedback
      ? this.checkInFeedback.message + ' · ' + statusMessage
      : statusMessage;
  }

  private checkIn(): void {
    const result = this.callbacks.onCheckIn();
    this.checkInFeedback = {
      ok: result.ok,
      message: result.message || (result.ok ? '签到成功' : '签到未完成，请稍后再试'),
    };
    // render() owns the persistence wording. A queued write remains “保存中”
    // until sync() observes its final result, so a success receipt never masks
    // a failed or still-pending archive write.
    this.sync();
  }
}
