import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  invokeModel, ProviderError, redactedView, profileRedactedView, validateProfile,
  type DecisionRequest, type ModelProfile, type ProviderEnvironment,
} from '../packages/providers/src/index.js';

// Deliberately fake, injected credentials. Every invocation below targets 127.0.0.1.
const TEST_KEY = 'fixture-provider-key-never-a-real-credential';
const environment: ProviderEnvironment = { STATE_AI_PROVIDER_TEST_KEY: TEST_KEY };
const decision: DecisionRequest = {
  system: '你是策略模型。请输出 JSON。',
  user: '{"decision_id":"fixture-decision","observation":{}}',
  decisionId: 'fixture-decision',
};

async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    void Promise.resolve().then(() => handler(request, response)).catch((error: unknown) => {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
  if (failures.length) throw new AggregateError(failures, 'Mock HTTP protocol assertions failed.');
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(response: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}

function profile(origin: string, provider: ModelProfile['provider'] = 'openai-compatible'): ModelProfile {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  return {
    id: `fixture-${provider}`, label: '本机协议夹具', provider, model: 'fixture-model',
    baseUrl: `${origin}/${provider === 'gemini' ? 'v1beta' : 'v1'}`,
    apiKeyEnv: 'STATE_AI_PROVIDER_TEST_KEY', maxOutputTokens: 128,
    timeoutMs: 2000, maxRetries: 0, inputUsdPerMillion: 2, outputUsdPerMillion: 6,
  };
}

function openaiResponse(usage: unknown = { prompt_tokens: 20, completion_tokens: 10 }): unknown {
  return { id: 'chatcmpl-fixture', model: 'returned-model-version', choices: [{ message: { role: 'assistant', content: '{"actions":[]}' } }], usage };
}

async function rejectsProvider(promise: Promise<unknown>, check: (error: ProviderError) => void): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    check(error);
    return true;
  });
}

test('OpenAI Chat Completions sends real wire fields and parses usage without double billing reasoning', async () => {
  await localServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.match(String(request.headers['content-type']), /application\/json/);
    assert.deepEqual(await bodyOf(request), {
      model: 'fixture-model', messages: [{ role: 'system', content: decision.system }, { role: 'user', content: decision.user }],
      stream: false, max_completion_tokens: 128, temperature: 0.25,
    });
    json(response, openaiResponse({
      prompt_tokens: 20, completion_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 4 }, prompt_tokens_details: { cached_tokens: 3 },
    }), 200, { 'x-request-id': 'http-request-fixture' });
  }, async (origin) => {
    const result = await invokeModel({ ...profile(origin), temperature: 0.25 }, decision, environment);
    assert.equal(result.text, '{"actions":[]}');
    assert.equal(result.model, 'returned-model-version');
    assert.equal(result.requestId, 'http-request-fixture');
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10, reasoningTokens: 4, cachedInputTokens: 3 });
    assert.ok(Math.abs(result.costUsd! - 0.0001) < 1e-12);
    assert.equal(result.costIsEstimate, true);
    assert.equal(result.costEstimateIncomplete, false);
    assert.equal(result.usageIsPartial, false);
    assert.equal(result.attempts, 1);
    assert.ok(result.latencyMs >= 0);
    assert.ok(!JSON.stringify(result).includes(TEST_KEY));
  });
});

