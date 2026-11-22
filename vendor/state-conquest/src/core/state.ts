import {
  BETRAYAL_INITIAL_DELAY_TICKS,
  BETRAYAL_MAX_LEVEL,
  CASUAL_PLAYER_START_BONUS,
  DEFAULT_REFERENCE_AREA,
  TICKS_PER_SECOND,
} from '../config/balance';
import { computeCannonRange } from './cannon';
import { capacityForArea } from './capacity';
import { createDisasterState } from './disaster';
import { createDiplomacy, toDiplomacySnapshot } from './diplomacy';
import { computeScores, computeTerritoryCounts, isFactionAlive } from './score';
import type {
  ArmySnapshot,
  Edge,
  FactionCount,
  MatchMode,
  MatchSnapshot,
  MatchState,
  PlayerId,
  Territory,
} from './types';
import { toFrontSnapshots } from './fronts';
import type { GameMapDefinition } from '../maps/types';
import { isTutorialMapId } from '../maps/tutorial-map';

function clonePolygon(polygon: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < polygon.length; i += 1) {
    out.push([polygon[i][0], polygon[i][1]]);
  }
  return out;
}

function cloneCenter(center: [number, number]): [number, number] {
  return [center[0], center[1]];
}

/** External unlock input: clamped to the configured 0..5 range. */
function normalizeBetrayalLevel(level: number | undefined): number {
  if (typeof level !== 'number' || !isFinite(level)) return 0;
  return Math.max(0, Math.min(BETRAYAL_MAX_LEVEL, Math.floor(level)));
}

/**
 * Seated owner slots per faction count, in canonical order. 2 keeps the exact
 * legacy pair; 3/4 append the additional AI slots.
 */
export function factionSeats(count: FactionCount): PlayerId[] {
  const seats: PlayerId[] = ['player', 'ai1'];
  if (count >= 3) seats.push('ai2');
  if (count >= 4) seats.push('ai3');
  return seats;
}

/**
 * Validates the requested faction count. Omitted/undefined = 2 (the exact
 * legacy default); anything that is not 2/3/4 throws — an illegal count is
 * never silently degraded.
 */
export function normalizeFactionCount(value: unknown): FactionCount {
  if (value === undefined || value === null) return 2;
  if (value === 2 || value === 3 || value === 4) return value;
  throw new Error(
    'Unsupported factionCount "' + String(value) + '". Use 2, 3 or 4.'
  );
}

