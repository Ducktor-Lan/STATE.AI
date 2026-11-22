import { TERRAIN_DEFENSE_PCT } from '../config/balance';
import type { Terrain } from './types';

export function terrainDefensePct(terrain: Terrain): number {
  return TERRAIN_DEFENSE_PCT[terrain] !== undefined ? TERRAIN_DEFENSE_PCT[terrain] : 0;
}

/**
 * Troops an attacker must exceed (strictly greater) to capture.
 * Integer math only: ceil(defender * (100 + terrainPct) / 100).
 */
export function requiredAttackCost(defenderTroops: number, terrain: Terrain): number {
  const defenders = isFinite(defenderTroops) && defenderTroops > 0 ? Math.ceil(defenderTroops) : 0;
  const pct = terrainDefensePct(terrain);
  return Math.ceil((defenders * (100 + pct)) / 100);
}

export interface BattleResolution {
  captured: boolean;
  /** Surviving attacker troops that can garrison the captured territory. */
  survivors: number;
  /** Defender troops left when the attack is repelled (always >= 1). */
  defenderRemaining: number;
  /** Shield troops left when the attack is repelled (present when shield > 0). */
  shieldRemaining?: number;
}

/**
 * Discrete battle rule. `defenderTroops` is the TOTAL defence (garrison +
 * shield); `defenderShield` tells how much of it is shield. Ties favour the
 * defender, so an owned territory can never be left with zero defenders.
 * On a repelled attack the shield absorbs damage first, then the garrison.
 */
export function resolveBattle(
  defenderTroops: number,
  terrain: Terrain,
  attackerTroops: number,
  defenderShield: number = 0
): BattleResolution {
  const total = isFinite(defenderTroops) && defenderTroops > 0 ? Math.ceil(defenderTroops) : 0;
  const shieldRaw = isFinite(defenderShield) && defenderShield > 0 ? Math.floor(defenderShield) : 0;
  const shield = Math.min(shieldRaw, total);
  const garrison = Math.max(0, total - shield);
  const attackers = isFinite(attackerTroops) && attackerTroops > 0 ? Math.floor(attackerTroops) : 0;
  const requiredCost = requiredAttackCost(total, terrain);

  if (attackers > requiredCost) {
    return {
      captured: true,
      survivors: attackers - requiredCost,
      defenderRemaining: 0,
    };
  }

  const pct = terrainDefensePct(terrain);
  const defenderLoss = Math.ceil((attackers * 100) / (100 + pct));
  const shieldLoss = Math.min(shield, defenderLoss);
  const troopLoss = Math.max(0, defenderLoss - shieldLoss);
  const result: BattleResolution = {
    captured: false,
    survivors: 0,
    defenderRemaining: Math.max(1, garrison - troopLoss),
  };
  if (shield > 0) result.shieldRemaining = shield - shieldLoss;
  return result;
}

/** Front (continuous siege) battle outcome, with real integer deltas. */
export interface FrontBattleResolution {
  captured: boolean;
  /** Survivors that garrison the captured territory. */
  survivors: number;
  defenderRemaining: number;
  shieldRemaining: number;
  /** Real shield losses caused by this wave (already subtracted). */
  shieldLoss: number;
  /** Real garrison losses caused by this wave (already subtracted). */
  troopLoss: number;
}

/**
 * Siege variant of `resolveBattle`, used only by continuous supply lines.
 *
 * The capture gate is IDENTICAL to the single-shot rule: a wave only takes the
 * ground when `attackers > requiredAttackCost(garrison + shield, terrain)`, so
 * terrain and shield cost can never be bypassed by a small batch. What differs
 * is only the reporting: the exact integer deltas are returned so the caller can
 * record real losses, and the defender's remaining defence is derived from
 * those deltas rather than re-rounded.
 *
 * Cumulative break-through is NOT simulated here. It happens naturally and
 * honestly in the live state: `markNeutralDamaged`/the defender's own
 * `troops`/`shield` keep every soldier a failed wave killed, so the next wave
 * faces a genuinely smaller garrison. With `CONTINUOUS_MIN_BATCH = 4` a wave
 * always clears the 1-troop remnant that the tie rule leaves behind, which is
 * what removes the old "one defender holds forever" stall. No damage is stored
 * between waves and no attack power is carried, so nothing can be double
 * counted.
 */
export function resolveFrontBattle(
  defenderTroops: number,
  terrain: Terrain,
  attackerTroops: number,
  defenderShield: number = 0
): FrontBattleResolution {
  const total = isFinite(defenderTroops) && defenderTroops > 0 ? Math.ceil(defenderTroops) : 0;
  const shieldRaw = isFinite(defenderShield) && defenderShield > 0 ? Math.floor(defenderShield) : 0;
  const shield = Math.min(shieldRaw, total);
  const garrison = Math.max(0, total - shield);
  const attackers = isFinite(attackerTroops) && attackerTroops > 0 ? Math.floor(attackerTroops) : 0;
  const requiredCost = requiredAttackCost(total, terrain);

  if (attackers > requiredCost) {
    return {
      captured: true,
      survivors: attackers - requiredCost,
      defenderRemaining: 0,
      shieldRemaining: 0,
      shieldLoss: shield,
      troopLoss: garrison,
    };
  }

  if (total <= 0) {
    // Undefended ground: the first wave to arrive occupies it and pays nothing.
    if (attackers > 0) {
      return {
        captured: true,
        survivors: attackers,
        defenderRemaining: 0,
        shieldRemaining: 0,
        shieldLoss: 0,
        troopLoss: 0,
      };
    }
    return {
      captured: false,
      survivors: 0,
      defenderRemaining: 0,
      shieldRemaining: 0,
      shieldLoss: 0,
      troopLoss: 0,
    };
  }

  const pct = terrainDefensePct(terrain);
  const defenderLoss = Math.ceil((attackers * 100) / (100 + pct));
  const shieldLoss = Math.min(shield, defenderLoss);
  let troopLoss = Math.min(garrison, Math.max(0, defenderLoss - shieldLoss));
  let defenderRemaining = garrison - troopLoss;
  // The tie rule: owned ground keeps at least one soldier. Because that floor
  // reduces the real garrison loss, `troopLoss` must be re-derived from the
  // final garrison — otherwise an event would report more dead soldiers than
  // actually left (`before - after`).
  if (defenderRemaining < 1 && garrison > 0) {
    defenderRemaining = 1;
    troopLoss = garrison - 1;
  }
  return {
    captured: false,
    survivors: 0,
    defenderRemaining: defenderRemaining,
    shieldRemaining: shield - shieldLoss,
    shieldLoss: shieldLoss,
    troopLoss: troopLoss,
  };
}
