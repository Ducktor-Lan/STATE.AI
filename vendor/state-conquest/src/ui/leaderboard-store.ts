/**
 * Local best-score archive. One platform key (`leaderboard`), one player, no
 * network path. A record is only accepted for a finished solo or challenge
 * match; local versus is never ranked because both sides are human-scored.
 *
 * Fairness grouping (v1.2 schema 2):
 *   rank class + mapId + seed + difficulty + durationSeconds + rule + speed
 *   + rules version
 *
 * Rank classes:
 *   fixed     fixed speed, unchanged mid-match, current rules → comparable
 *   practice  a speed change mid-match, a practice challenge, or a rules
 *             version mismatch → kept for history, never compared
 *   legacy    a row migrated from a v1.1 (schema 1) archive or a legacy `SC`
 *             challenge → no recorded speed, never silently called 1x
 *
 * A challenge's fairness lock (betrayal off) is a different group from a solo
 * match at betrayal Lv.0 even when the battlefield and seed are identical.
 *
 * Faction-count grouping (v1.4 schema 3): a 3- or 4-party free-for-all states
 * its count on every row and only ever ranks inside its own count. Rows of
 * schema 1/2 predate the dimension and are always read as two-faction matches;
 * the group id of a two-faction row is byte-identical to its pre-v1.4 form.
 *
 * Writes are serialized through one chain and the store is a reset
 * participant: beginReset() blocks new records, invalidates in-flight loads and
 * drains the write chain before the shell wipes storage.
 */
import type { PlatformAdapter } from '../platform';
import { BETRAYAL_MAX_LEVEL, TICKS_PER_SECOND } from '../config/balance';
import {
  LEADERBOARD_CHALLENGE_BETRAYAL_LEVEL,
  LEADERBOARD_CURRENT_RULES_VERSION,
  LEADERBOARD_DEFAULT_FACTION_COUNT,
  LEADERBOARD_LEGACY_RULES_VERSION,
  LEADERBOARD_MAX_AVATAR_ID_CHARS,
  LEADERBOARD_MAX_CHALLENGE_SCORE,
  LEADERBOARD_MAX_LEGACY_RECORDS,
  LEADERBOARD_MAX_MAP_ID_CHARS,
  LEADERBOARD_MAX_MAP_NAME_CHARS,
  LEADERBOARD_MAX_NICKNAME_CHARS,
  LEADERBOARD_MAX_RECORD_ID_CHARS,
  LEADERBOARD_MAX_RECORDS,
  LEADERBOARD_MAX_RECORDS_PER_GROUP,
  LEADERBOARD_MAX_RULES_VERSION,
  LEADERBOARD_MAX_SCORE,
  LEADERBOARD_MAX_SEED,
  LEADERBOARD_MIN_RULES_VERSION,
  LEADERBOARD_READABLE_SCHEMA_VERSIONS,
  LEADERBOARD_SCHEMA_VERSION,
  LEADERBOARD_STORAGE_KEY,
  LEADERBOARD_SUPPORTED_DURATIONS,
  LEADERBOARD_SUPPORTED_FACTION_COUNTS,
  LEADERBOARD_SUPPORTED_SPEEDS,
} from '../config/leaderboard';
import type {
  Difficulty,
  FactionCount,
  MatchMode,
  MatchStatus,
  ResultKind,
} from './view-model';

export type LeaderboardMode = 'solo' | 'challenge';
/** Comparable fixed-speed rows, practice rows, or migrated history. */
export type LeaderboardRankClass = 'fixed' | 'practice' | 'legacy';
export type LeaderboardLoadState = 'unloaded' | 'missing' | 'ok' | 'corrupt' | 'error';
export type LeaderboardRejectReason =
  | 'not_loaded'
  | 'blocked'
  | 'storage_unavailable'
  | 'storage_corrupt'
  | 'opted_out'
  | 'versus'
  | 'unfinished'
  | 'invalid';

/**
 * Structural subset of MatchView. Passing the view directly is intentional;
 * tests can provide only the fields the archive actually reads.
 */
export interface LeaderboardMatch {
  status: MatchStatus;
  mode: MatchMode;
  mapId: string;
  mapName: string;
  seed: number;
  difficulty: Difficulty;
  durationTicks: number;
  result: ResultKind | null;
  scores: { player: number };
  tick: number;
  /**
   * Total seated factions of the finished match. Omitted on pre-v1.4 call
   * sites means 2; when both this and the submission state a count they must
   * agree.
   */
  factionCount?: FactionCount;
}

export interface LeaderboardRecord {
  /** Unique within this local archive. */
  id: string;
  /** ISO completion timestamp written when the result was settled. */
  finishedAt: string;
  nickname: string;
  avatarId?: string;
  mapId: string;
  mapName: string;
  seed: number;
  difficulty: Difficulty;
  /** Match length setting; part of the group key, never a speed ranking. */
  durationSeconds: number;
  mode: LeaderboardMode;
  /** Skill level the match actually ran with (0 for a fair challenge). */
  betrayalLevel: number;
  result: ResultKind;
  /** Final territory score of the player; the only ranked value. */
  score: number;
  /** Informational only: elapsed time is never a rank or tie-break input. */
  elapsedSeconds: number;
  /**
   * Speed dimension. `null` only for `legacy` rows, which predate speed
   * selection and must never be presented as having been played at 1x.
   */
  speed: number | null;
  /** Rule set that produced the score; 0 means "not recorded" (legacy). */
  rulesVersion: number;
  /** True once any in-match speed change happened (always practice). */
  speedChanged: boolean;
  rankClass: LeaderboardRankClass;
  /**
   * Total seated factions of the match (2 = 1v1, 3/4 = 1 player + AIs). Rows
   * of different counts share no group and are never ranked against each
   * other. Schema 1/2 rows are always read as 2.
   */
  factionCount: number;
  /** The posted target when mode is 'challenge'. */
  challengeScore?: number;
}

