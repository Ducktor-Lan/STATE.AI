/**
 * Local commander archive: nickname + preset avatar (the "login"), gold and
 * the purchased betrayal level. Everything lives in the platform key-value
 * store under the shared `state-conquest:` prefix.
 *
 * Loading is strict on purpose: a stored archive that does not match the
 * schema is reported as corrupted (load() returns null AND corrupted() is
 * true) instead of being silently repaired into a fabricated commander.
 * loadState() separates a schema-invalid archive from a storage read failure,
 * and a corrupted payload is copied to the backup key before create() replaces
 * it, so gold and betrayal progress are never destroyed silently.
 */
import type { PlatformAdapter } from '../platform';
import {
  BETRAYAL_LEVEL_PRICES,
  BETRAYAL_MAX_LEVEL,
  GOLD_DEFEAT_REWARD,
  GOLD_DRAW_REWARD_RATIO,
  GOLD_REWARDS,
} from '../config/balance';
import type { Difficulty, ResultKind } from './view-model';
import {
  addExperience,
  dailyCheckInFor,
  localDateKey,
  isValidLocalDateKey,
  levelForExperience,
  matchExperienceFor,
  MAX_CHECK_IN_STREAK,
  MAX_COMMANDER_LEVEL,
} from '../config/progression';
import { defaultGrowthState, normalizeGrowthState } from './progression';
import type { CheckInState, GrowthState } from './progression';
import { isPlayerColorId, normalizePlayerColorId } from './player-colors';
import type { PlayerColorId } from './player-colors';

export type BetrayalLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type MatchMode = 'solo' | 'versus';

export interface ProfileRecord {
  wins: number;
  losses: number;
  draws: number;
}

export interface ProfileStats extends ProfileRecord {
  /**
   * Independent counters per tier. A pre-v1.3 archive has only the three
   * legacy keys and gains a zeroed `casual` record on load, without being
   * rewritten; every archive this store exposes carries all four.
   */
  byDifficulty: Record<Difficulty, ProfileRecord>;
}

export interface CommanderProfile {
  /** The profile key remains schema 1 so every v1.x archive stays readable. */
  schemaVersion: 1;
  nickname: string;
  avatarId: string;
  gold: number;
  betrayalLevel: BetrayalLevel;
  stats: ProfileStats;
  /** v2.0 local commander progression; absent only on an old archive fixture. */
  experience?: number;
  commanderLevel?: number;
  checkIn?: CheckInState;
  playerColorId?: PlayerColorId;
  /**
   * v1.3 first-run marker. Only an archive created while no profile existed
   * (`loadState() === 'missing'`) is pending. A pre-v1.3 archive has no field
   * and reads as false: upgrading never asks an existing player to onboard.
   * A present but non-boolean value is corruption, like every other field.
   */
  onboardingPending?: boolean;
  createdAt: string;
}

export interface CommanderAvatar {
  id: string;
  name: string;
  glyph: string;
}

/** Eight presets drawn purely with CSS + one glyph; no external images. */
export const PROFILE_AVATARS: CommanderAvatar[] = [
  { id: 'eagle', name: '鹰', glyph: '鹰' },
  { id: 'wolf', name: '狼', glyph: '狼' },
  { id: 'tiger', name: '虎', glyph: '虎' },
  { id: 'bear', name: '熊', glyph: '熊' },
  { id: 'fox', name: '狐', glyph: '狐' },
  { id: 'lion', name: '狮', glyph: '狮' },
  { id: 'serpent', name: '蛇', glyph: '蛇' },
  { id: 'raven', name: '鸦', glyph: '鸦' },
];

export const DEFAULT_AVATAR_ID = PROFILE_AVATARS[0].id;
export const NICKNAME_MIN_LENGTH = 1;
export const NICKNAME_MAX_LENGTH = 12;

const PROFILE_KEY = 'profile';
/** Last raw archive that failed validation, kept before create() overwrites it. */
export const PROFILE_BACKUP_KEY = 'profile-backup';
/** Every key owned by this store; the shell wipes exactly these keys. */
export const PROFILE_STORAGE_KEYS: readonly string[] = [PROFILE_KEY, PROFILE_BACKUP_KEY];
const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'casual'];
/** The three tiers every pre-v1.3 archive is guaranteed to carry. */
const LEGACY_DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];

/**
 * Result of the last load: a missing key is a first launch, 'corrupt' means
 * stored data failed JSON/schema checks, and 'error' means storage itself threw.
 */
export type ProfileLoadState = 'missing' | 'ok' | 'corrupt' | 'error';

