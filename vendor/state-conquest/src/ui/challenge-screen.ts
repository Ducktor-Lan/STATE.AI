/**
 * Challenge entry screen: type a code, inspect the locked match parameters,
 * then start the exact same battlefield. No network calls are ever made; the
 * code travels by copy/paste between players.
 */
import {
  CHALLENGE_CASUAL_NOTICE,
  CHALLENGE_LEGACY_DIFFICULTIES,
  CHALLENGE_RULES_VERSIONS,
  CHALLENGE_RULES_VERSION,
  CHALLENGE_V2_DIFFICULTIES,
  decodeChallengeAny,
} from '../core/challenge';
import type { ChallengeDifficulty, ChallengePayload } from '../core/challenge';
import { MAP_CATALOG, resolveMapVariant } from '../game-api';
import { button, clear, el } from './dom';
import { DIFFICULTY_LABEL, RESULT_LABEL, durationLabel } from './format';
import { factionOptionSub } from './factions';
import type { FactionCount } from './factions';

/**
 * Challenge code families. v1.1 codes are `SC-XXXXXX-XXXXXX`, v1.2 codes are
 * `SV-XXXXXX-XXXXXX-XX`; v1.4 adds the `SM-…` multi-party family whose payload
 * states its own 3|4 faction count (a 2-party match keeps using SC/SV).
 */
export type ChallengeCodeFamily = 'v2' | 'legacy' | 'v3';
/** A v2/v3 code carries the ruleset it was played under. */
export type ChallengeFairness = 'fair' | 'practice';

/**
 * Loose, structurally compatible view of one decoder result. The v1.2 score
 * decoder (`decodeChallengeAny`) returns `{ family, payload, comparable,
 * notice }` on success and `{ reason, message }` on failure; the v1.1 codec
 * returns `{ code, payload }`. This shape accepts both, and the screen
 * re-validates every field at runtime before it is handed to the shell.
 */
export interface ChallengeDecodePayloadLike {
  seed: number;
  durationSeconds: number;
  difficulty: string;
  score: number;
  result?: string | null;
  /** v1.2 only: 0.75 / 1 / 1.25. */
  speed?: number;
  /** v1.2 only: ruleset version recorded at play time. */
  rulesVersion?: number;
  /** v1.2 only. */
  fairness?: ChallengeFairness | string;
  /** v1.4 only (SM family): total seated factions stated by the code. */
  factionCount?: number;
}

export interface ChallengeDecodeAnyLike {
  ok: boolean;
  code?: string;
  family?: string;
  payload?: ChallengeDecodePayloadLike;
  comparable?: boolean;
  notice?: string | null;
  reason?: string;
  message?: string;
}

/** Injected code reader; omit it to use `decodeChallengeAny` directly. */
export type ChallengeDecoder = (raw: string) => ChallengeDecodeAnyLike;

export interface ChallengeUiDecodeOk {
  ok: true;
  /** Canonical code as reported by the decoder (or the trimmed input). */
  code: string;
  family: ChallengeCodeFamily;
  /** Core-compatible payload, re-validated at runtime. */
  payload: ChallengePayload;
  /** Null for legacy codes, which never recorded a speed. */
  speed: number | null;
  rulesVersion: number | null;
  fairness: ChallengeFairness;
  /**
   * Total seated factions this code runs with: strictly 3|4 for a validated
   * v3 (SM) code, and the historical 2 for legacy/v2 codes.
   */
  factionCount: FactionCount;
  /** False means the match is practice only: no verdict against the author. */
  comparable: boolean;
  notice: string | null;
}

export interface ChallengeUiDecodeFailure {
  ok: false;
  reason: string;
  message: string;
}

export type ChallengeUiDecoded = ChallengeUiDecodeOk | ChallengeUiDecodeFailure;

/** Optional extra context handed to the shell when a code is accepted. */
export interface ChallengeStartContext {
  family: ChallengeCodeFamily;
  comparable: boolean;
  speed: number | null;
  rulesVersion: number | null;
  fairness: ChallengeFairness;
  /**
   * Total factions the accepted code runs with. Optional so v1.2-era injected
   * contexts keep compiling; the shell treats a missing value as the legacy 2
   * and never promotes a v3 code whose context lost its count to comparable.
   */
  factionCount?: FactionCount;
  notice: string | null;
}

