/**
 * Official Xiaohongshu 9.51+ "follow the author" capability (minitool doc §3.15).
 *
 * Contract encoded here:
 * - The author is always the publisher of the current minitool; no ID argument.
 * - `getFollowStatus()` / `followAuthor()` take no business parameters and,
 *   without callbacks, return a Promise of `{ errMsg, follow_status }`.
 * - follow_status: -1 = failed, 0 = not following (or not logged in),
 *   1 = following, 2 = the current user is the tool author.
 * - `getFollowStatus` resolves -1 (and may reject) on failure; -1 is never a
 *   successful state.
 * - `followAuthor` may reject 20002 (user cancelled / abandoned login),
 *   15404 (10 confirmations per account/tool/day) or 10003 (another
 *   confirmation is still active).
 * - Never auto-follow: `follow()` is only ever invoked by an explicit UI click.
 * - Status failures are not cached; every `getStatus()` performs a fresh query.
 */
import {
  FOLLOW_AUTHOR_MIN_CLIENT_VERSION,
  clientVersion,
  getMiniTool,
  isClientVersionAtLeast,
  readBuildVersionFrom,
  readBuildVersionSync,
} from './xhs';
import type { FollowApiResult, FollowStatusValue, MiniToolApi } from './xhs';

export const AUTHOR_MIN_CLIENT_VERSION = FOLLOW_AUTHOR_MIN_CLIENT_VERSION;

export const FOLLOW_STATUS = {
  FAILED: -1,
  NONE: 0,
  FOLLOWED: 1,
  SELF: 2,
} as const;

/** Follow states the UI can render as a confirmed fact. */
export type AuthorFollowState = 'unfollowed' | 'followed' | 'self';

export type AuthorAvailabilityReason =
  | 'ready'
  | 'no-sdk'
  | 'old-client'
  | 'unknown-client'
  | 'no-api';

export interface AuthorAvailability {
  available: boolean;
  reason: AuthorAvailabilityReason;
  buildVersion: number;
  /** Normalised client version, e.g. 9510 for 9.51. */
  clientVersion: number;
  /** The 9510 comparison value required by the official API. */
  requiredClientVersion: number;
}

export type AuthorStatusFailure =
  | 'unavailable'
  | 'api-error'
  | 'business-error'
  | 'invalid-result';

export interface AuthorStatusResult {
  ok: boolean;
  /** `unknown` whenever the platform did not prove a state. */
  status: AuthorFollowState | 'unknown';
  followStatus: FollowStatusValue | null;
  reason: AuthorStatusFailure | null;
  message: string;
  retryable: boolean;
}

export type AuthorFollowFailure =
  | 'unavailable'
  | 'cancelled'
  | 'rate-limited'
  | 'in-progress'
  | 'business-error'
  | 'unconfirmed'
  | 'invalid-result'
  | 'api-error';

export interface AuthorFollowResult {
  ok: boolean;
  /** Set only when `ok`; a failed or unconfirmed call never claims a state. */
  status: AuthorFollowState | null;
  followStatus: FollowStatusValue | null;
  reason: AuthorFollowFailure | null;
  message: string;
  retryable: boolean;
}

export interface AuthorService {
  availability(): Promise<AuthorAvailability>;
  getStatus(): Promise<AuthorStatusResult>;
  follow(): Promise<AuthorFollowResult>;
}

function versionLabel(client: number): string {
  const digits = String(Math.max(0, Math.floor(client)));
  if (digits.length <= 2) return digits;
  return digits.charAt(0) + '.' + digits.slice(1, 3);
}

export function authorAvailabilityMessage(availability: AuthorAvailability): string {
  const required = versionLabel(AUTHOR_MIN_CLIENT_VERSION);
  if (availability.reason === 'no-sdk') {
    return '当前为浏览器预览，关注作者功能不可用。请在小红书 App 内打开本工具。';
  }
  if (availability.reason === 'old-client') {
    return '当前小红书版本过低，关注作者需要 ' + required + ' 及以上版本。';
  }
  if (availability.reason === 'unknown-client') {
    return '无法确认小红书版本，关注作者需要 ' + required + ' 及以上版本。';
  }
  if (availability.reason === 'no-api') {
    return '当前小红书环境未提供关注作者接口，需要 ' + required + ' 及以上版本。';
  }
  return '可以关注作者。';
}

function stateFor(value: FollowStatusValue): AuthorFollowState | null {
  if (value === FOLLOW_STATUS.FOLLOWED) return 'followed';
  if (value === FOLLOW_STATUS.SELF) return 'self';
  if (value === FOLLOW_STATUS.NONE) return 'unfollowed';
  return null;
}

