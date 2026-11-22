import type {
  AggregationOptions, BenchmarkProfile, ClusterSample, EvaluationGroup, EvaluationModel, EvaluationRecord,
  EvaluationReport, ExcludedRecord, ModelOutcome, ModelStatistics, PairedComparison, ScheduledGame,
} from './types.js';
import { benchmarkIdentity, compareText, comparisonGroupId, profileIdentity, requireInteger, requireNonnegative, requireText, validateContest } from './identity.js';
import { bootstrapSettings, clusterBootstrap, MINIMUM_MAP_CLUSTERS, RECOMMENDED_MAP_CLUSTERS } from './statistics.js';

interface ValidRecord {
  readonly record: EvaluationRecord;
  readonly groupId: string;
  readonly profileKey: string;
  readonly mapGroupId: string;
  readonly pairingId: string;
}

const totalMetrics = ['calls', 'actionAttempts', 'invalidActions', 'tokens', 'costMs', 'costUsd', 'errors'] as const;
const meanMetrics = ['latencyMs', 'score', 'lands', 'forces', 'eliminatedTick'] as const;
const integerMetrics = new Set<string>(['calls', 'actionAttempts', 'invalidActions', 'tokens', 'errors', 'eliminatedTick']);
type Metric = typeof totalMetrics[number] | typeof meanMetrics[number];

function metricValue(outcome: ModelOutcome, key: Metric): number | null {
  const value = outcome[key];
  return typeof value === 'number' ? value : null;
}

