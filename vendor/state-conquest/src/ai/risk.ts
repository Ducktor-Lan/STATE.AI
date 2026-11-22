import { requiredAttackCost, resolveBattle } from '../core/combat';
import { computeDispatch } from '../core/dispatch';
import { FIXED_DT_SECONDS } from '../config/balance';
import { effectiveProductionRate } from '../core/production';
import { travelTicksForEdge } from '../core/movement';
import { isHostileAt } from '../core/diplomacy';
import { isEdgePassable, layoutBoundaries } from '../core/reachability';
import { cachedReachability } from './routing-cache';
import type { OwnerReachability } from '../core/reachability';
import type { Edge, MatchState, PlayerId } from '../core/types';
import { isEnemyOf, isFrontier, projectTargetArrival } from './evaluate';

/**
 * Arrival-aware frontier risk. Raw adjacent troop mass is misleading: a 40
 * troop neighbour across a bridge may arrive after our own reinforcement, and
 * a heavily fortified hill needs a much larger attacker before it is truly
 * lost. This model combines:
 *
 *  - the attacker's real cost (`requiredAttackCost` of our current defence),
 *  - every legal attacker source under the v0.4 frontier rule, not only the
 *    adjacent stack,
 *  - the earliest enemy arrival tick and the actual arrival order
 *    (arrivalTick, then armyId exactly like the engine),
 *  - every own reinforcement that can land before that attack, computed
 *    independently of source iteration order.
 *
 * Pure and deterministic: only state, edges, routes and stocks are read.
 * No wall clock, no random source.
 */
export interface FrontlineRisk {
  territoryId: string;
  /** Garrison + shield right now. */
  defense: number;
  /** Attackers needed to capture the current defence. */
  requiredNow: number;
  /** Adjacent enemy mass plus inbound enemy troops (legacy pressure). */
  pressure: number;
  /**
   * Adjacent stacks that can beat `requiredNow`, plus inbound enemy troops.
   * When that fast estimate is blind, the strongest legal rear source is used
   * instead (v0.4 frontier rule; advisory 10).
   */
  crediblePressure: number;
  /** Largest single adjacent enemy stack. */
  strongestEnemy: number;
  /** Enemy troops already in flight toward this territory. */
  inbound: number;
  /** Earliest tick a credible enemy lands (Infinity = none). */
  enemyArrivalTick: number;
  /** Own troops that can land no later than `enemyArrivalTick`. */
  timelyReinforcement: number;
  /** Earliest own reinforcement arrival tick (Infinity = none). */
  reinforcementTick: number;
  /** Defence at the first credible enemy arrival, capacity only on garrison. */
  projectedDefense: number;
  /** crediblePressure / projectedDefense. */
  risk: number;
  /** True when even timely reinforcement cannot hold the front. */
  doomed: boolean;
}

export interface ThreatModel {
  risk(territoryId: string): FrontlineRisk;
}

interface EnemyStack {
  available: number;
  arrivalTick: number;
}

interface InboundWave {
  owner: 'enemy' | 'own';
  troops: number;
  arrivalTick: number;
  armyId: number;
}

interface AttackOption {
  troops: number;
  arrivalTick: number;
  /** Engine arrival ordering within the same tick (armyId ASC). */
  order: number;
}

interface TimelineEvent {
  tick: number;
  order: number;
  kind: 'own' | 'enemy';
  troops: number;
}

/** Arrival order after every real army (hypothetical orders get later ids). */
const HYPOTHETICAL_ORDER = Number.MAX_SAFE_INTEGER;

/**
 * Builds one cached threat model per planning pass. Ownership changes between
 * passes, so the caller must not keep it across ticks.
 */
/**
 * Reusable caches across threat models built in one planning pass. Ownership
 * (and therefore routing) does not change when commands are issued: only
 * garrisons do. Sharing the enemy reachability planner keeps the second model
 * after an accepted order almost free.
 */
export interface ThreatModelCache {
  enemyReach?: Record<string, OwnerReachability>;
  relationKey?: string;
}