function statusMessage(state: AuthorFollowState): string {
  if (state === 'followed') return '你已关注作者，感谢支持。';
  if (state === 'self') return '这是你自己的作品，无需关注。';
  return '你还没有关注作者。';
}

/**
 * Reads follow_status defensively: the declared type is a union, but a broken
 * or future container must degrade to "unknown" rather than invent a state.
 */
function readFollowStatus(result: unknown): FollowStatusValue | null {
  if (!result || typeof result !== 'object') return null;
  const raw = (result as { follow_status?: unknown }).follow_status;
  const value =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (value === FOLLOW_STATUS.FAILED) return FOLLOW_STATUS.FAILED;
  if (value === FOLLOW_STATUS.NONE) return FOLLOW_STATUS.NONE;
  if (value === FOLLOW_STATUS.FOLLOWED) return FOLLOW_STATUS.FOLLOWED;
  if (value === FOLLOW_STATUS.SELF) return FOLLOW_STATUS.SELF;
  return null;
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const record = error as { errMsg?: unknown; message?: unknown };
  if (typeof record.errMsg === 'string') return record.errMsg;
  if (typeof record.message === 'string') return record.message;
  return '';
}

function readErrorCode(error: unknown): number | null {
  if (typeof error === 'number' && Number.isFinite(error)) return error;
  if (error && typeof error === 'object') {
    const record = error as { errCode?: unknown; code?: unknown };
    const candidates = [record.errCode, record.code];
    for (let i = 0; i < candidates.length; i += 1) {
      const value = Number(candidates[i]);
      if (Number.isFinite(value) && value !== 0) return value;
    }
  }
  const text = errorText(error) || String(error);
  const match = /(?:^|\D)(20002|15404|10003)(?:\D|$)/.exec(text);
  return match ? Number(match[1]) : null;
}

function unavailableStatus(availability: AuthorAvailability): AuthorStatusResult {
  return {
    ok: false,
    status: 'unknown',
    followStatus: null,
    reason: 'unavailable',
    message: authorAvailabilityMessage(availability),
    retryable: false,
  };
}

function unavailableFollow(availability: AuthorAvailability): AuthorFollowResult {
  return {
    ok: false,
    status: null,
    followStatus: null,
    reason: 'unavailable',
    message: authorAvailabilityMessage(availability),
    retryable: false,
  };
}

/** Error codes documented for followAuthor. */
const FOLLOW_CANCELLED = 20002;
const FOLLOW_RATE_LIMITED = 15404;
const FOLLOW_IN_PROGRESS = 10003;

function followFromError(error: unknown): AuthorFollowResult {
  const code = readErrorCode(error);
  const text = errorText(error);
  if (code === FOLLOW_CANCELLED || (code === null && /取消|cancel/i.test(text))) {
    return {
      ok: false,
      status: null,
      followStatus: null,
      reason: 'cancelled',
      message: '已取消关注，未产生关注。',
      retryable: true,
    };
  }
  if (code === FOLLOW_RATE_LIMITED) {
    return {
      ok: false,
      status: null,
      followStatus: null,
      reason: 'rate-limited',
      message: '今天的关注次数已达上限（每天最多 10 次），请明天再试。',
      retryable: false,
    };
  }
  if (code === FOLLOW_IN_PROGRESS) {
    return {
      ok: false,
      status: null,
      followStatus: null,
      reason: 'in-progress',
      message: '关注确认正在进行中，请稍候再试。',
      retryable: true,
    };
  }
  return {
    ok: false,
    status: null,
    followStatus: null,
    reason: 'api-error',
    message: '关注失败，请稍后重试。',
    retryable: true,
  };
}