export type ProfileFailure =
  | 'nickname'
  | 'avatar'
  | 'invalid_color'
  | 'no_profile'
  | 'not_loaded'
  | 'storage_unavailable'
  | 'profile_exists'
  | 'reset_in_progress'
  | 'max_level'
  | 'insufficient_gold'
  | 'skipped_level'
  | 'invalid_level'
  | 'already_claimed'
  | 'date_rollback'
  | 'invalid_date';

export interface ProfileResult {
  ok: boolean;
  reason?: ProfileFailure;
  message?: string;
}

export interface PurchaseResult extends ProfileResult {
  /** Price of the attempted level (0 when no level was purchasable). */
  price: number;
  /** Betrayal level after the attempt (unchanged on failure). */
  level: BetrayalLevel;
  /** Gold balance after the attempt (unchanged on failure). */
  gold: number;
}

/** Accepted gains are resident immediately; saveStatus() reports persistence. */
export interface GrowthSettlement extends ProfileResult {
  /** Gold and XP gained by this action (zero when refused). */
  gold: number;
  experience: number;
  totalExperience: number;
  level: number;
  levelsGained: number;
}

export interface CheckInResult extends GrowthSettlement {
  streak: number;
  date: string;
}

/** 1..12 characters after trimming; returns an explicit error or null. */
export function validateNickname(value: unknown): string | null {
  if (typeof value !== 'string') return '昵称不能为空（1~12 个字符）';
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  if (length < NICKNAME_MIN_LENGTH) return '昵称不能为空（1~12 个字符）';
  if (length > NICKNAME_MAX_LENGTH) return '昵称最多 ' + NICKNAME_MAX_LENGTH + ' 个字符';
  return null;
}

export function validateAvatarId(value: unknown): string | null {
  if (typeof value !== 'string') return '请选择一个头像';
  for (let i = 0; i < PROFILE_AVATARS.length; i += 1) {
    if (PROFILE_AVATARS[i].id === value) return null;
  }
  return '请选择一个预设头像';
}

export function avatarById(id: string): CommanderAvatar | null {
  for (let i = 0; i < PROFILE_AVATARS.length; i += 1) {
    if (PROFILE_AVATARS[i].id === id) return PROFILE_AVATARS[i];
  }
  return null;
}

export function normalizeNickname(value: string): string {
  return value.trim();
}

function emptyRecord(): ProfileRecord {
  return { wins: 0, losses: 0, draws: 0 };
}

function emptyByDifficulty(): Record<Difficulty, ProfileRecord> {
  return {
    easy: emptyRecord(),
    normal: emptyRecord(),
    hard: emptyRecord(),
    casual: emptyRecord(),
  };
}

function emptyStats(): ProfileStats {
  return {
    wins: 0,
    losses: 0,
    draws: 0,
    byDifficulty: emptyByDifficulty(),
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function readCount(value: unknown): number | null {
  return isCount(value) ? value : null;
}

function readRecord(value: unknown): ProfileRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const wins = readCount(raw.wins);
  const losses = readCount(raw.losses);
  const draws = readCount(raw.draws);
  if (wins === null || losses === null || draws === null) return null;
  return { wins: wins, losses: losses, draws: draws };
}

function readStats(value: unknown): ProfileStats | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const totals = readRecord(raw);
  if (!totals) return null;
  const byRaw = raw.byDifficulty;
  if (!byRaw || typeof byRaw !== 'object' || Array.isArray(byRaw)) return null;
  const bySource = byRaw as Record<string, unknown>;
  const byDifficulty = emptyByDifficulty();

  // The three v1.0/v1.1/v1.2 tiers are mandatory on every archive.
  for (let i = 0; i < LEGACY_DIFFICULTIES.length; i += 1) {
    const record = readRecord(bySource[LEGACY_DIFFICULTIES[i]]);
    if (!record) return null;
    byDifficulty[LEGACY_DIFFICULTIES[i]] = record;
  }

  // v1.3 casual. A pre-v1.3 archive simply has no key: that is the documented
  // migration and the tier starts at zero in memory (the payload is not
  // rewritten by a read). A key that exists but is not a valid counter record
  // is corruption, exactly like the legacy tiers — never silently repaired.
  if (hasOwn(bySource, 'casual')) {
    const casual = readRecord(bySource.casual);
    if (!casual) return null;
    byDifficulty.casual = casual;
  }

  // Totals must agree with every tier, including the migrated casual zero.
  // A mismatch means the archive was hand-edited or half-written.
  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (let i = 0; i < DIFFICULTIES.length; i += 1) {
    const record = byDifficulty[DIFFICULTIES[i]];
    wins += record.wins;
    losses += record.losses;
    draws += record.draws;
  }
  if (totals.wins !== wins || totals.losses !== losses || totals.draws !== draws) {
    return null;
  }
  return {
    wins: wins,
    losses: losses,
    draws: draws,
    byDifficulty: byDifficulty,
  };
}

