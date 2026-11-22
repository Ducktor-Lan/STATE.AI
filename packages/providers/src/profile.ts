import { ProviderError, type ModelProfile, type ProviderRequestOptions, type ProviderEnvironment } from './types.js';
import { redactText, redactUrl, redactValue } from './redaction.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_BASE_URLS = {
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
} as const;

function invalid(message: string): never {
  throw new ProviderError('configuration', message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function stringField(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || /[\r\n\0]/.test(value)) {
    invalid(`profile.${name} must be a nonempty string within its length limit.`);
  }
  return value;
}

function numberField(value: unknown, name: string, minimum: number, maximum: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum
    || (integer && !Number.isSafeInteger(value))) {
    invalid(`profile.${name} is outside its supported numeric range.`);
  }
  return value;
}

function jsonObject(value: unknown, depth = 0): void {
  if (depth > 24) invalid('profile.requestOptions exceeds the supported JSON depth.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) jsonObject(item, depth + 1);
    return;
  }
  if (!record(value)) invalid('profile.requestOptions must contain only JSON values.');
  for (const item of Object.values(value)) jsonObject(item, depth + 1);
}

function optionsFor(provider: ModelProfile['provider'], value: unknown): ProviderRequestOptions {
  if (!record(value)) invalid('profile.requestOptions must be an object.');
  jsonObject(value);
  const serialized = JSON.stringify(value);
  if (serialized.length > 65_536) invalid('profile.requestOptions is too large.');
  const allowed = provider === 'openai-compatible'
    ? ['instructionRole', 'maxTokensParameter', 'response_format']
    : provider === 'anthropic' ? ['anthropicVersion', 'stop_sequences']
      : provider === 'gemini' ? ['responseMimeType', 'responseSchema'] : [];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    invalid('profile.requestOptions contains an unsupported option for this provider.');
  }
  if (value.instructionRole !== undefined && value.instructionRole !== 'system' && value.instructionRole !== 'developer') {
    invalid('profile.requestOptions.instructionRole must be system or developer.');
  }
  if (value.maxTokensParameter !== undefined && value.maxTokensParameter !== 'max_completion_tokens' && value.maxTokensParameter !== 'max_tokens') {
    invalid('profile.requestOptions.maxTokensParameter is unsupported.');
  }
  if (value.response_format !== undefined) {
    const format = value.response_format;
    if (!record(format) || typeof format.type !== 'string' || !['text', 'json_object', 'json_schema'].includes(format.type)
      || Object.keys(format).some((key) => !['type', 'json_schema'].includes(key))) {
      invalid('profile.requestOptions.response_format is invalid.');
    }
    if (format.type === 'json_schema') {
      const schema = format.json_schema;
      if (!record(schema) || typeof schema.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(schema.name)
        || !record(schema.schema) || (schema.description !== undefined && typeof schema.description !== 'string')
        || (schema.strict !== undefined && typeof schema.strict !== 'boolean')
        || Object.keys(schema).some((key) => !['name', 'description', 'schema', 'strict'].includes(key))) {
        invalid('profile.requestOptions.response_format.json_schema is invalid.');
      }
    } else if (format.json_schema !== undefined) {
      invalid('json_schema requires response_format.type json_schema.');
    }
  }
  if (value.anthropicVersion !== undefined && value.anthropicVersion !== '2023-06-01' && value.anthropicVersion !== '2026-10-21') {
    invalid('profile.requestOptions.anthropicVersion is unsupported.');
  }
  if (value.stop_sequences !== undefined && (!Array.isArray(value.stop_sequences)
    || value.stop_sequences.length > 64 || value.stop_sequences.some((item) => typeof item !== 'string' || item.length === 0))) {
    invalid('profile.requestOptions.stop_sequences must be an array of nonempty strings.');
  }
  if (value.responseMimeType !== undefined && (typeof value.responseMimeType !== 'string'
    || !['text/plain', 'application/json', 'text/x.enum'].includes(value.responseMimeType))) {
    invalid('profile.requestOptions.responseMimeType is unsupported.');
  }
  if (value.responseSchema !== undefined && (!record(value.responseSchema)
    || typeof value.responseMimeType !== 'string' || !['application/json', 'text/x.enum'].includes(value.responseMimeType))) {
    invalid('profile.requestOptions.responseSchema requires an explicit compatible responseMimeType.');
  }
  return JSON.parse(serialized) as ProviderRequestOptions;
}

