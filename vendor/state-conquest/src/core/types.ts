/**
 * Public game contracts and internal simulation types.
 *
 * The snapshot types in this file are the single API consumed by the UI,
 * renderer and AI preview layer. They must stay plain, cloneable data.
 */

export type OwnerId = 'player' | 'ai1' | 'ai2' | 'ai3' | 'neutral';
export type PlayerId = 'player' | 'ai1' | 'ai2' | 'ai3';

/** Frozen, receiver-side assessment at the last proposal; all values are finite. */
export interface TruceDecisionFactors {
  selfPower: number;
  proposerPower: number;
  strongestThirdPower: number;
  selfProduction: number;
  proposerProduction: number;
  incomingThreat: number;
  commonThreats: number;
  sharedTargets: number;
  sharedOpportunity: number;
  threatRelief: number;
  borderRelief: number;
  underdog: number;
}

/** Direction of the last diplomacy decision, retained for UI wording. */
export type TruceDecisionKind = 'player-proposal' | 'ai-offer';
/** Outcome of a decision or an offer that disappeared without a response. */
export type TruceDecisionOutcome = 'accepted' | 'rejected' | 'expired' | 'invalidated';

/** A deterministic AI-to-player invitation that is not an active truce. */
export interface PendingTruceOffer {
  /** Stable within a match; derived from pair and createdTick, never random. */
  id: string;
  from: PlayerId;
  to: PlayerId;
  createdTick: number;
  expiresTick: number;
  /** The AI's own receiver-side interest verdict that triggered the offer. */
  reason: TruceProposalReason;
  factors: TruceDecisionFactors;
}

export interface TruceRecord {
  a: PlayerId;
  b: PlayerId;
  startedTick: number;
  expiresTick: number;
  cooldownUntilTick: number;
  /**
   * Optional outcome of the last proposal between this pair. Older
   * fixtures omit every one of these fields and keep the plain-truce meaning;
   * a record whose expiresTick <= tick but cooldownUntilTick > tick is a
   * cooldown-only record (rejection, expiry, or a just-ended truce).
   */
  lastDecision?: 'accepted' | 'rejected';
  lastDecisionTick?: number;
  /** Machine-readable reason of the last AI accept/reject decision. */
  lastDecisionReason?: string;
  lastDecisionFactors?: TruceDecisionFactors;
  /** Optional direction/result metadata; absent on old v2 records. */
  lastDecisionKind?: TruceDecisionKind;
  lastDecisionProposer?: PlayerId;
  lastDecisionResponder?: PlayerId;
  lastDecisionOutcome?: TruceDecisionOutcome;
  /** An AI invitation waiting for an explicit player response. */
  pendingOffer?: PendingTruceOffer;
}

export interface DiplomacyState {
  enabled: boolean;
  /** Accepted proposals and deliberate breaks; retained after records expire. */
  uses: number;
  truces: TruceRecord[];
  /** Global anti-interruption throttle after an AI offer is answered/invalidated. */
  aiOfferCooldownUntilTick?: number;
}

export interface DiplomacySnapshot {
  enabled: boolean;
  /** Successful offer/break operations; old snapshots omit this and mean zero. */
  uses?: number;
  /** Global anti-interruption throttle; omitted by legacy snapshots. */
  aiOfferCooldownUntilTick?: number;
  truces: readonly TruceRecord[];
}

/**
 * Machine-readable outcome of a truce/alliance proposal (2.0.0). The prefixes
 * are the stable contract for the UI:
 *  - `ok: false` reasons are legality refusals; the AI never judged them.
 *  - `accept-*` / `reject-*` reasons are real AI interest decisions and carry
 *    a deterministic `score`.
 */