function readGrowth(raw: Record<string, unknown>): GrowthState | null {
  const hasGrowthField =
    hasOwn(raw, 'experience') ||
    hasOwn(raw, 'commanderLevel') ||
    hasOwn(raw, 'checkIn') ||
    hasOwn(raw, 'playerColorId');
  if (!hasGrowthField) return defaultGrowthState();

  const experience = hasOwn(raw, 'experience') ? readCount(raw.experience) : 0;
  if (experience === null) return null;
  const derivedLevel = levelForExperience(experience);
  if (hasOwn(raw, 'commanderLevel')) {
    // This cached compatibility field may reflect an older XP threshold table.
    // Validate its shape and range, then derive the current level from XP.
    if (
      !isCount(raw.commanderLevel) ||
      raw.commanderLevel < 1 ||
      raw.commanderLevel > MAX_COMMANDER_LEVEL
    ) {
      return null;
    }
  }
  if (hasOwn(raw, 'playerColorId') && !isPlayerColorId(raw.playerColorId)) return null;

  let checkIn: CheckInState = { lastDate: null, streak: 0, total: 0 };
  if (hasOwn(raw, 'checkIn')) {
    const value = raw.checkIn;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    if (!hasOwn(source, 'lastDate') || !hasOwn(source, 'streak') || !hasOwn(source, 'total')) {
      return null;
    }
    const lastDate = source.lastDate;
    if (lastDate !== null && !isValidLocalDateKey(lastDate)) return null;
    const streak = readCount(source.streak);
    const total = readCount(source.total);
    if (
      streak === null ||
      streak > MAX_CHECK_IN_STREAK ||
      total === null ||
      total < streak
    ) return null;
    if ((lastDate === null && streak !== 0) || (lastDate !== null && streak === 0)) {
      return null;
    }
    checkIn = {
      lastDate: lastDate,
      streak: streak,
      total: total,
    };
  }

  return {
    experience: experience,
    commanderLevel: derivedLevel,
    checkIn: checkIn,
    playerColorId: normalizePlayerColorId(raw.playerColorId),
  };
}

/**
 * Structural validation only: rejects anything that does not match the
 * documented shape so the caller can report a corrupted archive. It does not
 * detect tampering — a well-formed but hand-edited archive is accepted.
 */
export function sanitizeProfile(value: unknown): CommanderProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return null;

  const nickname = typeof raw.nickname === 'string' ? raw.nickname.trim() : '';
  if (validateNickname(nickname) !== null) return null;
  if (validateAvatarId(raw.avatarId) !== null) return null;

  const gold = readCount(raw.gold);
  if (gold === null) return null;
  const level = readCount(raw.betrayalLevel);
  if (level === null || level > BETRAYAL_MAX_LEVEL) return null;
  const stats = readStats(raw.stats);
  if (!stats) return null;
  const growth = readGrowth(raw);
  if (!growth) return null;
  if (typeof raw.createdAt !== 'string' || raw.createdAt.length === 0) return null;

  // v1.3 first-run marker. Absent is the pre-v1.3 shape and means "existing
  // player" (false); when present it must be a real boolean, otherwise the
  // field was damaged and the strict archive rule applies.
  let onboardingPending = false;
  if (hasOwn(raw, 'onboardingPending')) {
    if (typeof raw.onboardingPending !== 'boolean') return null;
    onboardingPending = raw.onboardingPending;
  }

  return {
    schemaVersion: 1,
    nickname: nickname,
    avatarId: raw.avatarId as string,
    gold: gold,
    betrayalLevel: level as BetrayalLevel,
    stats: stats,
    experience: growth.experience,
    commanderLevel: growth.commanderLevel,
    checkIn: growth.checkIn,
    playerColorId: growth.playerColorId,
    onboardingPending: onboardingPending,
    createdAt: raw.createdAt,
  };
}

/** Draw reward derived from the win reward: 30%, rounded half-up. */
export function drawGoldFor(winReward: number): number {
  return Math.round(winReward * GOLD_DRAW_REWARD_RATIO);
}

