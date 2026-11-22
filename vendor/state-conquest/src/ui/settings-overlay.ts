/**
 * Home settings sheet. Only two things live here: the local leaderboard
 * preference (persisted, no network) and the destructive archive reset entry.
 * The reset itself is confirmed through the shared confirm overlay and executed
 * by the shell, which owns the storage wipe and resident-state cleanup.
 */
import { createConfirmOverlay } from './confirm';
import { button, el } from './dom';
import { createOverlay } from './overlay';

/** The complete cleanup scope, shown verbatim in the second confirmation. */
export const RESET_SCOPE_ITEMS: readonly string[] = [
  '昵称与头像',
  '金币、策反等级与胜负/难度统计',
  '最近战绩',
  '本机排行榜记录',
  '偏好设置（时长、难度、排行榜开关）',
  '新手教程状态',
  '上次挑战码',
  '损坏档案备份',
];

export function resetScopeText(): string {
  return (
    '将清除：' +
    RESET_SCOPE_ITEMS.join('、') +
    '。操作不可撤销，完成后需要重新建立指挥官档案。其他应用的数据不会受影响。'
  );
}

export interface ResetConfirmCallbacks {
  onConfirm: () => void;
  onCancel: () => void;
}

/** Shared confirm overlay for the second reset confirmation. */
export function createResetConfirmOverlay(callbacks: ResetConfirmCallbacks): HTMLElement {
  return createConfirmOverlay({
    title: '重置本机存档？',
    body: resetScopeText(),
    confirmLabel: '确认清除',
    cancelLabel: '取消',
    danger: true,
    onConfirm: callbacks.onConfirm,
    onCancel: callbacks.onCancel,
  });
}

export interface SettingsOverlayOptions {
  leaderboardOptIn: boolean;
  onLeaderboardChange: (value: boolean) => void;
  onResetRequest: () => void;
  onClose: () => void;
  /**
   * v1.2 optional sound switch. Omitted by old callers, which keeps the sheet
   * identical; the shell passes the live value plus an honest status line.
   */
  soundEnabled?: boolean;
  /** Current capability copy (e.g. "音效不可用…"), shown under the switch. */
  soundStatus?: string;
  onSoundChange?: (enabled: boolean) => void;
}

export interface SettingsOverlayHandle {
  el: HTMLElement;
  setLeaderboardOptIn(value: boolean): void;
  /** Reflects the persisted sound switch (and keeps the row honest). */
  setSoundEnabled?(value: boolean): void;
  /** Replaces the sound status line; empty text hides it. */
  setSoundStatus?(text: string): void;
  /** Empty text hides the status line; tone drives the error colour. */
  setStatus(text: string, tone: 'info' | 'error'): void;
}

const LOCAL_LEADERBOARD_NOTE =
  '仅记录在本机，不联网、不上传，也不读取平台账号信息。关闭后停止记录并隐藏榜单，已有记录保留。';

/**
 * The status line only exists while it has real capability copy. Exported so a
 * test can pin "first open shows it" without a DOM.
 */
export function soundStatusClassName(text: string): string {
  return 'settings-status settings-sound-status' + (text ? ' is-visible' : '');
}