export type TruceProposalReason =
  | 'disabled'
  | 'not-playing'
  | 'invalid'
  | 'self'
  | 'unknown-target'
  | 'target-dead'
  | 'too-few-alive'
  | 'already-allied'
  | 'ally-limit'
  | 'cooldown'
  | 'offer-not-found'
  | 'offer-expired'
  | 'offer-invalidated'
  | 'accept-common-threat'
  | 'accept-opportunity'
  | 'accept-front-relief'
  | 'accept-underdog'
  | 'reject-dominant'
  | 'reject-winning'
  | 'reject-no-benefit';

export interface TruceProposalResult {
  /** True only when the request was legal and the AI actually decided it. */
  ok: boolean;
  /** True only when the truce/alliance was established. */
  accepted: boolean;
  reason: TruceProposalReason;
  /** Nonnegative deterministic interest score; present when the AI judged the request. */
  score?: number;
  factors?: TruceDecisionFactors;
  /** Absolute expiry tick of the new truce; present when accepted. */
  expiresTick?: number;
}

/** One deterministic AI verdict on a truce proposal (see ai/diplomacy-evaluate). */
export interface TruceDecision {
  accept: boolean;
  reason: TruceProposalReason;
  score: number;
  factors?: TruceDecisionFactors;
}

/**
 * Strategy seam injected by the engine: core/diplomacy stays AI-agnostic, the
 * engine wires the real planner evaluation. `proposer` offers, `target` is the
 * faction whose interest is evaluated.
 */
export type TruceDecider = (
  state: MatchState,
  proposer: PlayerId,
  target: PlayerId
) => TruceDecision;

/**
 * Total number of playable factions in one match, the player included.
 * 2 = player + ai1 (the legacy default), 3 = + ai2, 4 = + ai3. Versus and the
 * tutorial are always 2. An inactive faction owns nothing, never acts, and
 * every totals record reports 0 for it.
 */
export type FactionCount = 2 | 3 | 4;
export type Terrain = 'plain' | 'forest' | 'hill' | 'mountain';
/**
 * `casual` is the internal novice difficulty key. It keeps the same simulation
 * and AI contract as the other three values; only the tuning table and the
 * solo starting bonus differ.
 */
export type Difficulty = 'easy' | 'normal' | 'hard' | 'casual';
export type MatchStatus = 'ready' | 'playing' | 'paused' | 'ended';
export type MatchEndReason = 'elimination' | 'timeout' | 'stalemate' | 'resign';
/**
 * 'solo' is the built-in-AI game. 'versus' is the same simulation played by two
 * humans on one device: the built-in planner is never run and the second side
 * (the ai1 owner slot) is driven through the same owner-aware command boundary.
 */
export type MatchMode = 'solo' | 'versus';
export type MatchResult = 'win' | 'lose' | 'draw';
export type EdgeKind = 'land' | 'bridge';
export type Forecast = 'capture' | 'repelled' | 'reinforce' | 'unknown';
export type MoveReason =
  | 'not_own'
  | 'not_adjacent'
  | 'self'
  | 'no_troops'
  | 'not_playing'
  | 'truce'
  | 'invalid';

/**
 * Continuous supply line ("兵线") lifecycle actions. A line is created by the
 * first drag, replaced by dragging the same source to another target, and
 * stopped by dragging to the same target again (or by the engine when the
 * source is lost, the route disappears, the target is captured or the line
 * exhausts its budget).
 */
export type FrontAction = 'start' | 'replace' | 'stop' | 'send' | 'cancel' | 'capture';
export type FrontCancelReason =
  | 'manual'
  | 'source-lost'
  | 'route-invalid'
  | 'exhausted'
  | 'not-playing'
  | 'truce';

/**
 * Real, integer-only bookkeeping of one line's assault on its target.
 *
 * Informational only: it feeds the HUD and is never read back by the battle
 * rules, so a stale record can never deal damage. Owner-agnostic — every owner
 * (player and AI alike) accumulates the same fields under the same rule.
 */
