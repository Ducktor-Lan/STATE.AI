import {
  isValidLocalDateKey,
  normalizeExperience,
  levelForExperience,
  MAX_CHECK_IN_STREAK,
} from '../config/progression';
import type { CheckInState, ExperienceGain } from '../config/progression';
import { normalizePlayerColorId } from './player-colors';
import type { PlayerColorId } from './player-colors';

export {
  addExperience,
  checkInRewardFor,
  dailyCheckInFor,
  experienceToNextLevel,
  isPreviousLocalDate,
  levelForExperience,
  localDateKey,
  matchExperienceFor,
} from '../config/progression';
export type {
  CheckInDecisionReason,
  CheckInReward,
  ExperienceGain,
} from '../config/progression';

export type { CheckInState } from '../config/progression';
export type GrowthGain = ExperienceGain;

export interface GrowthState {
  experience: number;
  commanderLevel: number;
  checkIn: CheckInState;
  playerColorId: PlayerColorId;
}

export { MAX_CHECK_IN_STREAK, MAX_COMMANDER_LEVEL } from '../config/progression';

/** Normalizes optional v1 fields without mutating the stored payload. */
export function normalizeGrowthState(raw: {
  experience?: unknown;
  commanderLevel?: unknown;
  checkIn?: unknown;
  playerColorId?: unknown;
}): GrowthState {
  const checkInRaw =
    raw.checkIn && typeof raw.checkIn === 'object' && !Array.isArray(raw.checkIn)
      ? (raw.checkIn as Record<string, unknown>)
      : {};
  const lastDate = isValidLocalDateKey(checkInRaw.lastDate) ? checkInRaw.lastDate : null;
  const streakValue = normalizeExperience(checkInRaw.streak);
  const totalValue = normalizeExperience(checkInRaw.total);
  const streak = lastDate === null ? 0 : Math.min(MAX_CHECK_IN_STREAK, streakValue);
  return {
    experience: normalizeExperience(raw.experience),
    // The level is always derived from XP; the stored commanderLevel is only a
    // compatibility field and is never trusted as an independent counter.
    commanderLevel: levelForExperience(normalizeExperience(raw.experience)),
    checkIn: {
      lastDate: lastDate,
      streak: streak,
      total: totalValue,
    },
    playerColorId: normalizePlayerColorId(raw.playerColorId),
  };
}

export function defaultGrowthState(): GrowthState {
  return {
    experience: 0,
    commanderLevel: 1,
    checkIn: { lastDate: null, streak: 0, total: 0 },
    playerColorId: normalizePlayerColorId(undefined),
  };
}
