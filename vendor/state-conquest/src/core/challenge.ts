/**
 * Async challenge codec (PVP substitute): pure functions, no DOM, no network.
 *
 * A challenge fixes the four fairness inputs of one match — seed, duration,
 * difficulty and the challenger's territory score — so the receiver can play
 * the exact same map under the exact same rules. The code is deliberately
 * short enough to read aloud or retype:
 *
 *     SC-XXXXXX-XXXXXX       (16 characters, 12 base36 digits)
 *
 * Layout (all digits are base36):
 *   digits 0..10  payload, most significant first
 *   digit  11     check digit (weighted sum modulo 36)
 *
 * The 55 payload bits are split into two safe JavaScript numbers:
 *   lo (31 bits)  seed bits 0..30
 *   hi (24 bits)  seed bit 31, duration[2], difficulty[2], score[17],
 *                 result[2]
 * `lo` is written as 6 digits and `hi` as 5 digits; every intermediate value
 * stays below 2^31, so the codec never needs BigInt.
 *
 * The check digit uses weights coprime with 36. A single changed payload
 * character therefore always changes the weighted sum, and a changed check
 * character is always reported as a checksum failure. Field errors (enum or
 * range) are reported before the checksum so a malformed code gets a precise
 * message instead of a generic corruption notice.
 *
 * The challenge code is NOT a security token: it is a fairness handshake plus
 * typo protection. Players can always edit their own code before sharing.
 */

/**
 * The three difficulty values every challenge family has always carried. The
 * legacy SC codec below is restricted to exactly this set.
 */
export type ChallengeLegacyDifficulty = 'easy' | 'normal' | 'hard';
/**
 * Difficulty a decoded challenge can name. `casual` is an SV-only value: it
 * occupies difficulty index 3, which v1.2 reserved. SC encoding/decoding never
 * accepts it, so the legacy three-tier wire contract is unchanged.
 */
export type ChallengeDifficulty = ChallengeLegacyDifficulty | 'casual';
export type ChallengeResult = 'win' | 'lose' | 'draw';
export type ChallengeDurationSeconds = 180 | 300 | 480;
export type ChallengeVerdict = 'win' | 'lose' | 'draw';

export interface ChallengePayload {
  /** Positive 32-bit seed; (seed, durationSeconds) selects the map. */
  seed: number;
  durationSeconds: ChallengeDurationSeconds;
  difficulty: ChallengeDifficulty;
  /** Territory score the receiver has to beat, 0..99999. */
  score: number;
  /** Optional summary of the challenger's own match result. */
  result: ChallengeResult | null;
}

/** Encode input: enums are validated at runtime to keep call sites simple. */
export interface ChallengeFields {
  seed: number;
  durationSeconds: number;
  difficulty: string;
  score: number;
  result?: string | null;
}

export type ChallengeErrorCode =
  | 'empty'
  | 'prefix'
  | 'length'
  | 'chars'
  | 'checksum'
  | 'duration'
  | 'difficulty'
  | 'score'
  | 'seed'
  | 'result'
  | 'speed'
  | 'version'
  | 'fairness'
  | 'faction';

export const CHALLENGE_MAX_SCORE = 99999;
export const CHALLENGE_MAX_SEED = 0xffffffff;
export const CHALLENGE_CODE_PREFIX = 'SC';
export const CHALLENGE_CODE_LENGTH = 16;

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DURATIONS: ChallengeDurationSeconds[] = [180, 300, 480];
/**
 * Legacy SC difficulty order. This array is deliberately kept at the original
 * three entries: adding a value here would silently widen the SC wire format
 * and change what old codes mean.
 */
export const CHALLENGE_LEGACY_DIFFICULTIES: readonly ChallengeLegacyDifficulty[] = [
  'easy',
  'normal',
  'hard',
];
/**
 * SV difficulty order. Index 3 was reserved by the v1.2 layout and now names
 * the v1.3 casual tier; indices 0..2 keep their exact original meaning.
 */
export const CHALLENGE_V2_DIFFICULTIES: readonly ChallengeDifficulty[] = [
  'easy',
  'normal',
  'hard',
  'casual',
];
const DIFFICULTIES = CHALLENGE_LEGACY_DIFFICULTIES;
/** Bit 0 means "no summary"; 1..3 map to these results. */
const RESULTS: ChallengeResult[] = ['win', 'draw', 'lose'];
const CHECK_WEIGHTS: number[] = [1, 5, 7, 11, 13, 17, 19, 23, 25, 29, 31];

const SEED_LOW_MOD = 2147483648; // 2^31
const HI_LIMIT = 16777216; // 2^24

