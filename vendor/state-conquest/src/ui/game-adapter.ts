import {
  TUTORIAL_DURATION_SECONDS,
  TUTORIAL_MAP_ID,
  TUTORIAL_SEED,
  TUTORIAL_TERRITORY,
  computeDispatch,
  createMatch,
  evaluateMove,
  evaluateUpgrade,
  ownerReachableTargets,
  sourceReachability,
} from '../game-api';
import type {
  BetrayalResult,
  ConquestMatchSession,
  ContinuousFrontSnapshot,
  FrontCommandResult,
  MatchEvent,
  MatchMode,
  MatchSnapshot,
  PlayerId,
  TruceProposalResult,
  UpgradeEvaluation,
} from '../game-api';
import type {
  ArmyView,
  BoundaryView,
  DispatchPlan,
  FrontView,
  GameSettings,
  GeographyBriefView,
  GeographyView,
  MatchView,
  MoveForecast,
  MovePreview,
  TerritoryView,
  UpgradeEvaluationDetail,
  UpgradeKind,
} from './view-model';

export type CoreEvent = MatchEvent;

type TruceOfferSession = ConquestMatchSession & {
  acceptTruceOffer?: (offerId: string) => TruceProposalResult;
  rejectTruceOffer?: (offerId: string) => boolean;
};

/**
 * Stable ids of the teaching battlefield, re-exported for the tutorial shell.
 * Every value is taken from the real map metadata exported by game-api, so the
 * UI never keeps a private copy that could drift from the validated map.
 */
export const TUTORIAL_SCENE = {
  mapId: TUTORIAL_MAP_ID,
  durationSeconds: TUTORIAL_DURATION_SECONDS,
  seed: TUTORIAL_SEED,
  /** Player's starting city: initial drag source. */
  initialSourceId: TUTORIAL_TERRITORY.home,
  /** Weak neutral village: first capture target. */
  initialTargetId: TUTORIAL_TERRITORY.neutral,
  captureTargetId: TUTORIAL_TERRITORY.neutral,
  /** Upgrade on the home city so the captured village keeps its assault force. */
  upgradeTerritoryId: TUTORIAL_TERRITORY.home,
  /** Enemy outpost reached through the captured village. */
  enemyTargetId: TUTORIAL_TERRITORY.enemy,
  /** Enemy rear: guarantees the enemy faction survives the teaching wave. */
  enemyReserveId: TUTORIAL_TERRITORY.enemyReserve,
} as const;

