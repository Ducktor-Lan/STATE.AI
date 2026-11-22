/**
 * Frozen front-end API. The UI imports ONLY from this module.
 */
import { requiredAttackCost, terrainDefensePct } from './core/combat';
import { computeDispatch } from './core/dispatch';
import { computeUpgradePlan } from './core/commands';
import {
  BETRAYAL_MAX_LEVEL,
  DEFENSE_COSTS,
  MARCH_COSTS,
  MARCH_SPEED_MULTIPLIER,
  SHIELD_CAPACITY,
  UPGRADE_COSTS,
} from './config/balance';
import { productionRate } from './core/production';
import type { BetrayalReason, BetrayalResult } from './core/skills';
import { MatchEngine } from './core/engine';
import { normalizeSeed } from './core/rng';
import { inspectMoveRoute } from './core/reachability';
import { factionSeats, normalizeFactionCount } from './core/state';
import type {
  ContinuousFrontSnapshot,
  CreateMatchOptions,
  Difficulty,
  DispatchPlan,
  FactionCount,
  FrontCommandResult,
  MatchSession,
  MatchSnapshot,
  MatchEndReason,
  DiplomacySnapshot,
  PendingTruceOffer,
  TruceDecisionKind,
  TruceDecisionOutcome,
  TruceRecord,
  MoveEvaluation,
  OwnerId,
  PlannedMovement,
  PlayerId,
  TerritorySnapshot,
  TruceProposalReason,
  TruceProposalResult,
  UpgradeBenefit,
  UpgradeEvaluation,
  UpgradeKind,
} from './core/types';
import { DEFAULT_MAP_ID, getMapForMatch } from './maps';
import { validateMap } from './maps/validate-map';
import { durationToTicks, isSupportedDuration } from './config/modes';
import type { GameMapDefinition } from './maps/types';
import type { MatchEvent } from './core/events';

export type {
  ArmyRouteBoundary,
  ArmyRouteEndpoint,
  ArmySnapshot,
  ContinuousFront,
  ContinuousFrontSnapshot,
  CreateMatchOptions,
  DefenseLevel,
  Difficulty,
  DispatchPlan,
  EdgeSnapshot,
  FactionCount,
  Forecast,
  FrontAction,
  FrontCancelReason,
  FrontCommandResult,
  FrontEngagement,
  MapPoint,
  MarchLevel,
  MatchMode,
  MatchResult,
  MatchEndReason,
  DiplomacySnapshot,
  PendingTruceOffer,
  TruceDecisionKind,
  TruceDecisionOutcome,
  TruceRecord,
  MatchSession,
  MatchSnapshot,
  MatchStatsSnapshot,
  MatchStatus,
  MoveEvaluation,
  MoveReason,
  MoveRouteInspection,
  MoveRouteFailure,
  TruceDecisionFactors,
  OwnerId,
  PlannedMovement,
  PlayerId,
  TerritorySnapshot,
  Terrain,
  TruceProposalReason,
  TruceProposalResult,
  UpgradeBenefit,
  UpgradeEvaluation,
  UpgradeKind,
} from './core/types';

export { computeDispatch } from './core/dispatch';
export {
  getMap,
  listMaps,
  DEFAULT_MAP_ID,
  MAP_CATALOG,
  resolveMapVariant,
  getMapForMatch,
  selectSeededMap,
  listMapLibrary,
  MAP_LIBRARY,
  RANDOM_MAP_ID,
  TUTORIAL_DURATION_SECONDS,
  TUTORIAL_MAP_ID,
  TUTORIAL_SEED,
  TUTORIAL_TERRITORY,
  TUTORIAL_TERRITORY_IDS,
  isTutorialMapId,
  tutorialFirstSteps,
} from './maps';
export type { TutorialTerritoryId } from './maps';
export type { GameMapDefinition } from './maps/types';
export type {
  MapBoundaryKind,
  MapBoundaryMetadata,
  MapGeographyBrief,
  MapGeographyMetadata,
  MapLayoutMetadata,
  MapTerritoryDefinition,
} from './maps/types';
export type { MatchEvent } from './core/events';
export type { BetrayalReason, BetrayalResult } from './core/skills';