const MESSAGES: Record<ChallengeErrorCode, string> = {
  empty: '请输入挑战码',
  prefix: '挑战码格式错误：应以 SC 开头',
  length: '挑战码长度错误：应为 SC-XXXXXX-XXXXXX（12 位字符）',
  chars: '挑战码包含非法字符：只能使用 0-9 与 A-Z',
  checksum: '挑战码校验失败：可能输入有误，请核对后重试',
  duration: '挑战码时长无效：仅支持 3 / 5 / 8 分钟',
  difficulty: '挑战码难度无效：仅支持 easy / normal / hard',
  score: '挑战码分数越界：必须在 0~99999 之间',
  seed: '挑战码种子无效：必须为正整数',
  result: '挑战码战绩摘要无效',
  speed: '挑战码速度无效：仅支持 0.75× / 1× / 1.25×',
  version: '挑战码规则版本无效：仅支持 1~3',
  fairness: '挑战码公平规则无效：仅支持 fair / practice',
  faction: '挑战码人数无效：多方挑战码仅支持 3 或 4 方',
};

/** SV-only wording: the casual tier is valid there but never in legacy SC. */
const V2_DIFFICULTY_MESSAGE =
  '挑战码难度无效：SV 仅支持 easy / normal / hard / casual';

export class ChallengeCodecError extends Error {
  readonly reason: ChallengeErrorCode;

  constructor(reason: ChallengeErrorCode, message?: string) {
    super(message === undefined ? MESSAGES[reason] : message);
    this.name = 'ChallengeCodecError';
    this.reason = reason;
  }
}

export interface ChallengeDecodeOk {
  ok: true;
  /** Canonical uppercase, dash-grouped form (`SC-XXXXXX-XXXXXX`). */
  code: string;
  payload: ChallengePayload;
}

export interface ChallengeDecodeFailure {
  ok: false;
  reason: ChallengeErrorCode;
  message: string;
}

export type ChallengeDecodeResult = ChallengeDecodeOk | ChallengeDecodeFailure;

function failure(reason: ChallengeErrorCode): ChallengeDecodeFailure {
  return { ok: false, reason: reason, message: MESSAGES[reason] };
}

/**
 * Tolerant input normalization for the entry field: uppercase and drop all
 * whitespace/separators. Lowercase and missing dashes are accepted; anything
 * else is left for decode() to report explicitly.
 */
export function normalizeChallengeCode(raw: string): string {
  return String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

export function formatChallengeCode(digits: string): string {
  // Two groups of six keep the whole code at 16 characters. Splitting the
  // same 12 digits into three groups would need 17 characters including the
  // dashes, just over the budget.
  return (
    CHALLENGE_CODE_PREFIX + '-' + digits.slice(0, 6) + '-' + digits.slice(6, 12)
  );
}

function digitValue(character: string): number {
  return ALPHABET.indexOf(character);
}

function numberDigits(value: number, width: number): number[] {
  const out: number[] = new Array<number>(width);
  let rest = Math.floor(value);
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = rest % 36;
    rest = Math.floor(rest / 36);
  }
  if (rest !== 0) {
    // Only reachable for an internal packing bug; callers never see this.
    throw new RangeError('challenge: value does not fit in ' + width + ' base36 digits');
  }
  return out;
}

/** Weighted checksum over the 11 payload digits; coprime weights. */
function checkValue(payloadDigits: string): number {
  let sum = 0;
  for (let i = 0; i < CHECK_WEIGHTS.length; i += 1) {
    sum += digitValue(payloadDigits.charAt(i)) * CHECK_WEIGHTS[i];
  }
  return sum % 36;
}

function encodeError(reason: ChallengeErrorCode, message?: string): never {
  throw new ChallengeCodecError(reason, message);
}

function encodeSeed(value: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CHALLENGE_MAX_SEED
  ) {
    encodeError('seed');
  }
  return value;
}

/**
 * Encodes one challenge. Deterministic: identical fields always produce the
 * identical code. Invalid fields throw ChallengeCodecError with a precise
 * reason and message instead of being clamped or repaired.
 */
export function encodeChallenge(fields: ChallengeFields): string {
  if (!fields || typeof fields !== 'object') encodeError('empty');
  const seed = encodeSeed(fields.seed);

  const durationIndex = DURATIONS.indexOf(fields.durationSeconds as ChallengeDurationSeconds);
  if (durationIndex < 0) encodeError('duration');

  // Legacy SC: the three original tiers only. `casual` is deliberately not in
  // this table, so it is rejected exactly like any other unknown value.
  const difficultyIndex = DIFFICULTIES.indexOf(
    fields.difficulty as ChallengeLegacyDifficulty
  );
  if (difficultyIndex < 0) encodeError('difficulty');

  const score = fields.score;
  if (
    typeof score !== 'number' ||
    !Number.isSafeInteger(score) ||
    score < 0 ||
    score > CHALLENGE_MAX_SCORE
  ) {
    encodeError('score');
  }

  let resultBits = 0;
  if (fields.result !== undefined && fields.result !== null && fields.result !== '') {
    const resultIndex = RESULTS.indexOf(fields.result as ChallengeResult);
    if (resultIndex < 0) encodeError('result');
    resultBits = resultIndex + 1;
  }

  const lo = seed % SEED_LOW_MOD;
  const hi =
    (seed >= SEED_LOW_MOD ? 1 : 0) +
    durationIndex * 2 +
    difficultyIndex * 8 +
    score * 32 +
    resultBits * 4194304;

  const digits = numberDigits(hi, 5).concat(numberDigits(lo, 6));
  let payload = '';
  for (let i = 0; i < digits.length; i += 1) payload += ALPHABET.charAt(digits[i]);
  const check = ALPHABET.charAt(checkValue(payload));
  return formatChallengeCode(payload + check);
}