export function createThreatModel(
  state: MatchState,
  owner: PlayerId,
  reach: OwnerReachability,
  doomedRatio: number,
  shared?: ThreatModelCache
): ThreatModel {
  const adjacent: Record<string, EnemyStack[]> = {};
  const inbound: Record<string, InboundWave[]> = {};
  const cache: Record<string, FrontlineRisk> = {};
  const sources: Array<{ id: string; available: number }> = [];
  const enemyOwners: PlayerId[] = [];
  const currentRelationKey = relationKey();
  const enemyReach: Record<string, OwnerReachability> =
    shared && shared.relationKey === currentRelationKey && shared.enemyReach
      ? shared.enemyReach
      : {};
  if (shared) {
    shared.enemyReach = enemyReach;
    shared.relationKey = currentRelationKey;
  }
  const enemySources: Record<string, Array<{ id: string; troops: number }>> = {};

  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const id = state.territoryOrder[i];
    const territory = state.territories[id];
    if (territory.owner === owner) {
      sources.push({ id: id, available: computeDispatch(territory.troops, 1).available });
    }
  }
  for (let i = 0; i < state.activeOwners.length; i += 1) {
    const other = state.activeOwners[i];
    if (other === owner) continue;
    enemyOwners.push(other);
    enemySources[other] = [];
    for (let t = 0; t < state.territoryOrder.length; t += 1) {
      const territory = state.territories[state.territoryOrder[t]];
      if (territory.owner === other) {
        enemySources[other].push({ id: territory.id, troops: territory.troops });
      }
    }
  }
  function reachFor(other: PlayerId): OwnerReachability {
    let cached = enemyReach[other];
    if (!cached) {
      cached = cachedReachability(state, other);
      enemyReach[other] = cached;
    }
    return cached;
  }
  // The cheap adjacent approximation must obey the same crossability rule as
  // the route planner: a declared blocked arc can never feed a threat stack.
  const boundaries = layoutBoundaries(state.layout);
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    if (!isEdgePassable(boundaries, edge)) continue;
    pushEnemyStack(state, owner, edge, edge.from, edge.to, adjacent);
    pushEnemyStack(state, owner, edge, edge.to, edge.from, adjacent);
  }
  for (let i = 0; i < state.armies.length; i += 1) {
    const army = state.armies[i];
    const relationTick = Math.max(state.tick, army.arrivalTick);
    const hostile = isHostileAt(state.diplomacy, relationTick, owner, army.owner);
    // An allied wave returns to its own owner at landing; it neither attacks
    // this target nor joins our garrison as an own reinforcement.
    if (army.owner !== owner && !hostile) continue;
    if (!inbound[army.targetId]) inbound[army.targetId] = [];
    inbound[army.targetId].push({
      // A truce protects an already-dispatched army only if it is still active
      // when that army lands. The engine applies the same relation at landing.
      owner: hostile ? 'enemy' : 'own',
      troops: army.troops,
      arrivalTick: army.arrivalTick,
      armyId: army.id,
    });
  }

  /**
   * Every legal enemy source that can reach this territory under the v0.4
   * frontier rule. Adjacent stacks are included here as direct routes; the
   * separate edge pass only feeds the cheap adjacent approximation.
   *
   * Routing is deliberately not paid for on every measurement: the fast path
   * below uses adjacent stacks + committed inbound, and only falls back to
   * legal-source routing when that approximation sees no credible attacker.
   * The full list is also used by the strict continuous-wave check before a
   * front is pronounced doomed.
   */
  function legalSourceAttacks(territoryId: string): AttackOption[] {
    const out: AttackOption[] = [];
    for (let e = 0; e < enemyOwners.length; e += 1) {
      const other = enemyOwners[e];
      const list = enemySources[other];
      const theirReach = reachFor(other);
      for (let i = 0; i < list.length; i += 1) {
        const source = list[i];
        if (source.id === territoryId) continue;
        const available = computeDispatch(source.troops, 1).available;
        if (available < 2) continue;
        const movement = theirReach.plan(source.id, territoryId);
        if (!movement) continue;
        out.push({
          troops: available,
          arrivalTick: state.tick + movement.travelTicks,
          order: HYPOTHETICAL_ORDER,
        });
      }
    }
    return out;
  }

  function attackOptions(territoryId: string): AttackOption[] {
    // Full legal picture for the strict continuous-wave check: every enemy
    // source that can route here under the v0.4 frontier rule, plus committed
    // inbound armies, in engine arrival order.
    const out = legalSourceAttacks(territoryId);
    const waves = inbound[territoryId] || [];
    for (let i = 0; i < waves.length; i += 1) {
      const wave = waves[i];
      if (wave.owner !== 'enemy') continue;
      out.push({
        troops: wave.troops,
        arrivalTick: wave.arrivalTick,
        order: wave.armyId,
      });
    }
    return out;
  }

  /**
   * Strongest legal source that could land at all, used only when no adjacent
   * stack and no inbound army is credible. A 1-troop neighbour must not hide a
   * 50-troop rear stack that can legally attack through that frontier.
   */
  function strongestLegalAttack(territoryId: string, requiredNow: number): AttackOption | null {
    const attacks = legalSourceAttacks(territoryId);
    let best: AttackOption | null = null;
    for (let i = 0; i < attacks.length; i += 1) {
      const attack = attacks[i];
      if (attack.troops <= requiredNow) continue;
      if (
        best === null ||
        attack.troops > best.troops ||
        (attack.troops === best.troops && attack.arrivalTick < best.arrivalTick)
      ) {
        best = attack;
      }
    }
    return best;
  }

  /**
   * Sequential worst-case defence check. Committed and hypothetical enemy
   * attacks land in engine order; own committed waves and the troops every
   * reachable source could send are added at their real arrival ticks. Returns
   * true when any wave captures the territory before the match ends.
   */
  function fallsUnderWaves(
    territoryId: string,
    attacks: AttackOption[],
    territory: MatchState['territories'][string]
  ): boolean {
    const events: TimelineEvent[] = [];
    for (let i = 0; i < attacks.length; i += 1) {
      const attack = attacks[i];
      if (attack.arrivalTick > state.durationTicks) continue;
      events.push({
        tick: attack.arrivalTick,
        order: attack.order,
        kind: 'enemy',
        troops: attack.troops,
      });
    }
    const waves = inbound[territoryId] || [];
    for (let i = 0; i < waves.length; i += 1) {
      const wave = waves[i];
      if (wave.owner !== 'own' || wave.arrivalTick > state.durationTicks) continue;
      events.push({
        tick: wave.arrivalTick,
        order: wave.armyId,
        kind: 'own',
        troops: wave.troops,
      });
    }
    // Potential help: every source that can legally reach this front and has
    // something to send. The planner still has to issue the order.
    for (let i = 0; i < sources.length; i += 1) {
      const source = sources[i];
      if (source.id === territoryId || source.available < 2) continue;
      const movement = reach.plan(source.id, territoryId);
      if (!movement) continue;
      const arrivalTick = state.tick + movement.travelTicks;
      if (arrivalTick > state.durationTicks) continue;
      events.push({
        tick: arrivalTick,
        order: HYPOTHETICAL_ORDER - 1,
        kind: 'own',
        troops: source.available,
      });
    }
    events.sort(function (a, b) {
      if (a.tick !== b.tick) return a.tick - b.tick;
      if (a.order !== b.order) return a.order - b.order;
      // Own reinforcement wins an otherwise identical hypothetical tie so the
      // check never invents a fall it could not prove.
      if (a.kind !== b.kind) return a.kind === 'own' ? -1 : 1;
      return 0;
    });

    let garrison = territory.troops;
    let shield = territory.shield;
    let productionRemainder =
      isFinite(territory.productionRemainder) && territory.productionRemainder > 0
        ? territory.productionRemainder
        : 0;
    const capacity = territory.capacity;
    const terrain = territory.terrain;
    let productionCursor = state.tick;
    function produceUntil(eventTick: number): void {
      const end = Math.max(state.tick, eventTick);
      while (productionCursor < end) {
        if (garrison >= capacity) {
          garrison = capacity;
          productionRemainder = 0;
        } else {
          const gain =
            effectiveProductionRate(territory.productionLevel, state, owner) *
              FIXED_DT_SECONDS +
            productionRemainder;
          const whole = Math.max(0, Math.floor(gain));
          garrison = Math.min(capacity, garrison + whole);
          productionRemainder = garrison >= capacity ? 0 : Math.max(0, gain - whole);
        }
        productionCursor += 1;
      }
    }
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      // Arrivals resolve before production on the same tick. A due event from
      // an older tick is therefore resolved at the current tick before the
      // current production step, in the same order as the engine.
      produceUntil(event.tick <= state.tick ? state.tick : event.tick);
      if (event.kind === 'own') {
        garrison = Math.min(capacity, garrison + event.troops);
        if (garrison >= capacity) productionRemainder = 0;
        continue;
      }
      const total = garrison + shield;
      if (event.troops > requiredAttackCost(total, terrain)) return true;
      const battle = resolveBattle(total, terrain, event.troops, shield);
      garrison = battle.defenderRemaining;
      shield = battle.shieldRemaining === undefined ? 0 : battle.shieldRemaining;
    }
    return false;
  }

  function measure(territoryId: string): FrontlineRisk {
    const territory = state.territories[territoryId];
    const defense = territory ? territory.troops + territory.shield : 0;
    const requiredNow = territory ? requiredAttackCost(defense, territory.terrain) : 0;
    const stacks = adjacent[territoryId] || [];
    const waves = inbound[territoryId] || [];
    let pressure = 0;
    let crediblePressure = 0;
    let strongestEnemy = 0;
    let inboundTroops = 0;
    let enemyArrivalTick = Infinity;
    let firstEnemyOrder = Infinity;
    for (let i = 0; i < stacks.length; i += 1) {
      const stack = stacks[i];
      pressure += stack.available;
      if (stack.available > strongestEnemy) strongestEnemy = stack.available;
    }
    // Fast approximation: adjacent credible stacks plus every committed enemy
    // wave. This is what the M6 risk model already used and what keeps the
    // planner cheap; legal rear routing is a targeted correction below.
    for (let i = 0; i < stacks.length; i += 1) {
      const stack = stacks[i];
      if (stack.available <= requiredNow) continue;
      crediblePressure += stack.available;
      if (stack.arrivalTick < enemyArrivalTick) {
        enemyArrivalTick = stack.arrivalTick;
        firstEnemyOrder = HYPOTHETICAL_ORDER;
      }
    }
    for (let i = 0; i < waves.length; i += 1) {
      const wave = waves[i];
      if (wave.owner === 'own') continue;
      pressure += wave.troops;
      inboundTroops += wave.troops;
      crediblePressure += wave.troops;
      if (
        wave.arrivalTick < enemyArrivalTick ||
        (wave.arrivalTick === enemyArrivalTick && wave.armyId < firstEnemyOrder)
      ) {
        enemyArrivalTick = wave.arrivalTick;
        firstEnemyOrder = wave.armyId;
      }
    }
    if (crediblePressure === 0) {
      // Advisory 10: the adjacent approximation can see nothing while a rear
      // stack attacks legally through an adjacent frontier. Pay for routing
      // only in this case, and treat the strongest such source as the threat
      // (not every legal source summed at once).
      const legal = strongestLegalAttack(territoryId, requiredNow);
      if (legal) {
        crediblePressure = legal.troops;
        enemyArrivalTick = legal.arrivalTick;
        firstEnemyOrder = legal.order;
      }
    }

    // Defence at the first credible enemy arrival. Later friendly waves are not
    // allowed to pre-credit an earlier attack; same-tick ties follow the engine
    // order (armyId ASC). The projection also applies target production and the
    // capacity clamp before that event.
    let garrisonAtAttack = territory ? territory.troops : 0;
    let shieldAtAttack = territory ? territory.shield : 0;
    if (territory && enemyArrivalTick < Infinity) {
      const projection = projectTargetArrival(
        state,
        owner,
        territoryId,
        enemyArrivalTick,
        firstEnemyOrder
      );
      if (projection && projection.ownerAtArrival === owner) {
        garrisonAtAttack = projection.troopsAtArrival;
        shieldAtAttack = projection.shieldAtArrival;
      }
    }
    const projectedDefense = territory
      ? Math.min(territory.capacity, garrisonAtAttack) + shieldAtAttack
      : 0;

    // Order-independent: the earliest arrival and the total timely mass are two
    // separate folds, so no source can hide behind an earlier iteration. This
    // fold plans routes for every own source, so it is lazy: ranking a frontier
    // must not pay for it.
    let timelyCache: { value: number; tick: number } | null = null;
    function computeTimely(): { value: number; tick: number } {
      if (timelyCache !== null) return timelyCache;
      let value = 0;
      let tick = Infinity;
      if (crediblePressure > 0) {
        for (let i = 0; i < sources.length; i += 1) {
          const source = sources[i];
          if (source.id === territoryId || source.available < 2) continue;
          const movement = reach.plan(source.id, territoryId);
          if (!movement) continue;
          const arrivalTick = state.tick + movement.travelTicks;
          if (arrivalTick < tick) tick = arrivalTick;
          if (arrivalTick <= enemyArrivalTick) value += source.available;
        }
      }
      // Existing friendly waves, target production and the capacity clamp have
      // already been applied to garrisonAtAttack. Potential help can only use
      // the room left at that real instant; it cannot claim the same space twice.
      const room = Math.max(0, (territory ? territory.capacity : 0) - garrisonAtAttack);
      timelyCache = { value: Math.min(value, room), tick: tick };
      return timelyCache;
    }

    // Doomed compares attack cost against attack cost, never raw troops against
    // a terrain-adjusted number, and the shield is not capped by garrison
    // capacity. The strict legal-source / continuous-wave check is expensive,
    // so it is lazy: callers that only rank risks never pay for it.
    let doomedCache: boolean | null = null;
    function computeDoomed(): boolean {
      if (doomedCache !== null) return doomedCache;
      if (
        territory === undefined ||
        (!isFrontier(state, territoryId) && inboundTroops <= 0) ||
        crediblePressure <= 0
      ) {
        doomedCache = false;
        return doomedCache;
      }
      const potentialDefense =
        Math.min(territory.capacity, garrisonAtAttack + computeTimely().value) +
        territory.shield;
      if (
        crediblePressure <
        requiredAttackCost(potentialDefense, territory.terrain) * doomedRatio
      ) {
        doomedCache = false;
        return doomedCache;
      }
      // The strict check (all legal sources, full wave order) only runs when
      // the cheap mass estimate already says the front is lost.
      doomedCache = fallsUnderWaves(territoryId, attackOptions(territoryId), territory);
      return doomedCache;
    }

    const ratio = projectedDefense > 0 ? crediblePressure / projectedDefense : crediblePressure;
    return {
      territoryId: territoryId,
      defense: defense,
      requiredNow: requiredNow,
      pressure: pressure,
      crediblePressure: crediblePressure,
      strongestEnemy: strongestEnemy,
      inbound: inboundTroops,
      enemyArrivalTick: enemyArrivalTick,
      get timelyReinforcement(): number {
        return computeTimely().value;
      },
      get reinforcementTick(): number {
        return computeTimely().tick;
      },
      projectedDefense: projectedDefense,
      risk: ratio,
      get doomed(): boolean {
        return computeDoomed();
      },
    };
  }

  function relationKey(): string {
    let key = String(state.tick) + '|';
    const diplomacy = state.diplomacy;
    if (!diplomacy) return key + '0';
    key +=
      (diplomacy.enabled ? '1' : '0') +
      '|' +
      (typeof diplomacy.uses === 'number' && isFinite(diplomacy.uses)
        ? Math.floor(diplomacy.uses)
        : 0) +
      '|';
    const truces = Array.isArray(diplomacy.truces) ? diplomacy.truces : [];
    for (let i = 0; i < truces.length; i += 1) {
      const truce = truces[i];
      key +=
        truce.a +
        ',' +
        truce.b +
        ',' +
        truce.startedTick +
        ',' +
        truce.expiresTick +
        ',' +
        truce.cooldownUntilTick +
        ',' +
        (truce.lastDecision ? truce.lastDecision.charAt(0) : '-') +
        ',' +
        (typeof truce.lastDecisionTick === 'number' ? truce.lastDecisionTick : -1) +
        ';';
    }
    return key;
  }

  const local: ThreatModel = {
    risk: function (territoryId: string): FrontlineRisk {
      if (!cache[territoryId]) cache[territoryId] = measure(territoryId);
      return cache[territoryId];
    },
  };
  let signature = relationKey();
  let active = local;
  return {
    risk: function (territoryId: string): FrontlineRisk {
      const current = relationKey();
      if (current !== signature) {
        // A caller may retain a model while a truce is offered, broken, or
        // expires. Rebuild every relation-dependent fold before serving the
        // next measurement; the route cache has the same version boundary.
        // The owner's own reach view is relation-dependent too (borrowed
        // transit changes reinforcement paths), so it is re-keyed here instead
        // of reusing the caller's stale planner.
        signature = current;
        active = createThreatModel(
          state,
          owner,
          cachedReachability(state, owner),
          doomedRatio,
          shared
        );
      }
      return active.risk(territoryId);
    },
  };
}

