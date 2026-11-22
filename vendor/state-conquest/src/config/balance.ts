import type { Difficulty, Terrain } from '../core/types';

/** Fixed simulation step. Every rule is expressed in these ticks. */
export const FIXED_DT_MS = 100;
export const TICKS_PER_SECOND = 1000 / FIXED_DT_MS;
export const FIXED_DT_SECONDS = FIXED_DT_MS / 1000;

/** Long-press dispatch tuning. */
export const MIN_DISPATCH_RATIO = 0.2;
export const FULL_HOLD_MS = 1000;
export const RESERVE_RATIO = 0.15;

/** Temporary diplomacy windows in the fixed 100 ms simulation clock. */
export const TRUCE_DURATION_TICKS = 600;
export const TRUCE_COOLDOWN_TICKS = 300;
/**
 * Truce/alliance proposals (2.0.0). A REJECTED proposal leaves a cooldown-only
 * record so the same pair cannot be re-proposed (anti-spam) without touching
 * any active truce. An ACCEPTED proposal creates a normal truce record whose
 * active period can never be refreshed by re-proposing.
 */
export const TRUCE_PROPOSAL_COOLDOWN_TICKS = 300;
/** AI invitations wait for an explicit player response for 15 game seconds. */
export const TRUCE_AI_OFFER_DURATION_TICKS = 150;
/** Proactive diplomacy starts after 20 game seconds of live play. */
export const TRUCE_AI_OFFER_INITIAL_DELAY_TICKS = 200;
/** Proactive diplomacy scans once every five game seconds. */
export const TRUCE_AI_OFFER_SCAN_INTERVAL_TICKS = 50;
/** One response/expiry suppresses all new AI invitations for 30 game seconds. */
export const TRUCE_AI_OFFER_GLOBAL_COOLDOWN_TICKS = 300;

/**
 * Deterministic AI interest scoring for a truce proposal (pure function; no
 * RNG, no difficulty dice). The scoring side is the DECIDER (the faction that
 * receives the proposal); `other` is the proposer.
 *
 * Power includes garrisons, armies, land value and a short production horizon.
 * score = sum of route-weighted opportunities and pressure relief; score >= TRUCE_ACCEPT_SCORE
 * accepts unless a veto fires (proposer dominant, or decider already winning).
 */
export const TRUCE_VALUE_POWER_WEIGHT = 0.4;
export const TRUCE_PRODUCTION_HORIZON_SECONDS = 15;
export const TRUCE_ROUTE_DISCOUNT_SECONDS = 10;
export const TRUCE_ACCEPT_SCORE = 30;
/** Each attack target the alliance unlocks through the partner's frontier. */
export const TRUCE_W_SHARED_TARGET = 8;
/** A third faction that threatens both sides (by mass or by power). */
export const TRUCE_W_COMMON_ENEMY = 15;
/** The strongest third faction outguns the decider. */
export const TRUCE_W_OUTGUNNED = 15;
/** The pair actually shares a border with troops facing each other. */
export const TRUCE_W_FRONT_RELIEF = 12;
/** The decider is clearly the weaker side of the pair. */
export const TRUCE_W_UNDERDOG = 10;
export const TRUCE_UNDERDOG_RATIO = 0.6;
/** Proposer over 2x the decider's power with no bigger third party: reject. */
export const TRUCE_DOMINANCE_RATIO = 2;
/** Decider over 2x (proposer + strongest third) power: winning, no need. */
export const TRUCE_WIN_MARGIN = 2;

/** No-progress windows in the fixed 100 ms simulation clock. */
export const STALEMATE_WARNING_TICKS = 600;
export const STALEMATE_END_TICKS = 1200;

/** Continuous supply-line cadence and bounded in-flight waves. */
export const CONTINUOUS_MIN_BATCH = 4;
export const CONTINUOUS_SEND_INTERVAL_TICKS = 15;
export const CONTINUOUS_MAX_WAVES_IN_FLIGHT = 8;

/** capacity = clamp(round(20 + 30 * sqrt(areaUnits / referenceArea)), 30, 120) */
export const CAPACITY_BASE = 20;
export const CAPACITY_SCALE = 30;
export const CAPACITY_MIN = 30;
export const CAPACITY_MAX = 120;
export const DEFAULT_REFERENCE_AREA = 1;