/**
 * Decodes a user-typed challenge. Never throws and never silently repairs:
 * every rejection carries a ChallengeErrorCode plus Chinese copy.
 */
export function decodeChallenge(raw: string): ChallengeDecodeResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) return failure('empty');
  const compact = normalizeChallengeCode(raw);
  if (compact.length === 0) return failure('empty');

  for (let i = 0; i < compact.length; i += 1) {
    if (digitValue(compact.charAt(i)) < 0) return failure('chars');
  }
  if (compact.slice(0, CHALLENGE_CODE_PREFIX.length) !== CHALLENGE_CODE_PREFIX) {
    return failure('prefix');
  }

  const body = compact.slice(CHALLENGE_CODE_PREFIX.length);
  if (body.length !== 12) return failure('length');

  const payloadDigits = body.slice(0, 11);
  let hi = 0;
  for (let i = 0; i < 5; i += 1) hi = hi * 36 + digitValue(payloadDigits.charAt(i));
  let lo = 0;
  for (let i = 5; i < 11; i += 1) lo = lo * 36 + digitValue(payloadDigits.charAt(i));

  // 11 base36 digits can hold more than the 55-bit payload; reserved bits mean
  // the code cannot have been produced by this codec.
  if (hi >= HI_LIMIT || lo >= SEED_LOW_MOD) return failure('checksum');

  const durationIndex = Math.floor(hi / 2) % 4;
  if (durationIndex >= DURATIONS.length) return failure('duration');

  const difficultyIndex = Math.floor(hi / 8) % 4;
  if (difficultyIndex >= DIFFICULTIES.length) return failure('difficulty');

  const score = Math.floor(hi / 32) % 131072;
  if (score > CHALLENGE_MAX_SCORE) return failure('score');

  const seed = lo + (hi % 2) * SEED_LOW_MOD;
  if (seed < 1) return failure('seed');

  if (digitValue(body.charAt(11)) !== checkValue(payloadDigits)) {
    return failure('checksum');
  }

  const resultBits = Math.floor(hi / 4194304) % 4;
  return {
    ok: true,
    code: formatChallengeCode(body),
    payload: {
      seed: seed,
      durationSeconds: DURATIONS[durationIndex],
      difficulty: DIFFICULTIES[difficultyIndex],
      score: score,
      result: resultBits === 0 ? null : RESULTS[resultBits - 1],
    },
  };
}

/**
 * Score comparison used by the challenge settlement. Same "territory score"
 * basis as the timed match rule: strictly greater wins, equal draws, lower
 * loses. Non-finite input is a programming error, not a verdict.
 */
export function compareChallengeScore(
  myScore: number,
  challengeScore: number
): ChallengeVerdict {
  if (
    typeof myScore !== 'number' ||
    typeof challengeScore !== 'number' ||
    !isFinite(myScore) ||
    !isFinite(challengeScore)
  ) {
    throw new RangeError('compareChallengeScore requires finite scores');
  }
  if (myScore > challengeScore) return 'win';
  if (myScore === challengeScore) return 'draw';
  return 'lose';
}

/* ==================================================================== v1.2 ===
 *
 * Versioned challenge codec.
 *
 * The v1.0 `SC-XXXXXX-XXXXXX` code has no room for a speed or a rules version,
 * so v1.2 introduces an independent family instead of reusing (or overloading)
 * the SC namespace:
 *
 *     SV-XXXXXX-XXXXXX-XX        (19 characters, 14 base36 digits)
 *
 * Layout (all digits are base36, uppercase):
 *   digits 0..11   payload, most significant first
 *   digits 12..13  two check digits (weighted sums mod 36)
 *
 * The 61 payload bits are split into two safe JavaScript numbers so no step
 * ever needs BigInt and every intermediate stays below 2^31:
 *   lo (31 bits): seed bits 0..30
 *   hi (30 bits): seed bit 31, duration[2], difficulty[2], score[17],
 *                 speed[2], rulesVersion[2], fairness[2], result[2]
 *
 * Field order inside `hi` (low bits first) is line-by-line in `encodeV2`; the
 * reader inverts exactly that order. Reserved enum values (speed 3, version 0,
 * fairness 2/3) are rejected explicitly before the checksum check, matching the
 * v1 error precedence.
 *
 * The difficulty field is the one place v1.3 fills previously reserved space:
 * index 3 used to be rejected and now means `casual`. Indices 0..2 keep their
 * exact original meaning, so every historical SV code decodes identically.
 * Casual is not a rule change, so the rules version is deliberately NOT bumped;
 * the tier is carried by the difficulty field alone.
 *
 * Check strength: the weights are coprime with 36, so a single mistyped
 * character always changes at least one check digit. Two independent sums also
 * catch most adjacent transpositions, but this is NOT a security token and no
 * broader guarantee is claimed: an adversary can always mint a valid code.
 *
 * A v2 code always states its speed and rules version, which is what makes a
 * "fair" comparison meaningful. A code that is not fair (practice) is still
 * shareable and replayable, but it must never be used to decide a win or a
 * ranking; `comparable` is derived here and re-checked by the accept policy.
 */