export interface FrontEngagement {
  /** Target this engagement belongs to; a replaced target starts a new one. */
  targetId: string;
  /** Owner of the target when this engagement started; a change resets it. */
  targetOwner: OwnerId;
  /** Waves that actually landed on the target while this line was active. */
  waves: number;
  /** Troops those waves carried in total. */
  troopsArrived: number;
  /** Real defender losses caused by this line (shield + garrison, integer). */
  damageDealt: number;
  shieldDamage: number;
  troopDamage: number;
  /** Defence (garrison + shield) right after the previous landed wave. */
  lastDefence: number;
  lastWaveTick: number;
  /** Last tick this engagement made real progress (damage or capture attempt). */
  lastProgressTick: number;
  /** Consecutive landed waves that dealt no real damage (HUD hint only). */
  failedWaves: number;
}

/**
 * One active continuous supply line. At most one line exists per
 * (owner, sourceId); dragging that source to another target replaces it.
 *
 * A line only ever dispatches ordinary armies; the battle difference lives in
 * `core/fronts.ts`: a wave does NOT clamp the defender at 1, so repeated waves
 * on the same target really wear it down. Nothing is pre-charged and no attack
 * power is carried between waves, so a line can never deal free damage.
 */
export interface ContinuousFront {
  id: number;
  owner: PlayerId;
  sourceId: string;
  targetId: string;
  /** Frozen dispatch ratio chosen at the original drag. */
  ratio: number;
  startTick: number;
  /** Earliest tick the next wave may leave the source. */
  nextSendTick: number;
  /** Total troops actually dispatched by this line so far. */
  totalSent: number;
  /** Waves dispatched so far. */
  waves: number;
  engagement?: FrontEngagement;
}

/** Read-only copy of a live line for the snapshot/UI. */
export interface ContinuousFrontSnapshot {
  id: number;
  owner: OwnerId;
  sourceId: string;
  targetId: string;
  ratio: number;
  startTick: number;
  nextSendTick: number;
  totalSent: number;
  waves: number;
  engagement?: FrontEngagement;
}

/** Immutable outcome of one front command (start/replace/stop). */
export interface FrontCommandResult {
  ok: boolean;
  /** 'start' created a line, 'replace' rewrote the target, 'stop' removed it. */
  action: 'start' | 'replace' | 'stop';
  frontId?: number;
  reason?: MoveReason;
}

/** Upgrade tracks available on any owned territory. */
export type UpgradeKind = 'production' | 'march' | 'defense';
export type MarchLevel = 1 | 2 | 3;
export type DefenseLevel = 0 | 1 | 2;
export type MapPoint = [number, number];

/** Player active skill state. Level 0 disables the skill entirely. */
export interface SkillState {
  /** 0..5, supplied by the caller outside the match (0 = locked). */
  betrayalLevel: number;
  /** Earliest tick the next betrayal may be issued. */
  readyTick: number;
  /** Total betrayals issued this match. */
  uses: number;
}

/** At most one random global disaster per match. */
export interface DisasterState {
  /** null = this match has no disaster. */
  scheduledAtTick: number | null;
  struck: boolean;
  /** Set DISASTER_WARN_TICKS before the strike so the UI can warn. */
  warned: boolean;
}

export interface TerritorySnapshot {
  id: string;
  name?: string;
  /** Short Chinese map label; full `name` stays for panels/reports. */
  shortName?: string;
  owner: OwnerId;
  terrain: Terrain;
  troops: number;
  capacity: number;
  productionLevel: 1 | 2 | 3;
  productionRemainder: number;
  /** March speed track; frozen into an army's arrivalTick at dispatch. */
  marchLevel: MarchLevel;
  /** 0 = none, 1 = wall, 2 = wall + cannon. */
  defenseLevel: DefenseLevel;
  /** Shield troops absorb failure damage before the garrison. */
  shield: number;
  /** 12 * defenseLevel. */
  shieldCapacity: number;
  /** Precomputed map-coordinate cannon radius (cannon maps only). */
  cannonRange: number;
  /** Earliest tick this territory's cannon may fire again. */
  cannonReadyTick: number;
  polygon: Array<[number, number]>;
  center: [number, number];
  /** Preferred in-polygon label point (map coordinates). */
  labelAnchor?: [number, number];
  /** Optional external badge point for tiny/narrow territories. */
  labelLeader?: [number, number];
  scoreValue: number;
  areaUnits: number;
}