/** Integer troops per second by production level. */
export const PRODUCTION_RATES: Record<1 | 2 | 3, number> = {
  1: 0.8,
  2: 1.15,
  3: 1.55,
};

/** Troops deducted from the local garrison when upgrading FROM this level. */
export const UPGRADE_COSTS: Record<1 | 2, number> = {
  1: 10,
  2: 20,
};

/** March track: cost by current level and the speed multiplier it grants. */
export const MARCH_COSTS: Record<1 | 2, number> = {
  1: 10,
  2: 20,
};

export const MARCH_SPEED_MULTIPLIER: Record<1 | 2 | 3, number> = {
  1: 1,
  2: 1.2,
  3: 1.4,
};

/** Defense track: cost by current level (0 -> 1, 1 -> 2). */
export const DEFENSE_COSTS: Record<0 | 1, number> = {
  0: 12,
  1: 20,
};

/** Shield capacity granted per defense level (independent defenders). */
export const SHIELD_PER_DEFENSE_LEVEL = 12;
export const SHIELD_CAPACITY: Record<0 | 1 | 2, number> = {
  0: 0,
  1: SHIELD_PER_DEFENSE_LEVEL,
  2: SHIELD_PER_DEFENSE_LEVEL * 2,
};

/** Cannon (defense level 2) tuning. */
export const CANNON_DAMAGE = 2;
export const CANNON_COOLDOWN_TICKS = 8;
export const CANNON_RANGE_FACTOR = 0.85;
/** Safety clamps against degenerate map metadata (share of map diagonal). */
export const CANNON_RANGE_MIN_DIAGONAL_SHARE = 0.02;
export const CANNON_RANGE_MAX_DIAGONAL_SHARE = 0.4;

/**
 * Neutral recovery after a failed attack: quiet delay, then a slow refill
 * toward the territory's original garrison (never past it).
 */
export const NEUTRAL_RECOVERY_RATE = 0.35;
export const NEUTRAL_RECOVERY_DELAY_TICKS = 30;

/**
 * Betrayal active skill. Level x converts x * 10 enemy troops, is usable from
 * tick 300 and then has a 600-tick cooldown. Targets whose garrison is within
 * 1.5x the quota form the random pool; an empty pool falls back to the weakest
 * enemy territory.
 */
export const BETRAYAL_MAX_LEVEL = 5;
export const BETRAYAL_SOLDIERS_PER_LEVEL = 10;
export const BETRAYAL_INITIAL_DELAY_TICKS = 300;
export const BETRAYAL_COOLDOWN_TICKS = 600;
export const BETRAYAL_TARGET_POOL_FACTOR = 1.5;

/**
 * Random global disaster. At most one per match, scheduled by an independent
 * seed-derived RNG inside the [0.25, 0.60) match window. Every territory with
 * more than one troop loses floor(troops * r), r uniform in [0.10, 0.20).
 */
export const DISASTER_CHANCE = 0.35;
export const DISASTER_WINDOW_START_RATIO = 0.25;
export const DISASTER_WINDOW_END_RATIO = 0.6;
export const DISASTER_MIN_LOSS_RATIO = 0.1;
export const DISASTER_MAX_LOSS_RATIO = 0.2;
export const DISASTER_WARN_TICKS = 30;
/** Salts for the two independent disaster RNG streams (never the match RNG). */
export const DISASTER_SCHEDULE_SEED_SALT = 0x9e3779b9;
export const DISASTER_DAMAGE_SEED_SALT = 0x85ebca6b;

/** Defense bonus in integer percent. Only the defender benefits. */
export const TERRAIN_DEFENSE_PCT: Record<Terrain, number> = {
  plain: 0,
  forest: 15,
  hill: 25,
  mountain: 40,
};

export const TRAVEL_BASE_SECONDS = 0.75;
export const BRIDGE_TRAVEL_FACTOR = 1.35;
export const MIN_TRAVEL_SECONDS = 0.35;
export const MAX_TRAVEL_SECONDS = 3.5;