export type ChallengeSpeed = 0.75 | 1 | 1.25;
export type ChallengeFairness = 'fair' | 'practice';

/**
 * Current rule set (v2.0.0). The v2 progression, diplomacy, stalemate and
 * route rules are stamped separately from the v1.x baseline.
 * Bump when gameplay rules change again.
 */
export const CHALLENGE_RULES_VERSION = 2;
export const CHALLENGE_RULES_VERSIONS: readonly number[] = [1, 2, 3];
export const CHALLENGE_SPEEDS: readonly ChallengeSpeed[] = [0.75, 1, 1.25];

export const CHALLENGE_V2_CODE_PREFIX = 'SV';
export const CHALLENGE_V2_CODE_LENGTH = 19;
export const CHALLENGE_V2_BODY_LENGTH = 14;
export const CHALLENGE_V2_PAYLOAD_LENGTH = 12;

export interface ChallengePayloadV2 {
  seed: number;
  durationSeconds: ChallengeDurationSeconds;
  difficulty: ChallengeDifficulty;
  score: number;
  result: ChallengeResult | null;
  /** Fixed pace of the match that produced the score. */
  speed: ChallengeSpeed;
  /** Rule set version; 1 = v1.2 baseline. */
  rulesVersion: number;
  /** 'fair' may decide a verdict; 'practice' never may. */
  fairness: ChallengeFairness;
}

/** Permissive encode input; every field is validated at runtime. */
export interface ChallengeFieldsV2 {
  seed: number;
  durationSeconds: number;
  difficulty: string;
  score: number;
  result?: string | null;
  speed: number;
  /** Defaults to CHALLENGE_RULES_VERSION. */
  rulesVersion?: number;
  fairness: string;
}

export interface ChallengeDecodeAnyV2 {
  ok: true;
  family: 'v2';
  /** Canonical uppercase, dash-grouped form (`SV-XXXXXX-XXXXXX-XX`). */
  code: string;
  payload: ChallengePayloadV2;
  /** True only for a fair code of the current rules version. */
  comparable: boolean;
}

export interface ChallengeDecodeAnyLegacy {
  ok: true;
  family: 'legacy';
  code: string;
  /** The same payload v1.0/v1.1 produced: no speed, no rules version. */
  payload: ChallengePayload;
  comparable: false;
  /** Player-facing explanation; never empty. */
  notice: string;
}

export type ChallengeV2DecodeResult = ChallengeDecodeAnyV2 | ChallengeDecodeFailure;

export type ChallengeDecodeAnyResult =
  | ChallengeDecodeAnyV2
  | ChallengeDecodeAnyV3
  | ChallengeDecodeAnyLegacy
  | ChallengeDecodeFailure;

/** Required wording: a legacy code is practice, not a fair comparison. */
export const CHALLENGE_LEGACY_NOTICE =
  '旧版 SC 挑战码：未记录速度与规则版本，仅作同图练习，不参与固定速度比较。';

/**
 * Shown when a decoded SV code carries the casual tier. The code itself is
 * valid here, but a build that predates the fourth difficulty index rejects
 * it, so both sides of a share need a current version.
 */
export const CHALLENGE_CASUAL_NOTICE =
  '新手难度挑战码需新版使用：旧版本无法识别该难度，请双方更新后再打开。';

const SPEEDS: ChallengeSpeed[] = [0.75, 1, 1.25];
const FAIRNESSES: ChallengeFairness[] = ['fair', 'practice'];
const CHECK_WEIGHTS_A: number[] = [1, 5, 7, 11, 13, 17, 19, 23, 25, 29, 31, 35];
const CHECK_WEIGHTS_B: number[] = [7, 11, 13, 17, 19, 23, 25, 29, 31, 35, 1, 5];

/** hi payload is 30 bits; the seed low half is 31 bits. */
const V2_HI_LIMIT = 1073741824; // 2^30
const V2_SCORE_MOD = 131072; // 2^17
const V2_SPEED_SHIFT = 4194304; // score * 2^17 -> 2^22
const V2_VERSION_SHIFT = 16777216; // 2^24
const V2_FAIRNESS_SHIFT = 67108864; // 2^26
const V2_RESULT_SHIFT = 268435456; // 2^28

function isChallengeSpeed(value: unknown): value is ChallengeSpeed {
  return value === 0.75 || value === 1 || value === 1.25;
}

function isRulesVersion(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    CHALLENGE_RULES_VERSIONS.indexOf(value) >= 0
  );
}

/**
 * Shared 6-6-2 grouping of the 14-character SV/SM body. Both wide families
 * keep the exact same shape so the two differ only in their prefix letter.
 */