export interface LeaderboardSubmission {
  nickname: string;
  avatarId?: string | null;
  /** Defaults to 'solo'; challenge forces the fairness-locked skill rule. */
  matchKind?: LeaderboardMode;
  /** Actual level from the match's raw skill state (challenge must be 0). */
  betrayalLevel: number;
  challengeScore?: number | null;
  /**
   * Fixed pace of the match. Omitted means "caller has no speed dimension":
   * a solo match is then treated as the historical 1x, while a challenge is
   * refused a comparable rank (incomplete settings are practice, never fair).
   */
  speed?: number | null;
  /** True once the player changed speed mid-match; forces practice. */
  speedChanged?: boolean;
  /** Defaults to the current rules version. */
  rulesVersion?: number;
  /**
   * Codec-declared fairness of an accepted challenge. Omitted on a challenge
   * means the settings are incomplete → practice, never comparable.
   */
  fairness?: 'fair' | 'practice';
  /**
   * Total seated factions of the match (2|3|4). Omitted means the
   * pre-v1.4 two-faction match; when the match view also states a count the
   * two must agree or the record is refused.
   */
  factionCount?: number;
}

export interface LeaderboardRecordResult {
  ok: boolean;
  reason?: LeaderboardRejectReason;
  record?: LeaderboardRecord;
  /** False when the accepted record fell outside the per-group cap at once. */
  retained?: boolean;
  /** 1-based rank inside its group when retained. */
  rank?: number;
  /**
   * True when a valid record was accepted but a capacity bound dropped it (or
   * it never made it into its group) during the same call. `ok` stays true
   * because nothing failed, but the UI must not present this match as
   * "已入榜": show the trimming notice instead of a success line.
   */
  evicted?: boolean;
}

export interface LeaderboardGroupSummary {
  id: string;
  mapId: string;
  mapName: string;
  seed: number;
  difficulty: Difficulty;
  durationSeconds: number;
  mode: LeaderboardMode;
  betrayalLevel: number;
  /** Skill-rule dimension only: 'challenge-fair' or 'solo-betrayal-N'. */
  ruleKey: string;
  rankClass: LeaderboardRankClass;
  /** Fixed pace of this group; null for legacy groups. */
  speed: number | null;
  /** Rules version of this group; 0 for legacy groups. */
  rulesVersion: number;
  /** Total factions of this group (2|3|4); a group never mixes counts. */
  factionCount: number;
  recordCount: number;
  bestScore: number;
  latestFinishedAt: string;
}

export interface LeaderboardGroup extends LeaderboardGroupSummary {
  records: LeaderboardRecord[];
}

export interface LeaderboardStoreOptions {
  /**
   * Live opt-in source (normally SettingsStore.leaderboardOptIn). Evaluated on
   * every record() call so turning the setting off stops recording at once.
   * The safe default is false.
   */
  optIn?: () => boolean;
  now?: () => Date;
  onWrite?: (ok: boolean) => void;
}

/**
 * Persisted envelope.
 *
 * `evictedLegacy` / `evictedModern` are cumulative counters so the trimming
 * notice survives a cold start: the rows are already gone, and without the
 * counts a restart would silently forget that the archive was ever trimmed.
 * They are additive optional fields (schema 2); a v1 payload has neither and
 * reads as 0. They are never part of ranking.
 *
 * Schema 3 (v1.4) adds a `factionCount` to every record; schema 1/2 payloads
 * have none and read as 2.
 */
interface LeaderboardPayload {
  schemaVersion: number;
  records: LeaderboardRecord[];
  evictedLegacy?: number;
  evictedModern?: number;
}

export interface LeaderboardTrimNotice {
  /** Migrated v1.1 history rows removed by the legacy budget, lifetime total. */
  legacy: number;
  /** Fixed/practice rows removed by the modern budget, lifetime total. */
  modern: number;
  /** True when the last write could not persist the updated counters. */
  unpersisted: boolean;
}

const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'casual'];
const RESULTS: ResultKind[] = ['win', 'lose', 'draw'];

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Includes v1.3 casual: every tier is validated by the same strict rule. */
function isDifficulty(value: unknown): value is Difficulty {
  return DIFFICULTIES.indexOf(value as Difficulty) >= 0;
}

function isResult(value: unknown): value is ResultKind {
  return RESULTS.indexOf(value as ResultKind) >= 0;
}

function isSupportedDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    LEADERBOARD_SUPPORTED_DURATIONS.indexOf(value) >= 0
  );
}

function cleanText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (Array.from(trimmed).length > maxChars) return null;
  return trimmed;
}

function cleanAvatarId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return cleanText(value, LEADERBOARD_MAX_AVATAR_ID_CHARS) || undefined;
}

/** The skill dimension of the group key, kept explicit for the UI copy. */
export function leaderboardRuleKey(
  mode: LeaderboardMode,
  betrayalLevel: number
): string {
  if (mode === 'challenge') return 'challenge-fair';
  return 'solo-betrayal-' + String(betrayalLevel);
}

function isSupportedSpeed(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    LEADERBOARD_SUPPORTED_SPEEDS.indexOf(value) >= 0
  );
}

function isSupportedFactionCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    LEADERBOARD_SUPPORTED_FACTION_COUNTS.indexOf(value) >= 0
  );
}

function isRankClass(value: unknown): value is LeaderboardRankClass {
  return value === 'fixed' || value === 'practice' || value === 'legacy';
}

/**
 * A record is comparable only inside the `fixed` class of the current rules
 * version. Everything else is history that must never decide a ranking.
 */
export function isComparableRecord(record: {
  rankClass: LeaderboardRankClass;
  rulesVersion: number;
}): boolean {
  return (
    record.rankClass === 'fixed' &&
    record.rulesVersion === LEADERBOARD_CURRENT_RULES_VERSION
  );
}

export function isComparableGroup(group: {
  rankClass: LeaderboardRankClass;
  rulesVersion: number;
}): boolean {
  return isComparableRecord(group);
}

/** Speed label for group headers. Never invents a pace for history rows. */
export function leaderboardSpeedLabel(speed: number | null): string {
  if (speed === 0.75) return '0.75×';
  if (speed === 1) return '1×';
  if (speed === 1.25) return '1.25×';
  return '未记录速度';
}

/**
 * Faction-count label for group headers, kept separate from the group key on
 * purpose: the key distinguishes counts, this only names them.
 */
export function leaderboardFactionCountLabel(factionCount: number): string {
  if (factionCount === 2) return '2 方';
  if (factionCount === 3) return '3 方';
  if (factionCount === 4) return '4 方';
  return '未知人数';
}

