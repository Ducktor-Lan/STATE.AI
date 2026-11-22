import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, validateProfile } from './profile.js';
import { extractUsage, makeRequest, parseResponse } from './protocols.js';
import { redactText, redactValue } from './redaction.js';
import {
  ProviderError, type DecisionRequest, type ModelProfile, type ProviderAccounting,
  type ProviderEnvironment, type ProviderResult, type ProviderUsage,
} from './types.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// Fixed policy, in milliseconds. No jitter, Retry-After override, model swap or extra decision query.
const RETRY_DELAYS = [250, 500, 1000, 2000, 4000] as const;
const usageKeys = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens'] as const;

class Accounting {
  readonly usage: ProviderUsage = {};
  private usageIsPartial = false;
  private estimatedCost: number | undefined;
  private costIncomplete = false;

  add(usage: ProviderUsage, profile: ModelProfile): void {
    for (const key of usageKeys) {
      const value = usage[key];
      if (value !== undefined) this.usage[key] = (this.usage[key] ?? 0) + value;
    }
    if (usage.inputTokens === undefined || usage.outputTokens === undefined) this.usageIsPartial = true;
    for (const [tokens, rate] of [
      [usage.inputTokens, profile.inputUsdPerMillion],
      [usage.outputTokens, profile.outputUsdPerMillion],
    ]) {
      if (tokens !== undefined && rate !== undefined) {
        this.estimatedCost = (this.estimatedCost ?? 0) + (tokens / 1_000_000) * rate;
      } else this.costIncomplete = true;
    }
  }

  snapshot(): ProviderAccounting {
    return {
      usage: { ...this.usage },
      usageIsPartial: this.usageIsPartial,
      ...(this.estimatedCost === undefined ? {} : {
        costUsd: this.estimatedCost,
        costIsEstimate: true as const,
        costEstimateIncomplete: this.costIncomplete,
      }),
    };
  }
}

function aborted(): ProviderError {
  return new ProviderError('aborted', 'Model request aborted.');
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    const cancel = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function readBody(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ProviderError('infrastructure', 'The provider response exceeded the supported size limit.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (text.length === 0) return undefined;
  // Status classification takes priority over an HTML/non-JSON error body.
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

async function attempt(
  wire: ReturnType<typeof makeRequest>, timeoutMs: number, signal?: AbortSignal,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = (): void => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let received: Response | undefined;
  try {
    const response = received = await fetch(wire.url, {
      method: 'POST', headers: wire.headers, body: wire.body, signal: controller.signal,
      // A redirect must never forward API-key headers to another destination.
      redirect: 'manual',
    });
    const body = await readBody(response);
    if (signal?.aborted) throw aborted();
    if (timedOut) throw new ProviderError('infrastructure', 'Model request timed out.', { retryable: true });
    return { response, body };
  } catch (error) {
    if (signal?.aborted) throw aborted();
    // A failed/slow error body must not turn a known HTTP 400/401 into a network retry.
    if (received && !received.ok) return { response: received, body: undefined };
    if (timedOut) throw new ProviderError('infrastructure', 'Model request timed out.', { retryable: true });
    if (error instanceof ProviderError) throw error;
    // Do not attach fetch's cause/message: they can contain the URL or credential headers.
    throw new ProviderError('infrastructure', 'Model request failed due to a network error.', { retryable: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}

function httpError(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError('authentication', 'The provider rejected backend authentication.', { status });
  }
  if (status === 429) return new ProviderError('rate_limit', 'The provider rate limit was reached.', { status, retryable: true });
  if (status >= 500 && status <= 599) {
    return new ProviderError('infrastructure', 'The provider returned a server error.', { status, retryable: true });
  }
  if (status >= 400 && status <= 499) {
    return new ProviderError('configuration', 'The provider rejected the request configuration.', { status });
  }
  return new ProviderError('infrastructure', 'The provider returned an unsupported HTTP status or redirect.', { status });
}

function validateRequest(request: DecisionRequest): DecisionRequest {
  if (!request || typeof request.system !== 'string' || typeof request.user !== 'string'
    || typeof request.decisionId !== 'string' || request.decisionId.trim().length === 0
    || (request.signal !== undefined && (typeof request.signal.aborted !== 'boolean'
      || typeof request.signal.addEventListener !== 'function' || typeof request.signal.removeEventListener !== 'function'))) {
    throw new ProviderError('configuration', 'A decision request requires system, user, decisionId and an optional AbortSignal.');
  }
  return { system: request.system, user: request.user, decisionId: request.decisionId, signal: request.signal };
}

/** Backend only. Credentials are read from this environment snapshot, never from the profile. */
export async function invokeModel(
  profile: ModelProfile, request: DecisionRequest, environment: ProviderEnvironment = process.env,
): Promise<ProviderResult> {
  const validated = validateProfile(profile);
  if (validated.provider === 'baseline') {
    throw new ProviderError('configuration', 'Baseline decisions must be handled by the arena.');
  }
  const decision = validateRequest(request);
  if (decision.signal?.aborted) throw aborted();
  const value = validated.apiKeyEnv && Object.hasOwn(environment, validated.apiKeyEnv) ? environment[validated.apiKeyEnv] : undefined;
  const originalKey = typeof value === 'string' ? value : undefined;
  const key = originalKey?.trim();
  if (!key) throw new ProviderError('authentication', 'The configured backend API key is missing or empty.');
  if (!/^[\x21-\x7e]+$/.test(key)) throw new ProviderError('configuration', 'The configured backend API key has invalid header characters.');
  const secrets = originalKey === key ? [key] : [key, originalKey ?? ''];
  const wire = makeRequest(validated, decision, key);
  const accounting = new Accounting();
  const started = performance.now();
  const maxRetries = validated.maxRetries ?? DEFAULT_MAX_RETRIES;
  let attempts = 0;
  const finishError = (error: ProviderError): ProviderError => new ProviderError(error.kind, error.message, {
    retryable: error.retryable, status: error.status, attempts,
    latencyMs: performance.now() - started, ...accounting.snapshot(),
  });

  while (attempts <= maxRetries) {
    if (decision.signal?.aborted) throw finishError(aborted());
    attempts += 1;
    let recorded = false;
    try {
      const { response, body } = await attempt(wire, validated.timeoutMs ?? DEFAULT_TIMEOUT_MS, decision.signal);
      accounting.add(extractUsage(validated.provider, body), validated);
      recorded = true;
      if (!response.ok) throw httpError(response.status);
      const parsed = parseResponse(validated.provider, body);
      const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? parsed.responseId;
      return {
        text: redactText(parsed.text, secrets),
        requestId: requestId === undefined || requestId === null ? undefined : redactText(requestId, secrets),
        model: parsed.model === undefined ? undefined : redactText(parsed.model, secrets),
        ...accounting.snapshot(),
        latencyMs: performance.now() - started,
        attempts,
        raw: redactValue(body, secrets),
      };
    } catch (error) {
      if (!recorded) accounting.add({}, validated);
      const failure = decision.signal?.aborted ? aborted() : error instanceof ProviderError ? error
        : new ProviderError('infrastructure', 'The provider response could not be processed.');
      if (!failure.retryable || attempts > maxRetries) throw finishError(failure);
      try {
        await waitForRetry(RETRY_DELAYS[attempts - 1] ?? 4000, decision.signal);
      } catch {
        throw finishError(aborted());
      }
    }
  }
  // The bounded loop always returns or throws on its final attempt.
  throw finishError(new ProviderError('infrastructure', 'Model request attempts were exhausted.'));
}