function formatDashCode(prefix: string, digits: string): string {
  return (
    prefix +
    '-' +
    digits.slice(0, 6) +
    '-' +
    digits.slice(6, 12) +
    '-' +
    digits.slice(12, 14)
  );
}

export function formatChallengeCodeV2(digits: string): string {
  return formatDashCode(CHALLENGE_V2_CODE_PREFIX, digits);
}

function v2CheckDigits(payloadDigits: string): string {
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < payloadDigits.length; i += 1) {
    const value = digitValue(payloadDigits.charAt(i));
    sumA += value * CHECK_WEIGHTS_A[i];
    sumB += value * CHECK_WEIGHTS_B[i];
  }
  return ALPHABET.charAt(sumA % 36) + ALPHABET.charAt(sumB % 36);
}

/**
 * Encodes one v1.2 challenge. Deterministic; invalid input throws a
 * ChallengeCodecError with a precise reason instead of being clamped.
 */
export function encodeChallengeV2(fields: ChallengeFieldsV2): string {
  if (!fields || typeof fields !== 'object') encodeError('empty');
  const seed = encodeSeed(fields.seed);

  const durationIndex = DURATIONS.indexOf(fields.durationSeconds as ChallengeDurationSeconds);
  if (durationIndex < 0) encodeError('duration');

  // SV is the wider family: index 3 (formerly reserved) is the casual tier.
  const difficultyIndex = CHALLENGE_V2_DIFFICULTIES.indexOf(
    fields.difficulty as ChallengeDifficulty
  );
  if (difficultyIndex < 0) encodeError('difficulty', V2_DIFFICULTY_MESSAGE);

  const score = fields.score;
  if (
    typeof score !== 'number' ||
    !Number.isSafeInteger(score) ||
    score < 0 ||
    score > CHALLENGE_MAX_SCORE
  ) {
    encodeError('score');
  }

  if (!isChallengeSpeed(fields.speed)) encodeError('speed');
  const speedIndex = SPEEDS.indexOf(fields.speed as ChallengeSpeed);

  const rulesVersion =
    fields.rulesVersion === undefined ? CHALLENGE_RULES_VERSION : fields.rulesVersion;
  if (!isRulesVersion(rulesVersion)) encodeError('version');
  const versionIndex = rulesVersion - 1;

  const fairnessIndex = FAIRNESSES.indexOf(fields.fairness as ChallengeFairness);
  if (fairnessIndex < 0) encodeError('fairness');

  let resultBits = 0;
  if (fields.result !== undefined && fields.result !== null && fields.result !== '') {
    const resultIndex = RESULTS.indexOf(fields.result as ChallengeResult);
    if (resultIndex < 0) encodeError('result');
    resultBits = resultIndex + 1;
  }

  const lo = seed % SEED_LOW_MOD;
  const hi =
    (seed >= SEED_LOW_MOD ? 1 : 0) +
    durationIndex * 2 +
    difficultyIndex * 8 +
    score * 32 +
    speedIndex * V2_SPEED_SHIFT +
    versionIndex * V2_VERSION_SHIFT +
    fairnessIndex * V2_FAIRNESS_SHIFT +
    resultBits * V2_RESULT_SHIFT;

  const digits = numberDigits(hi, 6).concat(numberDigits(lo, 6));
  let payload = '';
  for (let i = 0; i < digits.length; i += 1) payload += ALPHABET.charAt(digits[i]);
  return formatChallengeCodeV2(payload + v2CheckDigits(payload));
}

/**
 * Decodes an `SV-` code. Never throws; field errors are reported before the
 * checksum so a mistyped code gets a precise message.
 */
