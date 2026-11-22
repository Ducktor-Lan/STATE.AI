export type ProviderKind = 'baseline' | 'openai-compatible' | 'anthropic' | 'gemini';

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

/** Options are opt-in; JSON/schema support still depends on the selected model. */
export interface ProviderRequestOptions {
  /** OpenAI adapter option, not a wire field. New reasoning models may need developer. */
  instructionRole?: 'system' | 'developer';
  /** OpenAI adapter option for older compatible servers; never sends both limits. */
  maxTokensParameter?: 'max_completion_tokens' | 'max_tokens';
  /** OpenAI Chat Completions wire parameter. */
  response_format?: {
    type: 'text' | 'json_object' | 'json_schema';
    json_schema?: {
      name: string;
      description?: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };
  };
  /** Anthropic adapter option, sent only as the anthropic-version header. */
  anthropicVersion?: '2023-06-01' | '2026-10-21';
  /** Anthropic Messages wire parameter. */
  stop_sequences?: string[];
  /** Gemini generationConfig wire parameters. responseSchema uses its OpenAPI subset. */
  responseMimeType?: 'text/plain' | 'application/json' | 'text/x.enum';
  responseSchema?: Record<string, unknown>;
}

export interface ModelProfile {
  id: string;
  label: string;
  provider: ProviderKind;
  /** For baseline, the arena may use this as its strategy id. */
  model?: string;
  /** API base including version, e.g. https://api.openai.com/v1; no query or fragment. */
  baseUrl?: string;
  /** Name of a backend environment variable, never a literal credential. */
  apiKeyEnv?: string;
  /** Omit when unsupported by the selected model. Anthropic API 2026-10-21 rejects it. */
  temperature?: number;
  maxOutputTokens?: number;
  /** Per attempt, including reading the response body; default 30,000, maximum 300,000. */
  timeoutMs?: number;
  /** Additional attempts; default 2, maximum 5. No model/decision fallback. */
  maxRetries?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  requestOptions?: ProviderRequestOptions;
}

export interface DecisionRequest {
  system: string;
  user: string;
  /** Kept out of the wire body: the arena owns binding/validating the decision id. */
  decisionId: string;
  signal?: AbortSignal;
}

/** Sums of reported counts across attempts. Missing fields remain undefined, never zero-filled. */
export interface ProviderUsage {
  /** Includes reported cached input; Anthropic cache creation/read are added to uncached input. */
  inputTokens?: number;
  /** Includes reasoning when separately reported by Gemini; OpenAI already includes it. */
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface ProviderAccounting {
  usage: ProviderUsage;
  /** True if any attempt did not report both primary token counts. Known sums may be partial. */
  usageIsPartial?: boolean;
  /** ESTIMATE of reported tokens at configured flat rates, summed across all attempts. */
  costUsd?: number;
  costIsEstimate?: true;
  /** Unknown usage/rates are excluded; no cache discounts, tiers, tool fees or taxes assumed. */
  costEstimateIncomplete?: boolean;
}

export interface ProviderResult extends ProviderAccounting {
  text: string;
  requestId?: string;
  model?: string;
  latencyMs: number;
  attempts: number;
  /** Sanitized response JSON only. Never includes request headers or credentials. */
  raw?: unknown;
}

export type ProviderErrorKind =
  | 'infrastructure'
  | 'authentication'
  | 'configuration'
  | 'rate_limit'
  | 'aborted';

export interface ProviderErrorOptions extends Partial<ProviderAccounting> {
  retryable?: boolean;
  status?: number;
  attempts?: number;
  latencyMs?: number;
}

export class ProviderError extends Error implements ProviderAccounting {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly attempts: number;
  readonly usage: ProviderUsage;
  readonly usageIsPartial?: boolean;
  readonly costUsd?: number;
  readonly costIsEstimate?: true;
  readonly costEstimateIncomplete?: boolean;
  readonly latencyMs?: number;

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.attempts = options.attempts ?? 0;
    this.usage = options.usage ?? {};
    this.usageIsPartial = options.usageIsPartial;
    this.costUsd = options.costUsd;
    this.costIsEstimate = options.costIsEstimate;
    this.costEstimateIncomplete = options.costEstimateIncomplete;
    this.latencyMs = options.latencyMs;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      kind: this.kind,
      retryable: this.retryable,
      status: this.status,
      attempts: this.attempts,
      usage: this.usage,
      usageIsPartial: this.usageIsPartial,
      costUsd: this.costUsd,
      costIsEstimate: this.costIsEstimate,
      costEstimateIncomplete: this.costEstimateIncomplete,
      latencyMs: this.latencyMs,
    };
  }
}
