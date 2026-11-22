export type ProgressionDifficulty = 'easy' | 'normal' | 'hard' | 'casual';
export type ProgressionResult = 'win' | 'lose' | 'draw';

export interface CheckInState {
  lastDate: string | null;
  streak: number;
  total: number;
}

export interface ExperienceState {
  experience: number;
}

export interface ExperienceGain {
  experience: number;
  previousLevel: number;
  level: number;
  levelsGained: number;
}

export interface CheckInReward {
  gold: number;
  experience: number;
}

export type CheckInDecisionReason =
  | 'claimed'
  | 'already_claimed'
  | 'date_rollback'
  | 'invalid_date';

export const MAX_COMMANDER_LEVEL = 12;
export const MAX_CHECK_IN_STREAK = 7;

/** Cumulative XP required for levels 1..12. Level 1 starts at zero. */
export const COMMANDER_LEVEL_XP: readonly number[] = [
  0,
  100,
  250,
  450,
  700,
  1000,
  1400,
  1850,
  2350,
  2900,
  3500,
  4200,
];

const CHECK_IN_GOLD: readonly number[] = [5, 8, 11, 14, 18, 22, 30];
const CHECK_IN_XP: readonly number[] = [20, 24, 28, 32, 38, 44, 55];
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export function normalizeExperience(value: unknown): number {
  return safeCount(value);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Checks a local calendar key, including month lengths and leap years. */
export function isValidLocalDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 10) return false;
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function dateParts(date: Date): string {
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const key =
    String(year).padStart(4, '0') +
    '-' +
    (month < 10 ? '0' + month : String(month)) +
    '-' +
    (day < 10 ? '0' + day : String(day));
  return isValidLocalDateKey(key) ? key : '';
}

/** Local calendar date; UTC conversion would change rewards around midnight. */
export function localDateKey(date: Date = new Date()): string {
  return dateParts(date);
}

export function isPreviousLocalDate(previous: string | null, currentDate: Date): boolean {
  if (!isValidLocalDateKey(previous)) return false;
  if (!localDateKey(currentDate)) return false;
  const yesterday = new Date(currentDate.getTime());
  // Calendar arithmetic respects 23/25-hour DST days and preserves years 1..99
  // (the multi-argument Date constructor would reinterpret them as 1901..1999).
  yesterday.setDate(yesterday.getDate() - 1);
  return previous === localDateKey(yesterday);
}

export function levelForExperience(experience: number): number {
  const value = safeCount(experience);
  let level = 1;
  for (let i = 1; i < COMMANDER_LEVEL_XP.length; i += 1) {
    if (value < COMMANDER_LEVEL_XP[i]) break;
    level = i + 1;
  }
  return Math.min(MAX_COMMANDER_LEVEL, level);
}

export function experienceToNextLevel(experience: number): {
  level: number;
  current: number;
  next: number | null;
  remaining: number;
  progress: number;
} {
  const value = safeCount(experience);
  const level = levelForExperience(value);
  const current = COMMANDER_LEVEL_XP[level - 1];
  const next = level >= MAX_COMMANDER_LEVEL ? null : COMMANDER_LEVEL_XP[level];
  if (next === null) {
    return { level: level, current: current, next: null, remaining: 0, progress: 1 };
  }
  const span = Math.max(1, next - current);
  const progress = Math.max(0, Math.min(1, (value - current) / span));
  return {
    level: level,
    current: current,
    next: next,
    remaining: Math.max(0, next - value),
    progress: progress,
  };
}

export function matchExperienceFor(
  result: ProgressionResult,
  difficulty: ProgressionDifficulty
): number {
  const base = result === 'win' ? 100 : result === 'draw' ? 60 : 30;
  const multiplier =
    difficulty === 'hard' ? 1.5 : difficulty === 'normal' ? 1.25 : difficulty === 'casual' ? 0.8 : 1;
  return Math.max(1, Math.round(base * multiplier));
}

export function checkInRewardFor(streak: number): CheckInReward {
  const numeric = typeof streak === 'number' && Number.isFinite(streak) ? Math.floor(streak) : 1;
  const day = Math.max(1, Math.min(MAX_CHECK_IN_STREAK, numeric));
  return {
    gold: CHECK_IN_GOLD[day - 1],
    experience: CHECK_IN_XP[day - 1],
  };
}

export function addExperience(state: ExperienceState, amount: number): ExperienceGain {
  const current = safeCount(state.experience);
  const gain = safeCount(amount);
  const previousLevel = levelForExperience(current);
  const experience = Math.min(Number.MAX_SAFE_INTEGER, current + gain);
  const level = levelForExperience(experience);
  return {
    experience: experience,
    previousLevel: previousLevel,
    level: level,
    levelsGained: Math.max(0, level - previousLevel),
  };
}

export function dailyCheckInFor(
  state: { checkIn: CheckInState },
  date: Date = new Date()
): {
  ok: boolean;
  reason: CheckInDecisionReason;
  date: string;
  streak: number;
  reward: CheckInReward;
} {
  const current = localDateKey(date);
  const previous = state.checkIn.lastDate;
  if (!current) {
    return {
      ok: false,
      reason: 'invalid_date',
      date: '',
      streak: state.checkIn.streak,
      reward: { gold: 0, experience: 0 },
    };
  }
  if (previous !== null && !isValidLocalDateKey(previous)) {
    return {
      ok: false,
      reason: 'invalid_date',
      date: current,
      streak: state.checkIn.streak,
      reward: { gold: 0, experience: 0 },
    };
  }
  if (previous === current) {
    return {
      ok: false,
      reason: 'already_claimed',
      date: current,
      streak: state.checkIn.streak,
      reward: { gold: 0, experience: 0 },
    };
  }
  // ISO calendar keys sort chronologically. Refuse a clock rollback so an
  // earlier date cannot be used to claim another reward from the same streak.
  // A future lastDate is rejected by the same comparison: the clock must first
  // catch up instead of granting a second reward after a manual rollback.
  if (previous !== null && current < previous) {
    return {
      ok: false,
      reason: 'date_rollback',
      date: current,
      streak: state.checkIn.streak,
      reward: { gold: 0, experience: 0 },
    };
  }
  const streak = isPreviousLocalDate(previous, date)
    ? Math.min(MAX_CHECK_IN_STREAK, state.checkIn.streak + 1)
    : 1;
  return {
    ok: true,
    reason: 'claimed',
    date: current,
    streak: streak,
    // Day 7 is the capped weekly reward. Consecutive days after day 7 keep
    // streak 7 and repeat the day-7 reward; a gap starts again at day 1.
    reward: checkInRewardFor(streak),
  };
}