/**
 * The frozen `MatchSession` contract predates active skills, so the betrayal
 * call rides alongside it: `createMatch` returns this richer interface while
 * every existing consumer keeps working through the shared base type.
 */
export interface ConquestMatchSession extends MatchSession {
  issueBetrayal(): BetrayalResult;
  /** Ends the player's current solo/versus match as a loss. */
  resign(): boolean;
  /**
   * Player truce/alliance proposal (2.0.0). The request is first validated
   * (disabled mode, 2-faction endgame, ally limit, cooldowns, dead targets —
   * `ok: false` with a legality reason), then the receiving AI decides from
   * its own deterministic interest (`ok: true` with an accept- or reject-
   * prefixed reason and a score). Only `accepted: true` establishes the truce.
   */
  proposeTruce(target: PlayerId): TruceProposalResult;
  /** Accepts a pending AI invitation by its exact `pendingOffer.id`. */
  acceptTruceOffer?(offerId: string): TruceProposalResult;
  /** Rejects a pending AI invitation by its exact `pendingOffer.id`. */
  rejectTruceOffer?(offerId: string): boolean;
  /**
   * Boolean compatibility projection of `proposeTruce`: same legality rules,
   * same AI judgment; true only when the AI accepted and the truce exists.
   */
  offerTruce(target: PlayerId): boolean;
  /** Breaks an existing player-to-faction truce. */
  breakTruce(target: PlayerId): boolean;
  /** Current diplomacy state; empty when diplomacy is disabled. */
  diplomacy(): DiplomacySnapshot;
  /**
   * Owner-aware move for local versus. The UI binds a pointer to the owner of
   * the territory it started on and submits through this entry point; the core
   * validator rejects a source that does not belong to that owner.
   */
  issueMoveForOwner(owner: PlayerId, sourceId: string, targetId: string, ratio: number): boolean;
  /**
   * Starts (or re-targets) the continuous supply line of `sourceId`.
   * Same target as the live line stops it; another target replaces it in place.
   * Waves already in flight are never re-routed.
   */
  issueFront(sourceId: string, targetId: string, ratio: number): FrontCommandResult;
  issueFrontForOwner(
    owner: PlayerId,
    sourceId: string,
    targetId: string,
    ratio: number
  ): FrontCommandResult;
  /** Stops the player's line on `sourceId`; false when there is none. */
  stopFront(sourceId: string): boolean;
  stopFrontForOwner(owner: PlayerId, sourceId: string): boolean;
  /** Read-only copy of the live lines (same shape as `snapshot().fronts`). */
  fronts(): ContinuousFrontSnapshot[];
  /** True only for the dedicated tutorial battlefield. */
  isTutorial(): boolean;
  /**
   * Tutorial teaching step: the real world advances (arrivals, production,
   * lines, cannons, events) with no AI, no disaster and no early-end/timeout
   * check, so the lesson can wait and run past the scene clock. Ordinary
   * matches are rejected; freeze the lesson by simply not calling it.
   */
  tickWithoutAi(): boolean;
  /**
   * Tutorial only: grants a fresh full free-play window from the current tick
   * before normal `tick()` (AI + normal end rules) resumes. Existing armies,
   * fronts and cannon cooldowns keep their absolute schedules.
   */
  enterTutorialFreeplay(): boolean;
}

/*
 * Headless simulation entry points. The UI does not need these, but the
 * benchmark harness and tests drive actors explicitly with the exact same
 * rules: `advanceOneTick(state, { aiEnabled: false })` advances arrivals,
 * production and end checks; `runAiForOwner` runs a real AI pass for ANY
 * playerId through the unified validators.
 */