function validateRecord(record: EvaluationRecord): ValidRecord {
  requireText(record.runId, 'runId');
  const game = record.game;
  requireText(game.gameId, 'gameId');
  requireText(game.benchmarkId, 'benchmarkId');
  validateContest(game);
  requireInteger(game.seed, 'seed', 0, 0xffffffff);
  requireInteger(game.repetition, 'repetition');
  requireInteger(game.initiativeOffset, 'initiativeOffset', 0, game.factionCount - 1);
  if (game.models.length !== game.factionCount || game.seats.length !== game.factionCount) throw new RangeError('Model and seat counts must equal factionCount.');
  const modelIds = new Set<string>();
  for (const model of game.models) {
    requireText(model.id, 'model.id');
    if (model.kind !== 'baseline' && model.kind !== 'remote') throw new RangeError('Unknown model kind.');
    if (modelIds.has(model.id)) throw new RangeError('A model cannot occupy multiple seats in one evaluation game.');
    modelIds.add(model.id);
  }
  const seats = new Set<number>();
  const seatedModels = new Set<string>();
  for (const assignment of game.seats) {
    requireInteger(assignment.seat, 'seat', 0, game.factionCount - 1);
    if (seats.has(assignment.seat) || seatedModels.has(assignment.modelId) || !modelIds.has(assignment.modelId)) throw new RangeError('Seat assignments must be a bijection onto the model lineup.');
    seats.add(assignment.seat);
    seatedModels.add(assignment.modelId);
  }
  if (record.outcomes.length !== game.factionCount) throw new RangeError('A completed game must provide one outcome per model.');
  const outcomeIds = new Set<string>();
  for (const outcome of record.outcomes) {
    if (!modelIds.has(outcome.modelId) || outcomeIds.has(outcome.modelId)) throw new RangeError('Outcome model ids must match the lineup exactly.');
    outcomeIds.add(outcome.modelId);
    requireInteger(outcome.rank, 'rank', 1, game.factionCount);
    for (const key of [...totalMetrics, ...meanMetrics]) {
      const value = outcome[key];
      if (value === null || value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${key} must be finite or explicitly unknown.`);
      if (key !== 'score') requireNonnegative(value, key);
      if (integerMetrics.has(key)) requireInteger(value, key);
    }
    if (outcome.actionAttempts != null && outcome.invalidActions != null && outcome.invalidActions > outcome.actionAttempts) throw new RangeError('invalidActions cannot exceed actionAttempts.');
  }
  const ranks = record.outcomes.map(outcome => outcome.rank).sort((a, b) => a - b);
  for (let index = 0; index < ranks.length; index++) {
    if ((index === 0 || ranks[index] !== ranks[index - 1]) && ranks[index] !== index + 1) throw new RangeError('Use competition ranks, for example 1, 1, 3 for a tied first place.');
  }
  const groupId = comparisonGroupId(game);
  const mapGroupId = benchmarkIdentity({ groupId, seed: game.seed });
  const pairingId = benchmarkIdentity({ groupId, seed: game.seed, repetition: game.repetition, models: [...modelIds].sort(compareText) });
  return { record, groupId, profileKey: profileIdentity(game.profile), mapGroupId, pairingId };
}

function exclusion(record: EvaluationRecord, reason: ExcludedRecord['reason'], detail: string): ExcludedRecord {
  return { runId: record?.runId ?? '', gameId: record?.game?.gameId ?? '', reason, detail };
}

function modelStatistics(model: EvaluationModel, records: readonly ValidRecord[], options: AggregationOptions): ModelStatistics {
  const rows = records.flatMap(item => {
    const outcome = item.record.outcomes.find(value => value.modelId === model.id);
    if (!outcome) return [];
    const champions = item.record.outcomes.filter(value => value.rank === 1).length;
    return [{ item, outcome, champions }];
  });
  const games = rows.length;
  const rankDistribution: Record<string, number> = Object.create(null) as Record<string, number>;
  let wins = 0;
  let ties = 0;
  let championShares = 0;
  let rankTotal = 0;
  const samples: ClusterSample[] = [];
  const metricCounts = Object.fromEntries([...totalMetrics, ...meanMetrics].map(key => [key, 0])) as Record<Metric, number>;
  const sums = Object.fromEntries([...totalMetrics, ...meanMetrics].map(key => [key, 0])) as Record<Metric, number>;
  let invalidRateSamples = 0;
  let invalidRateAttempts = 0;
  let invalidRateActions = 0;
  for (const { item, outcome, champions } of rows) {
    rankDistribution[String(outcome.rank)] = (rankDistribution[String(outcome.rank)] ?? 0) + 1;
    rankTotal += outcome.rank;
    const credit = outcome.rank === 1 ? 1 / champions : 0;
    championShares += credit;
    if (outcome.rank === 1) {
      if (champions === 1) wins++;
      else ties++;
    }
    samples.push({ clusterId: item.mapGroupId, value: credit });
    for (const key of [...totalMetrics, ...meanMetrics]) {
      const value = metricValue(outcome, key);
      if (value !== null) {
        metricCounts[key]++;
        sums[key] += value;
      }
    }
    if (outcome.actionAttempts != null && outcome.invalidActions != null) {
      invalidRateSamples++;
      invalidRateAttempts += outcome.actionAttempts;
      invalidRateActions += outcome.invalidActions;
    }
  }
  const completeTotal = (key: typeof totalMetrics[number]): number | null => metricCounts[key] === games && games > 0 ? sums[key] : null;
  const mean = (key: typeof meanMetrics[number]): number | null => metricCounts[key] ? sums[key] / metricCounts[key] : null;
  return {
    modelId: model.id,
    label: model.label ?? model.id,
    kind: model.kind,
    games,
    wins,
    ties,
    championShares,
    championShare: games ? championShares / games : null,
    winRate: games ? wins / games : null,
    rankDistribution,
    avgRank: games ? rankTotal / games : null,
    invalidActionRate: invalidRateAttempts ? invalidRateActions / invalidRateAttempts : null,
    calls: completeTotal('calls'),
    actionAttempts: completeTotal('actionAttempts'),
    invalidActions: completeTotal('invalidActions'),
    tokens: completeTotal('tokens'),
    costMs: completeTotal('costMs'),
    costUsd: completeTotal('costUsd'),
    errors: completeTotal('errors'),
    latencyMs: mean('latencyMs'),
    avgScore: mean('score'),
    avgLands: mean('lands'),
    avgForces: mean('forces'),
    avgEliminatedTick: mean('eliminatedTick'),
    samples: {
      games,
      mapGroups: new Set(rows.map(row => row.item.mapGroupId)).size,
      ...metricCounts,
      invalidActionRate: invalidRateSamples,
    },
    knownTotals: {
      calls: sums.calls,
      actionAttempts: sums.actionAttempts,
      invalidActions: sums.invalidActions,
      tokens: sums.tokens,
      costMs: sums.costMs,
      costUsd: sums.costUsd,
      errors: sums.errors,
    },
    championShareInterval: clusterBootstrap(samples, { iterations: options.bootstrapIterations, seed: options.bootstrapSeed }),
  };
}

function seatFor(game: ScheduledGame, modelId: string): number {
  return game.seats.find(seat => seat.modelId === modelId)!.seat;
}

function pairedComparisons(records: readonly ValidRecord[], options: AggregationOptions): PairedComparison[] {
  const lineups = new Map<string, { modelIds: [string, string]; pairs: Map<string, ValidRecord[]> }>();
  for (const record of records) {
    if (record.record.game.factionCount !== 2) continue;
    const ids = record.record.game.models.map(model => model.id).sort(compareText) as [string, string];
    const key = benchmarkIdentity(ids);
    const lineup = lineups.get(key) ?? { modelIds: ids, pairs: new Map<string, ValidRecord[]>() };
    const pair = lineup.pairs.get(record.pairingId) ?? [];
    pair.push(record);
    lineup.pairs.set(record.pairingId, pair);
    lineups.set(key, lineup);
  }
  return [...lineups.values()].sort((a, b) => compareText(a.modelIds[0], b.modelIds[0]) || compareText(a.modelIds[1], b.modelIds[1])).map(lineup => {
    let completePairs = 0;
    let incompletePairs = 0;
    const sampleGroups = new Set<string>();
    const points = [0, 0];
    const samples: [ClusterSample[], ClusterSample[]] = [[], []];
    for (const pair of lineup.pairs.values()) {
      if (pair.length !== 2
        || pair[0]!.record.game.initiativeOffset !== pair[1]!.record.game.initiativeOffset
        || seatFor(pair[0]!.record.game, lineup.modelIds[0]) === seatFor(pair[1]!.record.game, lineup.modelIds[0])) {
        incompletePairs++;
        continue;
      }
      completePairs++;
      sampleGroups.add(pair[0]!.mapGroupId);
      for (let index = 0; index < 2; index++) {
        const modelId = lineup.modelIds[index]!;
        let pairPoints = 0;
        for (const game of pair) {
          const ownRank = game.record.outcomes.find(outcome => outcome.modelId === modelId)!.rank;
          const otherRank = game.record.outcomes.find(outcome => outcome.modelId !== modelId)!.rank;
          pairPoints += ownRank < otherRank ? 1 : ownRank === otherRank ? 0.5 : 0;
        }
        points[index]! += pairPoints;
        samples[index]!.push({ clusterId: pair[0]!.mapGroupId, value: pairPoints / 2, weight: 2 });
      }
    }
    return {
      modelIds: lineup.modelIds,
      completePairs,
      games: completePairs * 2,
      incompletePairs,
      mapGroups: sampleGroups.size,
      models: lineup.modelIds.map((modelId, index) => ({
        modelId,
        points: points[index]!,
        score: completePairs ? points[index]! / (completePairs * 2) : null,
        confidenceInterval: clusterBootstrap(samples[index]!, { iterations: options.bootstrapIterations, seed: options.bootstrapSeed }),
      })),
    };
  });
}

/** Only valid completed runs contribute to outcomes. Caller labels never override profile/seed identity. */
export function aggregateResults(records: readonly EvaluationRecord[], options: AggregationOptions = {}): EvaluationReport {
  const settings = bootstrapSettings({ iterations: options.bootstrapIterations, seed: options.bootstrapSeed });
  const excludedRecords: ExcludedRecord[] = [];
  const candidates: ValidRecord[] = [];
  for (const record of records) {
    if (record?.status !== 'completed') {
      const status = record?.status;
      if (status === 'failed' || status === 'interrupted' || status === 'incomplete') {
        excludedRecords.push(exclusion(record, status, record.failureReason ?? `Run status is ${status}; no strategy loss is inferred.`));
      } else {
        excludedRecords.push(exclusion(record, 'invalid-record', 'Unknown run status.'));
      }
      continue;
    }
    try {
      candidates.push(validateRecord(record));
    } catch (error) {
      excludedRecords.push(exclusion(record, 'invalid-record', error instanceof Error ? error.message : String(error)));
    }
  }
  const runCounts = new Map<string, number>();
  const gameCounts = new Map<string, number>();
  const modelKinds = new Map<string, Set<EvaluationModel['kind']>>();
  for (const candidate of candidates) {
    const { record, groupId } = candidate;
    runCounts.set(record.runId, (runCounts.get(record.runId) ?? 0) + 1);
    gameCounts.set(record.game.gameId, (gameCounts.get(record.game.gameId) ?? 0) + 1);
    for (const model of record.game.models) {
      const key = benchmarkIdentity({ groupId, modelId: model.id });
      const kinds = modelKinds.get(key) ?? new Set<EvaluationModel['kind']>();
      kinds.add(model.kind);
      modelKinds.set(key, kinds);
    }
  }
  const groups = new Map<string, ValidRecord[]>();
  candidates.sort((a, b) => compareText(a.record.game.gameId, b.record.game.gameId) || compareText(a.record.runId, b.record.runId));
  let completedGames = 0;
  for (const candidate of candidates) {
    const { record, groupId } = candidate;
    if (runCounts.get(record.runId)! > 1) {
      excludedRecords.push(exclusion(record, 'duplicate-run', 'Repeated completed run id; all copies are excluded to avoid inflating the sample.'));
    } else if (gameCounts.get(record.game.gameId)! > 1) {
      excludedRecords.push(exclusion(record, 'duplicate-game', 'Multiple completed runs claim the same scheduled game; all are excluded rather than choosing a favorable result.'));
    } else if (record.game.models.some(model => modelKinds.get(benchmarkIdentity({ groupId, modelId: model.id }))!.size > 1)) {
      excludedRecords.push(exclusion(record, 'invalid-record', 'A model id has conflicting baseline/remote identities within this comparison group.'));
    } else {
      const group = groups.get(groupId) ?? [];
      group.push(candidate);
      groups.set(groupId, group);
      completedGames++;
    }
  }
  const summaries: EvaluationGroup[] = [...groups].sort(([a], [b]) => compareText(a, b)).map(([groupId, group]) => {
    const first = group[0]!;
    const game = first.record.game;
    const models = new Map<string, EvaluationModel>();
    for (const item of group) for (const model of item.record.game.models) if (!models.has(model.id)) models.set(model.id, model);
    const statistics = [...models.values()].sort((a, b) => compareText(a.id, b.id)).map(model => modelStatistics(model, group, options));
    const comparisons = pairedComparisons(group, options);
    const mapGroups = new Set(group.map(item => item.mapGroupId)).size;
    const warnings: string[] = [];
    if (mapGroups < MINIMUM_MAP_CLUSTERS) warnings.push('Insufficient independent seed/map groups for a 95% interval; no strong conclusion.');
    else if (mapGroups < RECOMMENDED_MAP_CLUSTERS) warnings.push('Fewer than twenty independent maps; confidence intervals are exploratory.');
    if (comparisons.some(comparison => comparison.incompletePairs)) warnings.push('Incomplete or unbalanced seat-swap blocks are omitted from paired head-to-head statistics. Completed games remain in descriptive model statistics.');
    if (statistics.some(model => model.costUsd === null)) warnings.push('One or more models have unknown USD cost. Known partial charges are reported separately and are not complete totals.');
    return {
      groupId,
      profileKey: first.profileKey,
      track: game.track,
      durationSeconds: game.durationSeconds,
      factionCount: game.factionCount,
      profile: JSON.parse(JSON.stringify(game.profile)) as BenchmarkProfile,
      completedGames: group.length,
      mapGroups,
      models: statistics,
      pairedComparisons: comparisons,
      warnings,
    };
  });
  excludedRecords.sort((a, b) => compareText(a.gameId, b.gameId) || compareText(a.runId, b.runId) || compareText(a.reason, b.reason));
  return {
    schemaVersion: 1,
    receivedRecords: records.length,
    completedGames,
    excludedRecords,
    groups: summaries,
    methodology: {
      confidence: 0.95,
      resamplingUnit: 'seed-map-group',
      minimumClusters: MINIMUM_MAP_CLUSTERS,
      recommendedClusters: RECOMMENDED_MAP_CLUSTERS,
      bootstrapIterations: settings.iterations,
      bootstrapSeed: settings.seed,
      onlineModelDeterminism: false,
    },
  };
}