function pushEnemyStack(
  state: MatchState,
  owner: PlayerId,
  edge: Edge,
  ownId: string,
  otherId: string,
  out: Record<string, EnemyStack[]>
): void {
  const own = state.territories[ownId];
  const other = state.territories[otherId];
  if (!own || !other || own.owner !== owner) return;
  if (!isEnemyOf(owner, other.owner, state)) return;
  // Defensive re-check: only crossable edges may carry a threat stack, so the
  // model can never disagree with the route planner about the map topology.
  if (!isEdgePassable(layoutBoundaries(state.layout), edge)) return;
  const available = computeDispatch(other.troops, 1).available;
  if (!out[ownId]) out[ownId] = [];
  out[ownId].push({
    available: available,
    arrivalTick: state.tick + travelTicksForEdge(edge, other.marchLevel),
  });
}

export interface AdjacentEnemyThreat {
  available: number;
  /** Total garrison of the source before its reserve is kept. */
  troops: number;
  arrivalTick: number;
  sourceId: string;
}

/**
 * Every adjacent enemy source that can launch a wave, strongest first. One
 * entry per source even when several edges connect the pair: a source has one
 * troop pool, so it cannot fund two attacks from two edges.
 *
 * Deterministic: sort is available DESC, arrivalTick ASC, id ASC. The deadline
 * filter drops waves that would land after the match, exactly like the old
 * single-threat helper.
 */