/** Class label: only `fixed` copy may read as a fair comparison. */
export function leaderboardRankClassLabel(rankClass: LeaderboardRankClass): string {
  if (rankClass === 'fixed') return '固定速度 · 可比';
  if (rankClass === 'practice') return '练习 · 不可比';
  return '历史记录 · 未记录速度';
}

/**
 * Copy for the "no comparable result yet" state. Shows the real reason instead
 * of borrowing a legacy or practice score as if it were a fixed-speed record.
 */
export function leaderboardNoComparableCopy(legacyRows: number, practiceRows: number): string {
  if (legacyRows === 0 && practiceRows === 0) {
    return '还没有固定速度成绩。完成一局中途未切速的单人或挑战赛后会在这里形成可比分组。';
  }
  return (
    '暂无固定速度可比成绩。' +
    (legacyRows > 0 ? '本机有 ' + legacyRows + ' 条旧版记录（未记录速度），仅作历史展示；' : '') +
    (practiceRows > 0 ? '另有 ' + practiceRows + ' 条练习记录（切速或练习码）；' : '') +
    '它们都不参与固定速度比较。'
  );
}

/**
 * Group key. Speed and rules version are part of it for `fixed` rows; practice
 * rows keep their (possibly null) speed so two different paces never share a
 * group; legacy rows have neither and always form their own history group.
 *
 * Omitted fields default to the "current fixed 1x group" so a caller that only
 * knows the battlefield (the v1.1 call shape) still addresses the group a new
 * solo match will land in.
 *
 * The faction count is appended ONLY when it is not the historical two-faction
 * match: every group id minted before v1.4 stays byte-identical, while 3/4
 * rows carry an extra dimension and can never be grouped — or ranked — with a
 * two-faction row. An omitted count reads as 2, matching the old call shape.
 */
export function leaderboardGroupId(
  record: Pick<
    LeaderboardRecord,
    'mapId' | 'seed' | 'difficulty' | 'durationSeconds' | 'mode' | 'betrayalLevel'
  > & {
    rankClass?: LeaderboardRankClass;
    speed?: number | null;
    rulesVersion?: number;
    factionCount?: number;
  }
): string {
  const rankClass: LeaderboardRankClass =
    record.rankClass === undefined ? 'fixed' : record.rankClass;
  const speed =
    record.speed === undefined
      ? rankClass === 'legacy'
        ? null
        : 1
      : record.speed;
  const rulesVersion =
    record.rulesVersion === undefined
      ? rankClass === 'legacy'
        ? LEADERBOARD_LEGACY_RULES_VERSION
        : LEADERBOARD_CURRENT_RULES_VERSION
      : record.rulesVersion;
  const factionCount = isSupportedFactionCount(record.factionCount)
    ? record.factionCount
    : LEADERBOARD_DEFAULT_FACTION_COUNT;
  // JSON keeps every field unambiguous even if a map id ever contains '|'.
  const dimensions: unknown[] = [
    record.mapId,
    record.seed,
    record.difficulty,
    record.durationSeconds,
    leaderboardRuleKey(record.mode, record.betrayalLevel),
    rankClass,
    speed,
    rulesVersion,
  ];
  if (factionCount !== LEADERBOARD_DEFAULT_FACTION_COUNT) {
    dimensions.push(factionCount);
  }
  return JSON.stringify(dimensions);
}

/**
 * Rank order inside one group: score descending, then earlier completion, then
 * smaller record id. The completed-at/id pair is the only tie-break; elapsed
 * time is never used, so a faster win is not presented as a fairer win.
 */
export function compareLeaderboardRecords(
  a: LeaderboardRecord,
  b: LeaderboardRecord
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.finishedAt !== b.finishedAt) return compareText(a.finishedAt, b.finishedAt);
  return compareText(a.id, b.id);
}

/**
 * Row reader. `schemaVersion` decides what "missing speed" means:
 *   - v1 rows predate speed entirely → `legacy` (speed null, version 0);
 *   - v2 rows must state speed/version/class explicitly, because a truncated
 *     v2 row could otherwise be promoted into a comparable fixed group.
 * Legacy rows are preserved as-is: they are history the player already earned.
 */