export {
  advanceOneTick,
  advanceSimulationOnly,
  MatchEngine,
} from './core/engine';
export { STALEMATE_WARNING_TICKS, STALEMATE_END_TICKS } from './core/stalemate';
export type { AdvanceOptions } from './core/engine';
export { runAiForOwner, planAiCommands, forecastAssault } from './ai';
export { createMatchState, toMatchSnapshot } from './core/state';
export { createRng, normalizeSeed } from './core/rng';
export type { Rng } from './core/rng';
export {
  armyPositionAt,
  armyRoutePoints,
  armyRouteSegmentsBetweenTicks,
  pointAlongRoute,
  polylineLength,
  routeCrossing,
  routeEndpointPoint,
} from './core/army-route';
export { resolveCannons, computeCannonRange } from './core/cannon';
export {
  travelTicksForRouteSegments,
  travelTicksForEdge,
} from './core/movement';
export type { RouteTravelSegment } from './core/movement';
export {
  canOwnerReachTarget,
  createOwnerReachability,
  ownerAttackTargets,
  ownerReachableTargets,
  sourceReachableTargets,
  sourceReachability,
  planMoveRoute,
  inspectMoveRoute,
} from './core/reachability';
export type { OwnerReachability, ReachabilityView, SourceReachability } from './core/reachability';
export {
  CONTINUOUS_MAX_WAVES_IN_FLIGHT,
  CONTINUOUS_MIN_BATCH,
  CONTINUOUS_SEND_INTERVAL_TICKS,
  cloneFronts,
  computeFrontPlan,
  frontForSource,
  frontsForOwner,
  resolveContinuousFronts,
  startFront,
  stopFront,
  toFrontSnapshots,
} from './core/fronts';
export type { FrontPlanResult } from './core/fronts';
export { resolveFrontBattle } from './core/combat';
export type { FrontBattleResolution } from './core/combat';

const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'casual'];

function isDifficulty(value: string): value is Difficulty {
  return DIFFICULTIES.indexOf(value as Difficulty) >= 0;
}

function findTerritory(
  snapshot: MatchSnapshot,
  territoryId: string
): TerritorySnapshot | null {
  for (let i = 0; i < snapshot.territories.length; i += 1) {
    if (snapshot.territories[i].id === territoryId) return snapshot.territories[i];
  }
  return null;
}

/**
 * Read-only prediction used by the gesture UI. It reuses the same dispatch and
 * battle-cost rules as the simulation but never mutates anything.
 *
 * Extra optional fields (defenderTroops / terrainDefensePct) are provided for
 * the preview panel; they do not change the frozen core fields.
 */
export function evaluateMove(
  snapshot: MatchSnapshot,
  sourceId: string,
  targetId: string,
  ratio: number,
  owner: PlayerId = 'player'
): MoveEvaluation {
  const source = findTerritory(snapshot, sourceId);
  const target = findTerritory(snapshot, targetId);
  const dispatch: DispatchPlan = computeDispatch(source ? source.troops : 0, ratio);
  const remaining = source ? Math.max(0, source.troops - dispatch.sent) : 0;

  if (
    snapshot.status !== 'playing' ||
    snapshot.tick >= snapshot.durationTicks
  ) {
    return {
      ok: false,
      reason: 'not_playing',
      available: dispatch.available,
      reserve: dispatch.reserve,
      sent: dispatch.sent,
      remaining: remaining,
      forecast: 'unknown',
    };
  }
  const route = inspectMoveRoute(snapshot, owner, sourceId, targetId);
  const movement = route.movement;
  if (!source || !target || !route.ok || !movement) {
    const reason = route.reason === 'source-not-owned' ? 'not_own'
      : route.reason === 'ally-target' ? 'truce'
        : route.reason === 'self' ? 'self' : route.reason === 'invalid' ? 'invalid' : 'not_adjacent';
    return {
      ok: false,
      reason: reason,
      route: route,
      available: dispatch.available,
      reserve: dispatch.reserve,
      sent: dispatch.sent,
      remaining: remaining,
      forecast: 'unknown',
    };
  }
  if (dispatch.sent <= 0) {
    return {
      ok: false,
      reason: 'no_troops',
      available: dispatch.available,
      reserve: dispatch.reserve,
      sent: 0,
      remaining: remaining,
      forecast: 'unknown',
      route: route,
      plannedMovement: movement,
      routePoints: movement.routePoints,
      travelTicks: movement.travelTicks,
    };
  }

  if (target.owner === owner) {
    return {
      ok: true,
      available: dispatch.available,
      reserve: dispatch.reserve,
      sent: dispatch.sent,
      remaining: remaining,
      forecast: 'reinforce',
      defenderTroops: target.troops,
      terrainDefensePct: terrainDefensePct(target.terrain),
      route: route,
      plannedMovement: movement,
      routePoints: movement.routePoints,
      travelTicks: movement.travelTicks,
    };
  }

  const cost = requiredAttackCost(target.troops + target.shield, target.terrain);
  return {
    ok: true,
    available: dispatch.available,
    reserve: dispatch.reserve,
    sent: dispatch.sent,
    remaining: remaining,
    forecast: dispatch.sent > cost ? 'capture' : 'repelled',
    requiredTroops: cost + 1,
    defenderTroops: target.troops,
    defenderShield: target.shield,
    terrainDefensePct: terrainDefensePct(target.terrain),
    route: route,
    plannedMovement: movement,
    routePoints: movement.routePoints,
    travelTicks: movement.travelTicks,
  };
}