const UI_DURATIONS: number[] = [180, 300, 480];
const UI_RESULTS: string[] = ['win', 'lose', 'draw'];

function decodeFailure(reason: string, message: string): ChallengeUiDecodeFailure {
  return { ok: false, reason: reason, message: message };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

const UI_SPEEDS: number[] = [0.75, 1, 1.25];

function validSpeed(value: unknown): number | null {
  if (!isFiniteNumber(value)) return null;
  for (let i = 0; i < UI_SPEEDS.length; i += 1) {
    if (Math.abs(UI_SPEEDS[i] - value) < 0.001) return UI_SPEEDS[i];
  }
  return null;
}

function validRulesVersion(value: unknown): number | null {
  return isFiniteNumber(value) &&
    Number.isInteger(value) &&
    CHALLENGE_RULES_VERSIONS.indexOf(value) >= 0
    ? value
    : null;
}

function strictPayload(
  raw: ChallengeDecodePayloadLike,
  family: ChallengeCodeFamily
): ChallengePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const seed = raw.seed;
  if (!isFiniteNumber(seed) || !Number.isInteger(seed) || seed < 1 || seed > 0xffffffff) {
    return null;
  }
  if (UI_DURATIONS.indexOf(raw.durationSeconds) < 0) return null;
  // Family-specific difficulty sets: legacy SC keeps exactly its original
  // three tiers, while SV may additionally carry the fourth (casual) index.
  // The shared challenge type is wider than SC's wire format, so this check is
  // what keeps an injected decoder from smuggling casual into a legacy code.
  const difficulties: readonly string[] =
    family === 'v2' ? CHALLENGE_V2_DIFFICULTIES : CHALLENGE_LEGACY_DIFFICULTIES;
  if (difficulties.indexOf(raw.difficulty) < 0) return null;
  const score = raw.score;
  if (!isFiniteNumber(score) || !Number.isInteger(score) || score < 0 || score > 99999) {
    return null;
  }
  const result =
    raw.result === 'win' || raw.result === 'lose' || raw.result === 'draw'
      ? raw.result
      : null;
  if (raw.result !== undefined && raw.result !== null && UI_RESULTS.indexOf(raw.result) < 0) {
    return null;
  }
  return {
    seed: seed,
    durationSeconds: raw.durationSeconds as 180 | 300 | 480,
    difficulty: raw.difficulty as ChallengeDifficulty,
    score: score,
    result: result,
  };
}

function detectFamily(
  decoded: ChallengeDecodeAnyLike,
  code: string
): ChallengeCodeFamily {
  if (decoded.family === 'v3') return 'v3';
  if (decoded.family === 'v2') return 'v2';
  if (decoded.family === 'legacy') return 'legacy';
  // No explicit family (v1.1 decoder): the prefix is the only honest signal.
  return /^SV/i.test(code) ? 'v2' : 'legacy';
}

/**
 * Validates the faction count a decoded payload states. A v3 (SM) code must
 * carry its own legal 3|4 — a missing or illegal value refuses the whole code
 * instead of silently degrading it to a 1v1. Legacy/v2 codes are always the
 * historical 2-faction match.
 */
function strictFactionCount(
  family: ChallengeCodeFamily,
  payload: ChallengeDecodePayloadLike | undefined
): FactionCount | null {
  if (family !== 'v3') return 2;
  const value = payload ? payload.factionCount : undefined;
  return value === 3 || value === 4 ? value : null;
}

/**
 * True when the locally issued code (the "my challenge code" card) carries
 * the casual tier. The card is our own canonical output, so it is decoded with
 * the real codec; an unreadable/legacy code simply gets no extra note.
 */
function isCasualChallengeCode(code: string): boolean {
  try {
    const decoded = decodeChallengeAny(code);
    return (
      decoded.ok &&
      (decoded.family === 'v2' || decoded.family === 'v3') &&
      decoded.payload.difficulty === 'casual'
    );
  } catch (error) {
    return false;
  }
}