function sanitizeRecord(
  value: unknown,
  schemaVersion: number
): LeaderboardRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const id =
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    raw.id.length <= LEADERBOARD_MAX_RECORD_ID_CHARS
      ? raw.id
      : null;
  if (!id) return null;

  const finishedAt =
    typeof raw.finishedAt === 'string' && isFinite(Date.parse(raw.finishedAt))
      ? new Date(Date.parse(raw.finishedAt)).toISOString()
      : null;
  if (!finishedAt) return null;

  const nickname = cleanText(raw.nickname, LEADERBOARD_MAX_NICKNAME_CHARS);
  const mapId = cleanText(raw.mapId, LEADERBOARD_MAX_MAP_ID_CHARS);
  const mapName = cleanText(raw.mapName, LEADERBOARD_MAX_MAP_NAME_CHARS);
  if (!nickname || !mapId || !mapName) return null;

  if (!isIntegerInRange(raw.seed, 1, LEADERBOARD_MAX_SEED)) return null;
  if (!isDifficulty(raw.difficulty)) return null;
  if (!isSupportedDuration(raw.durationSeconds)) return null;
  if (raw.mode !== 'solo' && raw.mode !== 'challenge') return null;
  if (!isIntegerInRange(raw.betrayalLevel, 0, BETRAYAL_MAX_LEVEL)) return null;
  if (raw.mode === 'challenge' && raw.betrayalLevel !== LEADERBOARD_CHALLENGE_BETRAYAL_LEVEL) {
    return null;
  }
  if (!isResult(raw.result)) return null;
  if (!isIntegerInRange(raw.score, 0, LEADERBOARD_MAX_SCORE)) return null;
  if (!isIntegerInRange(raw.elapsedSeconds, 0, raw.durationSeconds)) return null;

  let challengeScore: number | undefined;
  if (raw.mode === 'challenge') {
    if (raw.challengeScore !== undefined && raw.challengeScore !== null) {
      if (!isIntegerInRange(raw.challengeScore, 0, LEADERBOARD_MAX_CHALLENGE_SCORE)) return null;
      challengeScore = raw.challengeScore;
    }
  }

  let rankClass: LeaderboardRankClass;
  let speed: number | null;
  let rulesVersion: number;
  let speedChanged: boolean;

  if (schemaVersion === 1) {
    // v1.1 archive: no speed dimension existed, so nothing may be inferred.
    rankClass = 'legacy';
    speed = null;
    rulesVersion = LEADERBOARD_LEGACY_RULES_VERSION;
    speedChanged = false;
  } else {
    const rawClass = raw.rankClass;
    if (!isRankClass(rawClass)) return null;
    rankClass = rawClass;

    if (rankClass === 'legacy') {
      // Legacy rows are history from before the speed dimension. Anything a
      // damaged write left in `speed` / `speedChanged` is normalized away
      // instead of dropping the row: a stray invalid value must not erase an
      // otherwise readable result, and it must never be shown as a real pace.
      speed = null;
      speedChanged = false;
      if (raw.rulesVersion !== LEADERBOARD_LEGACY_RULES_VERSION) return null;
      rulesVersion = LEADERBOARD_LEGACY_RULES_VERSION;
    } else {
      const rawSpeed = raw.speed;
      if (rawSpeed === null || rawSpeed === undefined) {
        // A practice row may omit the speed when the caller could not prove
        // one. A fixed row must always state it.
        if (rankClass === 'fixed') return null;
        speed = null;
      } else {
        if (!isSupportedSpeed(rawSpeed)) return null;
        speed = rawSpeed;
      }

      // Read-side version check is deliberately WIDER than the write-side
      // bound: any positive integer is preserved (see the comment below), so a
      // row written by a newer build is never erased by an older one.
      const rawVersion = raw.rulesVersion;
      if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 1) {
        return null;
      }
      rulesVersion = rawVersion;

      if (typeof raw.speedChanged !== 'boolean') return null;
      speedChanged = raw.speedChanged;
    }

    // Class invariants. A row from another rules version is NOT dropped and
    // its class is not rewritten: it was a result under the rules of its own
    // generation. `rankClass` stays as stored, the version is part of the group
    // key, and `isComparableGroup()` refuses it because it requires the current
    // version. That keeps the row visible and reversible (a future build that
    // raises the current version can rank it again) instead of letting the next
    // write silently erase a legal past result.
    if (rankClass === 'fixed') {
      if (speed === null || speedChanged) return null;
    }
    if (rankClass === 'practice') {
      if (rulesVersion < 1) return null;
    }
  }

  // Faction-count dimension. Schema 1/2 rows predate v1.4: every one of them
  // was a two-faction match, so the count is defaulted (a stray field is
  // ignored exactly like schema 1 ignores rank fields). Schema 3 rows must
  // state a legal count themselves — a missing or unknown one means the row
  // cannot be placed in a group and is dropped, never silently read as 2.
  let factionCount: number;
  if (schemaVersion <= 2) {
    factionCount = LEADERBOARD_DEFAULT_FACTION_COUNT;
  } else {
    if (!isSupportedFactionCount(raw.factionCount)) return null;
    factionCount = raw.factionCount;
  }

  return {
    id: id,
    finishedAt: finishedAt,
    nickname: nickname,
    avatarId: cleanAvatarId(raw.avatarId),
    mapId: mapId,
    mapName: mapName,
    seed: raw.seed,
    difficulty: raw.difficulty,
    durationSeconds: raw.durationSeconds,
    mode: raw.mode,
    betrayalLevel: raw.betrayalLevel,
    result: raw.result,
    score: raw.score,
    elapsedSeconds: raw.elapsedSeconds,
    speed: speed,
    rulesVersion: rulesVersion,
    speedChanged: speedChanged,
    rankClass: rankClass,
    factionCount: factionCount,
    challengeScore: challengeScore,
  };
}

interface ParsedPayload {
  records: LeaderboardRecord[];
  /** Records skipped because they failed sanitization or repeated an id. */
  dropped: number;
  /** Rows read from a v1.1 payload and preserved as `legacy` history. */
  migratedLegacy: number;
  /** Schema version the payload actually declared. */
  schemaVersion: number;
  /** Persisted cumulative trimming counters (0 when absent, e.g. schema 1). */
  evictedLegacy: number;
  evictedModern: number;
}

function readTrimCounter(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Strict payload reader: an unknown shape yields null, never a repaired list. */
function readPayload(value: unknown): ParsedPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const schemaVersion = raw.schemaVersion;
  if (
    typeof schemaVersion !== 'number' ||
    LEADERBOARD_READABLE_SCHEMA_VERSIONS.indexOf(schemaVersion) < 0
  ) {
    return null;
  }
  if (!Array.isArray(raw.records)) return null;

  const records: LeaderboardRecord[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let migratedLegacy = 0;
  for (let i = 0; i < raw.records.length; i += 1) {
    const record = sanitizeRecord(raw.records[i], schemaVersion);
    if (!record || seen.has(record.id)) {
      dropped += 1;
      continue;
    }
    if (record.rankClass === 'legacy') migratedLegacy += 1;
    seen.add(record.id);
    records.push(record);
  }
  return {
    records: records,
    dropped: dropped,
    migratedLegacy: migratedLegacy,
    schemaVersion: schemaVersion,
    evictedLegacy: readTrimCounter(raw.evictedLegacy),
    evictedModern: readTrimCounter(raw.evictedModern),
  };
}

function groupRecords(
  records: LeaderboardRecord[]
): Map<string, LeaderboardRecord[]> {
  const groups = new Map<string, LeaderboardRecord[]>();
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const id = leaderboardGroupId(record);
    const list = groups.get(id);
    if (list) list.push(record);
    else groups.set(id, [record]);
  }
  return groups;
}

interface PruneResult {
  records: LeaderboardRecord[];
  /** Migrated history rows removed by the legacy budget; surfaced, never silent. */
  evictedLegacy: number;
  /** Fixed/practice rows removed by the modern budget; also surfaced. */
  evictedModern: number;
}

function compareOldestFirst(a: LeaderboardRecord, b: LeaderboardRecord): number {
  if (a.finishedAt !== b.finishedAt) return compareText(a.finishedAt, b.finishedAt);
  return compareText(a.id, b.id);
}

