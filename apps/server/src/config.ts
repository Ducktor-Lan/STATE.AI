import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateProfile } from '@state/providers';
import type { ModelProfile } from '@state/providers';
import type { CreateRunInput, ModelSummary } from './types.js';
import { HttpError, isObject } from './security.js';

export interface ServerModelProfile extends ModelProfile { enabled?: boolean }
export async function loadProfiles(rootDir: string, configPath?: string): Promise<ServerModelProfile[]> {
  const paths = configPath ? [configPath] : ['models.local.json', 'models.default.json', 'models.example.json'].map(name => join(rootDir, 'configs', name));
  for (const path of paths) {
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if (!configPath && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Error('Cannot read the model configuration.', { cause: error }); }
    let value: unknown;
    try { value = JSON.parse(text.replace(/^\uFEFF/u, '')) as unknown; } catch { throw new Error('Model configuration is not valid JSON.'); }
    if (!isObject(value) || !Array.isArray(value.models) || !value.models.length) throw new Error('Model configuration must contain a nonempty models array.');
    const profiles: ServerModelProfile[] = value.models.map((item: unknown) => {
      if (isObject(item) && item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error('Model enabled must be boolean.');
      return { ...validateProfile(item), ...(isObject(item) && item.enabled === false ? { enabled: false } : {}) };
    });
    const ids = new Set<string>();
    for (const profile of profiles) {
      if (ids.has(profile.id)) throw new Error('Model configuration contains duplicate ids.');
      ids.add(profile.id);
      if (profile.provider === 'baseline' && !['normal', 'hard'].includes(profile.model ?? 'normal')) throw new Error('Baseline model must be normal or hard.');
    }
    return profiles;
  }
  throw new Error('Missing configs/models.local.json, configs/models.default.json and configs/models.example.json.');
}
export function modelSummaries(profiles: readonly ServerModelProfile[], env: NodeJS.ProcessEnv): ModelSummary[] {
  return profiles.map(profile => {
    const baseline = profile.provider === 'baseline';
    const hasKey = baseline || Boolean(profile.apiKeyEnv && env[profile.apiKeyEnv]?.trim());
    return {
      id: profile.id, label: profile.label, provider: profile.provider,
      kind: baseline ? 'baseline' : 'remote', available: hasKey && profile.enabled !== false,
      ...(profile.enabled === false ? { unavailableReason: 'Model profile is disabled.' } : !hasKey ? { unavailableReason: 'Required backend API key is missing.' } : {}),
      ...(profile.inputUsdPerMillion !== undefined ? { inputUsdPerMillion: profile.inputUsdPerMillion } : {}),
      ...(profile.outputUsdPerMillion !== undefined ? { outputUsdPerMillion: profile.outputUsdPerMillion } : {}),
    };
  });
}
function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, `${field} must be an integer between ${min} and ${max}.`);
  return value;
}
export function validateRunInput(value: unknown, models: readonly ModelSummary[]): CreateRunInput {
  if (!isObject(value)) throw new HttpError(400, 'Run configuration must be an object.');
  const allowed = new Set(['track', 'seed', 'durationSeconds', 'factionCount', 'models', 'disaster', 'budget', 'decisionTicks', 'maxActions', 'recordVideo']);
  for (const field of Object.keys(value)) if (!allowed.has(field)) throw new HttpError(400, `Unknown run field: ${field}.`);
  if (value.track !== 'strategy' && value.track !== 'diplomacy') throw new HttpError(400, 'track must be strategy or diplomacy.');
  const duration = value.durationSeconds;
  if (duration !== 180 && duration !== 300 && duration !== 480) throw new HttpError(400, 'durationSeconds must be 180, 300 or 480.');
  const count = value.factionCount;
  if (count !== 2 && count !== 3 && count !== 4) throw new HttpError(400, 'factionCount must be 2, 3 or 4.');
  if (value.track === 'diplomacy' && count < 3) throw new HttpError(400, 'Diplomacy requires at least three factions.');
  const seed = boundedInteger(value.seed, 1, 0xffffffff, 'seed');
  if (!Array.isArray(value.models) || value.models.length !== count || value.models.some(id => typeof id !== 'string')) throw new HttpError(400, 'models must contain one model id per faction.');
  const selected: string[] = [];
  for (const raw of value.models) {
    const id = String(raw);
    const model = models.find(item => item.id === id);
    if (!model) throw new HttpError(400, `Unknown model id: ${id}.`, 'UNKNOWN_MODEL');
    if (!model.available) throw new HttpError(400, `Model ${id} is unavailable: ${model.unavailableReason}`, 'MODEL_UNAVAILABLE');
    selected.push(id);
  }
  if (value.disaster !== undefined && typeof value.disaster !== 'boolean') throw new HttpError(400, 'disaster must be boolean.');
  if (value.recordVideo !== undefined && typeof value.recordVideo !== 'boolean') throw new HttpError(400, 'recordVideo must be boolean.');
  if (value.decisionTicks !== undefined && value.decisionTicks !== 20) throw new HttpError(400, 'Protocol v1 requires decisionTicks=20.');
  if (value.maxActions !== undefined && value.maxActions !== 3) throw new HttpError(400, 'Protocol v1 requires maxActions=3.');
  if (!isObject(value.budget) || Object.keys(value.budget).some(key => key !== 'maxCalls' && key !== 'maxCostUsd')) throw new HttpError(400, 'budget requires maxCalls and maxCostUsd.');
  const maxCalls = boundedInteger(value.budget.maxCalls, 1, 1_000_000, 'budget.maxCalls');
  const maxCostUsd = value.budget.maxCostUsd;
  if (typeof maxCostUsd !== 'number' || !Number.isFinite(maxCostUsd) || maxCostUsd < 0 || maxCostUsd > 1_000_000) throw new HttpError(400, 'budget.maxCostUsd must be a finite nonnegative USD amount.');
  return { track: value.track, seed, durationSeconds: duration, factionCount: count, models: selected,
    disaster: value.disaster === true, budget: { maxCalls, maxCostUsd }, decisionTicks: 20, maxActions: 3,
    ...(value.recordVideo !== undefined ? { recordVideo: value.recordVideo } : {}) };
}
