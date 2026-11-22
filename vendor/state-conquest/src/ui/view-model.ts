import type {
  PlannedMovement,
  MoveRouteInspection,
  PlayerId,
  TruceDecisionFactors,
  TruceProposalReason,
} from '../game-api';

/**
 * Mirror of the core `FactionCount`: total seated factions including the
 * player. 2 is the legacy default; versus and the tutorial are always 2.
 */
export type FactionCount = 2 | 3 | 4;
export type OwnerId = 'player' | 'ai1' | 'ai2' | 'ai3' | 'neutral';
export type Terrain = 'plain' | 'forest' | 'hill' | 'mountain';
/** `casual` is the internal novice difficulty key used by the core. */
export type Difficulty = 'easy' | 'normal' | 'hard' | 'casual';
export type MatchStatus = 'ready' | 'playing' | 'paused' | 'ended';
export type MatchEndReason = 'elimination' | 'timeout' | 'stalemate' | 'resign';
export type MatchMode = 'solo' | 'versus';

export interface PendingTruceOfferView {
  id: string;
  from: PlayerId;
  to: PlayerId;
  createdTick: number;
  expiresTick: number;
  reason: TruceProposalReason;
  factors: TruceDecisionFactors;
}

export interface TruceView {
  a: OwnerId;
  b: OwnerId;
  startedTick: number;
  expiresTick: number;
  cooldownUntilTick: number;
  /**
   * Outcome of the last proposal between this pair, mirrored from the
   * core TruceRecord. Optional: old fixtures omit it and keep the plain-truce
   * meaning. A record with expiresTick <= tick < cooldownUntilTick is a pure
   * cooldown; lastDecision 'rejected' marks it as a rejected proposal.
   */
  lastDecision?: 'accepted' | 'rejected';
  lastDecisionTick?: number;
  /** Machine-readable reason of the last AI accept/reject decision. */
  lastDecisionReason?: string;
  lastDecisionFactors?: TruceDecisionFactors;
  /** Direction-aware result metadata; absent on legacy fixtures. */
  lastDecisionKind?: 'player-proposal' | 'ai-offer';
  lastDecisionProposer?: PlayerId;
  lastDecisionResponder?: PlayerId;
  lastDecisionOutcome?: 'accepted' | 'rejected' | 'expired' | 'invalidated';
  /** An incoming or outgoing AI invitation; never an active alliance. */
  pendingOffer?: PendingTruceOfferView;
}

export interface DiplomacyView {
  enabled: boolean;
  uses?: number;
  aiOfferCooldownUntilTick?: number;
  truces: TruceView[];
}
export type ResultKind = 'win' | 'lose' | 'draw';
export type MoveForecast = 'capture' | 'repelled' | 'reinforce' | 'unknown';
export type UpgradeKind = 'production' | 'march' | 'defense';
export type MarchLevel = 1 | 2 | 3;
export type DefenseLevel = 0 | 1 | 2;

export interface TerritoryView {
  id: string;
  name?: string;
  /** Short Chinese map label; the selection card keeps the full name. */
  shortName?: string;
  owner: OwnerId;
  terrain: Terrain;
  troops: number;
  capacity: number;
  productionLevel: 1 | 2 | 3;
  marchLevel: MarchLevel;
  defenseLevel: DefenseLevel;
  shield: number;
  shieldCapacity: number;
  cannonRange: number;
  cannonReadyTick: number;
  polygon: Array<[number, number]>;
  center: [number, number];
  labelAnchor?: [number, number];
  labelLeader?: [number, number];
  scoreValue: number;
  areaUnits?: number;
}

export type BoundaryKind = 'open' | 'river' | 'ridge';

export interface BoundaryView {
  id: string;
  from: string;
  to: string;
  points: Array<[number, number]>;
  kind: BoundaryKind;
  passable: boolean;
  edgeId?: string;
  crossing?: [number, number];
  length?: number;
  midpoint?: [number, number];
}

