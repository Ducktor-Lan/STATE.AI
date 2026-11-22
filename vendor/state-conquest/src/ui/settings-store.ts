import type { PlatformAdapter } from '../platform';
import { isFactionCount, normalizeFactionCount } from './factions';
import type { FactionCount } from './factions';
import { RANDOM_MAP_ID } from './view-model';
import type { Difficulty, MatchEndReason, MatchMode } from './view-model';

/**
 * v1.2 match speed. The core still advances one fixed tick per unit of game
 * time; the shell scales the real-time accumulator by this factor, so 0.75×
 * takes longer in wall-clock terms and 1.25× finishes sooner.
 */
export type GameSpeed = 0.75 | 1 | 1.25;

/** Recommended first-run speed: a calmer opening match for new players. */
export const DEFAULT_GAME_SPEED: GameSpeed = 0.75;
/** Archives written before v1.2 have no speed field and keep the old 1× pace. */
export const LEGACY_GAME_SPEED: GameSpeed = 1;

export const GAME_SPEEDS: readonly GameSpeed[] = [0.75, 1, 1.25];

export interface GameSpeedOption {
  speed: GameSpeed;
  /** Button face, e.g. "0.75×". */
  label: string;
  /** Short Chinese qualifier shown under the label. */
  name: string;
}

export const GAME_SPEED_OPTIONS: readonly GameSpeedOption[] = [
  { speed: 0.75, label: '0.75×', name: '慢' },
  { speed: 1, label: '1×', name: '标准' },
  { speed: 1.25, label: '1.25×', name: '快' },
];

export function isGameSpeed(value: unknown): value is GameSpeed {
  return value === 0.75 || value === 1 || value === 1.25;
}

/** Invalid values degrade to `fallback` (1× by default), never to a new default. */
export function normalizeGameSpeed(
  value: unknown,
  fallback: GameSpeed = LEGACY_GAME_SPEED
): GameSpeed {
  return isGameSpeed(value) ? value : fallback;
}

export function gameSpeedLabel(speed: GameSpeed): string {
  const option = gameSpeedOption(speed);
  return option ? option.label : '1×';
}

export function gameSpeedOption(speed: GameSpeed): GameSpeedOption | null {
  for (let i = 0; i < GAME_SPEED_OPTIONS.length; i += 1) {
    if (GAME_SPEED_OPTIONS[i].speed === speed) return GAME_SPEED_OPTIONS[i];
  }
  return null;
}

/** Wall-clock seconds a match of `matchSeconds` game time really takes. */
export function actualGameSeconds(matchSeconds: number, speed: GameSpeed): number {
  const safe = typeof matchSeconds === 'number' && isFinite(matchSeconds) && matchSeconds > 0
    ? matchSeconds
    : 0;
  const rate = isGameSpeed(speed) ? speed : LEGACY_GAME_SPEED;
  return Math.ceil(safe / rate);
}

export function formatDurationText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return rest + ' 秒';
  return rest === 0 ? minutes + ' 分' : minutes + ' 分 ' + rest + ' 秒';
}

/**
 * One sentence shared by setup and pause so both screens state the same
 * consequence: slow speed stretches the real match duration.
 */
export function gameSpeedDurationNote(matchSeconds: number, speed: GameSpeed): string {
  const actual = actualGameSeconds(matchSeconds, speed);
  const base = '实际对局约 ' + formatDurationText(actual);
  if (speed === 0.75) return base + '，慢速下耗时更长';
  if (speed === 1.25) return base + '，节奏更快';
  return base + ' · 标准速度';
}

/**
 * Recommended difficulty for a BRAND-NEW archive only. It is deliberately not
 * part of FALLBACK_SETTINGS: upgrading an existing player, or a storage read
 * that falls back to defaults, must never switch anyone to casual. The shell
 * applies it explicitly after a first archive is created.
 */
export const NEW_PROFILE_DIFFICULTY: Difficulty = 'casual';

