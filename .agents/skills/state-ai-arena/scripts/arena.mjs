import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const usage = `Usage (Node.js 22+): node arena.mjs COMMAND [options]
  check                                      Verify the local service and list models
  models                                     List public model metadata
  register --base-url URL --model NAME --input-price USD --output-price USD
           [--label LABEL] [--max-output-tokens N] [--max-tokens-parameter NAME]
  quote --config FILE                         Read the first-round requirements
  start --config FILE --approved               Recheck the quote and start one authorized match
  status RUN_ID                               Summarize current status and show viewer links
  state RUN_ID [--tick N]                      Summarize one committed state
  replay RUN_ID --from N --limit N             List up to 40 committed frame ticks
  recording RUN_ID                            Show recording status and available MP4 link
  recording RUN_ID --request --approved       Request recording for one completed match

Use --port PORT to select http://127.0.0.1:PORT (STATE_AI_PORT or 4180 by default).
Registration reads STATE_AI_MODEL_API_KEY from the environment and persists it on the server.
Prices are USD per million tokens. Only the operator can authorize mutations.`;

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const commands = new Map(Object.entries({
  check: {}, models: {},
  register: { 'base-url': string, model: string, 'input-price': string, 'output-price': string,
    label: string, 'max-output-tokens': string, 'max-tokens-parameter': string },
  quote: { config: string }, start: { config: string, approved: boolean },
  status: {}, state: { tick: string }, replay: { from: string, limit: string },
  recording: { request: boolean, approved: boolean },
}));
const runCommands = new Set(['status', 'state', 'replay', 'recording']);
const runStatuses = ['queued', 'running', 'waiting', 'paused', 'completed', 'failed'];
const jobStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled'];
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/u.test(value);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const knownErrors = new Map(Object.entries({
  INVALID_REQUEST: 'Check the documented input fields and values.',
  UNKNOWN_MODEL: 'Use a model ID from the local model list.',
  MODEL_UNAVAILABLE: 'Check model availability and backend credentials.',
  UNBOUNDED_MODEL: 'The chosen model needs prices and an output token limit.',
  START_BUDGET_TOO_LOW: 'The authorized caps are below the first-round requirements.',
  RUN_NOT_COMPLETED: 'Recording can be requested after the match completes.',
  MODEL_REGISTRY_WRITE_FAILED: 'The server could not save the registration.',
  NOT_FOUND: 'Check the run ID and the running service version.',
}));

class ArenaError extends Error {}

function requireValue(value, message) {
  if (!value) throw new ArenaError(message);
}

function integer(raw, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(raw);
  requireValue(typeof raw === 'string' && /^\d+$/u.test(raw) && Number.isSafeInteger(value) && value >= min && value <= max,
    `${field} must be an integer from ${min} to ${max}.`);
  return value;
}

function price(raw, field) {
  const value = Number(raw);
  requireValue(raw?.trim() && nonnegative(value), `${field} must be a nonnegative USD price.`);
  return value;
}

function shape(ok, path) {
  requireValue(ok, `${path} returned an unexpected response. Check the local service version.`);
}

function summarizeModel(model, path) {
  shape(typeof model?.id === 'string' && typeof model.available === 'boolean' && ['baseline', 'remote'].includes(model.kind), path);
  return { id: model.id, kind: model.kind, available: model.available,
    inputUsdPerMillion: nonnegative(model.inputUsdPerMillion) ? model.inputUsdPerMillion : undefined,
    outputUsdPerMillion: nonnegative(model.outputUsdPerMillion) ? model.outputUsdPerMillion : undefined };
}

function summarizeRun(run, path, expectedId) {
  shape(safeId(run?.id) && (!expectedId || run.id === expectedId) && runStatuses.includes(run.status) && count(run.tick) && count(run.calls)
    && (run.costUsd === null || nonnegative(run.costUsd)), path);
  return { id: run.id, status: run.status, tick: run.tick, calls: run.calls, costUsd: run.costUsd,
    knownHttpAttempts: count(run.knownHttpAttempts) ? run.knownHttpAttempts : undefined,
    errorKind: ['infrastructure', 'budget', 'recovery', 'cancelled'].includes(run.errorKind) ? run.errorKind : undefined };
}

