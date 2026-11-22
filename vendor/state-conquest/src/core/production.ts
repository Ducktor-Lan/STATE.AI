import {
  CASUAL_AI_PRODUCTION_MULTIPLIER,
  FIXED_DT_SECONDS,
  NEUTRAL_RECOVERY_DELAY_TICKS,
  NEUTRAL_RECOVERY_RATE,
  PRODUCTION_RATES,
} from '../config/balance';
import type { MatchState, OwnerId, Territory } from './types';

export function productionRate(level: 1 | 2 | 3): number {
  return PRODUCTION_RATES[level] !== undefined ? PRODUCTION_RATES[level] : PRODUCTION_RATES[1];
}

/**
 * Effective production multiplier for one owner. Only casual solo penalizes
 * the built-in AI (every seated AI slot: ai1/ai2/ai3): the player economy,
 * versus (two humans) and the three legacy difficulties always return 1.
 * Neutral recovery never uses this.
 */
export function productionMultiplierFor(
  state: Pick<MatchState, 'difficulty' | 'mode'>,
  owner: OwnerId
): number {
  if (state.difficulty !== 'casual') return 1;
  if (state.mode === 'versus') return 1;
  if (owner === 'ai1' || owner === 'ai2' || owner === 'ai3') {
    return CASUAL_AI_PRODUCTION_MULTIPLIER;
  }
  return 1;
}

/** Production rate actually applied to `owner` in this match. */
export function effectiveProductionRate(
  level: 1 | 2 | 3,
  state: Pick<MatchState, 'difficulty' | 'mode'>,
  owner: OwnerId
): number {
  return productionRate(level) * productionMultiplierFor(state, owner);
}

/** Recovery cap for a damaged neutral territory: never past its original garrison. */
export function neutralRecoveryCap(target: Territory): number {
  return Math.max(0, Math.min(target.initialTroops, target.capacity));
}

/**
 * Neutral territories never produce on their own. After a failed attack they
 * slowly refill toward their original garrison (not capacity) once the quiet
 * delay has elapsed. Fractional progress accumulates in its own remainder.
 */
export function recoverNeutralTerritory(
  territory: Territory,
  tick: number,
  dtSeconds: number = FIXED_DT_SECONDS
): number {
  if (territory.owner !== 'neutral') return 0;
  const lastDamaged = territory.lastDamagedTick === undefined ? -1 : territory.lastDamagedTick;
  if (lastDamaged < 0) return 0;
  const cap = neutralRecoveryCap(territory);
  if (territory.troops >= cap) {
    territory.neutralRecoveryTarget = 0;
    territory.neutralRecoveryRemainder = 0;
    return 0;
  }
  if (tick - lastDamaged < NEUTRAL_RECOVERY_DELAY_TICKS) return 0;

  const remainder =
    isFinite(territory.neutralRecoveryRemainder || 0) && (territory.neutralRecoveryRemainder || 0) > 0
      ? (territory.neutralRecoveryRemainder as number)
      : 0;
  const gain = NEUTRAL_RECOVERY_RATE * dtSeconds + remainder;
  const whole = Math.floor(gain);
  const actualGain = Math.min(whole, cap - territory.troops);
  territory.troops += actualGain;
  let next = gain - whole;
  if (!isFinite(next) || next < 0) next = 0;
  if (territory.troops >= cap) next = 0;
  territory.neutralRecoveryRemainder = next;
  if (territory.troops >= cap) territory.neutralRecoveryTarget = 0;
  return actualGain;
}

/**
 * Accumulates fractional production per territory, but only ever adds whole
 * troops. Neutral territories use recovery instead of production. Production
 * is capped by capacity.
 */
export function produceForTerritory(
  territory: Territory,
  dtSeconds: number = FIXED_DT_SECONDS,
  multiplier: number = 1
): number {
  if (territory.owner === 'neutral') return 0;
  if (territory.troops >= territory.capacity) {
    territory.productionRemainder = 0;
    return 0;
  }

  const safeMultiplier = isFinite(multiplier) && multiplier >= 0 ? multiplier : 1;
  const rate = productionRate(territory.productionLevel) * safeMultiplier;
  const gain = rate * dtSeconds + territory.productionRemainder;
  const whole = Math.floor(gain);
  const actualGain = Math.min(whole, territory.capacity - territory.troops);
  territory.troops += actualGain;

  let remainder = gain - whole;
  if (!isFinite(remainder) || remainder < 0) remainder = 0;
  if (remainder >= 1 || territory.troops >= territory.capacity) remainder = 0;
  territory.productionRemainder = remainder;
  return actualGain;
}

/**
 * One production/recovery step for every territory. Called exactly once per
 * tick; neutral recovery is part of this single pass.
 */
export function produceTick(state: MatchState, dtSeconds: number = FIXED_DT_SECONDS): void {
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    if (territory.owner === 'neutral') {
      recoverNeutralTerritory(territory, state.tick, dtSeconds);
    } else {
      produceForTerritory(
        territory,
        dtSeconds,
        productionMultiplierFor(state, territory.owner)
      );
    }
  }
}