/**
 * Bounds are enforced on every mutation and load.
 *
 * Two independent budgets, both stated in `config/leaderboard.ts`:
 *   1. inside a group, only the best MAX_RECORDS_PER_GROUP rows survive;
 *   2. the modern budget (fixed + practice) keeps the newest MAX_RECORDS;
 *   3. the legacy budget keeps the newest MAX_LEGACY_RECORDS migrated rows.
 *
 * The budgets are independent on purpose. A player who upgrades with a full
 * v1.1 archive must still be able to build new comparable results; the old
 * rows are never silently displaced by a fresh one, and a fresh row is never
 * evicted just because history filled the archive. Every eviction is counted
 * and surfaced through `evictedLegacyRecords()` / `evictedRecords()`.
 */
function pruneRecords(records: LeaderboardRecord[]): PruneResult {
  let evictedLegacy = 0;
  let evictedModern = 0;

  // Step 1: per-group cap, keeping the best rows of each group.
  const perGroupSurvivors: LeaderboardRecord[] = [];
  groupRecords(records).forEach(function (list) {
    const sorted = list.slice().sort(compareLeaderboardRecords);
    const keep = Math.min(sorted.length, LEADERBOARD_MAX_RECORDS_PER_GROUP);
    for (let i = 0; i < sorted.length; i += 1) {
      if (i < keep) perGroupSurvivors.push(sorted[i]);
      else if (sorted[i].rankClass === 'legacy') evictedLegacy += 1;
      else evictedModern += 1;
    }
  });

  // Step 2: split the survivors into the two budgets.
  const modern: LeaderboardRecord[] = [];
  const legacy: LeaderboardRecord[] = [];
  for (let i = 0; i < perGroupSurvivors.length; i += 1) {
    const record = perGroupSurvivors[i];
    if (record.rankClass === 'legacy') legacy.push(record);
    else modern.push(record);
  }

  if (legacy.length > LEADERBOARD_MAX_LEGACY_RECORDS) {
    legacy.sort(compareOldestFirst);
    const drop = legacy.length - LEADERBOARD_MAX_LEGACY_RECORDS;
    legacy.splice(0, drop);
    evictedLegacy += drop;
  }
  if (modern.length > LEADERBOARD_MAX_RECORDS) {
    modern.sort(compareOldestFirst);
    const drop = modern.length - LEADERBOARD_MAX_RECORDS;
    modern.splice(0, drop);
    evictedModern += drop;
  }

  // Stable persistence order: newest first, id ascending for identical times.
  const kept = modern.concat(legacy);
  kept.sort(function (a, b) {
    if (a.finishedAt !== b.finishedAt) return compareText(b.finishedAt, a.finishedAt);
    return compareText(a.id, b.id);
  });
  return { records: kept, evictedLegacy: evictedLegacy, evictedModern: evictedModern };
}

function buildGroups(records: LeaderboardRecord[]): LeaderboardGroup[] {
  const groups = groupRecords(records);
  const out: LeaderboardGroup[] = [];
  groups.forEach(function (list) {
    const sorted = list.slice().sort(compareLeaderboardRecords);
    const best = sorted[0];
    let latest = list[0];
    for (let i = 1; i < list.length; i += 1) {
      const candidate = list[i];
      if (
        candidate.finishedAt > latest.finishedAt ||
        (candidate.finishedAt === latest.finishedAt && candidate.id > latest.id)
      ) {
        latest = candidate;
      }
    }
    out.push({
      id: leaderboardGroupId(best),
      mapId: best.mapId,
      mapName: latest.mapName,
      seed: best.seed,
      difficulty: best.difficulty,
      durationSeconds: best.durationSeconds,
      mode: best.mode,
      betrayalLevel: best.betrayalLevel,
      ruleKey: leaderboardRuleKey(best.mode, best.betrayalLevel),
      rankClass: best.rankClass,
      speed: best.speed,
      rulesVersion: best.rulesVersion,
      factionCount: best.factionCount,
      recordCount: sorted.length,
      bestScore: best.score,
      latestFinishedAt: latest.finishedAt,
      records: sorted,
    });
  });
  out.sort(function (a, b) {
    if (a.latestFinishedAt !== b.latestFinishedAt) {
      return compareText(b.latestFinishedAt, a.latestFinishedAt);
    }
    return compareText(a.id, b.id);
  });
  return out;
}

/**
 * The single owner of the local leaderboard. It never reads SettingsStore
 * directly; the shell supplies a live opt-in callback. No historical data is
 * imported from the v1.0 `records` list.
 */
export class LeaderboardStore {
  private readonly platform: PlatformAdapter;
  private readonly optIn: () => boolean;
  private readonly now: () => Date;
  private readonly onWrite: ((ok: boolean) => void) | null;

  private records: LeaderboardRecord[] = [];
  private loaded = false;
  private loadStateValue: LeaderboardLoadState = 'unloaded';
  private writeChain: Promise<void> = Promise.resolve();
  private lastWriteOkValue = true;
  private blocked = false;
  private epoch = 0;
  private idSeq = 0;
  /** Invalid/duplicate rows skipped by the most recent load. */
  private droppedRecordCount = 0;
  /**
   * Migrated v1.1 history rows removed by a cap since the last load/reset.
   * Cumulative rather than per-write so the screen can state how much history
   * was trimmed without racing individual settlements.
   */
  private evictedLegacyCount = 0;
  /** Fixed/practice rows removed by a cap since the last load/reset. */
  private evictedModernCount = 0;
  /** Migrated history rows read by the most recent load (kept, not rewritten). */
  private migratedLegacyCount = 0;
  /**
   * Bumped once per reset. A write queued before the bump still reaches storage
   * (the drain must not fake success), but its late continuation no longer
   * updates post-reset state. A record queued after abort captures the new
   * token, so it persists and reports normally.
   */
  private resetToken = 0;
  /** Highest reset token whose storage wipe completed successfully. */
  private completedResetToken = 0;
  /** A stale write failed while a reset was active; report it only if aborted. */
  private pendingStaleFailure = false;
  private resetSettled: Promise<void> | null = null;
  private settleReset: (() => void) | null = null;

  /** Keys the shell removes during its unified wipe. */
  readonly resetKeys: readonly string[] = [LEADERBOARD_STORAGE_KEY];