/**
 * True for the v1.4 multi-party (SM) family. An older build cannot open an SM
 * code at all, so the sender's copy card must say a 1.4.0+ build is required.
 */
function isMultiFactionChallengeCode(code: string): boolean {
  try {
    const decoded = decodeChallengeAny(code);
    return decoded.ok && decoded.family === 'v3';
  } catch (error) {
    return false;
  }
}

/** Human label for the faction count stated by an accepted code. */
export function challengeFactionLabel(count: FactionCount): string | null {
  if (count < 3) return null;
  return factionOptionSub(count);
}

function practiceNotice(
  family: ChallengeCodeFamily,
  fairness: ChallengeFairness,
  rulesVersion: number | null,
  notice: string | null
): string {
  if (notice) return notice;
  if (family === 'legacy') {
    return '旧版 SC 挑战码未记录速度与规则版本，仅可做同图练习，不比较胜负。';
  }
  if (fairness === 'fair' && rulesVersion !== null && rulesVersion !== CHALLENGE_RULES_VERSION) {
    return (
      '挑战码规则为 v' +
      rulesVersion +
      '，当前为 v' +
      CHALLENGE_RULES_VERSION +
      '，仅作同图练习，不比较胜负。'
    );
  }
  if (fairness === 'practice') {
    return '该挑战码为练习码，仅可同图重玩，不比较胜负。';
  }
  return '本局按练习处理，不与挑战者比较成绩。';
}

/**
 * Normalizes either decoder into one render-ready result. Every value is
 * checked here, so a decoder bug can never put an out-of-range payload into
 * the match setup:
 *   - v2 must explicitly carry fairness 'fair'|'practice', a supported speed
 *     and a known rules version, or it is rejected with a precise error;
 *   - `comparable` is true only for an explicit fair code on this build's
 *     current ruleset *and* an explicit decoder verdict of true. An injected
 *     decoder cannot bypass the payload checks by claiming comparable.
 */
export function normalizeChallengeDecode(
  raw: string,
  decoder?: ChallengeDecoder
): ChallengeUiDecoded {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  let decoded: ChallengeDecodeAnyLike | null = null;
  try {
    decoded =
      typeof decoder === 'function' ? decoder(trimmed) : decodeChallengeAny(trimmed);
  } catch (error) {
    return decodeFailure('invalid', '挑战码无法识别，请核对后重试');
  }
  if (!decoded || typeof decoded !== 'object') {
    return decodeFailure('invalid', '挑战码无法识别，请核对后重试');
  }
  if (!decoded.ok) {
    const reason =
      typeof decoded.reason === 'string' && decoded.reason
        ? decoded.reason
        : 'invalid';
    const message =
      typeof decoded.message === 'string' && decoded.message
        ? decoded.message
        : '挑战码无法识别，请核对后重试';
    return decodeFailure(reason, message);
  }
  const code =
    typeof decoded.code === 'string' && decoded.code
      ? decoded.code
      : trimmed.toUpperCase();
  const family = detectFamily(decoded, code);
  const payload = decoded.payload ? strictPayload(decoded.payload, family) : null;
  if (!payload) {
    return decodeFailure('invalid', '挑战码内容无效：参数缺失或越界');
  }
  const rawPayload = decoded.payload;

  // A v3 (SM) code owns its faction count: without a legal 3|4 it is refused
  // outright — never silently read as the legacy 1v1.
  const factionCount = strictFactionCount(family, rawPayload);
  if (factionCount === null) {
    return decodeFailure(
      'faction',
      '多方挑战码未声明合法人数（3 或 4 方），无法打开。'
    );
  }

  // v2 and v3 must state their fairness explicitly. An unknown/missing value
  // is never promoted to "fair": the decoder contract requires fair or practice.
  let fairness: ChallengeFairness = 'practice';
  if (family !== 'legacy') {
    const rawFairness = rawPayload ? rawPayload.fairness : undefined;
    if (rawFairness !== 'fair' && rawFairness !== 'practice') {
      return decodeFailure(
        'fairness',
        '挑战码缺少有效公平标记：新版挑战码必须明确标注公平或练习'
      );
    }
    fairness = rawFairness;
  }

  // v2 and v3 must also state a supported speed and a known rules version. A
  // missing or out-of-range value means the code cannot be trusted, so it is
  // refused instead of being treated as 1× / current.
  let speed: number | null = null;
  let rulesVersion: number | null = null;
  if (family !== 'legacy') {
    speed = validSpeed(rawPayload ? rawPayload.speed : undefined);
    if (speed === null) {
      return decodeFailure(
        'speed',
        '挑战码速度无效：新版挑战码必须记录 0.75× / 1× / 1.25× 之一'
      );
    }
    rulesVersion = validRulesVersion(
      rawPayload ? rawPayload.rulesVersion : undefined
    );
    if (rulesVersion === null) {
      return decodeFailure(
        'version',
        '挑战码规则版本无效：新版挑战码必须记录受支持的规则版本'
      );
    }
  }

  // A legacy code or a practice match never yields a verdict. A v2/v3 code is
  // comparable only when BOTH the payload says fair and the decoder's own
  // verdict is explicitly true, on this build's current ruleset. An injected
  // decoder cannot bypass the speed/version/fairness checks above.
  const comparable =
    family !== 'legacy' &&
    fairness === 'fair' &&
    rulesVersion === CHALLENGE_RULES_VERSION &&
    decoded.comparable === true;
  const baseNotice =
    typeof decoded.notice === 'string' && decoded.notice
      ? decoded.notice
      : comparable
        ? null
        : practiceNotice(family, fairness, rulesVersion, null);
  // A casual code is valid in this build, but older builds reject the fourth
  // difficulty index. Surface that compatibility fact even when the code is
  // otherwise comparable, and never show the same sentence twice.
  const notice =
    payload.difficulty !== 'casual'
      ? baseNotice
      : baseNotice && baseNotice.indexOf(CHALLENGE_CASUAL_NOTICE) < 0
        ? CHALLENGE_CASUAL_NOTICE + ' ' + baseNotice
        : CHALLENGE_CASUAL_NOTICE;
  return {
    ok: true,
    code: code,
    family: family,
    payload: payload,
    speed: speed,
    rulesVersion: rulesVersion,
    fairness: fairness,
    factionCount: factionCount,
    comparable: comparable,
    notice: notice,
  };
}