test('OpenAI compatible text blocks, developer role, legacy token cap and native JSON are explicit opt-ins', async () => {
  const format = { type: 'json_schema' as const, json_schema: { name: 'decision', strict: true, schema: { type: 'object', properties: {}, additionalProperties: false } } };
  await localServer(async (request, response) => {
    const body = await bodyOf(request);
    assert.deepEqual(body.messages, [{ role: 'developer', content: decision.system }, { role: 'user', content: decision.user }]);
    assert.equal(body.max_tokens, 128);
    assert.equal(body.max_completion_tokens, undefined);
    assert.deepEqual(body.response_format, format);
    assert.equal(body.instructionRole, undefined);
    json(response, { choices: [{ message: { content: [{ type: 'text', text: '{"actions":' }, { type: 'text', text: '[]}' }] } }] });
  }, async (origin) => {
    const result = await invokeModel({ ...profile(origin), requestOptions: { instructionRole: 'developer', maxTokensParameter: 'max_tokens', response_format: format } }, decision, environment);
    assert.equal(result.text, '{"actions":[]}');
    assert.equal(result.usage.inputTokens, undefined);
    assert.equal(result.usage.outputTokens, undefined);
    assert.equal(result.usage.reasoningTokens, undefined);
    assert.equal(result.usage.cachedInputTokens, undefined);
    assert.equal(result.usageIsPartial, true);
    assert.equal(result.costUsd, undefined);
  });
});

test('Anthropic Messages uses system, required max_tokens, version header and all visible text blocks', async () => {
  await localServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/messages');
    assert.equal(request.headers['x-api-key'], TEST_KEY);
    assert.equal(request.headers['anthropic-version'], '2026-10-21');
    assert.deepEqual(await bodyOf(request), {
      model: 'fixture-model', max_tokens: 128, system: decision.system,
      messages: [{ role: 'user', content: decision.user }], stream: false, stop_sequences: ['END'],
    });
    json(response, {
      id: 'msg-fixture', model: 'claude-returned-version',
      content: [{ type: 'thinking', thinking: 'not visible decision text' }, { type: 'text', text: '{"actions":' }, { type: 'text', text: '[]}' }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 15, output_tokens: 8, output_tokens_details: { thinking_tokens: 3 } },
    }, 200, { 'request-id': 'anthropic-request-fixture' });
  }, async (origin) => {
    const result = await invokeModel({ ...profile(origin, 'anthropic'), requestOptions: { stop_sequences: ['END'] } }, decision, environment);
    assert.equal(result.text, '{"actions":[]}');
    assert.equal(result.model, 'claude-returned-version');
    assert.equal(result.requestId, 'anthropic-request-fixture');
    assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 8, reasoningTokens: 3, cachedInputTokens: 15 });
    assert.ok(Math.abs(result.costUsd! - 0.000108) < 1e-12);
    assert.equal(result.costIsEstimate, true);
  });
});

test('Anthropic sampling is rejected on current version and only sent with an explicit legacy version', async () => {
  await localServer(async (request, response) => {
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    const body = await bodyOf(request);
    assert.equal(body.temperature, 0.5);
    assert.equal(body.anthropicVersion, undefined);
    json(response, { content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } });
  }, async (origin) => {
    await rejectsProvider(invokeModel({ ...profile(origin, 'anthropic'), temperature: 0.5 }, decision, environment), (error) => {
      assert.equal(error.kind, 'configuration');
      assert.equal(error.attempts, 0);
      assert.match(error.message, /2026-10-21/);
    });
    const result = await invokeModel({ ...profile(origin, 'anthropic'), temperature: 0.5, requestOptions: { anthropicVersion: '2023-06-01' } }, decision, environment);
    assert.equal(result.text, '{}');
    assert.equal(result.usage.cachedInputTokens, undefined);
  });
});

test('Gemini generateContent uses header credentials, systemInstruction, generationConfig and thought-aware usage', async () => {
  await localServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1beta/models/fixture-model:generateContent');
    assert.equal(request.headers['x-goog-api-key'], TEST_KEY);
    assert.equal(request.headers.authorization, undefined);
    assert.deepEqual(await bodyOf(request), {
      systemInstruction: { parts: [{ text: decision.system }] },
      contents: [{ role: 'user', parts: [{ text: decision.user }] }],
      generationConfig: { maxOutputTokens: 128, temperature: 0.4, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: {} } },
    });
    json(response, {
      responseId: 'gemini-response-fixture', modelVersion: 'gemini-returned-version',
      candidates: [
        { content: { role: 'model', parts: [{ thought: true, text: 'private thought' }, { text: '{"actions":' }, { text: '[]}' }] } },
        { content: { parts: [{ text: 'alternative must not be merged' }] } },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 7, cachedContentTokenCount: 3 },
    });
  }, async (origin) => {
    const result = await invokeModel({ ...profile(origin, 'gemini'), model: 'models/fixture-model', temperature: 0.4, requestOptions: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: {} } } }, decision, environment);
    assert.equal(result.text, '{"actions":[]}');
    assert.equal(result.model, 'gemini-returned-version');
    assert.equal(result.requestId, 'gemini-response-fixture');
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 12, reasoningTokens: 7, cachedInputTokens: 3 });
    assert.ok(Math.abs(result.costUsd! - 0.000112) < 1e-12);
  });
});