  constructor(platform: PlatformAdapter, options?: LeaderboardStoreOptions) {
    this.platform = platform;
    this.optIn = (options && options.optIn) || function () {
      return false;
    };
    this.now = (options && options.now) || function () {
      return new Date();
    };
    this.onWrite = (options && options.onWrite) || null;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  loadState(): LeaderboardLoadState {
    return this.loadStateValue;
  }

  /** Result of the newest finished write (false when only memory accepted it). */
  lastWriteOk(): boolean {
    return this.lastWriteOkValue;
  }

  recordCount(): number {
    return this.records.length;
  }

  /** Rows skipped by the most recent load because they were invalid/duplicated. */
  droppedRecords(): number {
    return this.droppedRecordCount;
  }

  /**
   * Migrated history rows dropped by a storage cap. Reported so the screen can
   * say the archive was trimmed instead of silently erasing old results.
   */
  evictedLegacyRecords(): number {
    return this.evictedLegacyCount;
  }

  /** New rows dropped by the archive cap; a plain "not retained" is not silent. */
  evictedRecords(): number {
    return this.evictedModernCount;
  }

  /**
   * Cold-start-safe trimming notice. The counters are persisted in the same
   * payload as the records, so a restart still reports that history was
   * trimmed instead of quietly forgetting it. `unpersisted` is true when the
   * newest write failed: the counts are then only session-local and must not
   * be presented as saved.
   */
  trimNotice(): LeaderboardTrimNotice {
    return {
      legacy: this.evictedLegacyCount,
      modern: this.evictedModernCount,
      unpersisted: !this.lastWriteOkValue,
    };
  }

  /** History rows carried over from a v1.1 archive (still stored, never ranked). */
  migratedLegacyRecords(): number {
    return this.migratedLegacyCount;
  }

  /**
   * Rows recorded under another rules version (including a version this build
   * does not know). They are preserved verbatim and are never comparable here;
   * the screen should say so instead of hiding or "repairing" them.
   */
  foreignRulesVersionRecords(): number {
    let count = 0;
    for (let i = 0; i < this.records.length; i += 1) {
      const version = this.records[i].rulesVersion;
      if (version !== LEADERBOARD_LEGACY_RULES_VERSION &&
          version !== LEADERBOARD_CURRENT_RULES_VERSION) {
        count += 1;
      }
    }
    return count;
  }

  /** History rows the resident archive holds, regardless of how they were read. */
  legacyRecordCount(): number {
    let count = 0;
    for (let i = 0; i < this.records.length; i += 1) {
      if (this.records[i].rankClass === 'legacy') count += 1;
    }
    return count;
  }

  /** Groups whose scores may be compared (fixed speed, current rules). */
  comparableGroups(): LeaderboardGroupSummary[] {
    return this.groups().filter(isComparableGroup);
  }

  /**
   * True when at least one comparable group exists. The screen uses this to
   * show "no comparable fixed-speed result yet" instead of substituting a
   * legacy or practice score.
   */
  hasComparableRecords(): boolean {
    return this.comparableGroups().length > 0;
  }

  /** Sorted archive copy for diagnostics and tests, newest first. */
  allRecords(): LeaderboardRecord[] {
    return this.records.slice();
  }

  /** Group summaries, newest group first. */
  groups(): LeaderboardGroupSummary[] {
    return buildGroups(this.records).map(function (group) {
      return {
        id: group.id,
        mapId: group.mapId,
        mapName: group.mapName,
        seed: group.seed,
        difficulty: group.difficulty,
        durationSeconds: group.durationSeconds,
        mode: group.mode,
        betrayalLevel: group.betrayalLevel,
        ruleKey: group.ruleKey,
        rankClass: group.rankClass,
        speed: group.speed,
        rulesVersion: group.rulesVersion,
        factionCount: group.factionCount,
        recordCount: group.recordCount,
        bestScore: group.bestScore,
        latestFinishedAt: group.latestFinishedAt,
      };
    });
  }

  /** One group with its records ranked inside the group. */
  group(groupId: string): LeaderboardGroup | null {
    const groups = buildGroups(this.records);
    for (let i = 0; i < groups.length; i += 1) {
      if (groups[i].id === groupId) return groups[i];
    }
    return null;
  }

  /**
   * Loads the local archive. Missing data is a first launch; an unknown
   * version or broken payload is reported as corrupt and left untouched.
   * A load interrupted by a reset waits for that reset to settle and reads
   * again, so an aborted reset cannot leave the screen loading forever.
   */
  async load(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (this.blocked) {
        await this.waitForResetSettlement();
        continue;
      }
      const epoch = this.epoch;
      try {
        const raw = await this.platform.storage.readRaw(LEADERBOARD_STORAGE_KEY);
        if (epoch !== this.epoch) continue;
        if (raw.state === 'missing') {
          this.records = [];
          this.droppedRecordCount = 0;
          this.evictedLegacyCount = 0;
          this.migratedLegacyCount = 0;
          this.evictedModernCount = 0;
          this.loadStateValue = 'missing';
        } else if (raw.state === 'corrupt') {
          this.records = [];
          this.droppedRecordCount = 0;
          this.evictedLegacyCount = 0;
          this.migratedLegacyCount = 0;
          this.evictedModernCount = 0;
          this.loadStateValue = 'corrupt';
        } else {
          const parsed = readPayload(raw.value);
          if (!parsed) {
            this.records = [];
            this.droppedRecordCount = 0;
            this.evictedLegacyCount = 0;
            this.migratedLegacyCount = 0;
            this.evictedModernCount = 0;
            this.loadStateValue = 'corrupt';
          } else {
            const pruned = pruneRecords(parsed.records);
            this.records = pruned.records;
            this.droppedRecordCount = parsed.dropped;
            // Persisted lifetime counters + anything this load had to trim
            // (e.g. a payload written by a build with larger budgets). The sum
            // is deterministic, so a load that is never followed by a write
            // does not double-count on the next cold start.
            this.evictedLegacyCount = parsed.evictedLegacy + pruned.evictedLegacy;
            this.evictedModernCount = parsed.evictedModern + pruned.evictedModern;
            this.migratedLegacyCount = parsed.migratedLegacy;
            this.loadStateValue = 'ok';
          }
        }
      } catch (error) {
        if (epoch !== this.epoch) continue;
        // Keep any resident records; report that this read could not refresh them.
        this.loadStateValue = 'error';
      }
      this.loaded = true;
      return;
    }
    if (!this.loaded) {
      this.loadStateValue = 'error';
      this.loaded = true;
    }
  }

