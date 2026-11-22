import { TICKS_PER_SECOND } from './balance';

export const MATCH_DURATIONS: number[] = [180, 300, 480];
export const DEFAULT_DURATION_SECONDS = 180;

export function isSupportedDuration(seconds: number): boolean {
  return MATCH_DURATIONS.indexOf(seconds) >= 0;
}

export function durationToTicks(seconds: number): number {
  return Math.max(1, Math.round(seconds * TICKS_PER_SECOND));
}

export function durationLabel(seconds: number): string {
  if (seconds === 180) return '速战';
  if (seconds === 480) return '持久';
  return '标准';
}