test('429 and 5xx retry the identical request and accumulate every reported attempt cost', async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  await localServer(async (request, response) => {
    bodies.push(await bodyOf(request));
    calls += 1;
    if (calls === 1) json(response, { usage: { prompt_tokens: 10, completion_tokens: 2 } }, 429);
    else if (calls === 2) json(response, { usage: { prompt_tokens: 4, completion_tokens: 1 } }, 503);
    else json(response, openaiResponse({ prompt_tokens: 6, completion_tokens: 3 }));
  }, async (origin) => {
    const result = await invokeModel({ ...profile(origin), maxRetries: 2 }, decision, environment);
    assert.equal(calls, 3);
    assert.equal(result.attempts, 3);
    assert.equal(new Set(bodies.map((body) => JSON.stringify(body))).size, 1);
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 6 });
    assert.equal(result.usageIsPartial, false);
    assert.equal(result.costEstimateIncomplete, false);
    assert.ok(Math.abs(result.costUsd! - 0.000076) < 1e-12);
  });
});

test('partly missing usage and unconfigured rates stay unknown and mark estimates incomplete', async () => {
  await localServer((_request, response) => json(response, openaiResponse({ prompt_tokens: 20 })), async (origin) => {
    const result = await invokeModel(profile(origin), decision, environment);
    assert.equal(result.usage.inputTokens, 20);
    assert.equal(result.usage.outputTokens, undefined);
    assert.equal(result.usage.reasoningTokens, undefined);
    assert.equal(result.usage.cachedInputTokens, undefined);
    assert.equal(result.usageIsPartial, true);
    assert.equal(result.costIsEstimate, true);
    assert.equal(result.costEstimateIncomplete, true);
    assert.ok(Math.abs(result.costUsd! - 0.00004) < 1e-12);
    const withoutRates = { ...profile(origin), inputUsdPerMillion: undefined, outputUsdPerMillion: undefined };
    const unpriced = await invokeModel(withoutRates, decision, environment);
    assert.equal(unpriced.usage.inputTokens, 20);
    assert.equal(unpriced.costUsd, undefined);
    assert.equal(unpriced.costIsEstimate, undefined);
  });
});

test('rate limit retries are bounded and retain known cost on ProviderError', async () => {
  let calls = 0;
  await localServer((_request, response) => {
    calls += 1;
    json(response, { usage: { prompt_tokens: 2, completion_tokens: 0 }, error: { message: `Bearer ${TEST_KEY}` } }, 429);
  }, async (origin) => {
    await rejectsProvider(invokeModel({ ...profile(origin), maxRetries: 1 }, decision, environment), (error) => {
      assert.equal(error.kind, 'rate_limit');
      assert.equal(error.retryable, true);
      assert.equal(error.status, 429);
      assert.equal(error.attempts, 2);
      assert.equal(error.usage.inputTokens, 4);
      assert.equal(error.usage.outputTokens, 0);
      assert.ok(Math.abs(error.costUsd! - 0.000008) < 1e-12);
      assert.ok(!JSON.stringify(error).includes(TEST_KEY));
    });
    assert.equal(calls, 2);
  });
});