export function createMatchState(
  map: GameMapDefinition,
  difficulty: MatchState['difficulty'],
  durationTicks: number,
  seed: number,
  betrayalLevel: number = 0,
  mode: MatchMode = 'solo',
  factionCount: FactionCount = 2,
  diplomacyEnabled: boolean = true
): MatchState {
  // Versus is by definition the two-human 2-faction layout; an explicit larger
  // count contradicts the mode and is refused instead of degraded.
  const requestedCount = normalizeFactionCount(factionCount);
  if (mode === 'versus') {
    if (requestedCount !== 2) {
      throw new Error('Versus matches are always 2-faction; got factionCount ' + requestedCount);
    }
  }
  const seats = factionSeats(requestedCount);
  const referenceArea =
    isFinite(map.referenceArea || 0) && (map.referenceArea || 0) > 0
      ? (map.referenceArea as number)
      : DEFAULT_REFERENCE_AREA;

  const territories: Record<string, Territory> = {};
  const order: string[] = [];
  const cannonRange = computeCannonRange(map, referenceArea);
  // Casual solo only: a real starting-garrison advantage for the player. The
  // bonus is clamped by each territory's own capacity, so it can never create
  // an illegal (> capacity) stack. Versus is human vs human and gets nothing.
  const casualBonus =
    difficulty === 'casual' && mode !== 'versus' ? CASUAL_PLAYER_START_BONUS : 0;
  for (let i = 0; i < map.territories.length; i += 1) {
    const definition = map.territories[i];
    const capacity = capacityForArea(definition.areaUnits, referenceArea);
    const bonus = casualBonus > 0 && definition.owner === 'player' ? casualBonus : 0;
    // With no bonus (every legacy difficulty, versus, and every non-player
    // territory) this is exactly the map garrison, preserving old behaviour
    // even for hand-built fixtures that intentionally exceed capacity.
    const troops = bonus > 0 ? Math.min(capacity, definition.initialTroops + bonus) : definition.initialTroops;
    const territory: Territory = {
      id: definition.id,
      name: definition.name,
      shortName: definition.shortName,
      owner: definition.owner,
      terrain: definition.terrain,
      troops: troops,
      capacity: capacity,
      productionLevel: 1,
      productionRemainder: 0,
      marchLevel: 1,
      defenseLevel: 0,
      shield: 0,
      shieldCapacity: 0,
      cannonRange: cannonRange,
      cannonReadyTick: 0,
      polygon: clonePolygon(definition.polygon),
      center: cloneCenter(definition.center),
      labelAnchor: definition.labelAnchor
        ? cloneCenter(definition.labelAnchor)
        : undefined,
      labelLeader: definition.labelLeader
        ? cloneCenter(definition.labelLeader)
        : undefined,
      scoreValue: definition.scoreValue,
      areaUnits: definition.areaUnits,
      initialTroops: definition.initialTroops,
      neutralRecoveryTarget: 0,
      neutralRecoveryRemainder: 0,
      lastDamagedTick: -1,
    };
    territories[definition.id] = territory;
    order.push(definition.id);
  }

  const edges: Edge[] = [];
  for (let i = 0; i < map.edges.length; i += 1) {
    const definition = map.edges[i];
    const travelFactor =
      typeof definition.travelFactor === 'number' && definition.travelFactor > 0
        ? definition.travelFactor
        : 1;
    edges.push({
      id: definition.id || definition.from + '-' + definition.to,
      from: definition.from,
      to: definition.to,
      kind: definition.kind,
      travelFactor: travelFactor,
    });
  }

  const spawnTerritories: Partial<Record<PlayerId, string[]>> = {};
  const activeOwners: PlayerId[] = [];
  for (let i = 0; i < seats.length; i += 1) {
    const owner = seats[i];
    const list = map.spawnTerritories[owner];
    if (list && list.length > 0) {
      spawnTerritories[owner] = list.slice();
      activeOwners.push(owner);
    }
  }
  // Ghost-owner guard: every non-neutral territory must belong to a seated
  // faction. Keeps the initialized counts consistent with activeOwners instead
  // of leaving a silent zombie owner that owns troops but can never act.
  for (let i = 0; i < order.length; i += 1) {
    const owner = territories[order[i]].owner;
    if (owner !== 'neutral' && activeOwners.indexOf(owner as PlayerId) < 0) {
      throw new Error(
        'Map "' + map.id + '" seats factionCount ' + requestedCount +
          ' but has unseated "' + owner + '" territories'
      );
    }
  }

  let playerTerritories = 0;
  for (let i = 0; i < order.length; i += 1) {
    if (territories[order[i]].owner === 'player') playerTerritories += 1;
  }

  return {
    status: 'ready',
    tick: 0,
    durationTicks: durationTicks,
    endReason: undefined,
    lastProgressTick: 0,
    stalemateWarned: false,
    diplomacy: createDiplomacy(
      mode === 'solo' && !isTutorialMapId(map.id) && diplomacyEnabled !== false
    ),
    seed: seed,
    mapId: map.id,
    mapName: map.name,
    mapWidth: map.width,
    mapHeight: map.height,
    difficulty: difficulty,
    mode: mode === 'versus' ? 'versus' : 'solo',
    factionCount: requestedCount,
    referenceArea: referenceArea,
    territoryOrder: order,
    territories: territories,
    edges: edges,
    armies: [],
    nextArmyId: 1,
    fronts: [],
    nextFrontId: 1,
    result: null,
    stats: {
      ordersByPlayer: 0,
      capturesByPlayer: 0,
      troopsSentByPlayer: 0,
      maxTerritoriesByPlayer: playerTerritories,
      upgradesByPlayer: 0,
    },
    activeOwners: activeOwners,
    spawnTerritories: spawnTerritories,
    events: [],
    skill: {
      betrayalLevel: normalizeBetrayalLevel(betrayalLevel),
      readyTick: BETRAYAL_INITIAL_DELAY_TICKS,
      uses: 0,
    },
    disaster: createDisasterState(seed, durationTicks),
    layout: map.layout,
    geog: map.geog,
    themeId: map.themeId,
    variantSize: map.variantSize,
  };
}

