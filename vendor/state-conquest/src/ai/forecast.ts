import { applyMove } from '../core/commands';
import { computeDispatch } from '../core/dispatch';
import { resolveCannons } from '../core/cannon';
import { resolveContinuousFronts } from '../core/fronts';
import { resolveArrivals } from '../core/movement';
import { produceTick } from '../core/production';
import { planMoveRoute } from '../core/reachability';
import type { MatchState, PlayerId } from '../core/types';
import { cloneMatchState } from './clone';
import { isEnemyOf, travelTicks } from './evaluate';

export interface AssaultAction {
  sourceId: string;
  targetId: string;
  ratio: number;
}

export interface AssaultForecast {
  ok: boolean;
  captured: boolean;
  targetOwner: string;
  targetTroops: number;
  /** First source's garrison immediately after issuing its order. */
  sourceRemaining: number;
  arrivedTick: number;
  /** True when a predicted enemy counter-wave retook the target. */
  lostToCounter: boolean;
  /** Surviving garrison at the end of the look-ahead. */
  garrison: number;
}

const DEFAULT_TAIL_TICKS = 6;

export interface AssaultForecastOptions {
  counterWaves?: number;
  tailTicks?: number;
  /**
   * True when the caller is inside the AI phase of the current tick: the
   * engine incremented tick, then runs AI, and only afterwards cannon,
   * arrivals and production. The forecast must replay those pending phases
   * before advancing. External callers that forecast from a fully resolved
   * tick keep the default (false).
   */
  includeCurrentTick?: boolean;
}

/**
 * Pure short-horizon forecast on a full state copy. It issues the candidate
 * orders (validated exactly like live commands) and then advances the copy in
 * the engine's own order: cannon, arrivals (arrivalTick, armyId), production.
 * The live state is never mutated and no hidden information is used.
 */
