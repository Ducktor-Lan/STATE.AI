import type { EvaluationModel, EvaluationSchedule, ScheduleConfig, ScheduledGame, Seat } from './types.js';
import { benchmarkIdentity, canonicalJson, compareText, comparisonGroupId, profileIdentity, randomGenerator, requireInteger, requireText, validateContest } from './identity.js';

function combinations<T>(values: readonly T[], count: number): T[][] {
  const result: T[][] = [];
  function visit(start: number, chosen: T[]): void {
    if (chosen.length === count) {
      result.push(chosen.slice());
      return;
    }
    for (let index = start; index <= values.length - count + chosen.length; index++) {
      chosen.push(values[index]!);
      visit(index + 1, chosen);
      chosen.pop();
    }
  }
  visit(0, []);
  return result;
}

function permutations<T>(values: readonly T[]): T[][] {
  if (!values.length) return [[]];
  return values.flatMap((value, index) => permutations(values.filter((_, position) => position !== index)).map(rest => [value, ...rest]));
}

function rotations<T>(values: readonly T[], seed: number): T[][] {
  const base = values.slice();
  const random = randomGenerator(seed);
  for (let index = base.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [base[index], base[other]] = [base[other]!, base[index]!];
  }
  return base.map((_, offset) => base.map((__, index) => base[(index + offset) % base.length]!));
}

/** Enumerates every lineup; two-player lineups always include both seat assignments. */
export function createSchedule(input: ScheduleConfig): EvaluationSchedule {
  validateContest(input);
  if (!['full-permutations', 'balanced-rotations'].includes(input.seatPolicy)) throw new RangeError('Unknown seat policy.');
  requireInteger(input.repetitions ?? 1, 'repetitions', 1);
  if (!Array.isArray(input.models) || input.models.length < input.factionCount) throw new RangeError('The roster must contain at least factionCount models.');
  const modelIds = new Set<string>();
  const models: EvaluationModel[] = input.models.map(model => {
    requireText(model.id, 'model.id');
    if (modelIds.has(model.id)) throw new RangeError(`Duplicate model id: ${model.id}`);
    if (model.kind !== 'baseline' && model.kind !== 'remote') throw new RangeError(`Unknown model kind: ${model.id}`);
    modelIds.add(model.id);
    if (model.label !== undefined) requireText(model.label, 'model.label');
    return { id: model.id, kind: model.kind, ...(model.label === undefined ? {} : { label: model.label }) };
  }).sort((a, b) => compareText(a.id, b.id));
  if (!Array.isArray(input.seeds) || !input.seeds.length) throw new RangeError('At least one map seed is required.');
  const seeds = input.seeds.slice().sort((a, b) => a - b);
  for (const seed of seeds) requireInteger(seed, 'seed', 0, 0xffffffff);
  if (new Set(seeds).size !== seeds.length) throw new RangeError('Duplicate seeds would repeat the same map; use repetitions instead.');
  const profileKey = profileIdentity(input.profile);
  const profile = JSON.parse(canonicalJson(input.profile)) as ScheduleConfig['profile'];
  const config: ScheduleConfig = {
    models,
    factionCount: input.factionCount,
    track: input.track,
    seeds,
    durationSeconds: input.durationSeconds,
    repetitions: input.repetitions ?? 1,
    seatPolicy: input.seatPolicy,
    profile,
  };
  const benchmarkId = benchmarkIdentity({ schemaVersion: 1, config });
  const groupId = comparisonGroupId(config);
  const games: ScheduledGame[] = [];
  const lineups = combinations(models, input.factionCount);
  for (const seed of seeds) {
    const mapGroupId = benchmarkIdentity({ groupId, seed });
    for (let repetition = 0; repetition < (config.repetitions ?? 1); repetition++) {
      for (const lineup of lineups) {
        const pairingId = benchmarkIdentity({ groupId, seed, repetition, models: lineup.map(model => model.id) });
        const rotationSeed = Number.parseInt(benchmarkIdentity({ seed, repetition, lineup: lineup.map(model => model.id) }).slice(7, 15), 16);
        const orders = input.factionCount === 2 || input.seatPolicy === 'full-permutations'
          ? permutations(lineup)
          : rotations(lineup, rotationSeed);
        orders.forEach((order, permutation) => {
          games.push({
            gameId: benchmarkIdentity({ benchmarkId, seed, repetition, lineup: lineup.map(model => model.id), permutation }),
            benchmarkId,
            profileKey,
            groupId,
            mapGroupId,
            pairingId,
            track: input.track,
            seed,
            repetition,
            durationSeconds: input.durationSeconds,
            factionCount: input.factionCount,
            // Constant within the seat block: moving it with each rotation would cancel initiative balancing.
            initiativeOffset: (seed + repetition) % input.factionCount,
            seats: order.map((model, seat) => ({ seat: seat as Seat, modelId: model.id })),
            models: lineup,
            profile,
          });
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    benchmarkId,
    groupId,
    profileKey,
    config,
    games,
    determinism: {
      schedule: true,
      onlineModelOutputs: false,
      note: 'Schedule and statistical resampling are deterministic. Online model responses, provider revisions and runtime failures are not guaranteed deterministic; retain profile versions and actual run records.',
    },
  };
}