export interface AiTuning {
  /** Ticks between decision passes (100 ms per tick). */
  decisionTicks: number;
  /** Maximum commands issued in one decision pass. */
  maxCommands: number;
  /** Chance to deliberately do nothing on a pass. */
  waitChance: number;
  /** Extra troop margin required before easy attacks an enemy territory. */
  enemyAttackMargin: number;
  /** Random score jitter used to avoid robotic openings. */
  jitter: number;
  /** Whether the AI may upgrade production. */
  upgrades: boolean;
  /** Attack options kept before the short-horizon search cut. */
  topK: number;
  /** Multi-source coordination capability. */
  coordination: 'none' | 'simple' | 'full';
  /** Pure copy simulation steps used to validate candidates (0 = none). */
  simSteps: number;
  /** Predicted enemy counter waves considered by the simulation. */
  counterWaves: number;
  /** Share of a frontline garrison that must stay home. */
  guardShare: number;
  /** Whether the AI actively reinforces threatened frontiers. */
  reinforce: boolean;
  /** Upgrades are ignored inside this final window (seconds). */
  minUpgradeRemaining: number;
  /** Fraction of the match before sacrificial coordinated assaults unlock. */
  coordinationDelay: number;
  /** ROI safety multiplier applied to upgrade payback time. */
  upgradePayback: number;
  /** Use arrival-aware frontier risk instead of raw adjacent mass. */
  riskModel: boolean;
  /** Evacuate troops from a frontier that cannot be held. */
  retreat: boolean;
  /** Minimum garrison worth evacuating from a doomed frontier. */
  retreatMinTroops: number;
  /** Threat math may outrank production when buying a wall. */
  defenseRoi: boolean;
  /** Ratio of credible attackers to projected defence that marks a front lost. */
  doomedRatio: number;
  /** Hard-veto double-failure attacks (source and captured target both fall). */
  suicideGuard: boolean;
  /** Hard: minimum score after forecast deductions; lower attacks are dropped. */
  attackFloor: number;
  /** Final window (seconds) where score/territory/force tie-breaks matter. */
  endgameSeconds: number;
}

export const AI_TUNING: Record<Difficulty, AiTuning> = {
  easy: {
    decisionTicks: 30,
    maxCommands: 1,
    waitChance: 0.25,
    enemyAttackMargin: 8,
    jitter: 6,
    upgrades: true,
    topK: 0,
    coordination: 'none',
    simSteps: 0,
    counterWaves: 0,
    guardShare: 0.2,
    reinforce: false,
    minUpgradeRemaining: 50,
    coordinationDelay: 1,
    upgradePayback: 2.4,
    // Easy keeps the shallow legacy heuristics and leans on its jitter/wait
    // dice; none of the new risk, contraction or endgame logic applies.
    riskModel: false,
    retreat: false,
    retreatMinTroops: 99,
    defenseRoi: false,
    doomedRatio: 2,
    suicideGuard: false,
    attackFloor: -999,
    endgameSeconds: 0,
  },
  casual: {
    // The novice difficulty is a slightly more conservative easy, not a
    // disabled AI: the same real planner runs, expands, upgrades and attacks.
    // The cadence matches easy, the wait dice are not raised, and the extra
    // attack margin (8 -> 14) is what makes reckless enemy strikes rarer.
    decisionTicks: 30,
    maxCommands: 1,
    waitChance: 0.22,
    enemyAttackMargin: 14,
    jitter: 5,
    upgrades: true,
    topK: 0,
    coordination: 'none',
    simSteps: 0,
    counterWaves: 0,
    guardShare: 0.22,
    reinforce: false,
    minUpgradeRemaining: 50,
    coordinationDelay: 1,
    upgradePayback: 2.4,
    riskModel: false,
    retreat: false,
    retreatMinTroops: 99,
    defenseRoi: false,
    doomedRatio: 2,
    suicideGuard: false,
    attackFloor: -999,
    endgameSeconds: 0,
  },
  normal: {
    decisionTicks: 16,
    maxCommands: 1,
    waitChance: 0.08,
    enemyAttackMargin: 2,
    jitter: 3,
    upgrades: true,
    topK: 4,
    coordination: 'simple',
    simSteps: 1,
    counterWaves: 0,
    guardShare: 0.22,
    reinforce: true,
    minUpgradeRemaining: 30,
    coordinationDelay: 0.5,
    upgradePayback: 1.8,
    riskModel: true,
    retreat: true,
    retreatMinTroops: 6,
    defenseRoi: true,
    doomedRatio: 1.3,
    suicideGuard: true,
    attackFloor: -20,
    endgameSeconds: 30,
  },
  hard: {
    decisionTicks: 7,
    maxCommands: 2,
    waitChance: 0.02,
    enemyAttackMargin: 0,
    jitter: 1,
    upgrades: true,
    topK: 6,
    coordination: 'full',
    simSteps: 3,
    counterWaves: 1,
    guardShare: 0.25,
    reinforce: true,
    minUpgradeRemaining: 25,
    // The opening third is spent on favourable single-source captures; the
    // multi-source offensive (which may sacrifice its first wave) waits until
    // the economy is established.
    coordinationDelay: 0.34,
    upgradePayback: 1.6,
    riskModel: true,
    retreat: true,
    retreatMinTroops: 5,
    defenseRoi: true,
    doomedRatio: 1.25,
    suicideGuard: true,
    // The floor is rechecked after the hard forecast's deductions. It keeps a
    // capture that a counter wave is predicted to retake (tempo is still worth
    // it) while dropping genuinely losing strikes; double failure is vetoed
    // unconditionally elsewhere. Round 2 tightened that veto to a real capture
    // cost and added the score-only counter margin, which removes 6 of the old
    // wins; -33 restores the tempo attacks the stricter veto now already
    // proves safe (seeded canonical 48/108).
    attackFloor: -33,
    endgameSeconds: 40,
  },
};