export function forecastAssault(
  state: MatchState,
  owner: PlayerId,
  actions: AssaultAction[],
  options?: AssaultForecastOptions
): AssaultForecast {
  const opts = options || {};
  const tail = opts.tailTicks === undefined ? DEFAULT_TAIL_TICKS : opts.tailTicks;
  const counterWaves = opts.counterWaves || 0;
  const includeCurrentTick = opts.includeCurrentTick === true;
  const targetId = actions.length ? actions[actions.length - 1].targetId : '';
  const clone = cloneMatchState(state);
  // With continuous lines the world may always contain unrelated waves, so the
  // "has the candidate landed?" test has to be scoped to the candidate's own
  // armies. Without lines the legacy behaviour is preserved exactly.
  const frontsActive = !!(state.fronts && state.fronts.length > 0);
  // Stable identity marker for the armies the candidate actions create. Array
  // indices are unsafe here: arrivals remove elements while the loop runs.
  const candidateArmyIdStart = clone.nextArmyId;
  let ok = true;
  let sourceRemaining = 0;

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    const result = applyMove(clone, owner, action.sourceId, action.targetId, action.ratio);
    if (!result.ok) {
      ok = false;
      break;
    }
    if (i === 0) sourceRemaining = clone.territories[action.sourceId].troops;
  }

  const fallback = state.territories[targetId];
  if (!ok || !targetId) {
    return {
      ok: false,
      captured: false,
      targetOwner: fallback ? fallback.owner : '',
      targetTroops: fallback ? fallback.troops : 0,
      sourceRemaining: sourceRemaining,
      arrivedTick: state.tick,
      lostToCounter: false,
      garrison: fallback ? fallback.troops : 0,
    };
  }

  let lastArrival = clone.tick;
  if (frontsActive) {
    // Only the candidate's own armies define "the candidate has landed". A
    // supply line already streaming at the SAME target must not starve the
    // counter wave, and an unrelated line must not postpone it. Identity is
    // taken from the monotonically increasing army id, never from an array
    // index (arrivals remove elements during the walk).
    for (let i = 0; i < clone.armies.length; i += 1) {
      const army = clone.armies[i];
      if (
        army.id >= candidateArmyIdStart &&
        army.targetId === targetId &&
        army.arrivalTick > lastArrival
      ) {
        lastArrival = army.arrivalTick;
      }
    }
  } else {
    for (let i = 0; i < clone.armies.length; i += 1) {
      if (clone.armies[i].arrivalTick > lastArrival) {
        lastArrival = clone.armies[i].arrivalTick;
      }
    }
  }

  // When planning inside the AI phase, the engine has not yet run this tick's
  // cannon, arrivals, production or continuous-front phase. Replay them now so
  // the forecast cannot skip a shot or a wave that will land before the next
  // tick.
  if (includeCurrentTick) {
    resolveCannons(clone);
    resolveArrivals(clone);
    produceTick(clone);
    resolveContinuousFronts(clone);
  }

  let wave = 0;
  let counterArrival = 0;
  const limit = Math.min(clone.durationTicks, lastArrival + tail + counterWaves * 30 + 2);
  while (clone.tick < limit) {
    clone.tick += 1;
    resolveCannons(clone);
    resolveArrivals(clone);
    produceTick(clone);
    resolveContinuousFronts(clone);

    if (
      wave < counterWaves &&
      (frontsActive ? true : clone.armies.length === 0) &&
      clone.tick >= Math.max(lastArrival, counterArrival)
    ) {
      const target = clone.territories[targetId];
      if (target && target.owner === owner) {
        // Identify the counter army by the id watermark taken immediately
        // before the call: arrivals delete array entries mid-walk, so a length
        // or index captured earlier would be wrong.
        const counterArmyIdStart = clone.nextArmyId;
        if (enemyCounter(clone, owner, targetId)) {
          wave += 1;
          if (frontsActive) {
            // Only the counter wave we just launched matters for the tail
            // budget; supply-line traffic must not be counted as a counter.
            for (let i = 0; i < clone.armies.length; i += 1) {
              const army = clone.armies[i];
              if (
                army.id >= counterArmyIdStart &&
                army.targetId === targetId &&
                army.arrivalTick > counterArrival
              ) {
                counterArrival = army.arrivalTick;
              }
            }
          } else {
            for (let i = 0; i < clone.armies.length; i += 1) {
              if (clone.armies[i].arrivalTick > counterArrival) {
                counterArrival = clone.armies[i].arrivalTick;
              }
            }
          }
        }
      }
    }
    if (wave > 0 && clone.tick > Math.max(lastArrival, counterArrival) + tail) break;
  }

  const target = clone.territories[targetId];
  const captured = !!target && target.owner === owner;
  return {
    ok: true,
    captured: captured,
    targetOwner: target ? target.owner : '',
    targetTroops: target ? target.troops : 0,
    sourceRemaining: sourceRemaining,
    arrivedTick: lastArrival,
    lostToCounter: !captured && !!target && target.owner !== 'neutral',
    garrison: target ? target.troops : 0,
  };
}

/**
 * Predicts one plausible enemy counter-attack. Counter sources obey the same
 * v0.4 frontier rule as real orders (any owned front can launch), and the move
 * is still validated by applyMove. A comfortable margin prevents the AI from
 * hallucinating a counter the opponent could not actually afford.
 */
function enemyCounter(clone: MatchState, owner: PlayerId, targetId: string): boolean {
  const target = clone.territories[targetId];
  if (!target || target.owner !== owner) return false;

  let bestSourceId = '';
  let bestOwner: PlayerId | null = null;
  let bestAvailable = 0;
  for (let i = 0; i < clone.territoryOrder.length; i += 1) {
    const source = clone.territories[clone.territoryOrder[i]];
    if (!isEnemyOf(owner, source.owner, clone)) continue;
    const available = computeDispatch(source.troops, 1).available;
    if (available <= target.troops + 6 || available <= bestAvailable) continue;
    const sourceOwner = source.owner as PlayerId;
    if (!planMoveRoute(clone, sourceOwner, source.id, targetId)) continue;
    bestAvailable = available;
    bestSourceId = source.id;
    bestOwner = sourceOwner;
  }
  if (!bestSourceId || !bestOwner) return false;
  return applyMove(clone, bestOwner, bestSourceId, targetId, 1).ok;
}

/** Predicted arrival tick of a candidate, before it is issued. */
export function predictedArrivalTick(
  state: MatchState,
  sourceId: string,
  targetId: string,
  delayTicks: number = 0
): number {
  return state.tick + delayTicks + travelTicks(state, sourceId, targetId);
}
