export type Track = 'strategy' | 'diplomacy';
export type FactionCount = 2 | 3 | 4;
export type Seat = 0 | 1 | 2 | 3;
export type SeatPolicy = 'full-permutations' | 'balanced-rotations';
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface EvaluationModel {
  readonly id: string;
  readonly kind: 'baseline' | 'remote';
  readonly label?: string;
}

/** Change any applicable version/rule when the benchmark evolves. */
export interface BenchmarkProfile {
  readonly engineVersion: string;
  readonly protocolVersion: string;
  readonly promptVersion: string;
  readonly budget: JsonValue;
  readonly context: JsonValue;
  readonly rules: JsonValue;
}

export interface ScheduleConfig {
  readonly models: readonly EvaluationModel[];
  readonly factionCount: FactionCount;
  readonly track: Track;
  readonly seeds: readonly number[];
  readonly durationSeconds: number;
  readonly repetitions?: number;
  readonly seatPolicy: SeatPolicy;
  readonly profile: BenchmarkProfile;
}

export interface SeatAssignment {
  readonly seat: Seat;
  readonly modelId: string;
}

export interface ScheduledGame {
  readonly gameId: string;
  readonly benchmarkId: string;
  readonly profileKey: string;
  readonly groupId: string;
  /** Shared by all repetitions/matchups with this seed in this comparison group. */
  readonly mapGroupId: string;
  /** Shared by all seat permutations of one lineup, seed and repetition. */
  readonly pairingId: string;
  readonly track: Track;
  readonly seed: number;
  readonly repetition: number;
  readonly durationSeconds: number;
  readonly factionCount: FactionCount;
  /** Zero-based starting seat for the engine's initiative order. */
  readonly initiativeOffset: number;
  readonly seats: readonly SeatAssignment[];
  readonly models: readonly EvaluationModel[];
  readonly profile: BenchmarkProfile;
}

export interface EvaluationSchedule {
  readonly schemaVersion: 1;
  readonly benchmarkId: string;
  readonly groupId: string;
  readonly profileKey: string;
  readonly config: ScheduleConfig;
  readonly games: readonly ScheduledGame[];
  readonly determinism: {
    readonly schedule: true;
    readonly onlineModelOutputs: false;
    readonly note: string;
  };
}

export interface ModelOutcome {
  readonly modelId: string;
  /** Competition rank: 1, 1, 3 for a two-way tie for first. */
  readonly rank: number;
  readonly score?: number | null;
  readonly lands?: number | null;
  readonly forces?: number | null;
  readonly eliminatedTick?: number | null;
  readonly calls?: number | null;
  /** Submitted actions (including diplomacy); a malformed response may be one invalid opportunity. */
  readonly actionAttempts?: number | null;
  readonly invalidActions?: number | null;
  readonly tokens?: number | null;
  /** Mean decision latency for this model in this run, in milliseconds. */
  readonly latencyMs?: number | null;
  /** Total execution/provider time in milliseconds; independent of USD cost. */
  readonly costMs?: number | null;
  readonly costUsd?: number | null;
  readonly errors?: number | null;
}

export interface UnrankedOutcome extends Omit<ModelOutcome, 'rank' | 'score' | 'lands' | 'forces' | 'eliminatedTick'> {
  readonly score: number;
  readonly lands: number;
  readonly forces: number;
  readonly eliminatedTick: number | null;
}

export interface EvaluationRecord {
  readonly game: ScheduledGame;
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'interrupted' | 'incomplete';
  readonly outcomes: readonly ModelOutcome[];
  readonly failureReason?: string;
}

export interface AggregationOptions {
  readonly bootstrapIterations?: number;
  readonly bootstrapSeed?: number;
}

export interface BootstrapOptions {
  readonly iterations?: number;
  readonly seed?: number;
}

export interface ClusterSample {
  readonly clusterId: string;
  readonly value: number;
  readonly weight?: number;
}

export interface ConfidenceInterval {
  readonly method: 'cluster-bootstrap';
  readonly confidence: 0.95;
  readonly estimate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly sampleCount: number;
  readonly clusterCount: number;
  readonly iterations: number;
  readonly rngSeed: number;
  /** Fewer than five maps are not estimated; fewer than twenty remain limited. */
  readonly status: 'insufficient' | 'limited' | 'estimated';
  readonly strongConclusion: false;
  readonly warning: string | null;
}

export interface WilsonInterval {
  readonly method: 'wilson-independent-games';
  readonly confidence: 0.95;
  readonly estimate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly sampleCount: number;
  readonly primary: false;
  readonly warning: string;
}

export interface MetricSampleCounts {
  readonly games: number;
  readonly mapGroups: number;
  readonly calls: number;
  readonly actionAttempts: number;
  readonly invalidActions: number;
  readonly tokens: number;
  readonly latencyMs: number;
  readonly costMs: number;
  readonly costUsd: number;
  readonly errors: number;
  readonly score: number;
  readonly lands: number;
  readonly forces: number;
  readonly eliminatedTick: number;
  readonly invalidActionRate: number;
}