export interface PersistedSettings {
  tutorialDone: boolean;
  themeId: string;
  durationSeconds: number;
  difficulty: Difficulty;
  /**
   * Local-only leaderboard recording. Defaults to false; the leaderboard module
   * owns the actual entries. Persisting just this switch is enough here.
   */
  leaderboardOptIn: boolean;
  /**
   * v1.2 match speed. Missing (pre-v1.2 archive) reads as 1×; only a brand-new
   * profile gets the recommended 0.75×.
   */
  gameSpeed: GameSpeed;
  /**
   * v1.2 sound switch. Missing/unknown values read as enabled, so both old
   * archives and fresh installs start with sound on.
   */
  soundEnabled: boolean;
  /**
   * v1.4 match size (1 human + N AI, free-for-all). Missing (pre-1.4 archive)
   * reads as the historical 2-faction match; unknown values degrade to 2.
   */
  factionCount: FactionCount;
}

/**
 * Pure first-run value: a new archive recommends casual, everything else
 * (speed, sound, tutorial flag) keeps the current choice. The shell must call
 * this only when ProfileStore reported a missing archive and created one.
 */
export function withNewProfileDifficulty(settings: PersistedSettings): PersistedSettings {
  return { ...settings, difficulty: NEW_PROFILE_DIFFICULTY };
}

export interface MatchRecord {
  at: string;
  result: 'win' | 'lose' | 'draw';
  mapName: string;
  themeId: string;
  difficulty: Difficulty;
  durationSeconds: number;
  playerScore: number;
  enemyScore: number;
  elapsedSeconds: number;
  territories: number;
  /**
   * Optional for backward compatibility: records written before versus
   * existed have no field and are read as 'solo'.
   */
  mode?: MatchMode;
  /**
   * v1.4 match size; absent on records written before multi-faction existed.
   * Old records keep their two-side totals below as the only score source.
   */
  factionCount?: FactionCount;
  /**
   * v1.4 per-faction final scores (`ai3` is 0 outside a 4-faction match).
   * Absent on older records; `playerScore`/`enemyScore` stay authoritative
   * for anything written before v1.4.
   */
  factionScores?: MatchFactionScores;
  /** v2.0 end reason; old records omit it and remain readable. */
  endReason?: MatchEndReason;
  /** True when the match used any diplomatic operation. */
  diplomacyUsed?: boolean;
}

/** Per-faction final scores stored on a v1.4 match record. */
export interface MatchFactionScores {
  player: number;
  ai1: number;
  ai2: number;
  ai3: number;
}

const SETTINGS_KEY = 'settings';
const RECORDS_KEY = 'records';
/** Reserved for the local leaderboard module; a wipe includes it from day one. */
export const LEADERBOARD_KEY = 'leaderboard';
/** Every key owned by this store; the shell wipes exactly these keys. */
export const SETTINGS_STORAGE_KEYS: readonly string[] = [
  SETTINGS_KEY,
  RECORDS_KEY,
  LEADERBOARD_KEY,
];
const MAX_RECORDS = 5;

/**
 * First-launch (and post-wipe) values. `gameSpeed` is the v1.2 recommendation
 * for new players; existing archives are migrated separately in
 * `sanitizeSettings` so they keep their old 1× pace.
 */
export const FALLBACK_SETTINGS: PersistedSettings = {
  tutorialDone: false,
  themeId: RANDOM_MAP_ID,
  durationSeconds: 300,
  difficulty: 'normal',
  leaderboardOptIn: false,
  gameSpeed: DEFAULT_GAME_SPEED,
  soundEnabled: true,
  factionCount: 2,
};

/**
 * Old builds persisted a theme or one of the nine explicit variants. New
 * matches always draw a seeded random map, so those settings migrate to
 * "random" once; match history records keep their original map ids.
 */
function sanitizeThemeId(value: unknown): string {
  if (value === RANDOM_MAP_ID) return RANDOM_MAP_ID;
  return RANDOM_MAP_ID;
}

function isDifficulty(value: unknown): value is Difficulty {
  return value === 'easy' || value === 'normal' || value === 'hard' || value === 'casual';
}