export function decodeChallengeV2(raw: string): ChallengeV2DecodeResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) return failure('empty');
  const compact = normalizeChallengeCode(raw);
  if (compact.length === 0) return failure('empty');

  for (let i = 0; i < compact.length; i += 1) {
    if (digitValue(compact.charAt(i)) < 0) return failure('chars');
  }
  if (compact.slice(0, CHALLENGE_V2_CODE_PREFIX.length) !== CHALLENGE_V2_CODE_PREFIX) {
    return failure('prefix');
  }

  const body = compact.slice(CHALLENGE_V2_CODE_PREFIX.length);
  if (body.length !== CHALLENGE_V2_BODY_LENGTH) return failure('length');

  const payloadDigits = body.slice(0, CHALLENGE_V2_PAYLOAD_LENGTH);
  let hi = 0;
  for (let i = 0; i < 6; i += 1) hi = hi * 36 + digitValue(payloadDigits.charAt(i));
  let lo = 0;
  for (let i = 6; i < 12; i += 1) lo = lo * 36 + digitValue(payloadDigits.charAt(i));

  // 12 base36 digits can hold more than the 61-bit payload; a value in the
  // reserved space cannot have been produced by this codec.
  if (hi >= V2_HI_LIMIT || lo >= SEED_LOW_MOD) return failure('checksum');

  const durationIndex = Math.floor(hi / 2) % 4;
  if (durationIndex >= DURATIONS.length) return failure('duration');

  // All four indices are defined in v1.3: 0..2 keep their exact v1.2 meaning
  // and 3 is the formerly reserved casual tier. The guard is kept so a future
  // table change cannot silently read an unknown value.
  const difficultyIndex = Math.floor(hi / 8) % 4;
  if (difficultyIndex >= CHALLENGE_V2_DIFFICULTIES.length) {
    return failure('difficulty');
  }

  const score = Math.floor(hi / 32) % V2_SCORE_MOD;
  if (score > CHALLENGE_MAX_SCORE) return failure('score');

  const speedIndex = Math.floor(hi / V2_SPEED_SHIFT) % 4;
  if (speedIndex >= SPEEDS.length) return failure('speed');

  const versionIndex = Math.floor(hi / V2_VERSION_SHIFT) % 4;
  if (!isRulesVersion(versionIndex + 1)) return failure('version');

  const fairnessIndex = Math.floor(hi / V2_FAIRNESS_SHIFT) % 4;
  if (fairnessIndex >= FAIRNESSES.length) return failure('fairness');

  const seed = lo + (hi % 2) * SEED_LOW_MOD;
  if (seed < 1) return failure('seed');

  if (body.slice(12, 14) !== v2CheckDigits(payloadDigits)) return failure('checksum');

  const resultBits = Math.floor(hi / V2_RESULT_SHIFT) % 4;
  const payload: ChallengePayloadV2 = {
    seed: seed,
    durationSeconds: DURATIONS[durationIndex],
    difficulty: CHALLENGE_V2_DIFFICULTIES[difficultyIndex],
    score: score,
    result: resultBits === 0 ? null : RESULTS[resultBits - 1],
    speed: SPEEDS[speedIndex],
    rulesVersion: versionIndex + 1,
    fairness: FAIRNESSES[fairnessIndex],
  };
  return {
    ok: true,
    family: 'v2',
    code: formatChallengeCodeV2(body),
    payload: payload,
    comparable:
      payload.fairness === 'fair' &&
      payload.rulesVersion === CHALLENGE_RULES_VERSION,
  };
}

/**
 * Single entry point for the accept screen. `SC` codes still decode with the
 * v1 semantics and are reported as non-comparable practice; `SV` codes carry
 * speed/rules/fairness; `SM` codes additionally state the faction count;
 * anything else fails with an explicit prefix reason.
 */
export function decodeChallengeAny(raw: string): ChallengeDecodeAnyResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) return failure('empty');
  const compact = normalizeChallengeCode(raw);
  if (compact.length === 0) return failure('empty');

  for (let i = 0; i < compact.length; i += 1) {
    if (digitValue(compact.charAt(i)) < 0) return failure('chars');
  }
  if (compact.length < CHALLENGE_CODE_PREFIX.length) return failure('length');

  const prefix = compact.slice(0, 2);
  if (prefix === CHALLENGE_V3_CODE_PREFIX) return decodeChallengeV3(raw);
  if (prefix === CHALLENGE_V2_CODE_PREFIX) return decodeChallengeV2(raw);
  if (prefix !== CHALLENGE_CODE_PREFIX) {
    return {
      ok: false,
      reason: 'prefix',
      message:
        '挑战码格式错误：应以 SC（旧版练习码）、SV（v1.2 挑战码）或 SM（多方挑战码）开头',
    };
  }

  const legacy = decodeChallenge(raw);
  if (!legacy.ok) return legacy;
  return {
    ok: true,
    family: 'legacy',
    code: legacy.code,
    payload: legacy.payload,
    comparable: false,
    notice: CHALLENGE_LEGACY_NOTICE,
  };
}

/* ==================================================================== v1.4 ===
 *
 * Multi-party challenge codec.
 *
 * v1.4 adds 1-player + 2/3-AI free-for-all matches. Their codes must state how
 * many factions the match runs with, and the SC/SV families have no spare
 * payload bit left (the v1.3 casual tier already filled SV's last reserved
 * difficulty index), so v1.4 introduces a third, independent prefix family
 * instead of reusing — or overloading — an existing namespace:
 *
 *     SM-XXXXXX-XXXXXX-XX        (19 characters, 14 base36 digits)
 *
 * Same shape and check-digit scheme as `SV`, different prefix letter. The
 * payload is 62 bits, split exactly like v1.2 so every intermediate stays
 * below 2^31 and no step needs BigInt:
 *   lo (31 bits): seed bits 0..30
 *   hi (31 bits): seed bit 31, duration[2], difficulty[2], score[17],
 *                 speed[2], rulesVersion[2], fairness[1], result[2],
 *                 factionCount[2]
 *
 * Two deliberate differences from the v1.2 bit layout, both confined to the
 * new family:
 *   - fairness is ONE bit (0 = fair, 1 = practice). The v1.2 field wasted a
 *     second bit on two values that never existed; the saved bit is what makes
 *     the faction count fit into the same six digits.
 *   - bits 29..30 carry the faction count (0 = 3 factions, 1 = 4 factions).
 *     Values 2/3 are rejected explicitly, so a decoded SM code always states
 *     a legal multi-party count and can never be mistaken for a 2-party code.
 *
 * Everything else keeps the v1.2 semantics verbatim: the same difficulty table
 * (including casual at index 3), speeds, rules versions and the same field
 * error precedence (field errors before the checksum). The rules version is
 * NOT bumped for multi-party: a 3/4-party fair match of the current rules is
 * comparable within its own faction-count class, and the leaderboard — not the
 * codec — keeps the counts apart.
 *
 * Old families stay frozen: SC and SV encode/decode code paths, payloads and
 * byte layouts are untouched, and an SM code can never collide with them
 * because the prefix differs.
 */

