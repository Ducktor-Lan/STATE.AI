import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateResults, benchmarkIdentity, canonicalJson, clusterBootstrap, createSchedule,
  estimateRunCost, preflightBudget, rankOutcomes, rateWilson,
} from '@state/evaluation';
import type { BenchmarkProfile, EvaluationRecord, ModelOutcome, ScheduleConfig, ScheduledGame } from '@state/evaluation';

const profile: BenchmarkProfile = {
  engineVersion: 'state-conquest@35d7ca7+arena.1',
  protocolVersion: 'arena-v1',
  promptVersion: 'prompt-v1',
  budget: { maxCalls: 1000, maxCostUsd: 10 },
  context: { memory: 'seat-private', truncation: 'none' },
  rules: { decisionTicks: 20, maxActions: 3, disaster: false },
};

function config(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    models: [
      { id: 'a', kind: 'baseline', label: 'Baseline' },
      { id: 'b', kind: 'remote' },
      { id: 'c', kind: 'remote' },
      { id: 'd', kind: 'remote' },
    ],
    factionCount: 2,
    track: 'strategy',
    seeds: [17],
    durationSeconds: 180,
    seatPolicy: 'balanced-rotations',
    profile,
    ...overrides,
  };
}

function completed(game: ScheduledGame, ranks?: readonly number[], metrics: Partial<ModelOutcome> = {}): EvaluationRecord {
  return {
    game,
    runId: `run-${game.gameId}`,
    status: 'completed',
    outcomes: game.models.map((model, index) => ({
      modelId: model.id,
      rank: ranks?.[index] ?? index + 1,
      calls: 10,
      actionAttempts: 10,
      invalidActions: 1,
      tokens: 200,
      latencyMs: 25,
      costMs: 250,
      errors: 0,
      ...metrics,
    })),
  };
}

function duel(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  const base = config();
  return config({ models: base.models.slice(0, 2), ...overrides });
}

test('multi-model duels enumerate every pair, swap both seats, and repeat deterministically', () => {
  const input = config({ seeds: [17, 3], repetitions: 2 });
  const schedule = createSchedule(input);
  assert.equal(schedule.games.length, 6 * 2 * 2 * 2);
  assert.equal(new Set(schedule.games.map(game => game.gameId)).size, schedule.games.length);
  assert.deepEqual(schedule, createSchedule(input));
  assert.deepEqual(schedule, createSchedule({ ...input, models: input.models.slice().reverse(), seeds: [3, 17] }));
  const blocks = new Map<string, ScheduledGame[]>();
  for (const game of schedule.games) {
    const block = blocks.get(game.pairingId) ?? [];
    block.push(game);
    blocks.set(game.pairingId, block);
  }
  assert.equal(blocks.size, 6 * 2 * 2);
  for (const games of blocks.values()) {
    assert.equal(games.length, 2);
    assert.equal(games[0]!.initiativeOffset, games[1]!.initiativeOffset);
    for (const model of games[0]!.models) {
      const seats = games.flatMap(game => game.seats.filter(seat => seat.modelId === model.id).map(seat => seat.seat));
      assert.deepEqual(seats.slice().sort(), [0, 1]);
    }
  }
  assert.equal(new Set(schedule.games.map(game => game.mapGroupId)).size, 2);
  assert.equal(schedule.determinism.onlineModelOutputs, false);
});

test('three- and four-faction policies cover every seat and initiative position', () => {
  for (const factionCount of [3, 4] as const) {
    for (const seatPolicy of ['full-permutations', 'balanced-rotations'] as const) {
      const schedule = createSchedule(config({ factionCount, models: config().models.slice(0, factionCount), seatPolicy, track: 'diplomacy' }));
      assert.equal(schedule.games.length, seatPolicy === 'balanced-rotations' ? factionCount : factionCount === 3 ? 6 : 24);
      for (const model of schedule.config.models) {
        const assignments = schedule.games.map(game => ({ seat: game.seats.find(seat => seat.modelId === model.id)!.seat, offset: game.initiativeOffset }));
        assert.equal(new Set(assignments.map(assignment => assignment.seat)).size, factionCount);
        assert.equal(new Set(assignments.map(assignment => (assignment.seat - assignment.offset + factionCount) % factionCount)).size, factionCount);
      }
    }
  }
  // A roster larger than the table also enumerates every multiplayer lineup.
  assert.equal(createSchedule(config({ factionCount: 3 })).games.length, 4 * 3);
  assert.throws(() => createSchedule(config({ track: 'diplomacy' })), /Diplomacy/);
  assert.throws(() => createSchedule(config({ seeds: [1, 1] })), /Duplicate seeds/);
  assert.throws(() => createSchedule(config({ models: [config().models[0]!, config().models[0]!] })), /Duplicate model/);
});