export function createSettingsOverlay(options: SettingsOverlayOptions): SettingsOverlayHandle {
  const parts = createOverlay('settings-overlay');
  parts.card.className = 'overlay-card settings-card';
  parts.card.setAttribute('role', 'dialog');
  parts.card.setAttribute('aria-modal', 'true');
  parts.card.setAttribute('aria-labelledby', 'settings-title');

  const header = el('header', 'settings-header');
  header.appendChild(el('p', 'overlay-kicker', 'SETTINGS'));
  const title = el('h2', 'overlay-title settings-title', '设置');
  title.id = 'settings-title';
  header.appendChild(title);
  header.appendChild(el('p', 'settings-subtitle', '本机偏好与存档管理'));

  const body = el('div', 'settings-body');

  const leaderboardRow = el('div', 'settings-row switch-row');
  const leaderboardText = el('div', 'settings-row-text');
  leaderboardText.appendChild(el('span', 'switch-label', '记录本机排行榜'));
  leaderboardText.appendChild(el('p', 'settings-note', LOCAL_LEADERBOARD_NOTE));
  const toggle = el('button', 'switch');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  leaderboardRow.appendChild(leaderboardText);
  leaderboardRow.appendChild(toggle);
  body.appendChild(leaderboardRow);

  // v1.2 sound switch. Only built when the shell wires it, so an old caller
  // keeps the exact same sheet. The status line is capability copy from the
  // audio service, never a claim that the container is supported.
  let soundToggle: HTMLButtonElement | null = null;
  let soundStatusNode: HTMLElement | null = null;
  let soundCurrent = options.soundEnabled !== false;
  if (typeof options.onSoundChange === 'function') {
    const soundRow = el('div', 'settings-row switch-row');
    const soundText = el('div', 'settings-row-text');
    soundText.appendChild(el('span', 'switch-label', '音效'));
    soundText.appendChild(
      el(
        'p',
        'settings-note',
        '离线合成音效，不下载任何音频文件。切后台或暂停时会静音，恢复后需要重新触屏激活。'
      )
    );
    soundToggle = el('button', 'switch');
    soundToggle.type = 'button';
    soundToggle.setAttribute('role', 'switch');
    soundRow.appendChild(soundText);
    soundRow.appendChild(soundToggle);
    body.appendChild(soundRow);

    // Initial state must be visible at first open: the CSS hides an empty
    // status line, so the capability text ("待激活/不可用/已开启") needs the
    // is-visible class from the start, not only after a toggle.
    soundStatusNode = el('p', 'settings-status settings-sound-status');
    soundStatusNode.setAttribute('role', 'status');
    body.appendChild(soundStatusNode);
    applySoundStatus(options.soundStatus || '');

    soundToggle.addEventListener('click', function () {
      soundCurrent = !soundCurrent;
      paintSound(soundCurrent);
      if (options.onSoundChange) options.onSoundChange(soundCurrent);
    });
  }

  const status = el('p', 'settings-status');
  status.setAttribute('role', 'status');
  body.appendChild(status);

  const danger = el('section', 'settings-danger');
  danger.appendChild(el('h3', 'settings-danger-title', '危险操作'));
  danger.appendChild(
    el(
      'p',
      'settings-danger-copy',
      '清除本机全部存档与设置，回到首次建档。清除前会再次确认并列出范围，取消不会改动任何数据。'
    )
  );
  const reset = button('重置存档', 'btn btn-danger btn-wide settings-reset-button', function () {
    options.onResetRequest();
  });
  reset.setAttribute('aria-label', '重置本机存档，清除全部本机数据');
  danger.appendChild(reset);
  body.appendChild(danger);

  const close = button('关闭', 'btn btn-secondary btn-wide settings-close', function () {
    options.onClose();
  });
  body.appendChild(close);

  parts.card.appendChild(header);
  parts.card.appendChild(body);

  let current = options.leaderboardOptIn !== true;

  function paintLeaderboard(value: boolean): void {
    current = value === true;
    if (current) toggle.classList.add('is-on');
    else toggle.classList.remove('is-on');
    toggle.setAttribute('aria-checked', current ? 'true' : 'false');
    toggle.setAttribute('aria-label', '记录本机排行榜，' + (current ? '已开启' : '已关闭'));
  }

  function setStatus(text: string, tone: 'info' | 'error'): void {
    status.textContent = text;
    status.className = 'settings-status' + (text ? ' is-visible' : '') + (tone === 'error' ? ' is-error' : '');
  }

  function paintSound(value: boolean): void {
    soundCurrent = value === true;
    if (!soundToggle) return;
    if (soundCurrent) soundToggle.classList.add('is-on');
    else soundToggle.classList.remove('is-on');
    soundToggle.setAttribute('aria-checked', soundCurrent ? 'true' : 'false');
    soundToggle.setAttribute('aria-label', '音效，' + (soundCurrent ? '已开启' : '已关闭'));
  }

  function applySoundStatus(text: string): void {
    if (!soundStatusNode) return;
    soundStatusNode.textContent = text;
    soundStatusNode.className = soundStatusClassName(text);
  }

  function setSoundStatus(text: string): void {
    applySoundStatus(text);
  }

  toggle.addEventListener('click', function () {
    const next = !current;
    paintLeaderboard(next);
    options.onLeaderboardChange(next);
  });

  paintLeaderboard(options.leaderboardOptIn);
  paintSound(soundCurrent);

  return {
    el: parts.root,
    setLeaderboardOptIn: paintLeaderboard,
    setSoundEnabled: paintSound,
    setSoundStatus: setSoundStatus,
    setStatus: setStatus,
  };
}
