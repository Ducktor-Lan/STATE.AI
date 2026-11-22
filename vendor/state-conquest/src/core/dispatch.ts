import { RESERVE_RATIO } from '../config/balance';
import type { DispatchPlan } from './types';

/**
 * Reserve keeps a defensive garrison. 100% means all *available* troops,
 * never the whole garrison. sent = floor(available * ratio).
 */
export function computeDispatch(troops: number, ratio: number): DispatchPlan {
  const safeTroops = isFinite(troops) && troops > 0 ? Math.floor(troops) : 0;
  const safeRatio = isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const reserve = Math.max(1, Math.ceil(safeTroops * RESERVE_RATIO));
  const available = Math.max(0, safeTroops - reserve);
  const sent = Math.floor(available * safeRatio);
  return { available: available, reserve: reserve, sent: sent };
}

export function remainingAfterDispatch(troops: number, sent: number): number {
  const safeTroops = isFinite(troops) && troops > 0 ? Math.floor(troops) : 0;
  const safeSent = isFinite(sent) && sent > 0 ? Math.floor(sent) : 0;
  return Math.max(0, safeTroops - safeSent);
}
