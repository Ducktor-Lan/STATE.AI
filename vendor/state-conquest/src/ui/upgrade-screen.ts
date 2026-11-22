import {
  BETRAYAL_COOLDOWN_TICKS,
  BETRAYAL_INITIAL_DELAY_TICKS,
  BETRAYAL_MAX_LEVEL,
  BETRAYAL_SOLDIERS_PER_LEVEL,
  TICKS_PER_SECOND,
} from '../config/balance';
import { button, clear, el } from './dom';
import { betrayalPriceFor } from './profile-store';
import type { BetrayalLevel, CommanderProfile, PurchaseResult } from './profile-store';

const LEVELS: BetrayalLevel[] = [];
for (let level = 1; level <= BETRAYAL_MAX_LEVEL; level += 1) {
  LEVELS.push(level as BetrayalLevel);
}

export interface UpgradeCallbacks {
  onBack: () => void;
  /** Fresh archive after a purchase, so the page can repaint in place. */
  getProfile: () => CommanderProfile | null;
  onBuy: (targetLevel: BetrayalLevel) => PurchaseResult;
}

function secondsLabel(ticks: number): string {
  return ticks / TICKS_PER_SECOND + ' 秒';
}

/**
 * Betrayal upgrade shop. Levels unlock strictly in order; the next level is
 * the only purchasable row, and the price/effect copy is derived from the
 * balance constants so the numbers can never drift from the engine.
 */
export class UpgradeScreen {
  readonly el: HTMLElement;

  private readonly callbacks: UpgradeCallbacks;
  private profile: CommanderProfile;
  private readonly goldValue: HTMLElement;
  private readonly levelChip: HTMLElement;
  private readonly rowsHost: HTMLElement;
  private readonly status: HTMLElement;

  constructor(profile: CommanderProfile, callbacks: UpgradeCallbacks) {
    this.profile = profile;
    this.callbacks = callbacks;

    const root = el('section', 'screen upgrade-screen');
    root.setAttribute('aria-labelledby', 'upgrade-title');

    const header = el('header', 'setup-header');
    const back = button('返回', 'back-btn', callbacks.onBack);
    back.setAttribute('aria-label', '返回首页');
    const titles = el('div', 'setup-titles');
    const title = el('h1', 'setup-title', '策反升级');
    title.id = 'upgrade-title';
    titles.appendChild(title);
    titles.appendChild(el('p', 'setup-subtitle', '金币解锁 · 按等级逐级购买'));
    header.appendChild(back);
    header.appendChild(titles);

    const body = el('div', 'setup-body');

    const balance = el('div', 'upgrade-balance');
    const balanceText = el('div', 'upgrade-balance-text');
    balanceText.appendChild(el('span', 'upgrade-balance-label', '金币余额'));
    this.goldValue = el('b', 'upgrade-gold');
    balanceText.appendChild(this.goldValue);
    this.levelChip = el('span', 'upgrade-level-chip');
    balance.appendChild(balanceText);
    balance.appendChild(this.levelChip);
    body.appendChild(balance);

    body.appendChild(
      el(
        'p',
        'upgrade-intro',
        '策反：让敌军士兵倒戈，进攻同阵营领地。等级越高，单次策反人数越多。'
      )
    );

    this.rowsHost = el('div', 'upgrade-levels');
    body.appendChild(this.rowsHost);

    this.status = el('p', 'upgrade-status');
    this.status.setAttribute('role', 'status');
    body.appendChild(this.status);

    body.appendChild(
      el(
        'p',
        'upgrade-foot-note',
        '对局开始 ' +
          secondsLabel(BETRAYAL_INITIAL_DELAY_TICKS) +
          '后可用 · 冷却 ' +
          secondsLabel(BETRAYAL_COOLDOWN_TICKS) +
          ' · 每级 +' +
          BETRAYAL_SOLDIERS_PER_LEVEL +
          ' 策反人数'
      )
    );

    root.appendChild(header);
    root.appendChild(body);
    this.el = root;

    this.render();
    if (profile.betrayalLevel >= BETRAYAL_MAX_LEVEL) {
      this.showStatus('策反技能已满级', 'good');
    }
  }

  private quotaFor(level: BetrayalLevel): number {
    return level * BETRAYAL_SOLDIERS_PER_LEVEL;
  }

  private render(): void {
    const profile = this.profile;
    this.goldValue.textContent = String(profile.gold);
    this.levelChip.textContent = '策反 Lv.' + profile.betrayalLevel;
    this.levelChip.setAttribute(
      'data-level',
      String(profile.betrayalLevel)
    );

    clear(this.rowsHost);
    for (let i = 0; i < LEVELS.length; i += 1) {
      const level = LEVELS[i];
      const owned = level <= profile.betrayalLevel;
      const isNext = level === profile.betrayalLevel + 1;
      const locked = !owned && !isNext;
      const price = betrayalPriceFor(level) || 0;

      const row = el(
        'div',
        'upgrade-level' +
          (owned ? ' is-owned' : '') +
          (isNext ? ' is-next' : '') +
          (locked ? ' is-locked' : '')
      );

      row.appendChild(el('span', 'upgrade-level-badge', 'Lv.' + level));

      const info = el('div', 'upgrade-level-info');
      info.appendChild(el('p', 'upgrade-level-title', '策反 ' + this.quotaFor(level) + ' 名士兵'));
      info.appendChild(
        el(
          'p',
          'upgrade-level-note',
          owned
            ? '已解锁 · 冷却 ' + secondsLabel(BETRAYAL_COOLDOWN_TICKS)
            : '单次最多策反 ' +
                this.quotaFor(level) +
                ' 名敌军 · 售价 ' +
                price +
                ' 金币'
        )
      );
      row.appendChild(info);

      const action = el('div', 'upgrade-level-action');
      if (owned) {
        action.appendChild(el('span', 'upgrade-state upgrade-state-owned', '已解锁'));
      } else if (isNext) {
        const priceBtn = button('解锁 · ' + price + ' 金币', 'upgrade-buy', () => {
          this.buy(level);
        });
        priceBtn.setAttribute('data-level', String(level));
        priceBtn.setAttribute('aria-label', '解锁策反 Lv.' + level + '，花费 ' + price + ' 金币');
        if (profile.gold < price) {
          priceBtn.disabled = true;
          action.appendChild(priceBtn);
          action.appendChild(
            el(
              'span',
              'upgrade-reason',
              '金币不足，还差 ' + (price - profile.gold)
            )
          );
        } else {
          action.appendChild(priceBtn);
        }
      } else {
        action.appendChild(
          el('span', 'upgrade-state', '需先解锁 Lv.' + (level - 1))
        );
      }
      row.appendChild(action);

      this.rowsHost.appendChild(row);
    }

    this.levelChip.setAttribute(
      'data-maxed',
      profile.betrayalLevel >= BETRAYAL_MAX_LEVEL ? 'true' : 'false'
    );
  }

  private buy(level: BetrayalLevel): void {
    const result = this.callbacks.onBuy(level);
    if (!result.ok) {
      this.showStatus(result.message || '购买失败，请稍后再试', 'bad');
      return;
    }
    const updated = this.callbacks.getProfile();
    if (updated) this.profile = updated;
    this.render();
    this.showStatus(result.message || '已解锁', 'good');
  }

  private showStatus(message: string, tone: 'good' | 'bad'): void {
    this.status.textContent = message;
    this.status.className = 'upgrade-status is-' + tone;
  }
}
