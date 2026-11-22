import {
  CANNON_COOLDOWN_TICKS,
  CANNON_DAMAGE,
  CANNON_RANGE_FACTOR,
  CANNON_RANGE_MAX_DIAGONAL_SHARE,
  CANNON_RANGE_MIN_DIAGONAL_SHARE,
} from '../config/balance';
import {
  armyRouteSegmentsBetweenTicks,
  routeEndpointPoint,
  segmentImpactPoint,
  segmentWithinRange,
} from './army-route';
import { pushEvent } from './events';
import { isHostile } from './diplomacy';
import type { MatchState, Army, MapPoint, Territory } from './types';
import type { GameMapDefinition, MapBoundaryMetadata } from '../maps/types';

function polygonArea(points: Array<[number, number]>): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    sum += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(sum) / 2;
}

/**
 * Map-wide cannon radius in map coordinates.
 *
 * referenceArea is expressed in source/projection units while polygons live in
 * rendered map units, so the ratio of rendered polygon area to logical source
 * area is the squared map/source scale. The radius is
 *   0.85 * sqrt(referenceArea * areaScale)
 * clamped to a sane share of the map diagonal. This depends only on immutable
 * map metadata: canvas size, zoom and viewport never change it.
 */
export function computeCannonRange(map: GameMapDefinition, referenceArea: number): number {
  let renderedArea = 0;
  let logicalArea = 0;
  for (let i = 0; i < map.territories.length; i += 1) {
    const territory = map.territories[i];
    const area = territory.areaUnits;
    if (!isFinite(area) || area <= 0) continue;
    renderedArea += polygonArea(territory.polygon);
    logicalArea += area;
  }
  const scaleSq = logicalArea > 0 && renderedArea > 0 ? renderedArea / logicalArea : 1;
  const raw = CANNON_RANGE_FACTOR * Math.sqrt(Math.max(0, referenceArea) * scaleSq);
  const diagonal = Math.sqrt(map.width * map.width + map.height * map.height);
  const min = diagonal * CANNON_RANGE_MIN_DIAGONAL_SHARE;
  const max = diagonal * CANNON_RANGE_MAX_DIAGONAL_SHARE;
  const clamped = Math.max(min, Math.min(max, raw));
  return Math.round(clamped * 1000) / 1000;
}

interface CannonTarget {
  army: Army;
  impact: MapPoint;
}

function selectTarget(
  state: MatchState,
  tower: Territory,
  center: MapPoint,
  boundaries: MapBoundaryMetadata[] | undefined
): CannonTarget | null {
  let best: CannonTarget | null = null;
  for (let i = 0; i < state.armies.length; i += 1) {
    const army = state.armies[i];
    if (army.troops <= 0) continue;
    if (army.owner === tower.owner) continue;
    if (!isHostile(state, tower.owner as Exclude<typeof tower.owner, 'neutral'>, army.owner)) continue;
    const source = state.territories[army.sourceId];
    const target = state.territories[army.targetId];
    if (!source || !target) continue;
    const segments = armyRouteSegmentsBetweenTicks(
      army,
      source,
      target,
      boundaries,
      state.tick - 1,
      state.tick
    );
    let impact: MapPoint | null = null;
    for (let s = 0; s < segments.length; s += 1) {
      const segment = segments[s];
      if (!segmentWithinRange(segment[0], segment[1], center, tower.cannonRange)) continue;
      impact = segmentImpactPoint(segment[0], segment[1], center, tower.cannonRange);
      break;
    }
    if (!impact) continue;
    if (
      best === null ||
      army.arrivalTick < best.army.arrivalTick ||
      (army.arrivalTick === best.army.arrivalTick && army.id < best.army.id)
    ) {
      best = { army: army, impact: impact };
    }
  }
  return best;
}

/**
 * One cannon phase. Runs after AI commands and before arrivals, so an army
 * whose arrivalTick is now can be hit while still in flight. Each defense-2
 * territory fires at most one shot and only sets its cooldown when it fires.
 */
export function resolveCannons(state: MatchState): void {
  if (state.status !== 'playing') return;
  const boundaries = state.layout ? state.layout.boundaries : undefined;
  const dead: Army[] = [];

  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const tower = state.territories[state.territoryOrder[i]];
    if (!tower) continue;
    if (tower.defenseLevel < 2) continue;
    const towerOwner = tower.owner;
    if (towerOwner === 'neutral') continue;
    if (tower.cannonReadyTick > state.tick) continue;
    if (!(tower.cannonRange > 0)) continue;

    const center = routeEndpointPoint(tower);
    const target = selectTarget(state, tower, center, boundaries);
    if (!target) continue;

    const army = target.army;
    const actualDamage = Math.min(CANNON_DAMAGE, army.troops);
    army.troops -= actualDamage;
    tower.cannonReadyTick = state.tick + CANNON_COOLDOWN_TICKS;
    pushEvent(state.events, {
      type: 'cannon',
      tick: state.tick,
      targetId: tower.id,
      amount: actualDamage,
      owner: towerOwner,
      targetArmyId: army.id,
      from: [center[0], center[1]],
      to: [target.impact[0], target.impact[1]],
    });
    if (army.troops <= 0) dead.push(army);
  }

  if (dead.length > 0) {
    const alive: Army[] = [];
    for (let i = 0; i < state.armies.length; i += 1) {
      const army = state.armies[i];
      if (army.troops > 0 && dead.indexOf(army) < 0) alive.push(army);
    }
    state.armies = alive;
  }
}