/** Deep-copy the simulation into the frozen snapshot contract. */
export function toMatchSnapshot(state: MatchState): MatchSnapshot {
  const territories = [];
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    territories.push({
      id: territory.id,
      name: territory.name,
      shortName: territory.shortName,
      owner: territory.owner,
      terrain: territory.terrain,
      troops: territory.troops,
      capacity: territory.capacity,
      productionLevel: territory.productionLevel,
      productionRemainder: territory.productionRemainder,
      marchLevel: territory.marchLevel,
      defenseLevel: territory.defenseLevel,
      shield: territory.shield,
      shieldCapacity: territory.shieldCapacity,
      cannonRange: territory.cannonRange,
      cannonReadyTick: territory.cannonReadyTick,
      polygon: clonePolygon(territory.polygon),
      center: cloneCenter(territory.center),
      labelAnchor: territory.labelAnchor ? cloneCenter(territory.labelAnchor) : undefined,
      labelLeader: territory.labelLeader ? cloneCenter(territory.labelLeader) : undefined,
      scoreValue: territory.scoreValue,
      areaUnits: territory.areaUnits,
    });
  }

  const edges = [];
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      travelFactor: edge.travelFactor,
    });
  }

  const armies: ArmySnapshot[] = [];
  const sortedArmies = state.armies.slice().sort(function (a, b) {
    return a.id - b.id;
  });
  for (let i = 0; i < sortedArmies.length; i += 1) {
    const army = sortedArmies[i];
    let routePoints: Array<[number, number]> | undefined;
    if (army.routePoints) {
      routePoints = [];
      for (let p = 0; p < army.routePoints.length; p += 1) {
        routePoints.push([army.routePoints[p][0], army.routePoints[p][1]]);
      }
    }
    const snapshotArmy: ArmySnapshot = {
      id: army.id,
      owner: army.owner,
      sourceId: army.sourceId,
      targetId: army.targetId,
      troops: army.troops,
      startTick: army.startTick,
      arrivalTick: army.arrivalTick,
      routePoints: routePoints,
    };
    if (army.frontId !== undefined) snapshotArmy.frontId = army.frontId;
    armies.push(snapshotArmy);
  }

  // Keep the pre-v1.2 snapshot shape byte-identical when no line was ever
  // created: `fronts` is only present when there is something to show.
  const frontSnapshots = toFrontSnapshots(state);

  // Seated factions are fixed; alive is derived per snapshot (a faction stays
  // alive while it owns a territory OR commands an in-flight army).
  const activeOwners = state.activeOwners.slice();
  const aliveOwners: PlayerId[] = [];
  for (let i = 0; i < activeOwners.length; i += 1) {
    if (isFactionAlive(state, activeOwners[i])) aliveOwners.push(activeOwners[i]);
  }

  return {
    status: state.status,
    tick: state.tick,
    durationTicks: state.durationTicks,
    endReason: state.endReason,
    lastProgressTick: state.lastProgressTick,
    stalemateWarned: state.stalemateWarned,
    diplomacy: toDiplomacySnapshot(state),
    mapId: state.mapId,
    mapName: state.mapName,
    mapWidth: state.mapWidth,
    mapHeight: state.mapHeight,
    difficulty: state.difficulty,
    mode: state.mode === 'versus' ? 'versus' : 'solo',
    factionCount: state.factionCount,
    activeOwners: activeOwners,
    aliveOwners: aliveOwners,
    seed: state.seed,
    territories: territories,
    edges: edges,
    armies: armies,
    ...(frontSnapshots.length > 0 ? { fronts: frontSnapshots } : {}),
    result: state.result,
    scores: computeScores(state),
    territoryCounts: computeTerritoryCounts(state),
    stats: {
      ordersByPlayer: state.stats.ordersByPlayer,
      capturesByPlayer: state.stats.capturesByPlayer,
      troopsSentByPlayer: state.stats.troopsSentByPlayer,
      maxTerritoriesByPlayer: state.stats.maxTerritoriesByPlayer,
      upgradesByPlayer: state.stats.upgradesByPlayer,
    },
    skill: {
      betrayalLevel: state.skill.betrayalLevel,
      readyTick: state.skill.readyTick,
      uses: state.skill.uses,
    },
    disaster: {
      scheduledAtTick: state.disaster.scheduledAtTick,
      struck: state.disaster.struck,
      warned: state.disaster.warned,
    },
    themeId: state.themeId,
    variantSize: state.variantSize,
    durationSeconds: state.durationTicks / TICKS_PER_SECOND,
    // Geography/boundary records are immutable map metadata; share the
    // precomputed reference instead of re-copying thousands of points per
    // snapshot. Legacy grid arrays keep their defensive copies.
    layout: state.layout
      ? {
          boundaryRow: state.layout.boundaryRow,
          passCols: state.layout.passCols ? state.layout.passCols.slice() : undefined,
          bridgeCols: state.layout.bridgeCols ? state.layout.bridgeCols.slice() : undefined,
          geography: state.layout.geography,
          boundaries: state.layout.boundaries,
        }
      : undefined,
    geog: state.geog,
    events: state.events.slice(),
  };
}