/** Runtime validation for config files; returns a snapshot, strips loader fields such as enabled. */
export function validateProfile(input: unknown): ModelProfile {
  if (!record(input)) invalid('A model profile must be an object.');
  const provider = input.provider;
  if (provider !== 'baseline' && provider !== 'openai-compatible' && provider !== 'anthropic' && provider !== 'gemini') {
    invalid('profile.provider is unsupported.');
  }
  const profile: ModelProfile = {
    id: stringField(input.id, 'id', 128),
    label: stringField(input.label, 'label', 256),
    provider,
  };
  if (input.model !== undefined) profile.model = stringField(input.model, 'model', 256);
  if (provider !== 'baseline' && !profile.model) invalid('An external provider requires profile.model.');
  if (provider === 'gemini' && !/^(?:models\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile.model ?? '')) {
    invalid('profile.model must be a Gemini model id or models/model-id.');
  }
  if (input.baseUrl !== undefined) {
    const base = stringField(input.baseUrl, 'baseUrl', 2048);
    let url: URL;
    try { url = new URL(base); } catch { invalid('profile.baseUrl must be an absolute HTTP(S) API base URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || /[\s\\]/.test(base) || /[?#]/.test(base)) {
      invalid('profile.baseUrl must use HTTP(S) without userinfo, query parameters or a fragment.');
    }
    profile.baseUrl = url.toString().replace(/\/+$/, '');
  }
  if (input.apiKeyEnv !== undefined) {
    if (typeof input.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.apiKeyEnv)) {
      invalid('profile.apiKeyEnv must be an environment variable name.');
    }
    profile.apiKeyEnv = input.apiKeyEnv;
  }
  if (provider !== 'baseline' && !profile.apiKeyEnv) {
    invalid('This provider requires profile.apiKeyEnv for backend authentication.');
  }
  if (input.requestOptions !== undefined) profile.requestOptions = optionsFor(provider, input.requestOptions);
  if (input.temperature !== undefined) {
    if (provider === 'anthropic' && profile.requestOptions?.anthropicVersion !== '2023-06-01') {
      invalid('Anthropic API version 2026-10-21 does not support temperature; omit it or explicitly select a compatible legacy version/model.');
    }
    profile.temperature = numberField(input.temperature, 'temperature', 0, provider === 'anthropic' ? 1 : 2);
  }
  if (input.maxOutputTokens !== undefined) profile.maxOutputTokens = numberField(input.maxOutputTokens, 'maxOutputTokens', 1, 2_147_483_647, true);
  if (input.timeoutMs !== undefined) profile.timeoutMs = numberField(input.timeoutMs, 'timeoutMs', 1, 300_000, true);
  if (input.maxRetries !== undefined) profile.maxRetries = numberField(input.maxRetries, 'maxRetries', 0, 5, true);
  for (const field of ['inputUsdPerMillion', 'outputUsdPerMillion'] as const) {
    if (input[field] !== undefined) profile[field] = numberField(input[field], field, 0, 1_000_000);
  }
  return profile;
}

/** Safe display projection, including protection against credentials in invalid profile URLs. */
export function redactedView(profile: ModelProfile, environment: ProviderEnvironment = process.env): ModelProfile {
  const value = profile.apiKeyEnv && Object.hasOwn(environment, profile.apiKeyEnv) ? environment[profile.apiKeyEnv] : undefined;
  const secret = typeof value === 'string' ? value : undefined;
  const secrets = secret ? [secret, secret.trim()].filter(Boolean) : [];
  const view = redactValue({
    id: profile.id, label: profile.label, provider: profile.provider, model: profile.model,
    baseUrl: profile.baseUrl === undefined ? undefined : redactUrl(profile.baseUrl),
    apiKeyEnv: profile.apiKeyEnv, temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens, timeoutMs: profile.timeoutMs, maxRetries: profile.maxRetries,
    inputUsdPerMillion: profile.inputUsdPerMillion, outputUsdPerMillion: profile.outputUsdPerMillion,
    requestOptions: profile.requestOptions,
  }, secrets) as ModelProfile;
  if (profile.apiKeyEnv !== undefined) view.apiKeyEnv = redactText(profile.apiKeyEnv, secrets);
  return view;
}

export const profileRedactedView = redactedView;