function sanitizeDifficulty(value: unknown): Difficulty {
  return isDifficulty(value) ? value : 'normal';
}

function sanitizeDuration(value: unknown): number {
  return value === 180 || value === 300 || value === 480 ? value : 300;
}

/**
 * Builds a complete settings value from any stored shape. Unknown fields are
 * ignored; every missing legacy field keeps its documented historical value,
 * so loading an old archive never adopts a new-run default (difficulty stays
 * whatever was stored, speed stays 1×, casual is never inferred).
 */
function sanitizeSettings(raw: unknown): PersistedSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...FALLBACK_SETTINGS };
  }
  const source = raw as Record<string, unknown>;
  return {
    tutorialDone: source.tutorialDone === true,
    themeId:
      typeof source.themeId === 'string' && source.themeId.length > 0
        ? sanitizeThemeId(source.themeId)
        : RANDOM_MAP_ID,
    durationSeconds: sanitizeDuration(source.durationSeconds),
    difficulty: sanitizeDifficulty(source.difficulty),
    // v1.0 archives have no field: unknown/missing values become the safe default.
    leaderboardOptIn: source.leaderboardOptIn === true,
    // v1.2: an existing archive without the field keeps the historical 1× pace;
    // only a fresh install (no archive at all) gets the recommended 0.75×.
    gameSpeed: hasOwn(source, 'gameSpeed')
      ? normalizeGameSpeed(source.gameSpeed, LEGACY_GAME_SPEED)
      : LEGACY_GAME_SPEED,
    // Sound has no legacy meaning: anything other than an explicit false is on.
    soundEnabled: source.soundEnabled !== false,
    // v1.4: an existing archive without the field keeps the historical
    // 2-faction match; unknown values degrade to 2 instead of failing.
    factionCount: normalizeFactionCount(source.factionCount),
  };
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function isFiniteScore(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value) && value >= 0;
}

/** Preserved only when every faction total is a real non-negative number. */
function sanitizeFactionScores(raw: unknown): MatchFactionScores | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  if (
    !isFiniteScore(source.player) ||
    !isFiniteScore(source.ai1) ||
    !isFiniteScore(source.ai2) ||
    !isFiniteScore(source.ai3)
  ) {
    return undefined;
  }
  return {
    player: source.player,
    ai1: source.ai1,
    ai2: source.ai2,
    ai3: source.ai3,
  };
}

function sanitizeRecord(raw: MatchRecord): MatchRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.result !== 'win' && raw.result !== 'lose' && raw.result !== 'draw') return null;
  return {
    at: typeof raw.at === 'string' ? raw.at : '',
    result: raw.result,
    mapName: typeof raw.mapName === 'string' ? raw.mapName : '',
    themeId: typeof raw.themeId === 'string' ? raw.themeId : '',
    difficulty: sanitizeDifficulty(raw.difficulty),
    durationSeconds: sanitizeDuration(raw.durationSeconds),
    playerScore: typeof raw.playerScore === 'number' && isFinite(raw.playerScore) ? raw.playerScore : 0,
    enemyScore: typeof raw.enemyScore === 'number' && isFinite(raw.enemyScore) ? raw.enemyScore : 0,
    elapsedSeconds:
      typeof raw.elapsedSeconds === 'number' && isFinite(raw.elapsedSeconds)
        ? Math.max(0, raw.elapsedSeconds)
        : 0,
    territories:
      typeof raw.territories === 'number' && isFinite(raw.territories) ? raw.territories : 0,
    // Missing/unknown values keep the historical solo semantics.
    mode: raw.mode === 'versus' ? 'versus' : 'solo',
    // v1.4 fields are preserved only in their complete, valid shape; an old
    // record (or a corrupt one) simply keeps them absent.
    factionCount: isFactionCount(raw.factionCount) ? raw.factionCount : undefined,
    factionScores: sanitizeFactionScores(raw.factionScores),
    endReason:
      raw.endReason === 'elimination' ||
      raw.endReason === 'timeout' ||
      raw.endReason === 'stalemate' ||
      raw.endReason === 'resign'
        ? raw.endReason
        : undefined,
    diplomacyUsed: raw.diplomacyUsed === true ? true : undefined,
  };
}