function upgradeLevelFor(territory: TerritorySnapshot, kind: UpgradeKind): number {
  if (kind === 'march') return territory.marchLevel;
  if (kind === 'defense') return territory.defenseLevel;
  return territory.productionLevel;
}

function upgradeMaxLevel(kind: UpgradeKind): number {
  return kind === 'defense' ? 2 : 3;
}

function upgradeCostFor(kind: UpgradeKind, currentLevel: number): number {
  if (kind === 'defense') {
    if (currentLevel === 0) return DEFENSE_COSTS[0];
    if (currentLevel === 1) return DEFENSE_COSTS[1];
    return 0;
  }
  if (kind === 'march') {
    if (currentLevel === 1) return MARCH_COSTS[1];
    if (currentLevel === 2) return MARCH_COSTS[2];
    return 0;
  }
  if (currentLevel === 1) return UPGRADE_COSTS[1];
  if (currentLevel === 2) return UPGRADE_COSTS[2];
  return 0;
}

function upgradeBenefitFor(
  territory: TerritorySnapshot,
  kind: UpgradeKind,
  nextLevel: number
): UpgradeBenefit {
  if (kind === 'production') {
    return {
      productionRateFrom: productionRate(territory.productionLevel),
      productionRateTo: productionRate(nextLevel as 1 | 2 | 3),
    };
  }
  if (kind === 'march') {
    return {
      marchSpeedFrom: MARCH_SPEED_MULTIPLIER[territory.marchLevel],
      marchSpeedTo: MARCH_SPEED_MULTIPLIER[nextLevel as 1 | 2 | 3],
    };
  }
  const from = SHIELD_CAPACITY[territory.defenseLevel];
  const to = SHIELD_CAPACITY[nextLevel as 0 | 1 | 2];
  return {
    shieldCapacityFrom: from,
    shieldCapacityTo: to,
    shieldGain: Math.max(0, to - from),
    unlocksCannon: nextLevel === 2,
  };
}

/**
 * Read-only upgrade preview for the UI. Uses the same costs, caps, owner and
 * playing checks as computeUpgradePlan/applyUpgrade; it never mutates.
 */
export function evaluateUpgrade(
  snapshot: MatchSnapshot,
  territoryId: string,
  kindParam?: UpgradeKind
): UpgradeEvaluation {
  const kind: UpgradeKind =
    kindParam === 'march' || kindParam === 'defense' ? kindParam : 'production';
  const territory = findTerritory(snapshot, territoryId);
  if (!territory) {
    return {
      ok: false,
      reason: 'invalid',
      kind: kind,
      cost: 0,
      currentLevel: 0,
      nextLevel: 0,
      remaining: 0,
      benefit: {},
    };
  }
  const currentLevel = upgradeLevelFor(territory, kind);
  const maxed = currentLevel >= upgradeMaxLevel(kind);
  const nextLevel = maxed ? currentLevel : currentLevel + 1;
  const cost = upgradeCostFor(kind, currentLevel);
  const benefit = upgradeBenefitFor(territory, kind, nextLevel);
  const fail = function (reason: UpgradeEvaluation['reason']): UpgradeEvaluation {
    return {
      ok: false,
      reason: reason,
      kind: kind,
      cost: cost,
      currentLevel: currentLevel,
      nextLevel: nextLevel,
      remaining: territory.troops,
      benefit: benefit,
    };
  };

  if (snapshot.status !== 'playing' || snapshot.tick >= snapshot.durationTicks) {
    return fail('not_playing');
  }
  if (territory.owner !== 'player') return fail('not_own');
  if (maxed) return fail('invalid');
  if (territory.troops <= cost) return fail('no_troops');
  return {
    ok: true,
    kind: kind,
    cost: cost,
    currentLevel: currentLevel,
    nextLevel: nextLevel,
    remaining: territory.troops - cost,
    benefit: benefit,
  };
}

