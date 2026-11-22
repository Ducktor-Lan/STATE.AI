import { DEFAULT_BASE_URLS } from './profile.js';
import { ProviderError, type DecisionRequest, type ModelProfile, type ProviderUsage } from './types.js';

// Wire references, read 2026-11-17 (no inference endpoints were called):
// https://developers.openai.com/api/reference/resources/chat
// https://platform.claude.com/docs/en/api/messages/create.md
// https://platform.claude.com/docs/en/api/versioning.md
// https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta
// All JSON constraints below are explicit opt-ins; model support is the caller's responsibility.
export const ANTHROPIC_VERSION = '2026-10-21';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function makeRequest(profile: ModelProfile, request: DecisionRequest, key?: string): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  if (profile.provider === 'baseline') {
    throw new ProviderError('configuration', 'Baseline decisions must be handled by the arena.');
  }
  const base = profile.baseUrl ?? DEFAULT_BASE_URLS[profile.provider];
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  const maxOutputTokens = profile.maxOutputTokens ?? 1024;
  const options = profile.requestOptions;
  if (profile.provider === 'openai-compatible') {
    if (key) headers.authorization = `Bearer ${key}`;
    const body: Record<string, unknown> = {
      model: profile.model,
      messages: [
        { role: options?.instructionRole ?? 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      stream: false,
      [options?.maxTokensParameter ?? 'max_completion_tokens']: maxOutputTokens,
    };
    if (profile.temperature !== undefined) body.temperature = profile.temperature;
    if (options?.response_format !== undefined) body.response_format = options.response_format;
    return { url: `${base}/chat/completions`, headers, body: JSON.stringify(body) };
  }
  if (profile.provider === 'anthropic') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = options?.anthropicVersion ?? ANTHROPIC_VERSION;
    const body: Record<string, unknown> = {
      model: profile.model,
      max_tokens: maxOutputTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      stream: false,
    };
    if (profile.temperature !== undefined) body.temperature = profile.temperature;
    if (options?.stop_sequences !== undefined) body.stop_sequences = options.stop_sequences;
    return { url: `${base}/messages`, headers, body: JSON.stringify(body) };
  }
  if (key) headers['x-goog-api-key'] = key;
  const generationConfig: Record<string, unknown> = { maxOutputTokens };
  if (profile.temperature !== undefined) generationConfig.temperature = profile.temperature;
  if (options?.responseMimeType !== undefined) generationConfig.responseMimeType = options.responseMimeType;
  if (options?.responseSchema !== undefined) generationConfig.responseSchema = options.responseSchema;
  const model = (profile.model ?? '').replace(/^models\//, '');
  return {
    url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
    headers,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig,
    }),
  };
}

export function extractUsage(provider: ModelProfile['provider'], body: unknown): ProviderUsage {
  const root = object(body);
  const usage = object(provider === 'gemini' ? root.usageMetadata : root.usage);
  if (provider === 'openai-compatible') {
    return {
      inputTokens: count(usage.prompt_tokens),
      outputTokens: count(usage.completion_tokens),
      reasoningTokens: count(object(usage.completion_tokens_details).reasoning_tokens),
      cachedInputTokens: count(object(usage.prompt_tokens_details).cached_tokens),
    };
  }
  if (provider === 'anthropic') {
    const input = count(usage.input_tokens);
    const created = count(usage.cache_creation_input_tokens);
    const read = count(usage.cache_read_input_tokens);
    return {
      // Anthropic input_tokens excludes cache creation and reads. output_tokens includes thinking.
      inputTokens: input === undefined ? undefined : input + (created ?? 0) + (read ?? 0),
      outputTokens: count(usage.output_tokens),
      reasoningTokens: count(object(usage.output_tokens_details).thinking_tokens),
      cachedInputTokens: read,
    };
  }
  if (provider === 'gemini') {
    const candidates = count(usage.candidatesTokenCount);
    const thoughts = count(usage.thoughtsTokenCount);
    return {
      inputTokens: count(usage.promptTokenCount),
      // Unlike OpenAI/Anthropic, Gemini candidatesTokenCount does not include thoughtsTokenCount.
      outputTokens: candidates === undefined ? undefined : candidates + (thoughts ?? 0),
      reasoningTokens: thoughts,
      cachedInputTokens: count(usage.cachedContentTokenCount),
    };
  }
  return {};
}

export function parseResponse(provider: ModelProfile['provider'], body: unknown): {
  text: string;
  model?: string;
  responseId?: string;
} {
  const root = object(body);
  const malformed = (): never => {
    // Do not retry a model's invalid decision/refusal, or include an untrusted response in errors.
    throw new ProviderError('infrastructure', 'The provider returned an invalid protocol response.');
  };
  if (provider === 'openai-compatible') {
    if (!Array.isArray(root.choices) || root.choices.length === 0) return malformed();
    const message = object(object(root.choices[0]).message);
    const content = message.content;
    let text: string;
    if (typeof content === 'string') text = content;
    else if (content === null || (content === undefined && typeof message.refusal === 'string')) text = '';
    else if (Array.isArray(content)) {
      // Some compatible servers return text blocks rather than a Chat Completions string.
      text = content.map((part) => {
        const block = object(part);
        return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
      }).join('');
    } else return malformed();
    return { text, model: string(root.model) };
  }
  if (provider === 'anthropic') {
    if (!Array.isArray(root.content)) return malformed();
    const text = root.content.map((part) => {
      const block = object(part);
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    }).join('');
    return { text, model: string(root.model) };
  }
  if (provider === 'gemini') {
    // A safety-blocked response may have promptFeedback and no candidates. Return its empty
    // decision unchanged for arena protocol accounting rather than re-asking for another action.
    if (!Array.isArray(root.candidates) || root.candidates.length === 0) {
      if (object(root.promptFeedback).blockReason !== undefined) {
        return { text: '', model: string(root.modelVersion), responseId: string(root.responseId) };
      }
      return malformed();
    }
    const candidate = object(root.candidates[0]);
    const parts = object(candidate.content).parts;
    if (parts !== undefined && !Array.isArray(parts)) return malformed();
    const text = (Array.isArray(parts) ? parts : []).map((part) => {
      const block = object(part);
      return block.thought !== true && typeof block.text === 'string' ? block.text : '';
    }).join('');
    return { text, model: string(root.modelVersion), responseId: string(root.responseId) };
  }
  return malformed();
}