/** `1×`, `0.75×`, `1.25×`; `未记录` when the code never carried a speed. */
export function formatSpeedMultiplier(speed: number | null | undefined): string {
  if (!isFiniteNumber(speed) || speed <= 0) return '未记录';
  return String(Math.round(speed * 100) / 100) + '×';
}

/**
 * Difficulty label for the challenge card. The three historical tiers come
 * from the shared table; `casual` is SV-only, so it is named here explicitly
 * instead of being rendered as an unknown/undefined value by an older table.
 */
export function challengeDifficultyLabel(difficulty: string): string {
  if (difficulty === 'casual') return '新手';
  if (
    difficulty === 'easy' ||
    difficulty === 'normal' ||
    difficulty === 'hard'
  ) {
    return DIFFICULTY_LABEL[difficulty];
  }
  return '未知';
}

/** Structural input for the shared ruleset line (challenge + result screens). */
export interface ChallengeRulesetInfo {
  family?: string | null;
  comparable: boolean;
  speed?: number | null;
  rulesVersion?: number | null;
}

/**
 * One ruleset line, identical on the challenge card and the result card:
 *   legacy    → history, no speed recorded, practice only
 *   practice  → explicitly not comparable (speed shown when known)
 *   fixed     → rules version + speed, comparable
 */
export function challengeRulesetLabel(info: ChallengeRulesetInfo): string {
  const legacy = info.family === 'legacy';
  if (legacy) return '历史挑战码 · 未记录速度 · 仅同图练习';
  if (!info.comparable) {
    return (
      '练习模式 · 不计挑战胜负' +
      (typeof info.speed === 'number' && isFinite(info.speed)
        ? ' · 速度 ' + formatSpeedMultiplier(info.speed)
        : '')
    );
  }
  const version =
    typeof info.rulesVersion === 'number' && isFinite(info.rulesVersion)
      ? 'v' + info.rulesVersion
      : '未记录';
  return (
    '固定挑战 · 规则 ' +
    version +
    ' · 速度 ' +
    formatSpeedMultiplier(info.speed)
  );
}