export function createAuthorService(
  miniTool?: MiniToolApi | null,
  buildVersion?: number
): AuthorService {
  const api = miniTool === undefined ? getMiniTool() : miniTool;
  let cachedBuildVersion =
    typeof buildVersion === 'number' && Number.isFinite(buildVersion) && buildVersion > 0
      ? Math.floor(buildVersion)
      : 0;
  let pendingFollow: Promise<AuthorFollowResult> | null = null;

  /**
   * A resolved version is stable for the session; a failed read (0) is not
   * cached, so a later successful launch-options call can still enable the UI.
   */
  async function resolveBuildVersion(): Promise<number> {
    if (cachedBuildVersion > 0) return cachedBuildVersion;
    const syncValue = readBuildVersionSync();
    if (syncValue > 0) {
      cachedBuildVersion = syncValue;
      return syncValue;
    }
    if (!api || typeof api.getLaunchOptions !== 'function') return 0;
    try {
      const value = readBuildVersionFrom(await api.getLaunchOptions());
      if (value > 0) cachedBuildVersion = value;
      return value;
    } catch {
      return 0;
    }
  }

  async function availability(): Promise<AuthorAvailability> {
    const build = await resolveBuildVersion();
    const version = clientVersion(build);
    const base = {
      buildVersion: build,
      clientVersion: version,
      requiredClientVersion: AUTHOR_MIN_CLIENT_VERSION,
    };
    if (!api) {
      return Object.assign(base, { available: false, reason: 'no-sdk' as const });
    }
    if (build <= 0) {
      return Object.assign(base, {
        available: false,
        reason: 'unknown-client' as const,
      });
    }
    if (!isClientVersionAtLeast(build, AUTHOR_MIN_CLIENT_VERSION)) {
      return Object.assign(base, { available: false, reason: 'old-client' as const });
    }
    if (
      typeof api.getFollowStatus !== 'function' ||
      typeof api.followAuthor !== 'function'
    ) {
      return Object.assign(base, { available: false, reason: 'no-api' as const });
    }
    return Object.assign(base, { available: true, reason: 'ready' as const });
  }

  async function getStatus(): Promise<AuthorStatusResult> {
    const ready = await availability();
    if (!ready.available || !api) return unavailableStatus(ready);

    let raw: FollowApiResult;
    try {
      raw = await api.getFollowStatus!();
    } catch {
      return {
        ok: false,
        status: 'unknown',
        followStatus: null,
        reason: 'api-error',
        message: '关注状态查询失败，请重试。',
        retryable: true,
      };
    }

    const value = readFollowStatus(raw);
    if (value === null) {
      return {
        ok: false,
        status: 'unknown',
        followStatus: null,
        reason: 'invalid-result',
        message: '关注状态无法识别，请稍后重试。',
        retryable: true,
      };
    }
    if (value === FOLLOW_STATUS.FAILED) {
      return {
        ok: false,
        status: 'unknown',
        followStatus: value,
        reason: 'business-error',
        message: '平台未返回有效的关注状态，请重试。',
        retryable: true,
      };
    }
    const state = stateFor(value) as AuthorFollowState;
    return {
      ok: true,
      status: state,
      followStatus: value,
      reason: null,
      message: statusMessage(state),
      retryable: false,
    };
  }

  async function doFollow(): Promise<AuthorFollowResult> {
    const ready = await availability();
    if (!ready.available || !api) return unavailableFollow(ready);

    let raw: FollowApiResult;
    try {
      // Official signature has no business parameters; no callbacks are passed
      // so the container returns a Promise.
      raw = await api.followAuthor!();
    } catch (error) {
      return followFromError(error);
    }

    const value = readFollowStatus(raw);
    if (value === null) {
      return {
        ok: false,
        status: null,
        followStatus: null,
        reason: 'invalid-result',
        message: '无法确认关注结果，请稍后重试。',
        retryable: true,
      };
    }
    if (value === FOLLOW_STATUS.FOLLOWED || value === FOLLOW_STATUS.SELF) {
      const state = stateFor(value) as AuthorFollowState;
      return {
        ok: true,
        status: state,
        followStatus: value,
        reason: null,
        message:
          state === 'self'
            ? '这是你自己的作品，无需关注。'
            : '已关注作者，感谢支持。',
        retryable: false,
      };
    }
    if (value === FOLLOW_STATUS.FAILED) {
      return {
        ok: false,
        status: null,
        followStatus: value,
        reason: 'business-error',
        message: '平台未确认关注结果，请稍后重试。',
        retryable: true,
      };
    }
    // follow_status 0 after an explicit follow attempt: not following (often
    // not logged in). It is not a success and must not be reported as one.
    return {
      ok: false,
      status: null,
      followStatus: value,
      reason: 'unconfirmed',
      message: '关注未生效，请确认已登录小红书后重试。',
      retryable: true,
    };
  }

  return {
    availability,

    getStatus,

    /**
     * Single-flight: concurrent callers share one SDK request, so a rapid
     * double tap cannot start two confirmation flows. The slot is released
     * only after the shared request settles.
     */
    follow(): Promise<AuthorFollowResult> {
      if (pendingFollow) return pendingFollow;
      const run = doFollow().catch(function (): AuthorFollowResult {
        return {
          ok: false,
          status: null,
          followStatus: null,
          reason: 'api-error',
          message: '关注失败，请稍后重试。',
          retryable: true,
        };
      });
      pendingFollow = run;
      const settle = (): void => {
        if (pendingFollow === run) pendingFollow = null;
      };
      run.then(settle, settle);
      return run;
    },
  };
}