/**
 * Thin, non-blocking wrapper over the platform key-value store. Every read and
 * write failure degrades to session memory, so the game never blocks on storage.
 *
 * Settings and record writes share one serialized chain (newest snapshot last),
 * and the chain is flushable so a wipe can drain it. Writes queued before a
 * wipe carry an old epoch and are discarded instead of resurrecting old data.
 */
export class SettingsStore {
  private readonly platform: PlatformAdapter;
  private readonly onWrite: ((ok: boolean) => void) | null;
  private settings: PersistedSettings = { ...FALLBACK_SETTINGS };
  private records: MatchRecord[] = [];
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private lastWriteOkValue = true;
  private writesSuspended = false;
  /** In-flight loads captured an older value and are discarded on reset. */
  private loadEpoch = 0;
  /** Write tasks captured an older value; bumped only after the queue drains. */
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

  current(): PersistedSettings {
    return this.settings;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  recentRecords(): MatchRecord[] {
    return this.records.slice();
  }

  /** Result of the newest finished settings/records write. */
  lastWriteOk(): boolean {
    return this.lastWriteOkValue;
  }

  /** Resolves after every queued settings/records write has settled. */
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
    // Queued pre-wipe writes landed during the flush; anything later starts
    // from a fresh epoch and cannot belong to the old snapshot.
    this.writeEpoch += 1;
  }

  /** Storage wipe succeeded: restore first-launch settings and empty records. */
  completeReset(): void {
    this.resetToken += 1;
    this.settings = { ...FALLBACK_SETTINGS };
    this.records = [];
    this.loaded = true;
    this.lastWriteOkValue = true;
    this.writesSuspended = false;
  }

  /** Storage wipe failed or was cancelled: keep resident state and resume writes. */
  abortReset(): void {
    this.resetToken += 1;
    this.writesSuspended = false;
  }

  async load(): Promise<PersistedSettings> {
    const epoch = this.loadEpoch;
    try {
      const stored = await this.platform.storage.read<Partial<PersistedSettings>>(SETTINGS_KEY);
      if (epoch !== this.loadEpoch) return this.settings;
      this.settings = sanitizeSettings(stored);
      const records = await this.platform.storage.read<MatchRecord[]>(RECORDS_KEY);
      if (epoch !== this.loadEpoch) return this.settings;
      if (Array.isArray(records)) {
        const clean: MatchRecord[] = [];
        for (let i = 0; i < records.length && clean.length < MAX_RECORDS; i += 1) {
          const record = sanitizeRecord(records[i]);
          if (record) clean.push(record);
        }
        this.records = clean;
      } else {
        this.records = [];
      }
    } catch (error) {
      if (epoch !== this.loadEpoch) return this.settings;
      this.settings = { ...FALLBACK_SETTINGS };
      this.records = [];
    }
    this.loaded = true;
    return this.settings;
  }

  update(patch: Partial<PersistedSettings>): PersistedSettings {
    this.settings = sanitizeSettings({
      tutorialDone:
        typeof patch.tutorialDone === 'boolean' ? patch.tutorialDone : this.settings.tutorialDone,
      themeId:
        typeof patch.themeId === 'string'
          ? sanitizeThemeId(patch.themeId)
          : this.settings.themeId,
      durationSeconds:
        typeof patch.durationSeconds === 'number'
          ? patch.durationSeconds
          : this.settings.durationSeconds,
      difficulty: typeof patch.difficulty === 'string' ? patch.difficulty : this.settings.difficulty,
      leaderboardOptIn:
        typeof patch.leaderboardOptIn === 'boolean'
          ? patch.leaderboardOptIn
          : this.settings.leaderboardOptIn,
      // Patch-only: when the caller omits gameSpeed, the resident value is
      // preserved (sanitizeSettings would otherwise read a missing field as 1×).
      gameSpeed: hasOwn(patch, 'gameSpeed')
        ? normalizeGameSpeed(patch.gameSpeed, this.settings.gameSpeed)
        : this.settings.gameSpeed,
      soundEnabled:
        typeof patch.soundEnabled === 'boolean'
          ? patch.soundEnabled
          : this.settings.soundEnabled,
      // Patch-only: when the caller omits factionCount, the resident value is
      // preserved (sanitizeSettings would otherwise read a missing field as 2).
      factionCount: hasOwn(patch, 'factionCount')
        ? normalizeFactionCount(patch.factionCount, this.settings.factionCount)
        : this.settings.factionCount,
    });
    this.persistSettings();
    return this.settings;
  }

