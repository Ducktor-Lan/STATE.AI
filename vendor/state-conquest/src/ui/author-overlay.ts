/**
 * "Follow the author" overlay (Xiaohongshu 9.51+).
 *
 * - Reuses the shared overlay/confirm styles; adds no CSS.
 * - Opening the overlay only queries `getFollowStatus`. `followAuthor` is
 *   called exclusively from the explicit "关注作者" click; the platform's own
 *   confirmation is the only confirmation step (no in-app second dialog).
 * - Every SDK call is guarded twice: the overlay refuses a second click while
 *   one is pending, and the platform service is single-flight.
 * - Unavailable environments (plain browser, old client, missing API) are
 *   explained and closeable; no success state is ever synthesised.
 * - Status failures are not cached: "重试查询" performs a fresh query.
 */
import { button, clear, el, setText } from './dom';
import { createOverlay } from './overlay';
import { authorAvailabilityMessage } from '../platform/author';
import type {
  AuthorAvailability,
  AuthorFollowResult,
  AuthorFollowState,
  AuthorService,
} from '../platform/author';

export interface AuthorOverlayOptions {
  author: AuthorService;
  onClose: () => void;
}

export interface AuthorOverlayParts {
  el: HTMLElement;
  destroy(): void;
  /** Re-queries the platform status; concurrent calls share one request. */
  refresh: () => Promise<void>;
}

type OverlayState =
  | { kind: 'loading' }
  | { kind: 'unavailable'; availability: AuthorAvailability }
  | { kind: 'status-error'; message: string; retryable: boolean }
  | { kind: 'ready'; status: AuthorFollowState }
  | { kind: 'following' }
  | { kind: 'result'; result: AuthorFollowResult };

const HINT_LOADING = '正在向小红书查询关注状态…';
const HINT_UNAVAILABLE = '该功能仅在小红书 App 9.51 及以上版本内可用。';
const HINT_UNFOLLOWED =
  '关注仅用于支持作者，不会修改游戏数据。点击后由小红书处理；若出现系统确认弹窗，请按提示完成。每个账号每天最多 10 次。';
const HINT_FOLLOWED = '你已关注作者，感谢支持。';
const HINT_SELF = '这是你自己的作品，无需关注。';
const HINT_STATUS_ERROR = '查询失败不会缓存，可随时重试。';
const HINT_FOLLOWING = '请在小红书弹窗中完成关注；处理期间不会重复发起请求。';
const HINT_CANCELLED = '已取消关注，本次未产生关注，可重新发起。';
const HINT_RATE_LIMITED = '频控按自然日重置，今天无法再次关注。';
const HINT_FOLLOW_FAILED = '本次未产生关注，可重试。';
const HINT_DONE = '关注状态已由平台确认，可关闭本窗口。';

function stateLabel(status: AuthorFollowState): string {
  if (status === 'followed') return '已关注作者';
  if (status === 'self') return '作者本人';
  return '未关注作者';
}

function disabledPrimary(label: string, extraClass: string): HTMLButtonElement {
  const node = button(label, 'btn btn-primary confirm-ok ' + extraClass, function () {
    // Disabled controls are inert; the handler exists only to keep the button
    // element consistent with the other primary actions.
  });
  node.disabled = true;
  node.setAttribute('aria-disabled', 'true');
  return node;
}

