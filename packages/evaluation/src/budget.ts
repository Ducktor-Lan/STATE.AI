import type { BudgetIssue, BudgetLimits, BudgetPreflight, RunEstimate, RunEstimateInput, Seat } from './types.js';
import { requireInteger, requireNonnegative } from './identity.js';

/** Decision opportunities, not a promise of actual billable calls or output tokens. */
export function estimateRunCost(input: RunEstimateInput): RunEstimate {
  requireInteger(input.durationTicks, 'durationTicks');
  requireInteger(input.decisionTicks, 'decisionTicks', 1);
  if (![2, 3, 4].includes(input.factions)) throw new RangeError('factions must be 2, 3 or 4.');
  if (input.pricing && input.pricing.length !== input.factions) throw new RangeError('pricing must contain one entry per faction.');
  if (input.inputTokensPerCall !== undefined) requireInteger(input.inputTokensPerCall, 'inputTokensPerCall');
  if (input.outputTokensPerCall !== undefined) requireInteger(input.outputTokensPerCall, 'outputTokensPerCall');
  const callsPerFaction = Math.ceil(input.durationTicks / input.decisionTicks);
  const totalCalls = callsPerFaction * input.factions;
  requireInteger(totalCalls, 'totalCalls');
  const inputTokens = input.inputTokensPerCall === undefined ? null : totalCalls * input.inputTokensPerCall;
  const outputTokens = input.outputTokensPerCall === undefined ? null : totalCalls * input.outputTokensPerCall;
  if (inputTokens !== null) requireInteger(inputTokens, 'inputTokens');
  if (outputTokens !== null) requireInteger(outputTokens, 'outputTokens');
  const totalTokens = inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
  if (totalTokens !== null) requireInteger(totalTokens, 'totalTokens');
  let knownCostUsd = 0;
  let pricedFactions = 0;
  let costKnownFactions = 0;
  const unpricedFactions: Seat[] = [];
  for (let seat = 0; seat < input.factions; seat++) {
    const price = input.pricing?.[seat];
    if (!price) {
      unpricedFactions.push(seat as Seat);
      continue;
    }
    requireNonnegative(price.inputUsdPerMillion, 'inputUsdPerMillion');
    requireNonnegative(price.outputUsdPerMillion, 'outputUsdPerMillion');
    pricedFactions++;
    const inputKnown = price.inputUsdPerMillion === 0 || input.inputTokensPerCall !== undefined;
    const outputKnown = price.outputUsdPerMillion === 0 || input.outputTokensPerCall !== undefined;
    if (inputKnown && outputKnown) {
      knownCostUsd += callsPerFaction * (
        (input.inputTokensPerCall ?? 0) * price.inputUsdPerMillion
        + (input.outputTokensPerCall ?? 0) * price.outputUsdPerMillion
      ) / 1_000_000;
      costKnownFactions++;
    }
  }
  requireNonnegative(knownCostUsd, 'estimated cost');
  const warnings: string[] = [];
  if (unpricedFactions.length) warnings.push(`Unknown prices for seats ${unpricedFactions.join(', ')}; total USD cost is unknown.`);
  if (inputTokens === null || outputTokens === null) warnings.push('Token usage per call is not fully specified; token totals and nonzero token-based charges may be unknown.');
  warnings.push('Estimates cover scheduled decision opportunities. Actual usage, retries, provider billing and early eliminations may differ.');
  return {
    durationTicks: input.durationTicks,
    decisionTicks: input.decisionTicks,
    factions: input.factions,
    callsPerFaction,
    totalCalls,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: costKnownFactions === input.factions ? knownCostUsd : null,
    knownCostUsd,
    pricedFactions,
    unpricedFactions,
    costKnownFactions,
    warnings,
  };
}

/** Unknown quantities cannot pass a corresponding hard cap. No I/O or budget mutation. */
export function preflightBudget(estimate: RunEstimate, budget: BudgetLimits): BudgetPreflight {
  if (budget.maxCalls !== undefined) requireInteger(budget.maxCalls, 'maxCalls');
  if (budget.maxTokens !== undefined) requireInteger(budget.maxTokens, 'maxTokens');
  if (budget.maxCostUsd !== undefined) requireNonnegative(budget.maxCostUsd, 'maxCostUsd');
  requireInteger(estimate.totalCalls, 'estimate.totalCalls');
  if (estimate.totalTokens !== null) requireInteger(estimate.totalTokens, 'estimate.totalTokens');
  if (estimate.costUsd !== null) requireNonnegative(estimate.costUsd, 'estimate.costUsd');
  const issues: BudgetIssue[] = [];
  if (budget.maxCalls !== undefined && estimate.totalCalls > budget.maxCalls) issues.push({ code: 'calls-exceeded', limit: budget.maxCalls, estimate: estimate.totalCalls });
  if (budget.maxTokens !== undefined) {
    if (estimate.totalTokens === null) issues.push({ code: 'tokens-unknown', limit: budget.maxTokens, estimate: null });
    else if (estimate.totalTokens > budget.maxTokens) issues.push({ code: 'tokens-exceeded', limit: budget.maxTokens, estimate: estimate.totalTokens });
  }
  if (budget.maxCostUsd !== undefined) {
    if (estimate.costUsd === null) issues.push({ code: 'cost-unknown', limit: budget.maxCostUsd, estimate: null });
    else if (estimate.costUsd > budget.maxCostUsd) issues.push({ code: 'cost-exceeded', limit: budget.maxCostUsd, estimate: estimate.costUsd });
  }
  const exceeded = issues.some(issue => issue.code.endsWith('-exceeded'));
  return { ok: issues.length === 0, status: exceeded ? 'exceeded' : issues.length ? 'unknown' : 'pass', issues, estimate, budget: { ...budget } };
}