export function adjacentEnemyThreats(
  state: MatchState,
  owner: PlayerId,
  territoryId: string,
  excludeId?: string,
  deadlineTick?: number
): AdjacentEnemyThreat[] {
  const territory = state.territories[territoryId];
  if (!territory) return [];
  const out: AdjacentEnemyThreat[] = [];
  const seen: Record<string, number> = {};
  const boundaries = layoutBoundaries(state.layout);
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    if (!isEdgePassable(boundaries, edge)) continue;
    let neighborId = '';
    if (edge.from === territoryId) neighborId = edge.to;
    else if (edge.to === territoryId) neighborId = edge.from;
    else continue;
    if (neighborId === excludeId) continue;
    const existing = seen[neighborId];
    if (existing !== undefined) continue;
    const neighbor = state.territories[neighborId];
    if (!neighbor || !isEnemyOf(owner, neighbor.owner, state)) continue;
    const available = computeDispatch(neighbor.troops, 1).available;
    const arrivalTick = state.tick + travelTicksForEdge(edge, neighbor.marchLevel);
    if (deadlineTick !== undefined && arrivalTick > deadlineTick) continue;
    seen[neighborId] = out.length;
    out.push({
      available: available,
      troops: Math.max(0, Math.floor(neighbor.troops)),
      arrivalTick: arrivalTick,
      sourceId: neighborId,
    });
  }
  out.sort(function (a, b) {
    if (b.available !== a.available) return b.available - a.available;
    if (a.arrivalTick !== b.arrivalTick) return a.arrivalTick - b.arrivalTick;
    return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;
  });
  return out;
}

/**
 * Strongest single adjacent enemy stack with the tick its wave could land.
 * Used by deadline-aware counter-risk, where a counter that cannot arrive
 * before the final tick must not veto a winning strike.
 */
export function strongestAdjacentEnemyThreat(
  state: MatchState,
  owner: PlayerId,
  territoryId: string,
  excludeId?: string,
  deadlineTick?: number
): AdjacentEnemyThreat | null {
  const threats = adjacentEnemyThreats(state, owner, territoryId, excludeId, deadlineTick);
  return threats.length > 0 ? threats[0] : null;
}

/**
 * Strongest adjacent enemy stack excluding one territory (the target of the
 * attack being evaluated, which may change hands). Used by counter-risk.
 */
export function strongestAdjacentEnemy(
  state: MatchState,
  owner: PlayerId,
  territoryId: string,
  excludeId?: string
): number {
  const threat = strongestAdjacentEnemyThreat(state, owner, territoryId, excludeId);
  return threat ? threat.available : 0;
}