export interface EdgeSnapshot {
  id?: string;
  from: string;
  to: string;
  kind: EdgeKind;
  travelFactor: number;
}

export interface ArmySnapshot {
  id: number;
  owner: OwnerId;
  sourceId: string;
  targetId: string;
  troops: number;
  startTick: number;
  arrivalTick: number;
  /**
   * Frozen map-space path chosen at dispatch. Optional for old fixtures and
   * snapshots created before v0.4 routes; when present it is authoritative for
   * rendering, cannon sweeps and hit-testing regardless of later ownership.
   */
  routePoints?: MapPoint[];
  /** Set when this army is a wave of a continuous supply line. */
  frontId?: number;
}

export interface MatchStatsSnapshot {
  ordersByPlayer: number;
  capturesByPlayer: number;
  troopsSentByPlayer: number;
  maxTerritoriesByPlayer: number;
  upgradesByPlayer?: number;
}

export interface FactionTotals {
  player: number;
  ai1: number;
  ai2: number;
  /**
   * Fourth faction total. Optional so pre-v1.4 fixtures keep compiling; the
   * formal compute functions always fill it (0 for an inactive faction).
   */
  ai3?: number;
}

export interface MatchSnapshot {
  status: MatchStatus;
  tick: number;
  durationTicks: number;
  /** Why the engine ended, when status is ended. */
  endReason?: MatchEndReason;
  /** Last tick with real capture or defence damage. */
  lastProgressTick?: number;
  /** True while the no-progress warning is active. */
  stalemateWarned?: boolean;
  diplomacy?: DiplomacySnapshot;
  mapId: string;
  mapName: string;
  mapWidth: number;
  mapHeight: number;
  difficulty: Difficulty;
  /** 'solo' (default) or the two-human local 'versus' variant. */
  mode: MatchMode;
  /**
   * Normalized total faction count of this match (2..4). Always filled by
   * `toMatchSnapshot`; optional in the type so hand-built fixtures compile.
   */
  factionCount?: FactionCount;
  /** Factions that were seated at match start; fixed for the whole match. */
  activeOwners?: PlayerId[];
  /** Seated factions still owning a territory or commanding an in-flight army. */
  aliveOwners?: PlayerId[];
  seed: number;
  territories: TerritorySnapshot[];
  edges: EdgeSnapshot[];
  armies: ArmySnapshot[];
  /** Active continuous supply lines (empty when none were ever started). */
  fronts?: ContinuousFrontSnapshot[];
  result: MatchResult | null;
  scores: FactionTotals;
  territoryCounts: FactionTotals;
  stats: MatchStatsSnapshot;
  /** Player active skill state (read-only for UI). */
  skill: SkillState;
  /** Global disaster schedule/flags (read-only for UI). */
  disaster: DisasterState;
  /** Pure metadata forwarded from the map variant (read-only for UI). */
  themeId?: string;
  variantSize?: number;
  durationSeconds?: number;
  layout?: import('../maps/types').MapLayoutMetadata;
  /** Top-level readable geography summary for selection/report UI. */
  geog?: import('../maps/types').MapGeographyBrief;
  /** Bounded UI events drained by the caller; never used for decisions. */
  events?: import('./events').MatchEvent[];
}

export interface DispatchPlan {
  available: number;
  reserve: number;
  sent: number;
}

/**
 * A validated, immutable movement plan. `routePoints` is the exact map-space
 * polyline an army will follow; it is frozen into the army at dispatch.
 */
