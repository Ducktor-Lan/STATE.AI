import {
  STALEMATE_END_TICKS,
  STALEMATE_WARNING_TICKS,
  TICKS_PER_SECOND,
} from '../config/balance';
import { decideTimedOutcome } from './score';
import type { MatchState } from './types';

export { STALEMATE_END_TICKS, STALEMATE_WARNING_TICKS };

function lastProgress(state: MatchState): number {
  if (typeof state.lastProgressTick !== 'number' || !isFinite(state.lastProgressTick)) {
    state.lastProgressTick = state.tick;
  }
  return state.lastProgressTick;
}

/** Records capture or real defence damage as meaningful match progress. */
export function markProgress(state: MatchState): void {
  state.lastProgressTick = state.tick;
  state.stalemateWarned = false;
}

export function stalemateSecondsRemaining(state: MatchState): number | null {
  const elapsed = Math.max(0, state.tick - lastProgress(state));
  if (elapsed < STALEMATE_WARNING_TICKS) return null;
  return Math.max(0, Math.ceil((STALEMATE_END_TICKS - elapsed) / TICKS_PER_SECOND));
}

/**
 * Checks the no-progress guard. Returns true only when it ended the match; the
 * normal elimination and timeout checks remain the engine's responsibility.
 */
export function resolveStalemate(state: MatchState): boolean {
  if (state.status !== 'playing') return false;
  const elapsed = Math.max(0, state.tick - lastProgress(state));
  if (elapsed < STALEMATE_WARNING_TICKS) {
    state.stalemateWarned = false;
    return false;
  }
  state.stalemateWarned = true;
  if (elapsed < STALEMATE_END_TICKS) return false;
  state.result = decideTimedOutcome(state);
  state.status = 'ended';
  state.endReason = 'stalemate';
  return true;
}