class EngineMatchSession implements ConquestMatchSession {
  private readonly engine: MatchEngine;

  constructor(engine: MatchEngine) {
    this.engine = engine;
  }

  snapshot(): MatchSnapshot {
    return this.engine.snapshot();
  }

  start(): void {
    this.engine.start();
  }

  pause(): void {
    this.engine.pause();
  }

  resume(): void {
    this.engine.resume();
  }

  tick(): void {
    this.engine.tick();
  }

  issueMove(sourceId: string, targetId: string, ratio: number): boolean {
    return this.engine.issueMove(sourceId, targetId, ratio);
  }

  issueMoveForOwner(
    owner: PlayerId,
    sourceId: string,
    targetId: string,
    ratio: number
  ): boolean {
    return this.engine.issueMoveForOwner(owner, sourceId, targetId, ratio);
  }

  issueFront(sourceId: string, targetId: string, ratio: number): FrontCommandResult {
    return this.engine.issueFront(sourceId, targetId, ratio);
  }

  issueFrontForOwner(
    owner: PlayerId,
    sourceId: string,
    targetId: string,
    ratio: number
  ): FrontCommandResult {
    return this.engine.issueFrontForOwner(owner, sourceId, targetId, ratio);
  }

  stopFront(sourceId: string): boolean {
    return this.engine.stopFront(sourceId);
  }

  stopFrontForOwner(owner: PlayerId, sourceId: string): boolean {
    return this.engine.stopFrontForOwner(owner, sourceId);
  }

  fronts(): ContinuousFrontSnapshot[] {
    return this.engine.snapshot().fronts || [];
  }

  isTutorial(): boolean {
    return this.engine.isTutorial();
  }

  tickWithoutAi(): boolean {
    return this.engine.tickWithoutAi();
  }

  enterTutorialFreeplay(): boolean {
    return this.engine.enterTutorialFreeplay();
  }

  upgrade(territoryId: string, kind?: UpgradeKind): boolean {
    return this.engine.upgrade(territoryId, kind);
  }

  /**
   * Issues the player's active skill. Illegal attempts never mutate the match
   * and return a `reason` (locked/cooldown/no_target/not_playing); a success
   * carries the chosen target plus the battle outcome for the UI effects.
   */
  issueBetrayal(): BetrayalResult {
    return this.engine.issueBetrayal();
  }

  resign(): boolean {
    return this.engine.resign();
  }

  proposeTruce(target: PlayerId): TruceProposalResult {
    return this.engine.proposeTruce(target);
  }

  acceptTruceOffer(offerId: string): TruceProposalResult {
    return this.engine.acceptTruceOffer(offerId);
  }

  rejectTruceOffer(offerId: string): boolean {
    return this.engine.rejectTruceOffer(offerId);
  }

  offerTruce(target: PlayerId): boolean {
    return this.engine.offerTruce(target);
  }

  breakTruce(target: PlayerId): boolean {
    return this.engine.breakTruce(target);
  }

  diplomacy(): DiplomacySnapshot {
    return this.engine.diplomacy();
  }

  /** UI helper: returns and clears pending overflow/capture/upgrade events. */
  drainEvents(): MatchEvent[] {
    return this.engine.drainEvents();
  }

  /** UI helper: peeks at pending events without clearing them. */
  peekEvents(): MatchEvent[] {
    return this.engine.lastEvents();
  }
}