  /**
   * Accepts one finished match. Refusals never mutate memory or storage:
   * a failed/corrupt read blocks writes until a successful reload or reset,
   * so an unreadable payload is never overwritten silently.
   */
  record(
    match: LeaderboardMatch,
    submission: LeaderboardSubmission
  ): LeaderboardRecordResult {
    if (this.blocked) return { ok: false, reason: 'blocked' };
    if (!this.loaded) return { ok: false, reason: 'not_loaded' };
    if (this.loadStateValue === 'error') {
      return { ok: false, reason: 'storage_unavailable' };
    }
    if (this.loadStateValue === 'corrupt') {
      return { ok: false, reason: 'storage_corrupt' };
    }

    let optedIn = false;
    try {
      optedIn = this.optIn() === true;
    } catch (error) {
      optedIn = false;
    }
    if (!optedIn) return { ok: false, reason: 'opted_out' };

    if (match && match.mode === 'versus') return { ok: false, reason: 'versus' };
    if (!match || match.status !== 'ended' || !match.result) {
      return { ok: false, reason: 'unfinished' };
    }

    const built = this.buildRecord(match, submission);
    if (!built) return { ok: false, reason: 'invalid' };

    this.records.push(built);
    const pruned = pruneRecords(this.records);
    this.records = pruned.records;
    this.loadStateValue = 'ok';
    // The queued payload contains only sanitized rows, so old bad rows are gone.
    this.droppedRecordCount = 0;
    this.evictedLegacyCount += pruned.evictedLegacy;
    this.evictedModernCount += pruned.evictedModern;
    this.persist();

    const group = this.group(leaderboardGroupId(built));
    let rank = -1;
    if (group) {
      for (let i = 0; i < group.records.length; i += 1) {
        if (group.records[i].id === built.id) {
          rank = i + 1;
          break;
        }
      }
    }
    return {
      ok: true,
      record: built,
      retained: rank > 0,
      rank: rank > 0 ? rank : undefined,
      evicted: rank <= 0,
    };
  }