export interface PlannedMovement {
  sourceId: string;
  targetId: string;
  /** True when source and target share one real state edge. */
  direct: boolean;
  /** Owned staging territory that owns the real edge into the target. */
  frontierId: string;
  /** Real edges crossed, in travel order. */
  edgeIds: string[];
  /** Ordered territory chain, including source and destination. */
  territoryIds?: string[];
  /** Active partners actually crossed; never includes the destination owner. */
  transitOwners?: PlayerId[];
  routePoints: MapPoint[];
  /** Polyline length in map units (crossings included). */
  distance: number;
  travelTicks: number;
  /** Length-weighted travel factor of the really crossed edges. */
  travelFactor: number;
  /** Length-weighted bridge multiplier of the really crossed edges. */
  bridgeFactor: number;
}

export type MoveRouteFailure =
  | 'invalid'
  | 'self'
  | 'source-not-owned'
  | 'ally-target'
  | 'no-frontier'
  | 'disconnected'
  | 'blocked-boundary'
  | 'truce-ended';

/** Read-only explanation of the same route used by commands and supply lines. */
export interface MoveRouteInspection {
  ok: boolean;
  reason?: MoveRouteFailure;
  movement?: PlannedMovement;
  blockedEdgeIds?: string[];
}

export interface MoveEvaluation extends DispatchPlan {
  ok: boolean;
  reason?: MoveReason;
  remaining: number;
  forecast: Forecast;
  requiredTroops?: number;
  defenderTroops?: number;
  defenderShield?: number;
  terrainDefensePct?: number;
  route?: MoveRouteInspection;
  /** Full frozen-route preview for the UI (optional for legacy callers). */
  plannedMovement?: PlannedMovement;
  /** Convenience copy of plannedMovement.routePoints. */
  routePoints?: MapPoint[];
  travelTicks?: number;
}

/** Structured numeric effect of the next upgrade step. */
export interface UpgradeBenefit {
  productionRateFrom?: number;
  productionRateTo?: number;
  marchSpeedFrom?: number;
  marchSpeedTo?: number;
  shieldCapacityFrom?: number;
  shieldCapacityTo?: number;
  shieldGain?: number;
  unlocksCannon?: boolean;
}

export interface UpgradeEvaluation {
  ok: boolean;
  reason?: MoveReason;
  kind: UpgradeKind;
  cost: number;
  currentLevel: number;
  nextLevel: number;
  /** Troops left after paying (ok) or the current garrison (not ok). */
  remaining: number;
  benefit: UpgradeBenefit;
}

/** Geometry-only endpoint accepted by the shared army route helper. */
export interface ArmyRouteEndpoint {
  id: string;
  center: [number, number];
  labelAnchor?: [number, number];
}

/**
 * Boundary data used by the shared route helper. It intentionally accepts the
 * map's MapBoundaryMetadata (and snapshot layout boundaries) structurally.
 */
export interface ArmyRouteBoundary {
  from: string;
  to: string;
  passable?: boolean;
  crossing?: [number, number];
  midpoint?: [number, number];
  length?: number;
}

export interface MatchSession {
  snapshot(): MatchSnapshot;
  start(): void;
  pause(): void;
  resume(): void;
  tick(): void;
  issueMove(sourceId: string, targetId: string, ratio: number): boolean;
  upgrade(territoryId: string, kind?: UpgradeKind): boolean;
}

export interface CreateMatchOptions {
  durationSeconds: number;
  difficulty: Difficulty;
  mapId?: string;
  seed?: number;
  /** Defaults to 'solo' so every existing caller keeps its behaviour. */
  mode?: MatchMode;
  /**
   * Total factions including the player (2..4). Omitted = 2, which is exactly
   * the legacy behaviour. An explicit value that is not 2/3/4 throws; an
   * explicit 3/4 on a map without the matching AI spawns throws as well
   * (never silently degraded). Versus forces 2.
   */
  factionCount?: FactionCount;
  /** Ordinary solo defaults to true; tutorial and versus always force false. */
  diplomacyEnabled?: boolean;
}