export interface GameAdapter {
  /** Requested settings; mapId may be "random" until the core resolves it. */
  readonly settings: GameSettings;
  /** Concrete map id chosen by the seeded core library. */
  readonly mapId: string;
  /** Seed used for this match (also exposed on the snapshot/view). */
  readonly seed: number;
  /** Resolved mode: 'solo' unless the caller requested 'versus'. */
  readonly mode: MatchMode;
  /** True only when this adapter drives the fixed tutorial battlefield. */
  readonly tutorial: boolean;
  view(): MatchView;
  rawSnapshot(): MatchSnapshot;
  /** Skill/disaster flags for the HUD, cached per adapter revision. */
  hudState(): HudState;
  drainEvents(): CoreEvent[];
  start(): void;
  pause(): void;
  resume(): void;
  tick(): void;
  /** True only for the dedicated tutorial battlefield. */
  isTutorial(): boolean;
  /**
   * Tutorial teaching step: the real world advances (arrivals, production,
   * lines, cannons, events) with no AI, no disaster and no end check, so the
   * lesson can wait and run past the scene clock. Rejected for normal matches.
   * The shell freezes the scene by simply not calling this function.
   */
  tickWithoutAi(): boolean;
  /**
   * Tutorial only: grants a fresh full free-play window from the current tick
   * before the shell switches to normal `tick()` (AI and normal end rules).
   */
  enterTutorialFreeplay(): boolean;
  issueMove(sourceId: string, targetId: string, ratio: number): boolean;
  /** Versus: submit for the owner a finger is bound to (core re-validates). */
  issueMoveForOwner(
    owner: PlayerId,
    sourceId: string,
    targetId: string,
    ratio: number
  ): boolean;
  /**
   * Continuous supply line. Same target as the live line stops it; another
   * target replaces it in place. Waves already in flight are never re-routed.
   */
  issueFront(sourceId: string, targetId: string, ratio: number): FrontCommandResult;
  issueFrontForOwner(
    owner: PlayerId,
    sourceId: string,
    targetId: string,
    ratio: number
  ): FrontCommandResult;
  stopFront(sourceId: string, owner?: PlayerId): boolean;
  /** Live lines, identical to `view().fronts` (one copy per revision). */
  fronts(): ContinuousFrontSnapshot[];
  upgrade(territoryId: string, kind: UpgradeKind): boolean;
  /** Active skill; failures carry a core reason and never mutate the match. */
  issueBetrayal(): BetrayalResult;
  resign(): boolean;
  offerTruce(target: PlayerId): boolean;
  /**
   * Truce/alliance proposal: legality check plus a real AI verdict.
   * `ok: false` reasons are legality refusals (the AI never judged);
   * `accept-*`/`reject-*` reasons are genuine AI interest decisions.
   */
  proposeTruce(target: PlayerId): TruceProposalResult;
  breakTruce(target: PlayerId): boolean;
  /** Optional while older fake adapters are still used by UI tests. */
  acceptTruceOffer?: (offerId: string) => TruceProposalResult | undefined;
  /** Optional while older fake adapters are still used by UI tests. */
  rejectTruceOffer?: (offerId: string) => boolean | undefined;
  /** False when the underlying session predates the offer response API. */
  truceOfferActionsAvailable?: boolean;
  diplomacy(): import('../game-api').DiplomacySnapshot;
  preview(
    sourceId: string,
    targetId: string,
    ratio: number,
    owner?: PlayerId
  ): MovePreview;
  plan(sourceId: string, ratio: number): DispatchPlan;
  evaluateUpgrade(territoryId: string, kind: UpgradeKind): UpgradeEvaluationDetail;
  /** Monotonic change counter; bumps on tick, start/pause/resume and commands. */
  revision(): number;
  /** Reachability helper result, cached until the next revision. */
  reachableTargets(owner: PlayerId): string[];
  sourceReachableTargets(owner: PlayerId, sourceId: string): string[];
  sourceReachability?(owner: PlayerId, sourceId: string): import('../game-api').SourceReachability;
  lastMessage(): string | null;
  commandLog(): unknown[];
}

export interface HudSkillState {
  betrayalLevel: number;
  readyTick: number;
  uses: number;
}

export interface HudDisasterState {
  scheduledAtTick: number | null;
  struck: boolean;
  warned: boolean;
}

export interface HudState {
  tick: number;
  skill: HudSkillState;
  disaster: HudDisasterState;
}

export interface ResolvedMatch {
  mapId: string;
  themeId: string;
  size: number;
  durationSeconds: number;
}

function mapSize(snapshot: MatchSnapshot): { width: number; height: number } {
  let maxX = 1;
  let maxY = 1;
  for (let i = 0; i < snapshot.territories.length; i += 1) {
    const polygon = snapshot.territories[i].polygon;
    for (let p = 0; p < polygon.length; p += 1) {
      if (polygon[p][0] > maxX) maxX = polygon[p][0];
      if (polygon[p][1] > maxY) maxY = polygon[p][1];
    }
  }
  return {
    width: snapshot.mapWidth && snapshot.mapWidth > 0 ? snapshot.mapWidth : maxX,
    height: snapshot.mapHeight && snapshot.mapHeight > 0 ? snapshot.mapHeight : maxY,
  };
}

function copyTerritory(source: MatchSnapshot['territories'][number]): TerritoryView {
  return {
    id: source.id,
    name: source.name,
    shortName: source.shortName,
    owner: source.owner,
    terrain: source.terrain,
    troops: source.troops,
    capacity: source.capacity,
    productionLevel: source.productionLevel,
    marchLevel: source.marchLevel,
    defenseLevel: source.defenseLevel,
    shield: source.shield,
    shieldCapacity: source.shieldCapacity,
    cannonRange: source.cannonRange,
    cannonReadyTick: source.cannonReadyTick,
    polygon: source.polygon,
    center: source.center,
    labelAnchor: source.labelAnchor,
    labelLeader: source.labelLeader,
    scoreValue: source.scoreValue,
    areaUnits: source.areaUnits,
  };
}