export function createAuthorOverlay(options: AuthorOverlayOptions): AuthorOverlayParts {
  const parts = createOverlay('author-overlay');
  parts.card.className = 'overlay-card overlay-card-compact';
  parts.card.setAttribute('role', 'dialog');
  parts.card.setAttribute('aria-modal', 'true');
  parts.card.setAttribute('aria-labelledby', 'author-follow-title');

  const title = el('h2', 'overlay-title confirm-title', '关注作者');
  title.id = 'author-follow-title';
  const statusLine = el('p', 'confirm-body author-status');
  statusLine.id = 'author-follow-status';
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');
  const hint = el('p', 'confirm-body author-hint');
  const actions = el('div', 'confirm-actions author-actions');

  parts.card.appendChild(el('p', 'overlay-kicker', 'AUTHOR · 9.51+'));
  parts.card.appendChild(title);
  parts.card.appendChild(statusLine);
  parts.card.appendChild(hint);
  parts.card.appendChild(actions);

  let state: OverlayState = { kind: 'loading' };
  let destroyed = false;
  let queryPending: Promise<void> | null = null;
  let followPending: Promise<void> | null = null;

  function close(): void {
    if (destroyed) return;
    destroyed = true;
    options.onClose();
  }

  function closeButton(className: string): HTMLButtonElement {
    const node = button('关闭', className, close);
    node.setAttribute('aria-label', '关闭关注作者窗口');
    return node;
  }

  function appendClosePrimary(): void {
    actions.appendChild(
      closeButton('btn btn-primary btn-wide author-close')
    );
  }

  function renderActions(): void {
    switch (state.kind) {
      case 'loading': {
        actions.appendChild(closeButton('btn btn-secondary author-close'));
        actions.appendChild(disabledPrimary('查询中…', 'author-follow'));
        return;
      }
      case 'unavailable': {
        appendClosePrimary();
        return;
      }
      case 'status-error': {
        if (!state.retryable) {
          appendClosePrimary();
          return;
        }
        actions.appendChild(closeButton('btn btn-secondary author-close'));
        const retry = button('重试查询', 'btn btn-primary confirm-ok author-retry', function () {
          void refresh();
        });
        actions.appendChild(retry);
        return;
      }
      case 'ready': {
        actions.appendChild(closeButton('btn btn-secondary author-close'));
        if (state.status === 'unfollowed') {
          const follow = button(
            '关注作者',
            'btn btn-primary confirm-ok author-follow',
            startFollow
          );
          follow.setAttribute('data-autofocus', '');
          actions.appendChild(follow);
        } else if (state.status === 'followed') {
          actions.appendChild(disabledPrimary('已关注', 'author-follow'));
        } else {
          actions.appendChild(disabledPrimary('作者本人', 'author-follow'));
        }
        return;
      }
      case 'following': {
        actions.appendChild(closeButton('btn btn-secondary author-close'));
        actions.appendChild(disabledPrimary('关注中…', 'author-follow'));
        return;
      }
      case 'result': {
        const result = state.result;
        if (result.ok) {
          appendClosePrimary();
          return;
        }
        if (!result.retryable) {
          appendClosePrimary();
          return;
        }
        actions.appendChild(closeButton('btn btn-secondary author-close'));
        const label = result.reason === 'cancelled' ? '重新关注' : '重试';
        const retry = button(label, 'btn btn-primary confirm-ok author-retry', startFollow);
        retry.setAttribute('data-autofocus', '');
        actions.appendChild(retry);
        return;
      }
    }
  }

  function render(): void {
    if (destroyed) return;
    clear(actions);
    switch (state.kind) {
      case 'loading': {
        setText(statusLine, '正在查询关注状态…');
        setText(hint, HINT_LOADING);
        break;
      }
      case 'unavailable': {
        setText(statusLine, authorAvailabilityMessage(state.availability));
        setText(hint, HINT_UNAVAILABLE);
        break;
      }
      case 'status-error': {
        setText(statusLine, state.message);
        setText(hint, HINT_STATUS_ERROR);
        break;
      }
      case 'ready': {
        setText(statusLine, stateLabel(state.status));
        setText(
          hint,
          state.status === 'followed'
            ? HINT_FOLLOWED
            : state.status === 'self'
              ? HINT_SELF
              : HINT_UNFOLLOWED
        );
        break;
      }
      case 'following': {
        setText(statusLine, '正在等待小红书确认…');
        setText(hint, HINT_FOLLOWING);
        break;
      }
      case 'result': {
        const result = state.result;
        setText(statusLine, result.message);
        setText(
          hint,
          result.ok
            ? HINT_DONE
            : result.reason === 'cancelled'
              ? HINT_CANCELLED
              : result.reason === 'rate-limited'
                ? HINT_RATE_LIMITED
                : HINT_FOLLOW_FAILED
        );
        break;
      }
    }
    renderActions();
  }

  /**
   * Fresh status query. Failures are rendered as retryable and never cached;
   * the next call always asks the platform again.
   */
  function refresh(): Promise<void> {
    if (queryPending) return queryPending;
    state = { kind: 'loading' };
    render();
    const run = (async function (): Promise<void> {
      const availability = await options.author.availability();
      if (destroyed) return;
      if (!availability.available) {
        state = { kind: 'unavailable', availability };
        render();
        return;
      }
      const result = await options.author.getStatus();
      if (destroyed) return;
      if (result.ok) {
        state = { kind: 'ready', status: result.status as AuthorFollowState };
      } else {
        state = {
          kind: 'status-error',
          message: result.message,
          retryable: result.retryable,
        };
      }
      render();
    })();
    queryPending = run;
    const settle = (): void => {
      if (queryPending === run) queryPending = null;
    };
    run.then(settle, settle);
    return run;
  }

  /**
   * Explicit follow handler. It is wired only to the "关注作者" / retry button;
   * the platform's own confirmation is the sole confirmation step. The state
   * flips to `following` before the await, so a second click on the same node
   * cannot start another flow.
   */
  function startFollow(): void {
    if (destroyed || followPending) return;
    if (state.kind === 'ready') {
      if (state.status !== 'unfollowed') return;
    } else if (state.kind === 'result') {
      if (state.result.ok || !state.result.retryable) return;
    } else {
      return;
    }
    state = { kind: 'following' };
    render();
    const run = (async function (): Promise<void> {
      let result: AuthorFollowResult;
      try {
        result = await options.author.follow();
      } catch {
        result = {
          ok: false,
          status: null,
          followStatus: null,
          reason: 'api-error',
          message: '关注失败，请稍后重试。',
          retryable: true,
        };
      }
      if (destroyed) return;
      state = { kind: 'result', result };
      render();
    })();
    followPending = run;
    const settle = (): void => {
      if (followPending === run) followPending = null;
    };
    run.then(settle, settle);
  }

  render();
  // Opening the overlay queries status only; followAuthor stays untouched until
  // the player presses "关注作者".
  void refresh();

  return {
    el: parts.root,
    destroy(): void {
      destroyed = true;
    },
    refresh,
  };
}