test('400/401/403 never retry or expose response bodies, credentials or URL userinfo', async () => {
  for (const status of [400, 401, 403]) {
    let calls = 0;
    await localServer((_request, response) => {
      calls += 1;
      json(response, { error: { message: `Authorization: Bearer ${TEST_KEY} https://url-user:url-password@example.invalid/?key=url-secret` } }, status);
    }, async (origin) => {
      await rejectsProvider(invokeModel({ ...profile(origin), maxRetries: 5 }, decision, environment), (error) => {
        assert.equal(error.kind, status === 400 ? 'configuration' : 'authentication');
        assert.equal(error.status, status);
        assert.equal(error.retryable, false);
        assert.equal(error.attempts, 1);
        assert.equal(error.usage.inputTokens, undefined);
        const serialized = JSON.stringify(error) + error.stack;
        for (const secret of [TEST_KEY, 'url-user', 'url-password', 'url-secret', 'Authorization']) assert.ok(!serialized.includes(secret));
      });
      assert.equal(calls, 1);
    });
  }
});

test('a slow 401 response body retains the nonretryable authentication status', async () => {
  let calls = 0;
  await localServer((_request, response) => {
    calls += 1;
    response.writeHead(401, { 'content-type': 'application/json' });
    response.write('{');
  }, async (origin) => {
    await rejectsProvider(invokeModel({ ...profile(origin), timeoutMs: 80, maxRetries: 2 }, decision, environment), (error) => {
      assert.equal(error.kind, 'authentication');
      assert.equal(error.status, 401);
      assert.equal(error.attempts, 1);
    });
    assert.equal(calls, 1);
  });
});

test('network failures retry with partial accounting and never change the request model', async () => {
  let calls = 0;
  await localServer(async (request, response) => {
    const body = await bodyOf(request);
    assert.equal(body.model, 'fixture-model');
    calls += 1;
    if (calls === 1) request.socket.destroy();
    else json(response, openaiResponse());
  }, async (origin) => {
    const result = await invokeModel({ ...profile(origin), maxRetries: 1 }, decision, environment);
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
    assert.equal(result.usage.inputTokens, 20);
    assert.equal(result.usageIsPartial, true);
    assert.equal(result.costEstimateIncomplete, true);
    assert.ok(Math.abs(result.costUsd! - 0.0001) < 1e-12);
  });
});

test('per-attempt timeout is finite, retryable and includes a stalled response body', async () => {
  let calls = 0;
  await localServer((_request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
    } else json(response, openaiResponse());
  }, async (origin) => {
    const result = await invokeModel({ ...profile(origin), timeoutMs: 80, maxRetries: 1 }, decision, environment);
    assert.equal(result.attempts, 2);
    assert.equal(result.usageIsPartial, true);
    assert.equal(result.costEstimateIncomplete, true);
    assert.equal(calls, 2);
  });
  await localServer(() => undefined, async (origin) => {
    await rejectsProvider(invokeModel({ ...profile(origin), timeoutMs: 80 }, decision, environment), (error) => {
      assert.equal(error.kind, 'infrastructure');
      assert.equal(error.retryable, true);
      assert.equal(error.attempts, 1);
      assert.match(error.message, /timed out/);
      assert.equal(error.costUsd, undefined);
    });
  });
});

test('AbortSignal cancels active fetch and an already-aborted request performs no attempt', async () => {
  let calls = 0;
  let seen!: () => void;
  const started = new Promise<void>((resolveStarted) => { seen = resolveStarted; });
  await localServer(() => { calls += 1; seen(); }, async (origin) => {
    const controller = new AbortController();
    const promise = invokeModel({ ...profile(origin), maxRetries: 5 }, { ...decision, signal: controller.signal }, environment);
    await started;
    controller.abort(new Error(TEST_KEY));
    await rejectsProvider(promise, (error) => {
      assert.equal(error.kind, 'aborted');
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      assert.ok(!JSON.stringify(error).includes(TEST_KEY));
    });
    await rejectsProvider(invokeModel(profile(origin), { ...decision, signal: controller.signal }, environment), (error) => {
      assert.equal(error.kind, 'aborted');
      assert.equal(error.attempts, 0);
    });
    assert.equal(calls, 1);
  });
});