test('grouping independently derives track and every benchmark profile field', () => {
  const variants: ScheduleConfig[] = [config({ factionCount: 3 })];
  variants.push({ ...variants[0]!, track: 'diplomacy' });
  for (const changed of [
    { engineVersion: 'engine-v2' }, { protocolVersion: 'protocol-v2' }, { promptVersion: 'prompt-v2' },
    { budget: { maxCalls: 2000 } }, { context: { memory: 'none' } }, { rules: { disaster: true } },
  ]) variants.push({ ...variants[0]!, profile: { ...profile, ...changed } });
  variants.push({ ...variants[0]!, durationSeconds: 300 });
  variants.push(config());
  const records = variants.map(variant => {
    const game = createSchedule(variant).games[0]!;
    // A server-supplied label must not defeat actual profile separation.
    return completed({ ...game, groupId: 'same-label', profileKey: 'same-label', mapGroupId: 'same-label' });
  });
  const report = aggregateResults(records);
  assert.equal(report.groups.length, variants.length);
  assert.equal(report.completedGames, variants.length);
  assert.equal(report.excludedRecords.length, 0);
  assert.equal(new Set(report.groups.map(group => group.groupId)).size, variants.length);
});

test('same-tick eliminations tie; FFA champions split credit and retain metrics', () => {
  const outcomes = rankOutcomes([
    { modelId: 'a', score: 20, lands: 2, forces: 10, eliminatedTick: null },
    { modelId: 'b', score: 20, lands: 2, forces: 10, eliminatedTick: null },
    { modelId: 'c', score: 100, lands: 0, forces: 0, eliminatedTick: 200 },
    { modelId: 'd', score: 1, lands: 0, forces: 0, eliminatedTick: 200 },
  ]);
  assert.deepEqual(outcomes.map(outcome => outcome.rank), [1, 1, 3, 3]);
  const game = createSchedule(config({ factionCount: 4 })).games[0]!;
  const report = aggregateResults([{ ...completed(game), outcomes }]);
  assert.equal(report.completedGames, 1);
  const a = report.groups[0]!.models.find(model => model.modelId === 'a')!;
  const c = report.groups[0]!.models.find(model => model.modelId === 'c')!;
  assert.equal(a.wins, 0);
  assert.equal(a.ties, 1);
  assert.equal(a.championShare, 0.5);
  assert.equal(a.avgRank, 1);
  assert.equal(a.rankDistribution['1'], 1);
  assert.equal(c.avgRank, 3);
  assert.equal(c.avgEliminatedTick, 200);
  assert.equal(a.costUsd, null);
  assert.equal(a.samples.costUsd, 0);
  assert.equal(a.kind, 'baseline');
});

test('failed, interrupted, unfinished, invalid and duplicate runs never become strategy losses', () => {
  const games = createSchedule(duel({ seeds: [1, 2, 3] })).games;
  const good = completed(games[0]!);
  const records: EvaluationRecord[] = [
    good,
    { ...completed(games[0]!), runId: 'failed-before-retry', status: 'failed', outcomes: [], failureReason: 'provider unavailable' },
    { ...completed(games[1]!), status: 'interrupted', outcomes: [] },
    { ...completed(games[2]!), status: 'incomplete', outcomes: [] },
    { ...completed(games[3]!), outcomes: [] },
    completed(games[4]!),
    { ...completed(games[4]!), runId: 'second-completion' },
  ];
  const report = aggregateResults(records);
  assert.equal(report.completedGames, 1);
  assert.equal(report.excludedRecords.length, 6);
  assert.equal(report.excludedRecords.filter(record => record.reason === 'duplicate-game').length, 2);
  assert.equal(report.groups[0]!.models[0]!.games, 1);
  assert.equal(report.groups[0]!.models[0]!.wins, 1);
  const duplicateRun = aggregateResults([good, { ...completed(games[1]!), runId: good.runId }]);
  assert.equal(duplicateRun.completedGames, 0);
  assert.equal(duplicateRun.excludedRecords.filter(record => record.reason === 'duplicate-run').length, 2);
});

test('paired swaps use 0.5 for draws, omit incomplete blocks and preserve unknown cost', () => {
  const games = createSchedule(duel({ seeds: [1, 2] })).games;
  const records = [
    completed(games[0]!, [1, 2], { costUsd: 0.2 }),
    completed(games[1]!, [1, 1]),
    completed(games[2]!, [2, 1]),
  ];
  const report = aggregateResults(records);
  const group = report.groups[0]!;
  const a = group.models.find(model => model.modelId === 'a')!;
  assert.equal(a.games, 3);
  assert.equal(a.championShare, 0.5);
  assert.equal(a.invalidActionRate, 0.1);
  assert.equal(a.calls, 30);
  assert.equal(a.tokens, 600);
  assert.equal(a.latencyMs, 25);
  assert.equal(a.costUsd, null);
  assert.equal(a.knownTotals.costUsd, 0.2);
  assert.equal(a.samples.costUsd, 1);
  const paired = group.pairedComparisons[0]!;
  assert.equal(paired.completePairs, 1);
  assert.equal(paired.incompletePairs, 1);
  assert.equal(paired.games, 2);
  assert.equal(paired.models.find(model => model.modelId === 'a')!.score, 0.75);
  assert.equal(paired.models.find(model => model.modelId === 'b')!.score, 0.25);
  assert.equal(paired.models[0]!.confidenceInterval.clusterCount, 1);
  assert.deepEqual(report, aggregateResults(records.slice().reverse()));
  const priced = aggregateResults(records.map(record => ({ ...record, outcomes: record.outcomes.map(outcome => ({ ...outcome, costUsd: 0 })) })));
  assert.equal(priced.groups[0]!.models[0]!.costUsd, 0);
});