function copyBoundaries(
  source: MatchSnapshot['layout']
): BoundaryView[] | undefined {
  if (!source || !source.boundaries) return undefined;
  const out: BoundaryView[] = [];
  for (let i = 0; i < source.boundaries.length; i += 1) {
    const boundary = source.boundaries[i];
    out.push({
      id: boundary.id,
      from: boundary.from,
      to: boundary.to,
      points: boundary.points,
      kind: boundary.kind,
      passable: boundary.passable,
      edgeId: boundary.edgeId,
      crossing: boundary.crossing,
      length: boundary.length,
      midpoint: boundary.midpoint,
    });
  }
  return out;
}

function copyGeography(source: MatchSnapshot['layout']): GeographyView | undefined {
  if (!source || !source.geography) return undefined;
  const geography = source.geography;
  return {
    country: geography.country,
    sourceLabel: geography.sourceLabel,
    sourceLicense: geography.sourceLicense,
    projection: geography.projection,
    regionLabel: geography.regionLabel,
    regionNote: geography.regionNote,
    states: geography.states,
    groups: geography.groups,
    barrier: geography.barrier,
  };
}

function copyBrief(source: MatchSnapshot['geog']): GeographyBriefView | undefined {
  if (!source) return undefined;
  return {
    regionLabel: source.regionLabel,
    sourceLabel: source.sourceLabel,
  };
}

function computeScores(territories: TerritoryView[]): MatchView['scores'] {
  const scores = { player: 0, ai1: 0, ai2: 0, ai3: 0 };
  for (let i = 0; i < territories.length; i += 1) {
    const territory = territories[i];
    if (territory.owner === 'player') scores.player += territory.scoreValue;
    else if (territory.owner === 'ai1') scores.ai1 += territory.scoreValue;
    else if (territory.owner === 'ai2') scores.ai2 += territory.scoreValue;
    else if (territory.owner === 'ai3') scores.ai3 += territory.scoreValue;
  }
  return scores;
}

function computeCounts(territories: TerritoryView[]): MatchView['territoryCounts'] {
  const counts = { player: 0, ai1: 0, ai2: 0, ai3: 0 };
  for (let i = 0; i < territories.length; i += 1) {
    const owner = territories[i].owner;
    if (owner === 'player') counts.player += 1;
    else if (owner === 'ai1') counts.ai1 += 1;
    else if (owner === 'ai2') counts.ai2 += 1;
    else if (owner === 'ai3') counts.ai3 += 1;
  }
  return counts;
}

/**
 * Fallback for pre-1.4 snapshots without seating metadata: derive the seated
 * factions from the owners actually present on the board. The formal core
 * snapshot always carries the exact values, so this never runs in production.
 */
function fallbackActiveOwners(territories: TerritoryView[]): MatchView['activeOwners'] {
  const seats: MatchView['activeOwners'] = [];
  const seated: Record<string, boolean> = {};
  const order: MatchView['activeOwners'] = ['player', 'ai1', 'ai2', 'ai3'];
  for (let i = 0; i < territories.length; i += 1) {
    const owner = territories[i].owner;
    if (owner !== 'neutral') seated[owner] = true;
  }
  for (let i = 0; i < order.length; i += 1) {
    const owner = order[i];
    if (owner && seated[owner]) seats.push(owner);
  }
  return seats;
}

/**
 * Fallback mirror of the core `isFactionAlive` rule: a seated faction stays
 * alive while it owns a territory OR commands an in-flight army.
 */
function fallbackAliveOwners(
  territories: TerritoryView[],
  armies: ArmyView[],
  activeOwners: MatchView['activeOwners']
): MatchView['aliveOwners'] {
  const out: MatchView['aliveOwners'] = [];
  if (!activeOwners) return out;
  for (let i = 0; i < activeOwners.length; i += 1) {
    const owner = activeOwners[i];
    let alive = false;
    for (let t = 0; t < territories.length && !alive; t += 1) {
      if (territories[t].owner === owner) alive = true;
    }
    for (let a = 0; a < armies.length && !alive; a += 1) {
      if (armies[a].owner === owner) alive = true;
    }
    if (alive) out.push(owner);
  }
  return out;
}

function normalizeForecast(value: string | undefined): MoveForecast {
  if (value === 'capture' || value === 'repelled' || value === 'reinforce') return value;
  return 'unknown';
}