/** Faction counts an SM code may state. 2-party matches keep using SC/SV. */
export type ChallengeFactionCount = 3 | 4;

export const CHALLENGE_V3_CODE_PREFIX = 'SM';
export const CHALLENGE_V3_CODE_LENGTH = 19;
export const CHALLENGE_V3_BODY_LENGTH = 14;
export const CHALLENGE_V3_PAYLOAD_LENGTH = 12;

export interface ChallengePayloadV3 {
  seed: number;
  durationSeconds: ChallengeDurationSeconds;
  difficulty: ChallengeDifficulty;
  score: number;
  result: ChallengeResult | null;
  /** Fixed pace of the match that produced the score. */
  speed: ChallengeSpeed;
  /** Rule set version; multi-party shares the v1.2 baseline version. */
  rulesVersion: number;
  /** 'fair' may decide a verdict; 'practice' never may. */
  fairness: ChallengeFairness;
  /** Total seated factions (1 player + AIs), 3 or 4. */
  factionCount: ChallengeFactionCount;
}

/** Permissive encode input; every field is validated at runtime. */
export interface ChallengeFieldsV3 extends ChallengeFieldsV2 {
  /** Total seated factions; only 3 and 4 are encodable. */
  factionCount: number;
}

export interface ChallengeDecodeAnyV3 {
  ok: true;
  family: 'v3';
  /** Canonical uppercase, dash-grouped form (`SM-XXXXXX-XXXXXX-XX`). */
  code: string;
  payload: ChallengePayloadV3;
  /** True only for a fair code of the current rules version. */
  comparable: boolean;
}

export type ChallengeV3DecodeResult = ChallengeDecodeAnyV3 | ChallengeDecodeFailure;

/** hi payload is 31 bits; the seed low half is 31 bits. */
const V3_HI_LIMIT = 2147483648; // 2^31
/** One fairness bit at 2^26: 0 = fair, 1 = practice. */
const V3_FAIRNESS_PRACTICE = 67108864; // 2^26
const V3_RESULT_SHIFT = 134217728; // 2^27
const V3_FACTION_SHIFT = 536870912; // 2^29

function isChallengeFactionCount(value: unknown): value is ChallengeFactionCount {
  return value === 3 || value === 4;
}

export function formatChallengeCodeV3(digits: string): string {
  return formatDashCode(CHALLENGE_V3_CODE_PREFIX, digits);
}

/**
 * Encodes one multi-party challenge. Deterministic; invalid input throws a
 * ChallengeCodecError with a precise reason instead of being clamped. A
 * faction count other than 3 or 4 is rejected up front: 2-party matches mint
 * SC/SV codes and never enter this family.
 */
export function encodeChallengeV3(fields: ChallengeFieldsV3): string {
  if (!fields || typeof fields !== 'object') encodeError('empty');
  if (!isChallengeFactionCount(fields.factionCount)) encodeError('faction');

  const seed = encodeSeed(fields.seed);

  const durationIndex = DURATIONS.indexOf(fields.durationSeconds as ChallengeDurationSeconds);
  if (durationIndex < 0) encodeError('duration');

  // SM is the wide family, same difficulty table as SV (index 3 = casual).
  const difficultyIndex = CHALLENGE_V2_DIFFICULTIES.indexOf(
    fields.difficulty as ChallengeDifficulty
  );
  if (difficultyIndex < 0) encodeError('difficulty', V2_DIFFICULTY_MESSAGE);

  const score = fields.score;
  if (
    typeof score !== 'number' ||
    !Number.isSafeInteger(score) ||
    score < 0 ||
    score > CHALLENGE_MAX_SCORE
  ) {
    encodeError('score');
  }

  if (!isChallengeSpeed(fields.speed)) encodeError('speed');
  const speedIndex = SPEEDS.indexOf(fields.speed as ChallengeSpeed);

  // Multi-party shares the current rule set; the version is stamped per code
  // so a future rule change can still distinguish generations inside SM.
  const rulesVersion =
    fields.rulesVersion === undefined ? CHALLENGE_RULES_VERSION : fields.rulesVersion;
  if (!isRulesVersion(rulesVersion)) encodeError('version');
  const versionIndex = rulesVersion - 1;

  const fairnessIndex = FAIRNESSES.indexOf(fields.fairness as ChallengeFairness);
  if (fairnessIndex < 0) encodeError('fairness');

  let resultBits = 0;
  if (fields.result !== undefined && fields.result !== null && fields.result !== '') {
    const resultIndex = RESULTS.indexOf(fields.result as ChallengeResult);
    if (resultIndex < 0) encodeError('result');
    resultBits = resultIndex + 1;
  }

  const lo = seed % SEED_LOW_MOD;
  const hi =
    (seed >= SEED_LOW_MOD ? 1 : 0) +
    durationIndex * 2 +
    difficultyIndex * 8 +
    score * 32 +
    speedIndex * V2_SPEED_SHIFT +
    versionIndex * V2_VERSION_SHIFT +
    (fairnessIndex === 1 ? V3_FAIRNESS_PRACTICE : 0) +
    resultBits * V3_RESULT_SHIFT +
    (fields.factionCount - 3) * V3_FACTION_SHIFT;

  const digits = numberDigits(hi, 6).concat(numberDigits(lo, 6));
  let payload = '';
  for (let i = 0; i < digits.length; i += 1) payload += ALPHABET.charAt(digits[i]);
  return formatChallengeCodeV3(payload + v2CheckDigits(payload));
}