/** Gold earned by one result; 0 in versus mode. Pure, used by UI + tests. */
export function goldRewardFor(
  result: ResultKind,
  difficulty: Difficulty,
  mode: MatchMode = 'solo'
): number {
  if (mode !== 'solo') return 0;
  if (result === 'win') return GOLD_REWARDS[difficulty];
  if (result === 'draw') return drawGoldFor(GOLD_REWARDS[difficulty]);
  return GOLD_DEFEAT_REWARD;
}

export function betrayalPriceFor(level: number): number | null {
  if (!isCount(level) || level < 1 || level > BETRAYAL_MAX_LEVEL) return null;
  return BETRAYAL_LEVEL_PRICES[level as 1 | 2 | 3 | 4 | 5];
}

function resultField(result: ResultKind): 'wins' | 'losses' | 'draws' {
  if (result === 'win') return 'wins';
  if (result === 'lose') return 'losses';
  return 'draws';
}

function withResult(
  stats: ProfileStats,
  result: ResultKind,
  difficulty: Difficulty
): ProfileStats {
  const field = resultField(result);
  const byDifficulty: Record<Difficulty, ProfileRecord> = {
    easy: { ...stats.byDifficulty.easy },
    normal: { ...stats.byDifficulty.normal },
    hard: { ...stats.byDifficulty.hard },
    casual: { ...stats.byDifficulty.casual },
  };
  byDifficulty[difficulty][field] += 1;
  const next: ProfileStats = {
    wins: stats.wins,
    losses: stats.losses,
    draws: stats.draws,
    byDifficulty: byDifficulty,
  };
  next[field] += 1;
  return next;
}

/**
 * The single owner of the commander archive. Reads/writes never block the UI:
 * writes go through one serialized chain (so SDK storage sees them in order),
 * while the in-memory profile always reflects the newest accepted change. The
 * newest write result is exposed through lastWriteOk() so the UI can tell the
 * player when this environment cannot persist the archive.
 */
export class ProfileStore {
  private readonly platform: PlatformAdapter;
  private readonly onWrite: ((ok: boolean) => void) | null;
  private profile: CommanderProfile | null = null;
  private loaded = false;
  private corruptedFlag = false;
  private loadStateValue: ProfileLoadState = 'missing';
  /** Raw stored payload that failed validation, captured for create() backup. */
  private pendingBackup: string | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private lastWriteOkValue = true;
  private pendingWriteCount = 0;
  /** Blocks new writes while the shell wipes storage. */
  private writesSuspended = false;
  /**
   * Bumped when a wipe starts (in-flight loads) and after the write queue drains
   * (queued writes). Pre-wipe writes still land before the delete, so a failed
   * reset leaves the archive as it was; post-drain writes cannot be resurrected.
   */
  private loadEpoch = 0;
  private writeEpoch = 0;
  /**
   * Identifies the newest reset attempt. A beginReset() continuation that
   * resumes after abortReset()/a newer beginReset() must not bump writeEpoch,
   * otherwise writes accepted after the abort would be silently skipped.
   */
  private resetToken = 0;

  constructor(platform: PlatformAdapter, onWrite?: (ok: boolean) => void) {
    this.platform = platform;
    this.onWrite = onWrite || null;
  }