  /** Current v1.4 match size; always a sanitized value (2 on old archives). */
  getFactionCount(): FactionCount {
    return this.settings.factionCount;
  }

  /** Persists one of the supported match sizes and returns the sanitized value. */
  setFactionCount(count: FactionCount): FactionCount {
    if (isFactionCount(count)) this.update({ factionCount: count });
    return this.settings.factionCount;
  }

  /** Current v1.2 match speed; always a sanitized value. */
  getGameSpeed(): GameSpeed {
    return this.settings.gameSpeed;
  }

  /** Persists one of the three speeds and returns the sanitized result. */
  setGameSpeed(speed: GameSpeed): GameSpeed {
    if (isGameSpeed(speed)) this.update({ gameSpeed: speed });
    return this.settings.gameSpeed;
  }

  /**
   * Persists one accepted difficulty tier, including v1.3 `casual`. An invalid
   * value is ignored (no write); the current tier is always returned.
   */
  setDifficulty(difficulty: Difficulty): Difficulty {
    if (isDifficulty(difficulty)) {
      this.settings = { ...this.settings, difficulty: difficulty };
      this.persistSettings();
    }
    return this.settings.difficulty;
  }

  /**
   * Applies the first-run recommendation for a BRAND-NEW archive. The shell
   * must call this only after ProfileStore.load() reported 'missing' and the
   * archive was created; old archives keep their difficulty and speed. Speed,
   * sound and the legacy tutorial flag are left untouched.
   */
  applyNewProfileDefaults(): PersistedSettings {
    this.settings = withNewProfileDifficulty(this.settings);
    this.persistSettings();
    return this.settings;
  }

  /** v1.2 sound switch; defaults to enabled on old archives and after a wipe. */
  getSoundEnabled(): boolean {
    return this.settings.soundEnabled;
  }

  /** Persists the switch and returns the sanitized value. */
  setSoundEnabled(enabled: boolean): boolean {
    if (typeof enabled === 'boolean') this.update({ soundEnabled: enabled });
    return this.settings.soundEnabled;
  }

  addRecord(record: MatchRecord): void {
    const clean = sanitizeRecord(record);
    if (!clean) return;
    this.records.unshift(clean);
    if (this.records.length > MAX_RECORDS) this.records.length = MAX_RECORDS;
    this.enqueueWrite(RECORDS_KEY, this.records.slice());
  }

  private persistSettings(): void {
    this.enqueueWrite(SETTINGS_KEY, this.settings);
  }

  /** One serialized chain for settings and records; never overtakes itself. */
  private enqueueWrite<T>(key: string, value: T): void {
    if (this.writesSuspended) return;
    const storage = this.platform.storage;
    const self = this;
    const epoch = this.writeEpoch;
    this.writeChain = this.writeChain
      .then(
        function () {
          if (epoch !== self.writeEpoch) return true;
          return storage.write(key, value);
        },
        function () {
          return true;
        }
      )
      .then(
        function (ok) {
          if (epoch === self.writeEpoch) self.finishWrite(ok !== false);
        },
        function () {
          if (epoch === self.writeEpoch) self.finishWrite(false);
        }
      );
  }

  private finishWrite(ok: boolean): void {
    this.lastWriteOkValue = ok;
    if (this.onWrite) this.onWrite(ok);
  }
}

export function isoDateLabel(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return year + '-' + (month < 10 ? '0' + month : String(month)) + '-' + (day < 10 ? '0' + day : String(day));
}