function copyArmies(armies: MatchSnapshot['armies']): ArmyView[] {
  const out: ArmyView[] = [];
  for (let i = 0; i < armies.length; i += 1) {
    const army = armies[i];
    out.push({
      id: army.id,
      owner: army.owner,
      sourceId: army.sourceId,
      targetId: army.targetId,
      troops: army.troops,
      startTick: army.startTick,
      arrivalTick: army.arrivalTick,
      // Deep copy the frozen path so the view never aliases mutable core data.
      routePoints: army.routePoints
        ? army.routePoints.map(function (point) {
            return [point[0], point[1]] as [number, number];
          })
        : undefined,
      frontId: army.frontId,
    });
  }
  return out;
}

function copyFronts(fronts: ContinuousFrontSnapshot[] | undefined): FrontView[] | undefined {
  if (!fronts) return undefined;
  const out: FrontView[] = [];
  for (let i = 0; i < fronts.length; i += 1) {
    const front = fronts[i];
    out.push({
      id: front.id,
      owner: front.owner,
      sourceId: front.sourceId,
      targetId: front.targetId,
      ratio: front.ratio,
      startTick: front.startTick,
      nextSendTick: front.nextSendTick,
      totalSent: front.totalSent,
      waves: front.waves,
      engagement: front.engagement
        ? {
            targetId: front.engagement.targetId,
            targetOwner: front.engagement.targetOwner,
            waves: front.engagement.waves,
            troopsArrived: front.engagement.troopsArrived,
            damageDealt: front.engagement.damageDealt,
            shieldDamage: front.engagement.shieldDamage,
            troopDamage: front.engagement.troopDamage,
            lastDefence: front.engagement.lastDefence,
            lastWaveTick: front.engagement.lastWaveTick,
            lastProgressTick: front.engagement.lastProgressTick,
            failedWaves: front.engagement.failedWaves,
          }
        : undefined,
    });
  }
  return out;
}

function findSnapshotTerritory(
  snapshot: MatchSnapshot,
  territoryId: string
): MatchSnapshot['territories'][number] | null {
  for (let i = 0; i < snapshot.territories.length; i += 1) {
    if (snapshot.territories[i].id === territoryId) return snapshot.territories[i];
  }
  return null;
}

function toUpgradeView(result: UpgradeEvaluation): UpgradeEvaluationDetail {
  return {
    ok: result.ok,
    kind: result.kind,
    reason: result.reason,
    cost: result.cost,
    currentLevel: result.currentLevel,
    nextLevel: result.nextLevel,
    remaining: result.remaining,
    benefit: {
      productionRateFrom: result.benefit.productionRateFrom,
      productionRateTo: result.benefit.productionRateTo,
      marchSpeedFrom: result.benefit.marchSpeedFrom,
      marchSpeedTo: result.benefit.marchSpeedTo,
      shieldCapacityFrom: result.benefit.shieldCapacityFrom,
      shieldCapacityTo: result.benefit.shieldCapacityTo,
      shieldGain: result.benefit.shieldGain,
      unlocksCannon: result.benefit.unlocksCannon,
    },
  };
}

/**
 * One seeded match. The UI generates the seed once per new game and passes it
 * here; `createMatch` resolves "random" through the same seeded map library it
 * uses internally, so the displayed map is always the simulated map.
 */