export interface ChallengeScreenOptions {
  /** Code of the most recently finished match in this session, if any. */
  lastCode: string | null;
  /**
   * Optional code reader. Defaults to the shared v1.2 entry point
   * (`decodeChallengeAny`), which accepts both `SV-…` and legacy `SC-…` codes;
   * the result is still normalized and re-validated below.
   */
  decode?: ChallengeDecoder;
}

export interface ChallengeCallbacks {
  onBack: () => void;
  /**
   * `context` is optional so v1.1 callbacks keep compiling; v1.2 shells should
   * store it with the active challenge and mark practice matches as
   * non-comparable in the result screen and leaderboard settlement.
   */
  onStart: (
    payload: ChallengePayload,
    code: string,
    context?: ChallengeStartContext
  ) => void;
  /**
   * Extra accept-time policy owned by the shell (e.g. refusing a 0 target).
   * Returns an error message to show through the existing error node, or null
   * when the code may be accepted.
   */
  validate?: (payload: ChallengePayload) => string | null;
  /** v1.2 policy hook: sees the full decoded result before the match starts. */
  validateCode?: (decoded: ChallengeUiDecodeOk) => string | null;
}

/** Human theme name for a challenge (map geometry is not built here). */
export function challengeThemeLabel(payload: ChallengePayload): string {
  try {
    const resolution = resolveMapVariant(
      'random',
      payload.durationSeconds,
      payload.seed
    );
    for (let i = 0; i < MAP_CATALOG.themes.length; i += 1) {
      if (MAP_CATALOG.themes[i].themeId === resolution.themeId) {
        return MAP_CATALOG.themes[i].name;
      }
    }
    return resolution.mapId;
  } catch (error) {
    return '随机战场';
  }
}

/**
 * Makes the visible code field fully selectable. The container disables the
 * system copy menu and the clipboard APIs, so the only manual-copy affordance
 * is an explicitly selectable text field.
 */
function markSelectable(node: HTMLElement | null): void {
  if (!node || !node.style || typeof node.style.setProperty !== 'function') return;
  try {
    node.style.setProperty('-webkit-user-select', 'text');
    node.style.setProperty('user-select', 'text');
  } catch (error) {
    // Styling is a convenience; the read-only input is still focusable.
  }
}

function selectCode(node: HTMLElement | null): void {
  if (!node) return;
  const input = node as HTMLInputElement;
  markSelectable(input);
  try {
    if (typeof input.focus === 'function') input.focus();
    if (typeof input.select === 'function') input.select();
    if (
      typeof input.setSelectionRange === 'function' &&
      typeof input.value === 'string' &&
      input.value.length > 0
    ) {
      input.setSelectionRange(0, input.value.length);
    }
  } catch (error) {
    // Selection is a convenience; the copy note remains explicit either way.
  }
}

/**
 * Selects a challenge code for manual copying. The Xiaohongshu container
 * disables the browser clipboard APIs, so this helper does not attempt any
 * automatic copy: it focuses and selects the visible, read-only field, and the
 * note states plainly that the user must long-press or copy by hand. The UI
 * never claims a copy succeeded.
 *
 * `_code` is kept for call-site compatibility; the visible field already holds
 * it, so there is nothing to write anywhere.
 */
export function copyChallengeCode(
  _code: string,
  source: HTMLElement | null,
  note: HTMLElement
): void {
  selectCode(source);
  note.textContent = '当前环境无法使用剪贴板：挑战码已选中，请长按或手动复制。';
}

export class ChallengeScreen {
  readonly el: HTMLElement;

  private readonly errorNode: HTMLElement;
  private readonly infoHost: HTMLElement;