test('AbortSignal interrupts retry backoff and retains first-attempt usage', async () => {
  let calls = 0;
  let seen!: () => void;
  const started = new Promise<void>((resolveStarted) => { seen = resolveStarted; });
  await localServer((_request, response) => {
    calls += 1;
    json(response, { usage: { prompt_tokens: 3, completion_tokens: 0 } }, 429);
    seen();
  }, async (origin) => {
    const controller = new AbortController();
    const promise = invokeModel({ ...profile(origin), maxRetries: 5 }, { ...decision, signal: controller.signal }, environment);
    await started;
    await delay(70);
    controller.abort();
    await rejectsProvider(promise, (error) => {
      assert.equal(error.kind, 'aborted');
      assert.equal(error.attempts, 1);
      assert.equal(error.usage.inputTokens, 3);
      assert.equal(error.usage.outputTokens, 0);
    });
    assert.equal(calls, 1);
  });
});

test('redirects never forward credentials and malformed success is not retried', async () => {
  let calls = 0;
  await localServer((_request, response) => {
    calls += 1;
    response.writeHead(302, { location: '/credential-target' });
    response.end();
  }, async (origin) => {
    await rejectsProvider(invokeModel({ ...profile(origin), maxRetries: 5 }, decision, environment), (error) => {
      assert.equal(error.status, 302);
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
    });
    assert.equal(calls, 1);
  });
  await localServer((_request, response) => json(response, { not_a_completion: true }), async (origin) => {
    await rejectsProvider(invokeModel({ ...profile(origin), maxRetries: 5 }, decision, environment), (error) => {
      assert.equal(error.kind, 'infrastructure');
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
    });
  });
});

test('model refusal/safety-block remains an empty decision without strategy retries', async () => {
  let calls = 0;
  await localServer((_request, response) => {
    calls += 1;
    json(response, { choices: [{ message: { content: null, refusal: 'refused' } }] });
  }, async (origin) => {
    const result = await invokeModel({ ...profile(origin), maxRetries: 5 }, decision, environment);
    assert.equal(result.text, '');
    assert.equal(result.attempts, 1);
  });
  assert.equal(calls, 1);
  await localServer((_request, response) => json(response, { promptFeedback: { blockReason: 'SAFETY' } }), async (origin) => {
    const result = await invokeModel({ ...profile(origin, 'gemini'), maxRetries: 5 }, decision, environment);
    assert.equal(result.text, '');
    assert.equal(result.attempts, 1);
    assert.equal(result.usage.inputTokens, undefined);
  });
});

test('successful text, raw JSON, model ids, headers and profile display redact keys and URL credentials', async () => {
  await localServer((_request, response) => {
    json(response, {
      model: TEST_KEY,
      choices: [{ message: { content: `${TEST_KEY} Authorization: Bearer other-bearer-secret https://url-user:url-password@example.invalid/v1?arbitrary=url-secret` } }],
      authorization: 'Bearer separate-secret', 'x-api-key': 'separate-api-secret',
      [TEST_KEY]: { link: 'https://raw-user:raw-password@example.invalid/path?unknown=raw-secret#frag' },
    }, 200, { 'x-request-id': TEST_KEY });
  }, async (origin) => {
    const result = await invokeModel(profile(origin), decision, environment);
    const serialized = JSON.stringify(result);
    for (const secret of [TEST_KEY, 'other-bearer-secret', 'url-user', 'url-password', 'url-secret', 'separate-secret', 'separate-api-secret', 'raw-user', 'raw-password', 'raw-secret']) {
      assert.ok(!serialized.includes(secret), `Unexpected credential fragment: ${secret}`);
    }
    assert.ok(serialized.includes('[REDACTED]'));
    const unsafe = { ...profile(origin), label: TEST_KEY, baseUrl: 'https://view-user:view-password@example.invalid/v1?key=view-secret#frag' };
    const displayed = redactedView(unsafe, environment);
    assert.equal(displayed.apiKeyEnv, 'STATE_AI_PROVIDER_TEST_KEY');
    const safe = JSON.stringify(displayed);
    for (const secret of [TEST_KEY, 'view-user', 'view-password', 'view-secret']) assert.ok(!safe.includes(secret));
    assert.deepEqual(profileRedactedView(unsafe, environment), displayed);
    const paddedEnvironment = { STATE_AI_PROVIDER_TEST_KEY: `  ${TEST_KEY}  ` };
    assert.ok(!JSON.stringify(redactedView(unsafe, paddedEnvironment)).includes(TEST_KEY));
  });
});

