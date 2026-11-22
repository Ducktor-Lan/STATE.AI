import type {
  Army,
  Edge,
  MatchState,
  Territory,
} from '../core/types';
import { cloneFronts } from '../core/fronts';
import { cloneDiplomacy } from '../core/diplomacy';

function cloneDiplomacyCompat(
  diplomacy: MatchState['diplomacy']
): MatchState['diplomacy'] {
  if (!diplomacy) return cloneDiplomacy(undefined);
  // Older hand-built fixtures may carry diplomacy without the v2 `uses` field
  // or even without a truce list. Normalize those shapes before cloning so the
  // AI copy remains usable while preserving every cooldown record present.
  const truces = Array.isArray(diplomacy.truces) ? diplomacy.truces : [];
  const normalized: MatchState['diplomacy'] = {
    enabled: diplomacy.enabled === true,
    uses:
      typeof diplomacy.uses === 'number' && isFinite(diplomacy.uses)
        ? diplomacy.uses
        : 0,
    truces: truces,
  };
  if (
    typeof diplomacy.aiOfferCooldownUntilTick === 'number' &&
    isFinite(diplomacy.aiOfferCooldownUntilTick)
  ) {
    normalized.aiOfferCooldownUntilTick = diplomacy.aiOfferCooldownUntilTick;
  }
  return cloneDiplomacy(normalized);
}

function cloneTerritory(source: Territory): Territory {
  const polygon: Array<[number, number]> = [];
  for (let i = 0; i < source.polygon.length; i += 1) {
    polygon.push([source.polygon[i][0], source.polygon[i][1]]);
  }
  return {
    id: source.id,
    name: source.name,
    shortName: source.shortName,
    owner: source.owner,
    terrain: source.terrain,
    troops: source.troops,
    capacity: source.capacity,
    productionLevel: source.productionLevel,
    productionRemainder: source.productionRemainder,
    marchLevel: source.marchLevel,
    defenseLevel: source.defenseLevel,
    shield: source.shield,
    shieldCapacity: source.shieldCapacity,
    cannonRange: source.cannonRange,
    cannonReadyTick: source.cannonReadyTick,
    polygon: polygon,
    center: [source.center[0], source.center[1]],
    labelAnchor: source.labelAnchor
      ? [source.labelAnchor[0], source.labelAnchor[1]]
      : undefined,
    labelLeader: source.labelLeader
      ? [source.labelLeader[0], source.labelLeader[1]]
      : undefined,
    scoreValue: source.scoreValue,
    areaUnits: source.areaUnits,
    initialTroops: source.initialTroops,
    neutralRecoveryTarget: source.neutralRecoveryTarget,
    neutralRecoveryRemainder: source.neutralRecoveryRemainder,
    lastDamagedTick: source.lastDamagedTick,
  };
}

function cloneEdge(source: Edge): Edge {
  return {
    id: source.id,
    from: source.from,
    to: source.to,
    kind: source.kind,
    travelFactor: source.travelFactor,
  };
}

function cloneArmy(source: Army): Army {
  let routePoints: Array<[number, number]> | undefined;
  if (source.routePoints) {
    routePoints = [];
    for (let i = 0; i < source.routePoints.length; i += 1) {
      routePoints.push([source.routePoints[i][0], source.routePoints[i][1]]);
    }
  }
  return {
    id: source.id,
    owner: source.owner,
    sourceId: source.sourceId,
    targetId: source.targetId,
    troops: source.troops,
    startTick: source.startTick,
    arrivalTick: source.arrivalTick,
    routePoints: routePoints,
    frontId: source.frontId,
  };
}

/**
 * Deep copy used for pure short-horizon search. The clone shares no arrays or
 * objects with the live match, so a failed prediction can never leak state.
 */
export function cloneMatchState(state: MatchState): MatchState {
  const territories: Record<string, Territory> = {};
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const id = state.territoryOrder[i];
    territories[id] = cloneTerritory(state.territories[id]);
  }
  const edges: Edge[] = [];
  for (let i = 0; i < state.edges.length; i += 1) edges.push(cloneEdge(state.edges[i]));
  const armies: Army[] = [];
  for (let i = 0; i < state.armies.length; i += 1) armies.push(cloneArmy(state.armies[i]));
  const spawns: MatchState['spawnTerritories'] = {};
  const keys = Object.keys(state.spawnTerritories) as Array<keyof MatchState['spawnTerritories']>;
  for (let i = 0; i < keys.length; i += 1) {
    const list = state.spawnTerritories[keys[i]];
    if (list) spawns[keys[i]] = list.slice();
  }

  return {
    status: state.status,
    tick: state.tick,
    durationTicks: state.durationTicks,
    endReason: state.endReason,
    lastProgressTick: state.lastProgressTick,
    stalemateWarned: state.stalemateWarned,
    diplomacy: cloneDiplomacyCompat(state.diplomacy),
    seed: state.seed,
    mapId: state.mapId,
    mapName: state.mapName,
    mapWidth: state.mapWidth,
    mapHeight: state.mapHeight,
    difficulty: state.difficulty,
    // Simulation context must survive cloning: production is owner- and
    // mode-aware (casual solo penalizes the AI; versus never does), so a
    // clone that dropped `mode` would mispredict a casual versus forecast.
    mode: state.mode,
    // Seating context must survive cloning for the same reason: validators and
    // score records are factionCount-aware.
    factionCount: state.factionCount,
    referenceArea: state.referenceArea,
    territoryOrder: state.territoryOrder.slice(),
    territories: territories,
    edges: edges,
    armies: armies,
    nextArmyId: state.nextArmyId,
    fronts: cloneFronts(state.fronts),
    nextFrontId:
      typeof state.nextFrontId === 'number' && isFinite(state.nextFrontId)
        ? state.nextFrontId
        : 1,
    result: state.result,
    stats: {
      ordersByPlayer: state.stats.ordersByPlayer,
      capturesByPlayer: state.stats.capturesByPlayer,
      troopsSentByPlayer: state.stats.troopsSentByPlayer,
      maxTerritoriesByPlayer: state.stats.maxTerritoriesByPlayer,
      upgradesByPlayer: state.stats.upgradesByPlayer,
    },
    activeOwners: state.activeOwners.slice(),
    spawnTerritories: spawns,
    events: [],
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
    layout: state.layout,
    geog: state.geog,
    themeId: state.themeId,
    variantSize: state.variantSize,
  };
}
