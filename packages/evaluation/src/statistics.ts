import type { BootstrapOptions, ClusterSample, ConfidenceInterval, ModelOutcome, UnrankedOutcome, WilsonInterval } from './types.js';
import { compareText, randomGenerator, requireInteger, requireNonnegative, requireText } from './identity.js';

export const DEFAULT_BOOTSTRAP_ITERATIONS = 2000;
export const DEFAULT_BOOTSTRAP_SEED = 0x53544154;
export const MINIMUM_MAP_CLUSTERS = 5;
export const RECOMMENDED_MAP_CLUSTERS = 20;

export function bootstrapSettings(options: BootstrapOptions = {}): { iterations: number; seed: number } {
  const iterations = options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  requireInteger(iterations, 'bootstrap iterations', 100, 100000);
  requireInteger(seed, 'bootstrap seed', 0, 0xffffffff);
  return { iterations, seed };
}

function quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower]! * (1 - fraction) + sorted[Math.ceil(position)]! * fraction;
}

/** Resample entire maps with replacement; games/repetitions on one map stay together. */
export function clusterBootstrap(samples: readonly ClusterSample[], options: BootstrapOptions = {}): ConfidenceInterval {
  const { iterations, seed } = bootstrapSettings(options);
  const grouped = new Map<string, { value: number; weight: number }[]>();
  for (const sample of samples) {
    requireText(sample.clusterId, 'clusterId');
    if (!Number.isFinite(sample.value) || sample.value < 0 || sample.value > 1) throw new RangeError('Bootstrap rate samples must lie in [0, 1].');
    const weight = sample.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) throw new RangeError('Bootstrap weights must be finite and positive.');
    const values = grouped.get(sample.clusterId) ?? [];
    values.push({ value: sample.value, weight });
    grouped.set(sample.clusterId, values);
  }
  // Sorting makes the result independent of record arrival order as well as RNG state.
  const clusters = [...grouped].sort(([a], [b]) => compareText(a, b)).map(([, values]) => {
    values.sort((a, b) => a.value - b.value || a.weight - b.weight);
    return values.reduce((total, item) => ({ value: total.value + item.value * item.weight, weight: total.weight + item.weight }), { value: 0, weight: 0 });
  });
  const numerator = clusters.reduce((sum, cluster) => sum + cluster.value, 0);
  const denominator = clusters.reduce((sum, cluster) => sum + cluster.weight, 0);
  const estimate = denominator ? numerator / denominator : null;
  const base = {
    method: 'cluster-bootstrap' as const,
    confidence: 0.95 as const,
    estimate,
    sampleCount: samples.length,
    clusterCount: clusters.length,
    iterations,
    rngSeed: seed,
    strongConclusion: false as const,
  };
  if (clusters.length < MINIMUM_MAP_CLUSTERS) {
    return { ...base, lower: null, upper: null, status: 'insufficient', warning: `Only ${clusters.length} independent seed/map groups; at least ${MINIMUM_MAP_CLUSTERS} are required to estimate an interval. No strong conclusion.` };
  }
  const random = randomGenerator(seed);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let value = 0;
    let weight = 0;
    for (let draw = 0; draw < clusters.length; draw++) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      value += cluster.value;
      weight += cluster.weight;
    }
    estimates.push(value / weight);
  }
  estimates.sort((a, b) => a - b);
  const limited = clusters.length < RECOMMENDED_MAP_CLUSTERS;
  const constant = estimates[0] === estimates[estimates.length - 1];
  return {
    ...base,
    lower: quantile(estimates, 0.025),
    upper: quantile(estimates, 0.975),
    status: limited ? 'limited' : 'estimated',
    warning: limited
      ? `Only ${clusters.length} independent seed/map groups; ${RECOMMENDED_MAP_CLUSTERS} or more are recommended. The interval is exploratory; no strong conclusion.`
      : constant ? 'All resampled rates are identical. A degenerate bootstrap interval does not establish certainty about unseen maps.' : null,
  };
}

/** Secondary diagnostic only: games on the same seed are not independent Bernoulli trials. */
export function rateWilson(successes: number, trials: number): WilsonInterval {
  requireInteger(trials, 'trials');
  requireNonnegative(successes, 'successes');
  if (successes > trials) throw new RangeError('successes cannot exceed trials.');
  const warning = 'Assumes independent games. Repeated seeds, swapped seats and shared maps violate that assumption; use the seed/map cluster bootstrap for the primary conclusion.';
  if (!trials) return { method: 'wilson-independent-games', confidence: 0.95, estimate: null, lower: null, upper: null, sampleCount: 0, primary: false, warning };
  const z = 1.959963984540054;
  const proportion = successes / trials;
  const scale = 1 + z * z / trials;
  const center = (proportion + z * z / (2 * trials)) / scale;
  const half = z * Math.sqrt(proportion * (1 - proportion) / trials + z * z / (4 * trials * trials)) / scale;
  return { method: 'wilson-independent-games', confidence: 0.95, estimate: proportion, lower: Math.max(0, center - half), upper: Math.min(1, center + half), sampleCount: trials, primary: false, warning };
}

/** Survivors precede eliminated factions; equal elimination ticks share a rank. */
export function rankOutcomes(outcomes: readonly UnrankedOutcome[]): ModelOutcome[] {
  if (outcomes.length < 2 || outcomes.length > 4) throw new RangeError('Ranking requires two to four factions.');
  const ids = new Set<string>();
  for (const outcome of outcomes) {
    requireText(outcome.modelId, 'modelId');
    if (ids.has(outcome.modelId)) throw new RangeError('Ranking requires unique model ids.');
    ids.add(outcome.modelId);
    if (!Number.isFinite(outcome.score)) throw new RangeError('score must be finite.');
    requireNonnegative(outcome.lands, 'lands');
    requireNonnegative(outcome.forces, 'forces');
    if (outcome.eliminatedTick !== null) requireInteger(outcome.eliminatedTick, 'eliminatedTick');
  }
  function compare(a: UnrankedOutcome, b: UnrankedOutcome): number {
    if (a.eliminatedTick !== null && b.eliminatedTick !== null) return b.eliminatedTick - a.eliminatedTick;
    if (a.eliminatedTick !== null) return 1;
    if (b.eliminatedTick !== null) return -1;
    return b.score - a.score || b.lands - a.lands || b.forces - a.forces;
  }
  const sorted = outcomes.slice().sort((a, b) => compare(a, b) || compareText(a.modelId, b.modelId));
  let rank = 1;
  return sorted.map((outcome, index) => {
    if (index && compare(sorted[index - 1]!, outcome) !== 0) rank = index + 1;
    return { ...outcome, rank };
  });
}