test('URL apostrophe regression redacts full path/userinfo URLs and malformed URLs in text, raw and profile views', async () => {
  const fixtures = [
    {
      url: "https://example.invalid/users/o'connor?arbitrary=fixture-url-secret#fixture-fragment-secret",
      safeUrl: "https://example.invalid/users/o'connor",
      hidden: ['fixture-url-secret', 'fixture-fragment-secret'],
    },
    {
      url: "https://o'connor:fixture-userinfo-secret@example.invalid/users/o'connor?arbitrary=fixture-query-secret#fixture-fragment-secret",
      safeUrl: "https://example.invalid/users/o'connor",
      hidden: ['fixture-userinfo-secret', 'fixture-query-secret', 'fixture-fragment-secret'],
    },
    {
      url: "https://o'connor:fixture-invalid-userinfo-secret@[invalid-host/users/o'connor?arbitrary=fixture-invalid-query-secret#fixture-invalid-fragment-secret",
      safeUrl: '[REDACTED]',
      hidden: ['fixture-invalid-userinfo-secret', 'fixture-invalid-query-secret', 'fixture-invalid-fragment-secret'],
    },
  ];
  for (const fixture of fixtures) {
    await localServer((_request, response) => json(response, {
      choices: [{ message: { content: JSON.stringify({ url: fixture.url, after: 'preserved-json-boundary' }) } }],
      link: fixture.url,
    }), async (origin) => {
      const result = await invokeModel(profile(origin), decision, environment);
      assert.deepEqual(JSON.parse(result.text), { url: fixture.safeUrl, after: 'preserved-json-boundary' });
      assert.equal((result.raw as { link: string }).link, fixture.safeUrl);
      const displayed = redactedView({ ...profile(origin), baseUrl: fixture.url }, environment);
      assert.equal(displayed.baseUrl, fixture.safeUrl);
      for (const hidden of fixture.hidden) {
        for (const view of [result.text, JSON.stringify(result.raw), JSON.stringify(displayed)]) {
          assert.ok(!view.includes(hidden), `URL secret survived redaction: ${hidden}`);
        }
      }
      if (displayed.baseUrl !== '[REDACTED]') {
        const sanitized = new URL(displayed.baseUrl!);
        assert.equal(sanitized.username, '');
        assert.equal(sanitized.password, '');
        assert.equal(sanitized.search, '');
        assert.equal(sanitized.hash, '');
      }
    });
  }
  // Structured URLs must be parsed as a whole even when a path contains a JSON quote boundary.
  const quoted = redactedView({
    ...profile('http://127.0.0.1:1'),
    baseUrl: 'https://example.invalid/users/"quoted"?arbitrary=fixture-quoted-secret#fixture-quoted-fragment',
  }, environment);
  assert.equal(quoted.baseUrl, 'https://example.invalid/users/%22quoted%22');
});