  /** Resolves after every queued archive write has settled. */
  async flushWrites(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Reset phase 1: reject new records, invalidate in-flight loads, then drain
   * the write chain. A new token means a drained write's late continuation can
   * no longer change post-reset state; the write itself is never skipped.
   */
  async beginReset(): Promise<void> {
    if (!this.resetSettled) {
      this.resetSettled = new Promise<void>((resolve) => {
        this.settleReset = resolve;
      });
    }
    this.resetToken += 1;
    this.blocked = true;
    this.epoch += 1;
    await this.flushWrites();
  }

  /** Reset phase 2 (all media removed): drop memory and accept new records. */
  completeReset(): void {
    this.records = [];
    this.droppedRecordCount = 0;
    this.evictedLegacyCount = 0;
    this.evictedModernCount = 0;
    this.migratedLegacyCount = 0;
    this.loaded = true;
    this.loadStateValue = 'missing';
    this.lastWriteOkValue = true;
    this.idSeq = 0;
    this.finishReset(true);
  }

  /** Reset cancelled: keep resident records and resume recording. */
  abortReset(): void {
    this.finishReset(false);
  }

  private finishReset(completed: boolean): void {
    this.blocked = false;
    const staleFailure = this.pendingStaleFailure;
    this.pendingStaleFailure = false;
    if (completed) this.completedResetToken = this.resetToken;
    const settle = this.settleReset;
    this.settleReset = null;
    this.resetSettled = null;
    if (settle) settle();
    // A completed wipe owns the new archive: an old write's failure is
    // irrelevant. An aborted reset keeps the old archive, so its genuine write
    // failure must still reach the player.
    if (!completed && staleFailure) this.finishWrite(false);
  }

  private async waitForResetSettlement(): Promise<void> {
    const pending = this.resetSettled;
    if (pending) await pending;
  }

  private buildRecord(
    match: LeaderboardMatch,
    submission: LeaderboardSubmission
  ): LeaderboardRecord | null {
    if (!submission || typeof submission !== 'object') return null;

    const mode: LeaderboardMode =
      submission.matchKind === 'challenge' ? 'challenge' : 'solo';
    const nickname = cleanText(submission.nickname, LEADERBOARD_MAX_NICKNAME_CHARS);
    if (!nickname) return null;
    if (submission.matchKind !== undefined && submission.matchKind !== 'solo' && submission.matchKind !== 'challenge') {
      return null;
    }

    const durationSeconds = Math.round(match.durationTicks / TICKS_PER_SECOND);
    if (!isSupportedDuration(durationSeconds)) return null;
    if (match.durationTicks !== durationSeconds * TICKS_PER_SECOND) return null;

    const mapId = cleanText(match.mapId, LEADERBOARD_MAX_MAP_ID_CHARS);
    const mapName = cleanText(match.mapName, LEADERBOARD_MAX_MAP_NAME_CHARS);
    if (!mapId || !mapName) return null;
    if (!isIntegerInRange(match.seed, 1, LEADERBOARD_MAX_SEED)) return null;
    if (!isDifficulty(match.difficulty)) return null;
    if (!isResult(match.result)) return null;
    if (!isIntegerInRange(match.tick, 0, match.durationTicks)) return null;

    // Faction dimension. The match view is the source of truth; a submission
    // may restate the same count but never a different one — accepting a
    // conflicting restatement would let a mislabeled row rank inside a group
    // of another size. Anything outside 2/3/4 is refused outright.
    if (
      match.factionCount !== undefined &&
      !isSupportedFactionCount(match.factionCount)
    ) {
      return null;
    }
    if (
      submission.factionCount !== undefined &&
      !isSupportedFactionCount(submission.factionCount)
    ) {
      return null;
    }
    if (
      match.factionCount !== undefined &&
      submission.factionCount !== undefined &&
      match.factionCount !== submission.factionCount
    ) {
      return null;
    }
    const factionCount =
      submission.factionCount !== undefined
        ? submission.factionCount
        : match.factionCount !== undefined
          ? match.factionCount
          : LEADERBOARD_DEFAULT_FACTION_COUNT;

    const score = match.scores ? match.scores.player : null;
    if (!isIntegerInRange(score, 0, LEADERBOARD_MAX_SCORE)) return null;

    const level = submission.betrayalLevel;
    if (!isIntegerInRange(level, 0, BETRAYAL_MAX_LEVEL)) return null;
    if (mode === 'challenge' && level !== LEADERBOARD_CHALLENGE_BETRAYAL_LEVEL) return null;

    let challengeScore: number | undefined;
    if (mode === 'challenge' && submission.challengeScore !== undefined && submission.challengeScore !== null) {
      if (!isIntegerInRange(submission.challengeScore, 0, LEADERBOARD_MAX_CHALLENGE_SCORE)) return null;
      challengeScore = submission.challengeScore;
    }

    // Speed dimension. A solo match from a caller that predates speed selection
    // keeps the historical 1x pace (v1.1 had exactly one speed). A challenge is
    // different: without the codec's speed/fairness the settings are incomplete,
    // so it can only ever be practice — never a comparable fixed result.
    const speedChanged = submission.speedChanged === true;
    let speed: number | null = null;
    if (submission.speed !== undefined && submission.speed !== null) {
      if (!isSupportedSpeed(submission.speed)) return null;
      speed = submission.speed;
    } else if (mode === 'solo') {
      speed = 1;
    }

    let rulesVersion: number = LEADERBOARD_CURRENT_RULES_VERSION;
    if (submission.rulesVersion !== undefined) {
      if (
        !isIntegerInRange(
          submission.rulesVersion,
          LEADERBOARD_MIN_RULES_VERSION,
          LEADERBOARD_MAX_RULES_VERSION
        )
      ) {
        return null;
      }
      rulesVersion = submission.rulesVersion;
    }

    if (submission.fairness !== undefined &&
        submission.fairness !== 'fair' &&
        submission.fairness !== 'practice') {
      return null;
    }

    // Fixed requires every fairness input at once:
    //   - a known fixed speed and no mid-match switch;
    //   - comparable rules for both sides.
    //
    // A challenge is comparable only when its code declared itself fair; a
    // code that was minted as practice can never be promoted to a rank here.
    // A solo match is different in kind: its betrayal level is part of the
    // group key, so a Lv.2 run is only ever compared with another Lv.2 run.
    // The shell's `fairness` therefore governs challenge comparability; on a
    // solo row it is accepted but does not demote the row, otherwise every
    // Lv.1+ solo result would silently stop ranking against its own peers.
    //
    // The rules version is deliberately NOT part of this decision. A result
    // from another known version is a genuine fixed-speed result of its own
    // generation: it stays `fixed` (with its version in the group key) and
    // `isComparableGroup()` refuses to rank it until the current version
    // matches. That keeps such history visible and re-rankable instead of
    // demoting it to a permanent practice bucket.
    const comparableRules =
      mode === 'solo' ? true : submission.fairness === 'fair';
    const rankClass: LeaderboardRankClass =
      speed !== null && !speedChanged && comparableRules ? 'fixed' : 'practice';
    if (rankClass === 'practice' && rulesVersion === LEADERBOARD_LEGACY_RULES_VERSION) {
      // A freshly recorded practice row still belongs to a known rule set; only
      // migrated v1 rows may claim "no rules version".
      rulesVersion = LEADERBOARD_CURRENT_RULES_VERSION;
    }

    const finishedAt = this.now().toISOString();
    if (!isFinite(Date.parse(finishedAt))) return null;

    return {
      id: this.nextId(finishedAt),
      finishedAt: finishedAt,
      nickname: nickname,
      avatarId: cleanAvatarId(submission.avatarId),
      mapId: mapId,
      mapName: mapName,
      seed: match.seed,
      difficulty: match.difficulty,
      durationSeconds: durationSeconds,
      mode: mode,
      betrayalLevel: level,
      result: match.result,
      score: score,
      elapsedSeconds: Math.floor(match.tick / TICKS_PER_SECOND),
      speed: speed,
      rulesVersion: rulesVersion,
      speedChanged: speedChanged,
      rankClass: rankClass,
      factionCount: factionCount,
      challengeScore: challengeScore,
    };
  }

  private nextId(finishedAt: string): string {
    let candidate = '';
    do {
      candidate = finishedAt + '-' + this.idSeq.toString(36);
      this.idSeq += 1;
    } while (this.records.some(function (record) {
      return record.id === candidate;
    }));
    return candidate;
  }

  private persist(): void {
    if (this.blocked) return;
    const payload: LeaderboardPayload = {
      schemaVersion: LEADERBOARD_SCHEMA_VERSION,
      records: this.records.slice(),
      // Counters are persisted so a cold start still reports that rows were
      // trimmed. They are informational only; ranking ignores them.
      evictedLegacy: this.evictedLegacyCount,
      evictedModern: this.evictedModernCount,
    };
    const storage = this.platform.storage;
    const self = this;
    const token = this.resetToken;
    this.writeChain = this.writeChain
      .then(function () {
        // The drained write always reaches storage; only its late state
        // continuation is stale after a reset token bump.
        return storage.write(LEADERBOARD_STORAGE_KEY, payload);
      })
      .then(
        function (ok) {
          self.finishWriteForToken(token, ok !== false);
        },
        function () {
          self.finishWriteForToken(token, false);
        }
      );
  }

  /**
   * Stale-success is always ignored so an old write cannot mask the new
   * archive. A stale failure must still be reported while the reset that
   * invalidated it was aborted; after a completed wipe it is discarded.
   */
  private finishWriteForToken(token: number, ok: boolean): void {
    if (token === this.resetToken) {
      this.finishWrite(ok);
      return;
    }
    if (ok) return;
    if (this.blocked) {
      this.pendingStaleFailure = true;
      return;
    }
    if (this.completedResetToken > token) return;
    this.finishWrite(false);
  }

  private finishWrite(ok: boolean): void {
    this.lastWriteOkValue = ok;
    if (this.onWrite) this.onWrite(ok);
  }
}