export const AI_RATIO_CHOICES: number[] = [0.25, 0.4, 0.55, 0.7, 0.85, 1];

/**
 * Casual solo start. Every player-owned territory begins with this many extra
 * troops, clamped to its own capacity. This is a real starting-state advantage
 * only: the player's production rates, AI cadence and every battle rule stay
 * untouched, and the versus mode (two humans) never receives it.
 */
export const CASUAL_PLAYER_START_BONUS = 8;

/**
 * Casual solo AI economy handicap. AI-owned territories produce at this
 * multiplier (player-owned and neutral territories are unaffected). The player
 * HUD still shows the real, unmodified player production rates, so no visible
 * number becomes a lie; this is only an opponent handicap. Versus, challenge
 * and every legacy difficulty use 1.
 */
export const CASUAL_AI_PRODUCTION_MULTIPLIER = 0.8;

/**
 * Economy. Gold is a local commander-archive currency: matches earn it, the
 * betrayal-upgrade screen spends it. The simulation never reads these values.
 *
 * - win: full reward for the difficulty
 * - draw: `GOLD_DRAW_REWARD_RATIO` of that same reward, rounded
 * - lose: flat `GOLD_DEFEAT_REWARD` on every difficulty
 * - versus (two players on one screen): no gold at all
 */
export const GOLD_REWARDS: Record<Difficulty, number> = {
  easy: 50,
  normal: 120,
  hard: 300,
  casual: 30,
};
export const GOLD_DRAW_REWARD_RATIO = 0.3;
export const GOLD_DEFEAT_REWARD = 10;

/**
 * Local versus (two humans on one device). The second human reuses the ai1
 * owner slot; the planner is never run. Copy lives here so HUD and result
 * screens cannot drift apart.
 */
export const VERSUS_BLUE_NAME = '蓝方';
export const VERSUS_RED_NAME = '红方';
export const VERSUS_TAGLINE = '同一设备 · 双人各控一色';
export const VERSUS_INTRO_TITLE = '双人对战';
export const VERSUS_INTRO_BODY = '蓝方与红方各控一色，各自长按己方领地蓄力，拖向目标出兵。';
export const VERSUS_INTRO_HINT = '双指可同时操作，互不干扰';
/** Versus shares one economy: neither side may buy battlefield upgrades. */
export const VERSUS_NO_UPGRADE_NOTE = '本模式无战场升级';
export const VERSUS_INTRO_AUTO_DISMISS_MS = 3000;

/** Sequential unlock prices for betrayal levels 1..BETRAYAL_MAX_LEVEL. */
export const BETRAYAL_LEVEL_PRICES: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 150,
  2: 400,
  3: 900,
  4: 1800,
  5: 3500,
};