test('map-cluster bootstrap is deterministic and cannot manufacture samples from repeated maps', () => {
  const repeated = clusterBootstrap(Array.from({ length: 100 }, (_, index) => ({ clusterId: 'one-map', value: index % 2 })));
  assert.equal(repeated.clusterCount, 1);
  assert.equal(repeated.sampleCount, 100);
  assert.equal(repeated.status, 'insufficient');
  assert.equal(repeated.lower, null);
  assert.equal(repeated.upper, null);
  assert.equal(repeated.strongConclusion, false);
  const samples = Array.from({ length: 20 }, (_, index) => ({ clusterId: `map-${index}`, value: index % 2 }));
  const interval = clusterBootstrap(samples);
  assert.deepEqual(interval, clusterBootstrap(samples.slice().reverse()));
  assert.equal(interval.status, 'estimated');
  assert.equal(interval.estimate, 0.5);
  assert.ok(interval.lower! < 0.5 && interval.upper! > 0.5);
  assert.equal(clusterBootstrap(samples.slice(0, 5)).status, 'limited');
  assert.equal(clusterBootstrap([]).estimate, null);
  const manySwaps = createSchedule(duel({ repetitions: 10 }));
  const report = aggregateResults(manySwaps.games.map(game => completed(game)));
  assert.equal(report.groups[0]!.models[0]!.championShareInterval.clusterCount, 1);
  assert.equal(report.groups[0]!.pairedComparisons[0]!.completePairs, 10);
  assert.equal(report.groups[0]!.pairedComparisons[0]!.models[0]!.confidenceInterval.status, 'insufficient');
  const wilson = rateWilson(10, 20);
  assert.equal(wilson.primary, false);
  assert.match(wilson.warning, /independent/);
});

test('call estimates round up per faction; unknown prices cannot pass a hard USD budget', () => {
  const input = {
    durationTicks: 1801,
    decisionTicks: 20,
    factions: 3 as const,
    inputTokensPerCall: 1000,
    outputTokensPerCall: 200,
    pricing: [{ inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, null],
  };
  const original = structuredClone(input);
  const estimate = estimateRunCost(input);
  assert.deepEqual(input, original);
  assert.equal(estimate.callsPerFaction, 91);
  assert.equal(estimate.totalCalls, 273);
  assert.equal(estimate.totalTokens, 327600);
  assert.equal(estimate.costUsd, null);
  assert.ok(Math.abs(estimate.knownCostUsd - 0.1274) < 1e-12);
  assert.deepEqual(estimate.unpricedFactions, [2]);
  assert.equal(preflightBudget(estimate, { maxCalls: 272 }).status, 'exceeded');
  assert.equal(preflightBudget(estimate, { maxCalls: 273 }).status, 'pass');
  const unknown = preflightBudget(estimate, { maxCostUsd: 1 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.issues[0]!.code, 'cost-unknown');
  assert.equal(estimateRunCost({ durationTicks: 1, decisionTicks: 20, factions: 2 }).costUsd, null);
  assert.equal(estimateRunCost({ ...input, pricing: Array(3).fill({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 }) }).costUsd, 0);
  assert.throws(() => estimateRunCost({ ...input, decisionTicks: 0 }), /decisionTicks/);
});

test('canonical identities ignore object insertion order and change when benchmark rules evolve', () => {
  assert.equal(canonicalJson({ b: 2, a: [1, { y: true, x: null }] }), '{"a":[1,{"x":null,"y":true}],"b":2}');
  assert.equal(benchmarkIdentity({ b: 2, a: 1 }), 'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  assert.equal(benchmarkIdentity({ a: 1, b: 2 }), benchmarkIdentity({ b: 2, a: 1 }));
  assert.notEqual(createSchedule(duel()).benchmarkId, createSchedule(duel({ profile: { ...profile, protocolVersion: 'v2' } })).benchmarkId);
  for (const invalid of [undefined, { missing: undefined }, NaN, new Date(), Array(1)]) assert.throws(() => canonicalJson(invalid));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /circular/);
});