export interface GeographyGroupView {
  id: string;
  label: string;
  territoryIds: string[];
}

export interface GeographyBarrierView {
  kind: 'river' | 'ridge';
  label: string;
  crossingCount: number;
  crossKind: 'land' | 'bridge';
  note: string;
}

export interface GeographyView {
  country: string;
  sourceLabel: string;
  sourceLicense: string;
  projection: string;
  regionLabel: string;
  regionNote?: string;
  states: string[];
  groups?: GeographyGroupView[];
  barrier?: GeographyBarrierView;
}

export interface GeographyBriefView {
  regionLabel: string;
  sourceLabel: string;
}

export interface EdgeView {
  from: string;
  to: string;
  kind: 'land' | 'bridge';
  travelFactor?: number;
}

export interface ArmyView {
  id: number;
  owner: OwnerId;
  sourceId: string;
  targetId: string;
  troops: number;
  startTick: number;
  arrivalTick: number;
  /** Frozen map-space route captured by the core at dispatch. */
  routePoints?: Array<[number, number]>;
  /** Set when this army is a wave of a continuous supply line. */
  frontId?: number;
}

export interface MatchStatsView {
  ordersByPlayer: number;
  capturesByPlayer: number;
  troopsSentByPlayer: number;
  maxTerritoriesByPlayer: number;
}

/**
 * One live continuous supply line, mirrored for the UI. Pure data: the renderer
 * only draws it and never mutates it. `engagement` is real bookkeeping (integer
 * losses actually inflicted), never a predicted damage pool.
 */
export interface FrontView {
  id: number;
  owner: OwnerId;
  sourceId: string;
  targetId: string;
  ratio: number;
  startTick: number;
  /** Earliest tick the next wave may leave; frozen while the source saves up. */
  nextSendTick: number;
  totalSent: number;
  waves: number;
  engagement?: {
    targetId: string;
    targetOwner: OwnerId;
    waves: number;
    troopsArrived: number;
    damageDealt: number;
    shieldDamage: number;
    troopDamage: number;
    lastDefence: number;
    lastWaveTick: number;
    lastProgressTick: number;
    failedWaves: number;
  };
}

export interface MatchView {
  status: MatchStatus;
  tick: number;
  durationTicks: number;
  endReason?: MatchEndReason;
  lastProgressTick?: number;
  stalemateWarned?: boolean;
  diplomacy?: DiplomacyView;
  mapId: string;
  mapName: string;
  mapWidth: number;
  mapHeight: number;
  difficulty: Difficulty;
  /** 'solo' (AI opponent) or 'versus' (two humans sharing one device). */
  mode: MatchMode;
  /** Match seed; only shown as a quiet "战场 #seed" in results. */
  seed: number;
  territories: TerritoryView[];
  edges: EdgeView[];
  armies: ArmyView[];
  /** Live continuous lines (undefined when the feature was never used). */
  fronts?: FrontView[];
  result: ResultKind | null;
  scores: { player: number; ai1: number; ai2: number; ai3?: number };
  territoryCounts: { player: number; ai1: number; ai2: number; ai3?: number };
  stats: MatchStatsView;
  /**
   * v1.4.0 multi-faction metadata. Optional so pre-1.4 hand-built fixtures
   * keep compiling; the formal game-adapter always fills all three. Old
   * readers can fall back with `factionCount ?? 2`. `aliveOwners` comes from
   * the core `isFactionAlive` rule (a faction with an army in flight is still
   * alive) — never infer elimination from a zero territory count.
   */
  factionCount?: FactionCount;
  /** Factions seated at match start; fixed for the whole match. */
  activeOwners?: OwnerId[];
  /** Seated factions still owning a territory or commanding an in-flight army. */
  aliveOwners?: OwnerId[];
  /** Immutable boundaries shared by the map, renderer and hit-testing. */
  boundaries?: BoundaryView[];
  geography?: GeographyView;
  geog?: GeographyBriefView;
}