  constructor(callbacks: ChallengeCallbacks, options: ChallengeScreenOptions) {
    const self = this;

    const root = el('section', 'screen setup-screen challenge-screen');
    root.setAttribute('aria-labelledby', 'challenge-title');

    const header = el('header', 'setup-header');
    const back = button('返回', 'back-btn', callbacks.onBack);
    back.setAttribute('aria-label', '返回首页');
    const titles = el('div', 'setup-titles');
    const title = el('h1', 'setup-title', '挑战赛');
    title.id = 'challenge-title';
    titles.appendChild(title);
    titles.appendChild(el('p', 'setup-subtitle', '同图 · 同难度 · 比分定胜负'));
    header.appendChild(back);
    header.appendChild(titles);

    const body = el('div', 'setup-body setup-body-compact');
    const panel = el('div', 'setup-panel');

    const entry = el('div', 'challenge-entry');
    entry.appendChild(
      el(
        'p',
        'profile-hint',
        '输入好友发来的挑战码。字母自动大写，空格与横线会被忽略。'
      )
    );
    const input = el('input', 'profile-name-input challenge-input');
    input.type = 'text';
    input.value = '';
    input.maxLength = 32;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'SV-XXXXXX-XXXXXX-XX · SC-XXXXXX-XXXXXX · SM-XXXXXX-XXXXXX-XX';
    input.setAttribute('aria-label', '输入挑战码');
    input.addEventListener('input', function () {
      input.value = input.value.toUpperCase().replace(/\s+/g, '');
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') accept();
    });
    entry.appendChild(input);

    const acceptButton = button('接受挑战', 'btn btn-primary btn-wide challenge-accept', accept);
    acceptButton.setAttribute('aria-label', '接受挑战，解析挑战码');
    entry.appendChild(acceptButton);

    const errorNode = el('p', 'profile-error challenge-error');
    errorNode.setAttribute('role', 'alert');
    errorNode.setAttribute('aria-live', 'assertive');
    entry.appendChild(errorNode);

    const infoHost = el('div', 'challenge-info-host');
    const lastHost = el('div', 'challenge-last');
    panel.appendChild(entry);
    panel.appendChild(infoHost);
    panel.appendChild(lastHost);
    body.appendChild(panel);

    root.appendChild(header);
    root.appendChild(body);
    this.el = root;
    this.errorNode = errorNode;
    this.infoHost = infoHost;

    function accept(): void {
      const decoded = normalizeChallengeDecode(input.value, options.decode);
      if (!decoded.ok) {
        clear(infoHost);
        self.showMessage(decoded.message);
        return;
      }
      const rejection = callbacks.validate
        ? callbacks.validate(decoded.payload)
        : null;
      const codeRejection =
        !rejection && callbacks.validateCode
          ? callbacks.validateCode(decoded)
          : null;
      if (rejection || codeRejection) {
        clear(infoHost);
        self.showMessage(rejection || codeRejection);
        return;
      }
      self.showMessage(null);
      self.renderInfo(decoded, callbacks);
    }

    this.renderLastCode(lastHost, options.lastCode);
  }

  /** Accept-time rejection: same node, role and visibility as a decode error. */
  private showMessage(message: string | null): void {
    if (!message) {
      this.errorNode.textContent = '';
      this.errorNode.classList.remove('is-visible');
      return;
    }
    this.errorNode.textContent = message;
    this.errorNode.classList.add('is-visible');
  }