  current(): CommanderProfile | null {
    return this.profile;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** True when the last load found stored data that failed the schema check. */
  corrupted(): boolean {
    return this.corruptedFlag;
  }

  /** Why the last load produced no profile ('ok' when one was loaded). */
  loadState(): ProfileLoadState {
    return this.loadStateValue;
  }

  /**
   * True while a corrupt archive's raw payload still needs a durable backup
   * before the profile key may be replaced (a failed backup write retains it).
   */
  hasPendingBackup(): boolean {
    return this.pendingBackup !== null;
  }

  /**
   * Retries a backup+archive write that failed (for example the create that
   * replaced a corrupt archive whose backup could not be persisted). Ordinary
   * mutations also retry automatically: persist() keeps reusing the retained
   * backup until it succeeds, so the original key is never overwritten first.
   * Returns false when there is no resident archive or a wipe owns the store;
   * in both cases nothing is queued and a retained backup is left untouched.
   */
  retryPersist(): boolean {
    if (this.writesSuspended || !this.profile) return false;
    this.persist(this.pendingBackup);
    return true;
  }

  /**
   * True only for an archive created while no profile existed and whose
   * first-run flow has not been finished or skipped. A pre-v1.3 archive has no
   * marker and is always false, so upgrading never onboards an existing player.
   */
  isOnboardingPending(): boolean {
    return this.profile !== null && this.profile.onboardingPending === true;
  }

  /**
   * Clears the first-run marker after the shell's onboarding is finished or
   * skipped. The difficulty the player ended up with is untouched. Old archives
   * are already clear, so this is a no-op for them (no write).
   */
  completeOnboarding(): ProfileResult {
    if (!this.profile) {
      return { ok: false, reason: 'no_profile', message: '尚未建立指挥官档案' };
    }
    if (this.profile.onboardingPending !== true) return { ok: true };
    // A wipe owns storage right now: persist() would drop the write silently.
    // Refuse before mutating so the caller can retry once the wipe settles.
    if (this.writesSuspended) {
      return {
        ok: false,
        reason: 'reset_in_progress',
        message: '正在清除本机存档，请稍后再试',
      };
    }
    this.profile = { ...this.profile, onboardingPending: false };
    this.persist();
    return { ok: true };
  }

  /**
   * Result of the newest finished write. Starts optimistic; becomes false when
   * the environment only accepted the value in session memory or threw.
   */
  lastWriteOk(): boolean {
    return this.lastWriteOkValue;
  }

  /** Reports pending asynchronous persistence without hiding a failed write. */
  saveStatus(): boolean | 'pending' {
    return this.pendingWriteCount > 0 ? 'pending' : this.lastWriteOkValue;
  }

  /** Resolves after every queued write has settled (UI/tests/diagnostics). */
  async flushWrites(): Promise<void> {
    await this.writeChain;
  }

  /**
   * First phase of a wipe: reject new writes, invalidate any in-flight load,
   * then drain the queue. The shell wipes storage after this resolves and
   * calls completeReset() or abortReset() depending on the structured result.
   */
  async beginReset(): Promise<void> {
    const token = (this.resetToken += 1);
    this.writesSuspended = true;
    this.loadEpoch += 1;
    await this.flushWrites();
    // A timeout/abort (or a newer attempt) owns the barrier now. This stale
    // continuation must leave the epoch alone so post-abort writes still land.
    if (token !== this.resetToken) return;
    // Everything queued before the wipe has landed by now; no write is queued
    // while suspended, so any later task must start from the post-wipe epoch.
    this.writeEpoch += 1;
  }

  /** Storage wipe succeeded: drop the resident archive and return to first launch. */
  completeReset(): void {
    this.resetToken += 1;
    this.profile = null;
    this.loaded = true;
    this.corruptedFlag = false;
    this.loadStateValue = 'missing';
    this.pendingBackup = null;
    this.lastWriteOkValue = true;
    this.pendingWriteCount = 0;
    this.writesSuspended = false;
  }

  /** Storage wipe failed or was cancelled: keep the archive and resume writes. */
  abortReset(): void {
    this.resetToken += 1;
    this.writesSuspended = false;
  }

  /**
   * Missing archive -> null. Corrupted archive -> null with corrupted() true,
   * so the UI can tell the player instead of inventing a commander. A storage
   * read failure is reported separately via loadState() === 'error'.
   */
  async load(): Promise<CommanderProfile | null> {
    const epoch = this.loadEpoch;
    try {
      const raw = await this.platform.storage.readRaw(PROFILE_KEY);
      if (epoch !== this.loadEpoch) return this.profile;
      if (raw.state === 'missing') {
        this.profile = null;
        this.corruptedFlag = false;
        this.loadStateValue = 'missing';
        this.pendingBackup = null;
      } else if (raw.state === 'corrupt') {
        this.profile = null;
        this.corruptedFlag = true;
        this.loadStateValue = 'corrupt';
        this.pendingBackup = raw.raw;
      } else {
        const clean = sanitizeProfile(raw.value);
        this.profile = clean;
        this.corruptedFlag = clean === null;
        this.loadStateValue = clean === null ? 'corrupt' : 'ok';
        this.pendingBackup = clean === null ? raw.raw : null;
      }
    } catch (error) {
      if (epoch !== this.loadEpoch) return this.profile;
      this.profile = null;
      this.corruptedFlag = true;
      this.loadStateValue = 'error';
      this.pendingBackup = null;
    }
    this.loaded = true;
    return this.profile;
  }

  create(
    nickname: string,
    avatarId: string,
    playerColorId?: PlayerColorId
  ): ProfileResult {
    // A wipe owns storage: persist() would silently drop the write, after the
    // create had already consumed the retained backup. Refuse before touching
    // either the resident profile or pendingBackup so the same create can be
    // retried once the wipe is aborted (or starts over from 'missing' after a
    // successful wipe).
    if (this.writesSuspended) {
      return {
        ok: false,
        reason: 'reset_in_progress',
        message: '正在清除本机存档，请稍后再试',
      };
    }
    // Creating is only ever allowed from a *confirmed* empty or damaged
    // archive. `loadStateValue` starts as 'missing', so acting before storage
    // answers could overwrite a real archive and mark a returning player as
    // new; a read failure must never be treated as permission to overwrite
    // data that may still exist; and a valid archive must not be replaced
    // through the create path at all (the UI's edit flow owns that).
    if (!this.loaded) {
      return {
        ok: false,
        reason: 'not_loaded',
        message: '档案尚未读取完成，请稍后再试',
      };
    }
    if (this.loadStateValue === 'error') {
      return {
        ok: false,
        reason: 'storage_unavailable',
        message: '档案读取失败，无法覆盖本机数据，请重新读取后再试',
      };
    }
    if (this.loadStateValue === 'ok') {
      return {
        ok: false,
        reason: 'profile_exists',
        message: '已存在指挥官档案，无法重复建立',
      };
    }
    const nameError = validateNickname(nickname);
    if (nameError) return { ok: false, reason: 'nickname', message: nameError };
    const avatarError = validateAvatarId(avatarId);
    if (avatarError) return { ok: false, reason: 'avatar', message: avatarError };
    if (playerColorId !== undefined && !isPlayerColorId(playerColorId)) {
      return { ok: false, reason: 'invalid_color', message: '请选择一个领地颜色' };
    }

    // A completed load makes loadStateValue trustworthy: 'missing' is the only
    // first launch. Rebuilding a corrupted archive is allowed (the damaged raw
    // payload is backed up first) but never hands out the new-player flow.
    const firstRun = this.loadStateValue === 'missing';
    const backup = this.pendingBackup;
    this.profile = {
      schemaVersion: 1,
      nickname: normalizeNickname(nickname),
      avatarId: avatarId,
      gold: 0,
      betrayalLevel: 0,
      stats: emptyStats(),
      experience: 0,
      commanderLevel: 1,
      checkIn: { lastDate: null, streak: 0, total: 0 },
      playerColorId: normalizePlayerColorId(playerColorId),
      // The marker rides in the same profile value, so one write makes the
      // archive and its first-run status durable together.
      onboardingPending: firstRun,
      createdAt: new Date().toISOString(),
    };
    this.corruptedFlag = false;
    this.loadStateValue = 'ok';
    this.pendingBackup = null;
    this.loaded = true;
    this.persist(backup);
    return { ok: true };
  }

  updateIdentity(
    nickname: string,
    avatarId: string,
    playerColorId?: PlayerColorId
  ): ProfileResult {
    if (this.writesSuspended) {
      return {
        ok: false,
        reason: 'reset_in_progress',
        message: '正在清除本机存档，请稍后再试',
      };
    }
    if (!this.profile) {
      return { ok: false, reason: 'no_profile', message: '尚未建立指挥官档案' };
    }
    const nameError = validateNickname(nickname);
    if (nameError) return { ok: false, reason: 'nickname', message: nameError };
    const avatarError = validateAvatarId(avatarId);
    if (avatarError) return { ok: false, reason: 'avatar', message: avatarError };
    if (playerColorId !== undefined && !isPlayerColorId(playerColorId)) {
      return { ok: false, reason: 'invalid_color', message: '请选择一个领地颜色' };
    }

    this.profile = {
      ...this.profile,
      nickname: normalizeNickname(nickname),
      avatarId: avatarId,
      playerColorId: normalizePlayerColorId(
        playerColorId === undefined ? this.profile.playerColorId : playerColorId
      ),
    };
    this.persist();
    return { ok: true };
  }

  /**
   * Applies a finished match to both the old economy and the v2 progression.
   * `options.rewardable` defaults to true. A `false` value (v2.0.0: voluntary
   * resign) still records the result and persists exactly once, but earns no
   * gold and no XP, so the archive schema stays untouched.
   */
  settleMatch(
    result: ResultKind,
    difficulty: Difficulty,
    mode: MatchMode = 'solo',
    options?: { rewardable?: boolean }
  ): GrowthSettlement {
    if (!this.profile || this.writesSuspended) {
      const growth = this.profile ? normalizeGrowthState(this.profile) : defaultGrowthState();
      return {
        ok: false,
        reason: this.writesSuspended ? 'reset_in_progress' : 'no_profile',
        message: this.writesSuspended
          ? '正在清除本机存档，请稍后再试'
          : '尚未建立指挥官档案',
        gold: 0,
        experience: 0,
        totalExperience: growth.experience,
        level: growth.commanderLevel,
        levelsGained: 0,
      };
    }
    const current = this.profile;
    const growth = normalizeGrowthState(current);
    const rewardable = options === undefined || options.rewardable !== false;
    const earnedGold = rewardable ? goldRewardFor(result, difficulty, mode) : 0;
    const earnedExperience =
      rewardable && mode === 'solo' ? matchExperienceFor(result, difficulty) : 0;
    const gained = addExperience(growth, earnedExperience);
    this.profile = {
      ...current,
      gold: current.gold + earnedGold,
      stats: withResult(current.stats, result, difficulty),
      experience: gained.experience,
      commanderLevel: gained.level,
      checkIn: growth.checkIn,
      playerColorId: growth.playerColorId,
    };
    this.persist();
    return {
      ok: true,
      gold: earnedGold,
      experience: gained.experience - growth.experience,
      totalExperience: gained.experience,
      level: gained.level,
      levelsGained: gained.levelsGained,
    };
  }

  /**
   * Legacy economy entry point. Existing callers still receive only gold, while
   * the underlying archive also receives match XP and the derived commander level.
   */
  awardGold(
    result: ResultKind,
    difficulty: Difficulty,
    mode: MatchMode = 'solo'
  ): number {
    return this.settleMatch(result, difficulty, mode).gold;
  }

  /** Claims once per local date. Earlier dates cannot bypass the last claim. */
  claimDailyCheckIn(date: Date = new Date()): CheckInResult {
    if (this.writesSuspended) {
      const growth = this.profile ? normalizeGrowthState(this.profile) : defaultGrowthState();
      return {
        ok: false,
        reason: 'reset_in_progress',
        message: '正在清除本机存档，请稍后再试',
        streak: growth.checkIn.streak,
        gold: 0,
        experience: 0,
        totalExperience: growth.experience,
        level: growth.commanderLevel,
        levelsGained: 0,
        date: localDateKey(date),
      };
    }
    if (!this.profile) {
      return {
        ok: false,
        reason: 'no_profile',
        message: '尚未建立指挥官档案',
        streak: 0,
        gold: 0,
        experience: 0,
        totalExperience: 0,
        level: 1,
        levelsGained: 0,
        date: '',
      };
    }
    const current = this.profile;
    const growth = normalizeGrowthState(current);
    const claim = dailyCheckInFor(growth, date);
    if (!claim.ok) {
      return {
        ok: false,
        reason: claim.reason === 'date_rollback'
          ? 'date_rollback'
          : claim.reason === 'invalid_date' ? 'invalid_date' : 'already_claimed',
        message: claim.reason === 'date_rollback'
          ? '本机日期早于上次签到，请恢复日期后再试'
          : claim.reason === 'invalid_date'
            ? '本机日期无效，请校正日期后再试'
            : '今天已经签到，明天再来领取奖励',
        streak: growth.checkIn.streak,
        gold: 0,
        experience: 0,
        totalExperience: growth.experience,
        level: growth.commanderLevel,
        levelsGained: 0,
        date: claim.date,
      };
    }

    const gained = addExperience(growth, claim.reward.experience);
    const earnedExperience = gained.experience - growth.experience;
    this.profile = {
      ...current,
      gold: current.gold + claim.reward.gold,
      experience: gained.experience,
      commanderLevel: gained.level,
      checkIn: {
        lastDate: claim.date,
        streak: claim.streak,
        total: growth.checkIn.total + 1,
      },
      playerColorId: growth.playerColorId,
    };
    this.persist();
    return {
      ok: true,
      message:
        '签到成功 · 连续 ' + claim.streak + ' 天 · +' + claim.reward.gold + ' 金币 · +' +
        earnedExperience + ' XP',
      streak: claim.streak,
      gold: claim.reward.gold,
      experience: earnedExperience,
      totalExperience: gained.experience,
      level: gained.level,
      levelsGained: gained.levelsGained,
      date: claim.date,
    };
  }

  /**
   * Buys the next betrayal level. `targetLevel` is optional and exists so the
   * sequential rule is explicit: anything other than current + 1 is refused
   * as skipped_level. No mutation on any failure.
   */
  buyBetrayalLevel(targetLevel?: number): PurchaseResult {
    if (this.writesSuspended) {
      return {
        ok: false,
        reason: 'reset_in_progress',
        message: '正在清除本机存档，请稍后再试',
        price: 0,
        level: this.profile ? this.profile.betrayalLevel : 0,
        gold: this.profile ? this.profile.gold : 0,
      };
    }
    if (!this.profile) {
      return {
        ok: false,
        reason: 'no_profile',
        message: '尚未建立指挥官档案',
        price: 0,
        level: 0,
        gold: 0,
      };
    }
    const current = this.profile;
    const gold = current.gold;
    if (current.betrayalLevel >= BETRAYAL_MAX_LEVEL) {
      return {
        ok: false,
        reason: 'max_level',
        message: '策反技能已满级',
        price: 0,
        level: current.betrayalLevel,
        gold: gold,
      };
    }

    const next = current.betrayalLevel + 1;
    const desired = targetLevel === undefined ? next : targetLevel;
    if (!isCount(desired) || desired < 1 || desired > BETRAYAL_MAX_LEVEL) {
      return {
        ok: false,
        reason: 'invalid_level',
        message: '目标等级无效',
        price: 0,
        level: current.betrayalLevel,
        gold: gold,
      };
    }
    if (desired !== next) {
      return {
        ok: false,
        reason: 'skipped_level',
        message: '必须按等级顺序购买，请先解锁 Lv.' + next,
        price: betrayalPriceFor(next) || 0,
        level: current.betrayalLevel,
        gold: gold,
      };
    }

    const price = betrayalPriceFor(desired);
    if (price === null) {
      return {
        ok: false,
        reason: 'invalid_level',
        message: '目标等级无效',
        price: 0,
        level: current.betrayalLevel,
        gold: gold,
      };
    }
    if (gold < price) {
      return {
        ok: false,
        reason: 'insufficient_gold',
        message: '金币不足，还差 ' + (price - gold),
        price: price,
        level: current.betrayalLevel,
        gold: gold,
      };
    }

    const level = desired as BetrayalLevel;
    this.profile = {
      ...current,
      gold: gold - price,
      betrayalLevel: level,
    };
    this.persist();
    return {
      ok: true,
      message: '已解锁策反 Lv.' + level,
      price: price,
      level: level,
      gold: this.profile.gold,
    };
  }

  /**
   * Queues one archive write. The optional backup payload is written first and
   * the profile key is only replaced after that backup was durably accepted:
   * if the backup returns false or rejects, the original key is left untouched
   * and the raw payload is retained so a later write (or retryPersist) tries
   * again. Every write shares one chain: newer snapshots never overtake older
   * ones. The pending backup is read when the task runs, not when it is
   * queued, so a write queued behind a just-failed backup cannot slip past it.
   * beginReset() drains this chain before bumping the epoch, so pre-wipe changes
   * still land; a task that somehow survives the drain is skipped rather than
   * writing after the delete.
   */
  private persist(backupRaw: string | null = null): void {
    if (this.writesSuspended) return;
    const payload = this.profile;
    if (!payload) return;
    const storage = this.platform.storage;
    const self = this;
    this.pendingWriteCount += 1;
    const epoch = this.writeEpoch;
    this.writeChain = this.writeChain
      .then(function () {
        if (epoch !== self.writeEpoch) return true;
        // Resolve at execution time: an earlier task may have just restored a
        // failed backup, which this write must retry before overwriting.
        const backupPayload = backupRaw !== null ? backupRaw : self.pendingBackup;
        if (backupPayload === null) return storage.write(PROFILE_KEY, payload);
        return storage
          .write(PROFILE_BACKUP_KEY, backupPayload)
          .then(
            function (ok) {
              return ok !== false;
            },
            function () {
              return false;
            }
          )
          .then(function (backupOk) {
            if (!backupOk) {
              // No durable backup means no overwrite: keeping the corrupt raw
              // archive is the only way the promised pre-replacement backup can
              // still be retried instead of silently losing the original.
              if (epoch === self.writeEpoch) self.pendingBackup = backupPayload;
              return false;
            }
            if (epoch !== self.writeEpoch) return true;
            self.pendingBackup = null;
            return storage.write(PROFILE_KEY, payload);
          });
      })
      .then(
        function (ok) {
          if (epoch === self.writeEpoch) self.finishWrite(ok !== false);
          else self.pendingWriteCount = Math.max(0, self.pendingWriteCount - 1);
        },
        function () {
          if (epoch === self.writeEpoch) self.finishWrite(false);
          else self.pendingWriteCount = Math.max(0, self.pendingWriteCount - 1);
        }
      );
  }

  private finishWrite(ok: boolean): void {
    this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1);
    this.lastWriteOkValue = ok;
    if (this.onWrite) this.onWrite(ok);
  }
}