function randomSeed(): number {
  const mixed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  return normalizeSeed(mixed);
}

/**
 * Seat validation: every AI slot of the requested faction count must have a
 * real spawn on the map. A missing seat throws — an illegal map/faction pair is
 * never silently degraded to a smaller match.
 */
function checkMapSupportsFactions(map: GameMapDefinition, factionCount: FactionCount): void {
  const seats = factionSeats(factionCount);
  const missing: string[] = [];
  for (let i = 1; i < seats.length; i += 1) {
    const list = map.spawnTerritories[seats[i]];
    if (!list || list.length === 0) missing.push(seats[i]);
  }
  if (missing.length > 0) {
    throw new Error(
      'Map "' + map.id + '" does not support ' + factionCount +
        '-faction matches (missing spawns: ' + missing.join(', ') + ')'
    );
  }
}

/**
 * `CreateMatchOptions` is core-owned and frozen for this milestone, so the
 * commander-archive betrayal level rides alongside it here. The engine clamps
 * the value again; the UI only ever supplies a purchased 0..5 level.
 */
export type MatchCreateOptions = CreateMatchOptions & {
  betrayalLevel?: number;
};

function normalizeBetrayalLevel(value: unknown): number {
  if (typeof value !== 'number' || !isFinite(value)) return 0;
  return Math.max(0, Math.min(BETRAYAL_MAX_LEVEL, Math.floor(value)));
}

/**
 * Creates a deterministic match. The caller must invoke start() (normally after
 * the 3-2-1 countdown) before tick() advances the simulation.
 */
export function createMatch(options: MatchCreateOptions): ConquestMatchSession {
  if (!options || typeof options !== 'object') {
    throw new Error('createMatch requires an options object');
  }
  const durationSeconds = options.durationSeconds;
  if (!isFinite(durationSeconds) || !isSupportedDuration(durationSeconds)) {
    throw new Error(
      'Unsupported durationSeconds "' + String(durationSeconds) + '". Use 180, 300 or 480.'
    );
  }
  const difficulty = options.difficulty;
  if (typeof difficulty !== 'string' || !isDifficulty(difficulty)) {
    throw new Error('Unsupported difficulty "' + String(difficulty) + '"');
  }

  const factionCount = normalizeFactionCount(options.factionCount);
  const mode = options.mode === 'versus' ? 'versus' : 'solo';
  if (mode === 'versus' && factionCount !== 2) {
    throw new Error(
      'Versus matches are always 2-faction; got factionCount ' + factionCount
    );
  }

  const seed =
    typeof options.seed === 'number' ? normalizeSeed(options.seed) : randomSeed();
  const requested =
    typeof options.mapId === 'string' &&
    options.mapId.length > 0 &&
    options.mapId !== 'random'
      ? options.mapId
      : undefined;
  // The map library resolves 'random'/undefined exactly once from the already
  // normalized seed. Map selection never touches the gameplay RNG stream.
  // The 4th factionCount argument is the v1.4.0 map contract (the map module
  // owns its implementation and caching).
  const resolved = getMapForMatch(requested, durationSeconds, seed, factionCount);
  const map = resolved.map;
  const validation = validateMap(map);
  if (!validation.ok) {
    throw new Error('Invalid map "' + map.id + '": ' + validation.errors.join('; '));
  }
  if (map.supportedDurations.indexOf(durationSeconds) < 0) {
    throw new Error(
      'Map "' + map.id + '" does not support ' + durationSeconds + ' second matches'
    );
  }
  checkMapSupportsFactions(map, factionCount);

  const engine = new MatchEngine(
    map,
    difficulty,
    durationSeconds,
    seed,
    normalizeBetrayalLevel(options.betrayalLevel),
    mode,
    factionCount,
    options.diplomacyEnabled !== false
  );
  return new EngineMatchSession(engine);
}

export { durationToTicks };
export type {
  MapCatalog,
  MapResolution,
  MapThemeInfo,
  MapVariantInfo,
} from './maps/catalog-types';
export type { MapLibraryRecord, MapLibrarySummary } from './maps/library-types';