  private renderInfo(decoded: ChallengeUiDecodeOk, callbacks: ChallengeCallbacks): void {
    clear(this.infoHost);
    const payload = decoded.payload;
    const card = el('div', 'setup-random-card challenge-info');
    card.setAttribute('data-code', decoded.code);
    card.setAttribute('data-code-family', decoded.family);
    card.setAttribute('data-fairness', decoded.comparable ? 'fair' : 'practice');
    card.setAttribute('data-comparable', decoded.comparable ? 'true' : 'false');
    const mark = el(
      'span',
      'setup-random-mark challenge-info-mark',
      decoded.comparable ? '战' : '练'
    );
    mark.setAttribute('aria-hidden', 'true');
    card.appendChild(mark);

    const text = el('div', 'setup-random-text');
    const factionLabel = challengeFactionLabel(decoded.factionCount);
    text.appendChild(
      el(
        'p',
        'setup-random-title',
        (decoded.comparable ? '挑战目标 · ' : '练习目标 · ') +
          challengeDifficultyLabel(payload.difficulty) +
          ' · ' +
          durationLabel(payload.durationSeconds) +
          (factionLabel ? ' · ' + factionLabel : '')
      )
    );
    text.appendChild(
      el(
        'p',
        'setup-random-note challenge-target',
        '挑战分数 ' + payload.score + ' · 地图 ' + challengeThemeLabel(payload)
      )
    );
    const summary =
      '战场 #' +
      payload.seed +
      (payload.result ? ' · 对手战绩 ' + RESULT_LABEL[payload.result] : '') +
      (decoded.family === 'legacy'
        ? ' · 历史挑战码'
        : ' · 规则 v' +
          (decoded.rulesVersion === null ? '?' : String(decoded.rulesVersion))) +
      (factionLabel ? ' · ' + factionLabel : '');
    text.appendChild(el('p', 'setup-random-note challenge-meta', summary));
    text.appendChild(
      el(
        'p',
        'setup-random-note challenge-fairness',
        challengeRulesetLabel(decoded)
      )
    );
    if (decoded.notice && decoded.notice.indexOf(challengeRulesetLabel(decoded)) < 0) {
      text.appendChild(
        el('p', 'setup-random-note challenge-notice', decoded.notice)
      );
    }
    card.appendChild(text);
    this.infoHost.appendChild(card);

    const start = button(
      '开始挑战',
      'btn btn-primary btn-wide challenge-start',
      function () {
        const context: ChallengeStartContext = {
          family: decoded.family,
          comparable: decoded.comparable,
          speed: decoded.speed,
          rulesVersion: decoded.rulesVersion,
          fairness: decoded.comparable ? 'fair' : 'practice',
          factionCount: decoded.factionCount,
          notice: decoded.notice,
        };
        callbacks.onStart(decoded.payload, decoded.code, context);
      }
    );
    start.setAttribute(
      'aria-label',
      decoded.comparable
        ? '开始挑战，参数已锁定'
        : '开始挑战，本局为练习，不与挑战者比较'
    );
    this.infoHost.appendChild(start);
  }

  private renderLastCode(host: HTMLElement, lastCode: string | null): void {
    clear(host);
    host.appendChild(el('p', 'setup-random-title challenge-last-title', '我的挑战码'));
    if (!lastCode) {
      host.appendChild(
        el(
          'p',
          'profile-hint challenge-last-empty',
          '完成一局后，这里会显示最近一局的挑战码。'
        )
      );
      return;
    }

    const card = el('div', 'setup-random-card challenge-last-card');
    const mark = el('span', 'setup-random-mark challenge-code-mark', '码');
    mark.setAttribute('aria-hidden', 'true');
    card.appendChild(mark);
    const text = el('div', 'setup-random-text challenge-last-text');
    const input = el('input', 'profile-name-input challenge-last-code');
    input.type = 'text';
    input.value = lastCode;
    input.readOnly = true;
    input.setAttribute('readonly', 'readonly');
    input.setAttribute('aria-label', '最近一局的挑战码');
    markSelectable(input);
    text.appendChild(input);
    const note = el(
      'p',
      'profile-hint challenge-copy-note',
      '发给好友，对方输入后即可打同一张图。'
    );
    text.appendChild(note);
    // A casual code is still shareable, but only a build with the fourth
    // difficulty index can open it. Say so where the sender copies the code.
    if (isCasualChallengeCode(lastCode)) {
      text.appendChild(
        el('p', 'profile-hint challenge-casual-note', CHALLENGE_CASUAL_NOTICE)
      );
    }
    // A multi-party (SM) code needs a v1.4.0+ build: older clients reject the
    // unknown family outright. Warn the sender before they share the code.
    if (isMultiFactionChallengeCode(lastCode)) {
      text.appendChild(
        el(
          'p',
          'profile-hint challenge-faction-note',
          '多方挑战码（三方/四方）：需要 1.4.0 及以上版本才能打开。'
        )
      );
    }
    const copy = button('复制挑战码', 'btn btn-secondary poster-btn challenge-copy', function () {
      copyChallengeCode(lastCode, input, note);
    });
    copy.setAttribute('aria-label', '复制最近一局的挑战码');
    const copyActions = el('div', 'poster-actions');
    copyActions.appendChild(copy);
    text.appendChild(copyActions);
    card.appendChild(text);
    host.appendChild(card);
  }
}