/* ------------------------------------------------------------------ */
/* Internal simulation model (never exposed to rendering directly)     */
/* ------------------------------------------------------------------ */

export interface Territory {
  id: string;
  name?: string;
  shortName?: string;
  owner: OwnerId;
  terrain: Terrain;
  troops: number;
  capacity: number;
  productionLevel: 1 | 2 | 3;
  productionRemainder: number;
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
  areaUnits: number;
  /** Original map garrison; neutral recovery never grows past it. */
  initialTroops: number;
  /** Neutral only: recovery cap recorded on the last failed attack. */
  neutralRecoveryTarget?: number;
  /** Neutral only: fractional recovery accumulator. */
  neutralRecoveryRemainder?: number;
  /** Neutral only: tick of the most recent failed attack (-1 = never). */
  lastDamagedTick?: number;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  travelFactor: number;
}

export interface Army {
  id: number;
  owner: PlayerId;
  sourceId: string;
  targetId: string;
  troops: number;
  startTick: number;
  arrivalTick: number;
  /**
   * Frozen map-space route captured when the order was accepted. Ownership,
   * upgrades, later map changes and source/target capture never alter it.
   * Optional so old fixtures and manually-built armies keep working.
   */
  routePoints?: MapPoint[];
  /**
   * Continuous-line wave marker. Absent for single-shot orders, so a wave whose
   * line was stopped mid-flight lands as an ordinary single attack.
   */
  frontId?: number;
}

export interface MatchStats {
  ordersByPlayer: number;
  capturesByPlayer: number;
  troopsSentByPlayer: number;
  maxTerritoriesByPlayer: number;
  upgradesByPlayer: number;
}

export interface MatchState {
  status: MatchStatus;
  tick: number;
  durationTicks: number;
  /** Why the engine ended; omitted on old hand-built fixtures. */
  endReason?: MatchEndReason;
  /** Last tick with real capture or defence damage. */
  lastProgressTick?: number;
  /** True while the no-progress warning is active. */
  stalemateWarned?: boolean;
  diplomacy?: DiplomacyState;
  seed: number;
  mapId: string;
  mapName: string;
  mapWidth: number;
  mapHeight: number;
  difficulty: Difficulty;
  /**
   * Optional so hand-built fixtures and older internal clones (which predate
   * versus) keep compiling; an omitted value is solo.
   */
  mode?: MatchMode;
  /**
   * Normalized total faction count (2..4). Always written by createMatchState;
   * required here so clones and validators cannot drop it.
   */
  factionCount: FactionCount;
  referenceArea: number;
  territoryOrder: string[];
  territories: Record<string, Territory>;
  edges: Edge[];
  armies: Army[];
  nextArmyId: number;
  /**
   * Continuous supply lines. Optional so hand-built fixtures and older clones
   * keep working; an omitted value means "no lines".
   */
  fronts?: ContinuousFront[];
  nextFrontId?: number;
  result: MatchResult | null;
  stats: MatchStats;
  /**
   * Seated factions, fixed for the whole match (distinct from alive). Derived
   * once from the map spawns intersected with the requested factionCount.
   */
  activeOwners: PlayerId[];
  spawnTerritories: Partial<Record<PlayerId, string[]>>;
  /** Bounded UI event queue; never used for simulation decisions. */
  events: import('./events').MatchEvent[];
  /** Player active skill state (betrayal level comes from outside the match). */
  skill: SkillState;
  /** Global disaster schedule; generated from an independent seed stream. */
  disaster: DisasterState;
  /** Map layout metadata forwarded from the map definition. */
  layout?: import('../maps/types').MapLayoutMetadata;
  /** Top-level readable geography summary (immutable map metadata). */
  geog?: import('../maps/types').MapGeographyBrief;
  themeId?: string;
  variantSize?: number;
}

export interface CommandResult {
  ok: boolean;
  reason?: MoveReason;
  sent: number;
}