test('enum coercion regression rejects nonstring OpenAI/Gemini options before any wire request', async () => {
  let calls = 0;
  await localServer((_request, response) => { calls += 1; json(response, openaiResponse()); }, async (origin) => {
    const invalidOptions = [
      { ...profile(origin), requestOptions: { response_format: { type: ['json_object'] } } },
      { ...profile(origin, 'gemini'), requestOptions: { responseMimeType: ['application/json'] } },
      { ...profile(origin, 'gemini'), requestOptions: { responseMimeType: ['application/json'], responseSchema: {} } },
    ];
    for (const invalidProfile of invalidOptions) {
      assert.throws(() => validateProfile(invalidProfile), ProviderError);
      await rejectsProvider(invokeModel(invalidProfile as unknown as ModelProfile, decision, environment), (error) => {
        assert.equal(error.kind, 'configuration');
        assert.equal(error.attempts, 0);
      });
    }
    assert.equal(calls, 0);
  });
});

test('profile validation rejects credential URLs, unbounded retries and arbitrary request overrides', () => {
  const candidate = profile('http://127.0.0.1:1');
  for (const baseUrl of ['file:///secret', 'ftp://example.invalid', 'https://user:password@example.invalid/v1', 'https://example.invalid/v1?key=secret', 'https://example.invalid/v1#secret']) {
    assert.throws(() => validateProfile({ ...candidate, baseUrl }), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'configuration');
      assert.equal(error.attempts, 0);
      assert.ok(!error.message.includes(baseUrl));
      return true;
    });
  }
  for (const changes of [{ maxRetries: 6 }, { maxRetries: -1 }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { apiKeyEnv: TEST_KEY }, { requestOptions: { model: 'another-model' } }, { requestOptions: { headers: { authorization: TEST_KEY } } }, { requestOptions: { responseSchema: {} } }]) {
    assert.throws(() => validateProfile({ ...candidate, ...changes }), ProviderError);
  }
  const validated = validateProfile({ ...candidate, enabled: true, apiKey: TEST_KEY });
  assert.equal('enabled' in validated, false);
  assert.equal('apiKey' in validated, false);
});

test('missing backend key and baseline configuration fail before any network attempt', async () => {
  let calls = 0;
  await localServer((_request, response) => { calls += 1; json(response, openaiResponse()); }, async (origin) => {
    await rejectsProvider(invokeModel(profile(origin), decision, {}), (error) => {
      assert.equal(error.kind, 'authentication');
      assert.equal(error.attempts, 0);
    });
    const inheritedEnvironment = Object.create(environment) as ProviderEnvironment;
    await rejectsProvider(invokeModel(profile(origin), decision, inheritedEnvironment), (error) => {
      assert.equal(error.kind, 'authentication');
      assert.equal(error.attempts, 0);
    });
    await rejectsProvider(invokeModel({ id: 'baseline', label: '标准', provider: 'baseline', model: 'normal' }, decision, environment), (error) => {
      assert.equal(error.kind, 'configuration');
      assert.equal(error.attempts, 0);
    });
    assert.equal(calls, 0);
  });
});

test('example config enables only real normal/hard baselines and has no credential values', async () => {
  const config = JSON.parse(await readFile(resolve('configs/models.example.json'), 'utf8')) as { models: Array<ModelProfile & { enabled: boolean }> };
  for (const model of config.models) validateProfile(model);
  const enabled = config.models.filter((model) => model.enabled);
  assert.equal(enabled.length, 2);
  assert.ok(enabled.every((model) => model.provider === 'baseline'));
  assert.deepEqual(new Set(enabled.map((model) => model.model)), new Set(['normal', 'hard']));
  assert.equal(config.models.filter((model) => model.provider !== 'baseline' && !model.enabled).length, 3);
  const env = await readFile(resolve('.env.example'), 'utf8');
  for (const variable of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) assert.match(env, new RegExp(`^${variable}=$`, 'm'));
  assert.match(env, /^STATE_AI_PORT=4180$/m);
  assert.match(env, /^STATE_AI_RUNS_DIR=\.\/runs$/m);
  assert.match(env, /^TTS_PROVIDER=system$/m);
  assert.match(env, /^TTS_ENDPOINT=$/m);
  assert.match(env, /^TTS_MODEL=$/m);
  assert.match(env, /^TTS_API_KEY_ENV=OPENAI_API_KEY$/m);
});