export interface DispatchPlan {
  available: number;
  reserve: number;
  sent: number;
  remaining: number;
}

export interface MovePreview extends DispatchPlan {
  ok: boolean;
  reason?: string;
  forecast: MoveForecast;
  requiredTroops?: number;
  defenderTroops?: number;
  defenderShield?: number;
  terrainDefensePct?: number;
  /** Exact frozen route the core would assign; shared with army rendering. */
  plannedMovement?: PlannedMovement;
  route?: MoveRouteInspection;
  routePoints?: Array<[number, number]>;
  travelTicks?: number;
}

export interface UpgradeEvaluationView {
  ok: boolean;
  kind: UpgradeKind;
  reason?: string;
  cost: number;
  currentLevel: number;
  nextLevel: number;
  remaining: number;
}

export interface UpgradeBenefitView {
  productionRateFrom?: number;
  productionRateTo?: number;
  marchSpeedFrom?: number;
  marchSpeedTo?: number;
  shieldCapacityFrom?: number;
  shieldCapacityTo?: number;
  shieldGain?: number;
  unlocksCannon?: boolean;
}

export interface UpgradeEvaluationDetail extends UpgradeEvaluationView {
  benefit: UpgradeBenefitView;
}

export interface GameSettings {
  durationSeconds: number;
  difficulty: Difficulty;
  mapId: string;
  /** Defaults to 'solo'; 'versus' suppresses the built-in planner. */
  mode?: MatchMode;
  /** Commander archive betrayal level (0..5); 0 keeps the skill locked. */
  betrayalLevel?: number;
  /**
   * Total factions including the player (2..4). Omitted = 2, the legacy
   * default; the core rejects an illegal count or an unseatable map.
   */
  factionCount?: FactionCount;
  /** Ordinary solo only; challenges/tutorial/versus force false. */
  diplomacyEnabled?: boolean;
}

/**
 * The single settlement policy for a finished match. Versus earns no gold and
 * never produces a challenge code; solo keeps the existing reward + code path.
 * `app-shell` skips `ProfileStore.awardGold` for versus, which is also what
 * keeps the result out of profile.stats.
 */
export interface MatchSettlementPolicy {
  mode: MatchMode;
  awardGold: boolean;
  issueChallengeCode: boolean;
}

export function settlementPolicy(mode: MatchMode = 'solo'): MatchSettlementPolicy {
  if (mode === 'versus') {
    return { mode: 'versus', awardGold: false, issueChallengeCode: false };
  }
  return { mode: 'solo', awardGold: true, issueChallengeCode: true };
}

/** Every new match draws a seeded map from the core library. */
export const RANDOM_MAP_ID = 'random';

export const DEFAULT_SETTINGS: GameSettings = {
  durationSeconds: 300,
  difficulty: 'normal',
  mapId: RANDOM_MAP_ID,
};

export function remainingSeconds(view: MatchView): number {
  const ticksLeft = Math.max(0, view.durationTicks - view.tick);
  return Math.ceil(ticksLeft / 10);
}

export function findTerritory(view: MatchView, id: string | null): TerritoryView | null {
  if (!id) return null;
  for (let i = 0; i < view.territories.length; i += 1) {
    if (view.territories[i].id === id) return view.territories[i];
  }
  return null;
}

export function findEdge(view: MatchView, a: string, b: string): EdgeView | null {
  for (let i = 0; i < view.edges.length; i += 1) {
    const edge = view.edges[i];
    if (
      (edge.from === a && edge.to === b) ||
      (edge.from === b && edge.to === a)
    ) {
      return edge;
    }
  }
  return null;
}

export function neighborIds(view: MatchView, id: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < view.edges.length; i += 1) {
    const edge = view.edges[i];
    if (edge.from === id) out.push(edge.to);
    else if (edge.to === id) out.push(edge.from);
  }
  return out;
}