export function createGameAdapter(settings: GameSettings, seed: number): GameAdapter {
  const matchSettings: GameSettings = {
    durationSeconds: settings.durationSeconds,
    difficulty: settings.difficulty,
    mapId: settings.mapId,
    mode: settings.mode === 'versus' ? 'versus' : 'solo',
    factionCount: settings.factionCount,
    diplomacyEnabled: settings.diplomacyEnabled,
  };
  const session: ConquestMatchSession = createMatch({
    durationSeconds: settings.durationSeconds,
    difficulty: settings.difficulty,
    mapId: settings.mapId,
    seed: seed,
    betrayalLevel: settings.betrayalLevel || 0,
    mode: matchSettings.mode,
    factionCount: matchSettings.factionCount,
    diplomacyEnabled: matchSettings.diplomacyEnabled,
  });
  const offerSession = session as TruceOfferSession;
  const truceOfferActionsAvailable =
    typeof offerSession.acceptTruceOffer === 'function' &&
    typeof offerSession.rejectTruceOffer === 'function';
  const extra = session as unknown as {
    lastMessage?: () => string | null;
    commandLog?: () => unknown[];
    drainEvents?: () => CoreEvent[];
  };

  // The session is only mutated through this adapter, so one snapshot per tick
  // is enough. Gesture planning and previews reuse the cached snapshot instead
  // of cloning every polygon on every pointer move.
  let cachedSnapshot: MatchSnapshot | null = null;
  let cachedView: MatchView | null = null;
  let cachedHud: HudState | null = null;
  let revision = 0;
  let reachableKey = '';
  let reachableValue: string[] = [];
  let sourceReachableKey = '';
  let sourceReachableValue: import('../game-api').SourceReachability = { targetIds: [], alliedFrontierIds: [] };
  const initialSnapshot = session.snapshot();
  const resolvedMapId = initialSnapshot.mapId;
  const resolvedSeed = initialSnapshot.seed;
  const resolvedMode: MatchMode = initialSnapshot.mode === 'versus' ? 'versus' : 'solo';
  const tutorialMatch = resolvedMapId === TUTORIAL_SCENE.mapId;

  function isTutorial(): boolean {
    return session.isTutorial();
  }

  function invalidate(): void {
    cachedSnapshot = null;
    cachedView = null;
    cachedHud = null;
    revision += 1;
    reachableKey = '';
    reachableValue = [];
  }

  function snapshot(): MatchSnapshot {
    if (!cachedSnapshot) cachedSnapshot = session.snapshot();
    return cachedSnapshot;
  }

  function view(): MatchView {
    if (cachedView) return cachedView;
    const raw = snapshot();
    const size = mapSize(raw);
    const territories = raw.territories.map(copyTerritory);
    const armies = copyArmies(raw.armies);
    // The formal snapshot always fills ai3; a legacy totals record is patched
    // to 0 so every view exposes a fully filled 4-faction totals record.
    const scores = raw.scores
      ? {
          player: raw.scores.player,
          ai1: raw.scores.ai1,
          ai2: raw.scores.ai2,
          ai3: raw.scores.ai3 === undefined ? 0 : raw.scores.ai3,
        }
      : computeScores(territories);
    const counts = raw.territoryCounts
      ? {
          player: raw.territoryCounts.player,
          ai1: raw.territoryCounts.ai1,
          ai2: raw.territoryCounts.ai2,
          ai3: raw.territoryCounts.ai3 === undefined ? 0 : raw.territoryCounts.ai3,
        }
      : computeCounts(territories);
    const activeOwners = raw.activeOwners || fallbackActiveOwners(territories);
    const aliveOwners = raw.aliveOwners || fallbackAliveOwners(territories, armies, activeOwners);
    cachedView = {
      status: raw.status,
      tick: raw.tick,
      durationTicks: raw.durationTicks,
      endReason: raw.endReason,
      lastProgressTick: raw.lastProgressTick,
      stalemateWarned: raw.stalemateWarned,
      diplomacy: raw.diplomacy
        ? {
            enabled: raw.diplomacy.enabled,
            uses: raw.diplomacy.uses,
            aiOfferCooldownUntilTick: raw.diplomacy.aiOfferCooldownUntilTick,
            truces: raw.diplomacy.truces.map(function (record) {
              return {
                a: record.a,
                b: record.b,
                startedTick: record.startedTick,
                expiresTick: record.expiresTick,
                cooldownUntilTick: record.cooldownUntilTick,
                // Keep the last AI verdict visible to the sheet when the
                // snapshot carries it (old fixtures stay without these keys).
                lastDecision: record.lastDecision,
                lastDecisionTick: record.lastDecisionTick,
                lastDecisionReason: record.lastDecisionReason,
                lastDecisionFactors: record.lastDecisionFactors ? Object.assign({}, record.lastDecisionFactors) : undefined,
                lastDecisionKind: record.lastDecisionKind,
                lastDecisionProposer: record.lastDecisionProposer,
                lastDecisionResponder: record.lastDecisionResponder,
                lastDecisionOutcome: record.lastDecisionOutcome,
                pendingOffer: record.pendingOffer
                  ? {
                      id: record.pendingOffer.id,
                      from: record.pendingOffer.from,
                      to: record.pendingOffer.to,
                      createdTick: record.pendingOffer.createdTick,
                      expiresTick: record.pendingOffer.expiresTick,
                      reason: record.pendingOffer.reason,
                      factors: Object.assign({}, record.pendingOffer.factors),
                    }
                  : undefined,
              };
            }),
          }
        : undefined,
      mapId: raw.mapId,
      mapName: raw.mapName || '中原争夺',
      mapWidth: size.width,
      mapHeight: size.height,
      difficulty: raw.difficulty,
      mode: raw.mode === 'versus' ? 'versus' : 'solo',
      seed: raw.seed,
      territories: territories,
      edges: raw.edges.map(function (edge) {
        return {
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          travelFactor: edge.travelFactor,
        };
      }),
      armies: armies,
      fronts: copyFronts(raw.fronts),
      result: raw.result,
      scores: scores,
      territoryCounts: counts,
      stats: raw.stats || {
        ordersByPlayer: 0,
        capturesByPlayer: 0,
        troopsSentByPlayer: 0,
        maxTerritoriesByPlayer: 0,
      },
      factionCount: raw.factionCount === undefined ? 2 : raw.factionCount,
      activeOwners: activeOwners,
      aliveOwners: aliveOwners,
      boundaries: copyBoundaries(raw.layout),
      geography: copyGeography(raw.layout),
      geog: copyBrief(raw.geog),
    };
    return cachedView;
  }

  /**
   * The snapshot already owns the skill/disaster flags, so the HUD reads them
   * directly. The wrapper is reused until the next revision, which keeps the
   * per-frame cost to one property lookup.
   */
  function hudState(): HudState {
    if (cachedHud) return cachedHud;
    const raw = snapshot();
    cachedHud = {
      tick: raw.tick,
      skill: raw.skill,
      disaster: raw.disaster,
    };
    return cachedHud;
  }

  function plan(sourceId: string, ratio: number): DispatchPlan {
    const raw = snapshot();
    const territory = findSnapshotTerritory(raw, sourceId);
    const troops = territory ? territory.troops : 0;
    const dispatch = computeDispatch(troops, ratio);
    return {
      available: dispatch.available,
      reserve: dispatch.reserve,
      sent: dispatch.sent,
      remaining: Math.max(0, troops - dispatch.sent),
    };
  }

  function preview(
    sourceId: string,
    targetId: string,
    ratio: number,
    owner: PlayerId = 'player'
  ): MovePreview {
    const raw = snapshot();
    const result = evaluateMove(raw, sourceId, targetId, ratio, owner);
    return {
      available: result.available,
      reserve: result.reserve,
      sent: result.sent,
      remaining: result.remaining,
      ok: result.ok,
      reason: result.reason,
      forecast: normalizeForecast(result.forecast),
      requiredTroops: result.requiredTroops,
      defenderTroops: result.defenderTroops,
      defenderShield: result.defenderShield,
      terrainDefensePct: result.terrainDefensePct,
      plannedMovement: result.plannedMovement,
      route: result.route,
      routePoints: result.routePoints,
      travelTicks: result.travelTicks,
    };
  }

  function reachableTargets(owner: PlayerId): string[] {
    const raw = snapshot();
    const key = revision + '|' + raw.tick + '|' + owner;
    if (key === reachableKey) return reachableValue;
    reachableKey = key;
    reachableValue = ownerReachableTargets(raw, owner);
    return reachableValue;
  }

  function sourceRoutes(owner: PlayerId, sourceId: string): import('../game-api').SourceReachability {
    const key = revision + '|' + owner + '|' + sourceId;
    if (key !== sourceReachableKey) {
      sourceReachableValue = sourceReachability(snapshot(), owner, sourceId);
      sourceReachableKey = key;
    }
    return sourceReachableValue;
  }

  function sourceReachable(owner: PlayerId, sourceId: string): string[] {
    return sourceRoutes(owner, sourceId).targetIds;
  }

  function upgradeEvaluation(
    territoryId: string,
    kind: UpgradeKind
  ): UpgradeEvaluationDetail {
    return toUpgradeView(evaluateUpgrade(snapshot(), territoryId, kind));
  }

  return {
    settings: matchSettings,
    mapId: resolvedMapId,
    seed: resolvedSeed,
    mode: resolvedMode,
    tutorial: tutorialMatch,
    view: view,
    rawSnapshot: snapshot,
    hudState: hudState,
    drainEvents: function () {
      if (!extra.drainEvents) return [];
      try {
        return extra.drainEvents();
      } catch (error) {
        return [];
      }
    },
    start: function () {
      session.start();
      invalidate();
    },
    pause: function () {
      session.pause();
      invalidate();
    },
    resume: function () {
      session.resume();
      invalidate();
    },
    tick: function () {
      session.tick();
      invalidate();
    },
    isTutorial: isTutorial,
    tickWithoutAi: function () {
      if (!tutorialMatch) {
        throw new Error('tickWithoutAi is reserved for the tutorial battlefield');
      }
      const advanced = session.tickWithoutAi();
      invalidate();
      return advanced;
    },
    enterTutorialFreeplay: function () {
      if (!tutorialMatch) {
        throw new Error('enterTutorialFreeplay is reserved for the tutorial battlefield');
      }
      const entered = session.enterTutorialFreeplay();
      invalidate();
      return entered;
    },
    issueMove: function (sourceId, targetId, ratio) {
      const accepted = session.issueMove(sourceId, targetId, ratio);
      invalidate();
      return accepted;
    },
    issueMoveForOwner: function (owner, sourceId, targetId, ratio) {
      const accepted = session.issueMoveForOwner(owner, sourceId, targetId, ratio);
      invalidate();
      return accepted;
    },
    issueFront: function (sourceId, targetId, ratio) {
      const result = session.issueFront(sourceId, targetId, ratio);
      invalidate();
      return result;
    },
    issueFrontForOwner: function (owner, sourceId, targetId, ratio) {
      const result = session.issueFrontForOwner(owner, sourceId, targetId, ratio);
      invalidate();
      return result;
    },
    stopFront: function (sourceId, owner) {
      const accepted =
        owner && owner !== 'player'
          ? session.stopFrontForOwner(owner, sourceId)
          : session.stopFront(sourceId);
      invalidate();
      return accepted;
    },
    fronts: function () {
      return snapshot().fronts || [];
    },
    upgrade: function (territoryId, kind) {
      const accepted = session.upgrade(territoryId, kind);
      invalidate();
      return accepted;
    },
    issueBetrayal: function () {
      // The core is the only authority on legality/target selection; even a
      // rejected cast may have consumed the target-selection RNG.
      const result = session.issueBetrayal();
      invalidate();
      return result;
    },
    resign: function () {
      const result = session.resign();
      invalidate();
      return result;
    },
    offerTruce: function (target) {
      const result = session.offerTruce(target);
      invalidate();
      return result;
    },
    proposeTruce: function (target) {
      const result = session.proposeTruce(target);
      invalidate();
      return result;
    },
    breakTruce: function (target) {
      const result = session.breakTruce(target);
      invalidate();
      return result;
    },
    acceptTruceOffer: function (offerId) {
      if (typeof offerSession.acceptTruceOffer !== 'function') return undefined;
      const result = offerSession.acceptTruceOffer(offerId);
      invalidate();
      return result;
    },
    rejectTruceOffer: function (offerId) {
      if (typeof offerSession.rejectTruceOffer !== 'function') return undefined;
      const result = offerSession.rejectTruceOffer(offerId);
      invalidate();
      return result;
    },
    truceOfferActionsAvailable: truceOfferActionsAvailable,
    diplomacy: function () {
      return session.diplomacy();
    },
    preview: preview,
    plan: plan,
    evaluateUpgrade: upgradeEvaluation,
    revision: function () {
      return revision;
    },
    reachableTargets: reachableTargets,
    sourceReachableTargets: sourceReachable,
    sourceReachability: sourceRoutes,
    lastMessage: function () {
      return extra.lastMessage ? extra.lastMessage() : null;
    },
    commandLog: function () {
      return extra.commandLog ? extra.commandLog() : [];
    },
  };
}

/**
 * Builds the fixed teaching match through the normal official path:
 * createGameAdapter -> createMatch -> validateMap. The duration and difficulty
 * are pinned so the tutorial can never accidentally borrow the player's last
 * settings and fail validation.
 */
export function createTutorialGameAdapter(
  seed: number = TUTORIAL_SCENE.seed
): GameAdapter {
  return createGameAdapter(
    {
      durationSeconds: TUTORIAL_SCENE.durationSeconds,
      difficulty: 'easy',
      mapId: TUTORIAL_SCENE.mapId,
      mode: 'solo',
      diplomacyEnabled: false,
      betrayalLevel: 0,
    },
    seed
  );
}