/**
 * Decodes an `SM-` code. Never throws; field errors are reported before the
 * checksum so a mistyped code gets a precise message. An illegal faction count
 * (index 2 or 3) is rejected explicitly — the count is payload, so the check
 * digits cover it too.
 */
export function decodeChallengeV3(raw: string): ChallengeV3DecodeResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) return failure('empty');
  const compact = normalizeChallengeCode(raw);
  if (compact.length === 0) return failure('empty');

  for (let i = 0; i < compact.length; i += 1) {
    if (digitValue(compact.charAt(i)) < 0) return failure('chars');
  }
  if (compact.slice(0, CHALLENGE_V3_CODE_PREFIX.length) !== CHALLENGE_V3_CODE_PREFIX) {
    return failure('prefix');
  }

  const body = compact.slice(CHALLENGE_V3_CODE_PREFIX.length);
  if (body.length !== CHALLENGE_V3_BODY_LENGTH) return failure('length');

  const payloadDigits = body.slice(0, CHALLENGE_V3_PAYLOAD_LENGTH);
  let hi = 0;
  for (let i = 0; i < 6; i += 1) hi = hi * 36 + digitValue(payloadDigits.charAt(i));
  let lo = 0;
  for (let i = 6; i < 12; i += 1) lo = lo * 36 + digitValue(payloadDigits.charAt(i));

  // 12 base36 digits can hold more than the 62-bit payload; a value in the
  // reserved space cannot have been produced by this codec.
  if (hi >= V3_HI_LIMIT || lo >= SEED_LOW_MOD) return failure('checksum');

  const durationIndex = Math.floor(hi / 2) % 4;
  if (durationIndex >= DURATIONS.length) return failure('duration');

  const difficultyIndex = Math.floor(hi / 8) % 4;
  if (difficultyIndex >= CHALLENGE_V2_DIFFICULTIES.length) {
    return failure('difficulty');
  }

  const score = Math.floor(hi / 32) % V2_SCORE_MOD;
  if (score > CHALLENGE_MAX_SCORE) return failure('score');

  const speedIndex = Math.floor(hi / V2_SPEED_SHIFT) % 4;
  if (speedIndex >= SPEEDS.length) return failure('speed');

  const versionIndex = Math.floor(hi / V2_VERSION_SHIFT) % 4;
  if (!isRulesVersion(versionIndex + 1)) return failure('version');

  // One fairness bit: any value is defined, unlike the v1.2 two-bit field.
  const practice = Math.floor(hi / V3_FAIRNESS_PRACTICE) % 2 === 1;

  const factionIndex = Math.floor(hi / V3_FACTION_SHIFT) % 4;
  if (factionIndex >= 2) return failure('faction');

  const seed = lo + (hi % 2) * SEED_LOW_MOD;
  if (seed < 1) return failure('seed');

  if (body.slice(12, 14) !== v2CheckDigits(payloadDigits)) return failure('checksum');

  const resultBits = Math.floor(hi / V3_RESULT_SHIFT) % 4;
  const payload: ChallengePayloadV3 = {
    seed: seed,
    durationSeconds: DURATIONS[durationIndex],
    difficulty: CHALLENGE_V2_DIFFICULTIES[difficultyIndex],
    score: score,
    result: resultBits === 0 ? null : RESULTS[resultBits - 1],
    speed: SPEEDS[speedIndex],
    rulesVersion: versionIndex + 1,
    fairness: practice ? 'practice' : 'fair',
    factionCount: factionIndex === 0 ? 3 : 4,
  };
  return {
    ok: true,
    family: 'v3',
    code: formatChallengeCodeV3(body),
    payload: payload,
    comparable:
      payload.fairness === 'fair' &&
      payload.rulesVersion === CHALLENGE_RULES_VERSION,
  };
}