function summarizeBudget(quote, path) {
  shape(count(quote?.requiredCalls) && nonnegative(quote.requiredCostUsd), path);
  return { requiredCalls: quote.requiredCalls, requiredCostUsd: quote.requiredCostUsd };
}

async function readConfig(file) {
  requireValue(file, 'Provide a run configuration with --config FILE.');
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new ArenaError('Cannot read --config as UTF-8 JSON.'); }
  requireValue(count(config?.budget?.maxCalls) && config.budget.maxCalls > 0 && nonnegative(config.budget.maxCostUsd),
    'Set both budget.maxCalls (positive integer) and budget.maxCostUsd (nonnegative USD) in --config.');
  return config;
}

async function main([command, ...args]) {
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(usage); return; }
  requireValue(Number(process.versions.node.split('.')[0]) >= 22, 'Use Node.js 22 or newer.');
  requireValue(commands.has(command), 'Unknown command. See --help.');
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { port: string, help: { ...boolean, short: 'h' }, ...commands.get(command) } });
  } catch { throw new ArenaError('Unknown option or missing option value. See --help.'); }
  const { values, positionals } = parsed;
  if (values.help) { console.log(usage); return; }
  const needsId = runCommands.has(command);
  const [id] = positionals;
  requireValue(needsId ? positionals.length === 1 && safeId(id) : positionals.length === 0,
    needsId ? 'Provide exactly one valid RUN_ID.' : 'Unexpected positional arguments. See --help.');
  const port = integer(values.port ?? process.env.STATE_AI_PORT ?? '4180', 'Port', 1, 65_535);
  const origin = `http://127.0.0.1:${port}`;
  const runPath = `/api/runs/${id}`;
  const key = command === 'register' ? process.env.STATE_AI_MODEL_API_KEY?.trim() : undefined;
  // A platform request must stay local even when Node is configured to proxy fetch.
  requireValue(process.env.NODE_USE_ENV_PROXY !== '1' && !process.execArgv.includes('--use-env-proxy')
    && !/(?:^|\s|["'])--use-env-proxy(?:\s|["']|$)/u.test(process.env.NODE_OPTIONS ?? ''),
  'Use a Node.js process with environment proxy support disabled for this loopback client.');

  const request = async (path, body) => {
    const method = body === undefined ? 'GET' : 'POST';
    let response;
    try {
      response = await fetch(origin + path, {
        method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ArenaError(`${method} ${path} could not reach ${origin} or timed out. Check the service before retrying.`);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new ArenaError(`${method} ${path} returned a redirect. Use the direct local service port.`);
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const code = result?.code;
      const hint = knownErrors.get(code);
      const quote = result?.startBudget;
      const required = code === 'START_BUDGET_TOO_LOW' && count(quote?.requiredCalls) && nonnegative(quote.requiredCostUsd)
        ? ` Required ${quote.requiredCalls} decision calls and USD ${quote.requiredCostUsd}.` : '';
      throw new ArenaError(`${method} ${path} failed (HTTP ${response.status}${hint ? ` ${code}` : ''}).${hint ? ` ${hint}` : ''}${required}`);
    }
    shape(result && typeof result === 'object' && !Array.isArray(result), path);
    return result;
  };

  const health = async () => {
    const path = '/api/health';
    const result = await request(path);
    shape(result.ok === true && result.service === 'STATE.AI' && result.version === 1 && result.port === port, path);
    return { service: 'STATE.AI', version: result.version, port,
      recoveryErrorCount: Array.isArray(result.recoveryErrors) ? result.recoveryErrors.length : undefined };
  };
  const models = async () => {
    const path = '/api/models';
    const result = await request(path);
    shape(Array.isArray(result.models), path);
    return result.models.map(model => summarizeModel(model, path));
  };
  const quote = async config => {
    const path = '/api/runs/start-budget';
    return summarizeBudget((await request(path, config)).startBudget, path);
  };
  const links = runId => ({ watchUrl: `${origin}/?screen=watch&run=${runId}`, replayUrl: `${origin}/?screen=replay&run=${runId}` });

  let output;
  switch (command) {
    case 'check': output = { ...(await health()), models: await models() }; break;
    case 'models': output = { models: await models() }; break;
    case 'register': {
      requireValue(values['base-url'] && values.model, 'Provide --base-url and --model.');
      requireValue(key && /^[\x21-\x7e]+$/u.test(key), 'Set STATE_AI_MODEL_API_KEY to a valid Bearer token outside the agent conversation, or use the service web form.');
      const input = { baseUrl: values['base-url'], model: values.model, label: values.label, apiKey: key,
        inputUsdPerMillion: price(values['input-price'], '--input-price'), outputUsdPerMillion: price(values['output-price'], '--output-price'),
        maxOutputTokens: values['max-output-tokens'] === undefined ? undefined : integer(values['max-output-tokens'], '--max-output-tokens', 1, 2_147_483_647),
        maxTokensParameter: values['max-tokens-parameter'] };
      await health();
      const path = '/api/models';
      const { model } = await request(path, input);
      shape(/^local-openai-[a-f0-9]{32}$/u.test(model?.id ?? ''), path);
      output = { model: summarizeModel(model, path) };
      break;
    }
    case 'quote': {
      output = { startBudget: await quote(await readConfig(values.config)) };
      break;
    }
    case 'start': {
      requireValue(values.approved, 'Starting a match requires explicit user authorization and --approved.');
      const config = await readConfig(values.config);
      await health();
      const startBudget = await quote(config);
      requireValue(startBudget.requiredCalls <= config.budget.maxCalls && startBudget.requiredCostUsd <= config.budget.maxCostUsd + 1e-12,
        `The first round requires ${startBudget.requiredCalls} decision calls and USD ${startBudget.requiredCostUsd}. The match was not started.`);
      const path = '/api/runs';
      const run = summarizeRun((await request(path, config)).run, path);
      output = { run, ...links(run.id) };
      break;
    }
    case 'status': {
      const { run } = await request(runPath);
      output = { run: summarizeRun(run, runPath, id), ...links(id) };
      break;
    }
    case 'state': {
      const path = `${runPath}/state${values.tick === undefined ? '' : `?tick=${integer(values.tick, '--tick')}`}`;
      const { run, snapshot } = await request(path);
      shape(count(snapshot?.tick), path);
      output = { run: summarizeRun(run, path, id), snapshotTick: snapshot.tick };
      break;
    }
    case 'replay': {
      const from = integer(values.from, '--from'), limit = integer(values.limit, '--limit', 1, 40);
      const path = `${runPath}/replay-frames?from=${from}&limit=${limit}`;
      const { run, frames } = await request(path);
      shape(Array.isArray(frames) && frames.every(frame => count(frame?.snapshot?.tick)), path);
      output = { run: summarizeRun(run, path, id), frameTicks: frames.map(frame => frame.snapshot.tick), replayUrl: links(id).replayUrl };
      break;
    }
    case 'recording': {
      requireValue(Boolean(values.request) === Boolean(values.approved), 'Recording is read-only by default. A request needs both --request and explicit user authorization with --approved.');
      if (values.request) await health();
      const path = `${runPath}/recording`;
      const { job } = await request(path, values.request ? {} : undefined);
      if (job === null && !values.request) { output = { job: null }; break; }
      shape(safeId(job?.id) && job.runId === id && jobStatuses.includes(job.status) && nonnegative(job.progress), path);
      const mp4Path = `/api/artifacts/${id}/exports/${job.id}/video.mp4`;
      const hasVideo = job.status === 'completed' && Array.isArray(job.artifacts)
        && job.artifacts.some(artifact => artifact?.name === 'video.mp4' && artifact.url === mp4Path);
      output = { job: { id: job.id, runId: job.runId, status: job.status, progress: job.progress,
        videoUrl: hasVideo ? origin + mp4Path : undefined } };
      break;
    }
  }
  console.log(JSON.stringify(output, null, 2));
}

try { await main(process.argv.slice(2)); }
catch (error) {
  console.error(error instanceof ArenaError ? error.message : 'Unexpected local client failure.');
  process.exitCode = 1;
}