export interface ModelStatistics {
  readonly modelId: string;
  readonly label: string;
  readonly kind: EvaluationModel['kind'];
  readonly games: number;
  /** Outright first places; top-rank ties are reported separately. */
  readonly wins: number;
  readonly ties: number;
  readonly championShares: number;
  /** Mean champion credit: 1 / number of tied champions, zero otherwise. */
  readonly championShare: number | null;
  readonly winRate: number | null;
  readonly rankDistribution: Readonly<Record<string, number>>;
  readonly avgRank: number | null;
  readonly invalidActionRate: number | null;
  /** Totals remain null if any participating run lacks that metric. */
  readonly calls: number | null;
  readonly actionAttempts: number | null;
  readonly invalidActions: number | null;
  readonly tokens: number | null;
  readonly costMs: number | null;
  readonly costUsd: number | null;
  readonly errors: number | null;
  /** Mean over observed per-run mean latencies; see samples.latencyMs. */
  readonly latencyMs: number | null;
  readonly avgScore: number | null;
  readonly avgLands: number | null;
  readonly avgForces: number | null;
  readonly avgEliminatedTick: number | null;
  readonly samples: MetricSampleCounts;
  /** Partial sums are explicitly separate from complete totals. */
  readonly knownTotals: {
    readonly calls: number;
    readonly actionAttempts: number;
    readonly invalidActions: number;
    readonly tokens: number;
    readonly costMs: number;
    readonly costUsd: number;
    readonly errors: number;
  };
  readonly championShareInterval: ConfidenceInterval;
}

export interface PairedModelStatistics {
  readonly modelId: string;
  readonly points: number;
  /** Mean head-to-head points; a drawn game contributes 0.5. */
  readonly score: number | null;
  readonly confidenceInterval: ConfidenceInterval;
}

export interface PairedComparison {
  readonly modelIds: readonly [string, string];
  readonly completePairs: number;
  readonly games: number;
  readonly incompletePairs: number;
  readonly mapGroups: number;
  readonly models: readonly PairedModelStatistics[];
}

export interface EvaluationGroup {
  readonly groupId: string;
  readonly profileKey: string;
  readonly track: Track;
  readonly durationSeconds: number;
  readonly factionCount: FactionCount;
  readonly profile: BenchmarkProfile;
  readonly completedGames: number;
  readonly mapGroups: number;
  readonly models: readonly ModelStatistics[];
  readonly pairedComparisons: readonly PairedComparison[];
  readonly warnings: readonly string[];
}

export interface ExcludedRecord {
  readonly runId: string;
  readonly gameId: string;
  readonly reason: 'failed' | 'interrupted' | 'incomplete' | 'invalid-record' | 'duplicate-game' | 'duplicate-run';
  readonly detail: string;
}

export interface EvaluationReport {
  readonly schemaVersion: 1;
  readonly receivedRecords: number;
  readonly completedGames: number;
  readonly excludedRecords: readonly ExcludedRecord[];
  readonly groups: readonly EvaluationGroup[];
  readonly methodology: {
    readonly confidence: 0.95;
    readonly resamplingUnit: 'seed-map-group';
    readonly minimumClusters: 5;
    readonly recommendedClusters: 20;
    readonly bootstrapIterations: number;
    readonly bootstrapSeed: number;
    readonly onlineModelDeterminism: false;
  };
}

export interface ModelPricing {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

export interface RunEstimateInput {
  readonly durationTicks: number;
  readonly decisionTicks: number;
  readonly factions: FactionCount;
  /** One entry per seat. Missing/null entries mean explicitly unknown prices. */
  readonly pricing?: readonly (ModelPricing | null)[];
  readonly inputTokensPerCall?: number;
  readonly outputTokensPerCall?: number;
}

export interface RunEstimate {
  readonly durationTicks: number;
  readonly decisionTicks: number;
  readonly factions: FactionCount;
  readonly callsPerFaction: number;
  readonly totalCalls: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly knownCostUsd: number;
  readonly pricedFactions: number;
  readonly unpricedFactions: readonly Seat[];
  readonly costKnownFactions: number;
  readonly warnings: readonly string[];
}

export interface BudgetLimits {
  readonly maxCalls?: number;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
}

export interface BudgetIssue {
  readonly code: 'calls-exceeded' | 'tokens-exceeded' | 'cost-exceeded' | 'tokens-unknown' | 'cost-unknown';
  readonly limit: number;
  readonly estimate: number | null;
}

export interface BudgetPreflight {
  readonly ok: boolean;
  readonly status: 'pass' | 'exceeded' | 'unknown';
  readonly issues: readonly BudgetIssue[];
  readonly estimate: RunEstimate;
  readonly budget: BudgetLimits;
}
