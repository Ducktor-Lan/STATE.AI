import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request as httpRequest, createServer as createMockServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { replayArenaRecord } from '@state/arena';
import { startServer } from '../apps/server/src/server.js';
import type { StateServer } from '../apps/server/src/server.js';
import type { ServerModelProfile } from '../apps/server/src/config.js';
import type { ModelSummary, ReplayFrames, RunState, RunSummary, StartBudget } from '../apps/server/src/types.js';
import { errorDiagnostics } from '../apps/server/src/environment.js';
import { atomicWriteJson } from '../apps/server/src/atomic-json.js';

test('atomic metadata publication retries only bounded transient rename failures', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'state-atomic-metadata-'));
  const oldJson = JSON.stringify({ version: 'old' }), newJson = JSON.stringify({ version: 'new' });
  try {
    await t.test('two EPERM failures keep the old target until the third atomic rename', async () => {
      const file = join(temporary, 'server.json'); await writeFile(file, oldJson);
      let attempts = 0, pending: string | undefined;
      const waits: number[] = [];
      await atomicWriteJson(file, newJson, {
        rename: async (source, destination) => {
          attempts++; assert.equal(dirname(source), dirname(file));
          pending ??= source; assert.equal(source, pending); assert.equal(destination, file);
          assert.equal(await readFile(file, 'utf8'), oldJson);
          assert.equal(await readFile(source, 'utf8'), newJson);
          if (attempts < 3) throw Object.assign(new Error('Simulated metadata sharing conflict'), { code: 'EPERM', syscall: 'rename', path: source, dest: destination });
          await rename(source, destination);
        },
        wait: async milliseconds => { waits.push(milliseconds); },
      });
      assert.equal(attempts, 3); assert.deepEqual(waits, [20, 50]);
      assert.equal(await readFile(file, 'utf8'), newJson);
      await assert.rejects(readFile(pending!, 'utf8'), { code: 'ENOENT' });
      let nextPending: string | undefined;
      await atomicWriteJson(file, oldJson, { rename: async (source, destination) => { nextPending = source; await rename(source, destination); } });
      assert.notEqual(nextPending, pending); assert.equal(await readFile(file, 'utf8'), oldJson);
    });
    await t.test('permanent EPERM/EBUSY/EACCES stop at six attempts and retain original error and pending JSON', async () => {
      for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
        const file = join(temporary, `permanent-${code}.json`); await writeFile(file, oldJson);
        const failure = Object.assign(new Error('Simulated permanent metadata lock'), { code, syscall: 'rename', path: '', dest: file });
        let attempts = 0, pending: string | undefined;
        const waits: number[] = [];
        await assert.rejects(atomicWriteJson(file, newJson, {
          rename: async source => {
            attempts++; pending ??= source; assert.equal(source, pending); failure.path = source;
            assert.equal(await readFile(file, 'utf8'), oldJson); throw failure;
          },
          wait: async milliseconds => { waits.push(milliseconds); },
        }), error => error === failure);
        assert.equal(attempts, 6); assert.deepEqual(waits, [20, 50, 100, 200, 400]);
        assert.equal(waits.reduce((sum, value) => sum + value, 0), 770);
        assert.equal(failure.code, code); assert.equal(failure.path, pending); assert.equal(failure.dest, file);
        assert.equal(await readFile(file, 'utf8'), oldJson); assert.equal(await readFile(pending!, 'utf8'), newJson);
      }
    });
    await t.test('a nonretryable rename error is thrown unchanged after one attempt', async () => {
      const file = join(temporary, 'nonretryable.json'); await writeFile(file, oldJson);
      const failure = Object.assign(new Error('Simulated metadata I/O error'), { code: 'EIO', syscall: 'rename', path: '', dest: file });
      let attempts = 0, waits = 0;
      await assert.rejects(atomicWriteJson(file, newJson, {
        rename: async source => { attempts++; failure.path = source; throw failure; },
        wait: async () => { waits++; },
      }), error => error === failure);
      assert.equal(attempts, 1); assert.equal(waits, 0);
      assert.equal(await readFile(file, 'utf8'), oldJson); assert.equal(await readFile(failure.path, 'utf8'), newJson);
    });
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
});

const profiles: ServerModelProfile[] = [
  { id: 'baseline-normal', label: 'Normal', provider: 'baseline', model: 'normal' },
  { id: 'baseline-hard', label: 'Hard', provider: 'baseline', model: 'hard' },
  { id: 'no-key', label: 'Remote without key', provider: 'openai-compatible', model: 'test', baseUrl: 'http://127.0.0.1:1/private-endpoint-secret', apiKeyEnv: 'STATE_SERVER_TEST_MISSING_KEY', maxOutputTokens: 64, inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
  { id: 'disabled', label: 'Disabled baseline', provider: 'baseline', model: 'normal', enabled: false },
];
const input = (seed = 1729) => ({ track: 'strategy', seed, durationSeconds: 180, factionCount: 2, models: ['baseline-normal', 'baseline-hard'], disaster: false, budget: { maxCalls: 1000, maxCostUsd: 0 } });
async function post(app: StateServer, path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
async function createRun(app: StateServer, seed = 1729): Promise<RunSummary> {
  const response = await post(app, '/api/runs', input(seed)); assert.equal(response.status, 201);
  const body = await response.json() as { run: RunSummary }; return body.run;
}
async function raw(app: StateServer, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<number> {
  return new Promise((accept, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(`${app.url}`, { path, method: text === undefined ? 'GET' : 'POST', headers: { ...(text ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) } : {}), ...headers } }, response => {
      response.resume(); response.once('end', () => accept(response.statusCode ?? 0));
    }); request.on('error', reject); request.end(text);
  });
}

test('local HTTP service: real baseline, replay, pause/recovery and request boundaries', { timeout: 180_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'state-server-'));
  const dataDir = join(temporary, 'runs');
  let app = await startServer({ rootDir: process.cwd(), dataDir, profiles, env: {}, port: 0 });
  try {
    await t.test('health/models list only safe available metadata', async () => {
      const health = await fetch(`${app.url}/api/health`); assert.equal(health.status, 200); assert.equal((await health.json() as { ok: boolean }).ok, true);
      const response = await fetch(`${app.url}/api/models`); const text = await response.text();
      assert.equal(response.status, 200); assert.ok(!text.includes('private-endpoint-secret')); assert.ok(!text.includes('STATE_SERVER_TEST_MISSING_KEY'));
      const body = JSON.parse(text) as { models: Array<{ id: string; available: boolean; unavailableReason?: string }> };
      assert.equal(body.models.find(model => model.id === 'baseline-normal')?.available, true);
      assert.equal(body.models.find(model => model.id === 'no-key')?.available, false);
      assert.match(body.models.find(model => model.id === 'no-key')?.unavailableReason ?? '', /key/iu);
      assert.equal(body.models.find(model => model.id === 'disabled')?.available, false);
      const list = await fetch(`${app.url}/api/runs`); assert.deepEqual(await list.json(), { runs: [] });
    });
    await t.test('invalid payloads and missing credentials fail explicitly before any run', async () => {
      for (const value of [{}, { ...input(), factionCount: 5 }, { ...input(), seed: -1 }, { ...input(), maxActions: 99 }, { ...input(), models: ['baseline-normal', 'no-key'] }]) {
        const response = await post(app, '/api/runs', value); assert.equal(response.status, 400); const body = await response.json() as { error: string }; assert.ok(body.error.length > 5);
      }
      const malformed = await fetch(`${app.url}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }); assert.equal(malformed.status, 400);
      const large = await fetch(`${app.url}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"padding":"${'x'.repeat(1_048_576)}"}` }); assert.equal(large.status, 413);
      assert.equal(app.runs.list().length, 0);
    });
    await t.test('Host/Origin block cross-site side effects', async () => {
      assert.equal(await raw(app, '/api/runs', { Origin: 'https://evil.example' }, input()), 403);
      assert.equal(await raw(app, '/api/runs', { Host: 'evil.example:4180' }, input()), 403);
      assert.equal(await raw(app, '/api/runs', { 'Sec-Fetch-Site': 'cross-site' }, input()), 403);
      assert.equal(app.runs.list().length, 0);
    });
    await t.test('valid POST finishes via ArenaSession and replay snapshots match recorded facts', async () => {
      const created = await createRun(app), completed = await app.runs.wait(created.id);
      assert.equal(completed.status, 'completed', completed.error); assert.ok(completed.tick > 0); assert.ok(completed.calls > 0); assert.equal(completed.costUsd, 0); assert.equal(completed.httpAttempts, 0);
      assert.equal(completed.reproducibility.development, !completed.reproducibility.codeHEAD || completed.reproducibility.dirty !== false);
      assert.match(completed.reproducibility.engineHash, /^[a-f0-9]{64}$/u);
      const record = app.runs.record(created.id), verified = replayArenaRecord(record);
      assert.equal(verified.state.tick, completed.tick); assert.deepEqual(verified.result, app.runs.result(created.id));
      const frame = await fetch(`${app.url}/api/runs/${created.id}/state?tick=20`); assert.equal(frame.status, 200);
      const state = await frame.json() as { snapshot: { tick: number }; events: unknown[] }; assert.equal(state.snapshot.tick, 20); assert.ok(Array.isArray(state.events));
      assert.equal((await fetch(`${app.url}/api/runs/${created.id}/state?tick=-1`)).status, 400);
      const replayUrl = `${app.url}/api/runs/${created.id}/replay-frames`;
      const replay = await fetch(`${replayUrl}?from=19&limit=3`, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(replay.status, 200);
      assert.equal(replay.headers.get('Content-Encoding'), 'gzip');
      assert.equal(replay.headers.get('Vary'), 'Accept-Encoding');
      const batch = await replay.json() as ReplayFrames;
      assert.deepEqual(batch.frames.map(frame => frame.snapshot.tick), [19, 20, 21]);
      assert.deepEqual(batch.decisionsByRound.map(round => round.tick), [0, 20]);
      const checkFrames = async ({ frames, map }: ReplayFrames) => {
        const { territories: geometry, ...mapFields } = map;
        for (const { snapshot, outcome } of frames) {
          const response = await fetch(`${app.url}/api/runs/${created.id}/state?tick=${snapshot.tick}`);
          const state = await response.json() as RunState;
          assert.deepEqual({ ...snapshot, ...mapFields, territories: snapshot.territories.map(territory => ({ ...territory, ...geometry[territory.id] })) }, state.snapshot);
          assert.deepEqual(outcome, state.outcome);
        }
      };
      await checkFrames(batch);
      const tail = await fetch(`${replayUrl}?from=${completed.tick - 1}&limit=40`, { headers: { 'Accept-Encoding': '*;q=1, gzip;q=0' } });
      assert.equal(tail.status, 200);
      assert.equal(tail.headers.get('Content-Encoding'), null);
      const last = await tail.json() as ReplayFrames;
      assert.deepEqual(last.frames.map(frame => frame.snapshot.tick), [completed.tick - 1, completed.tick]);
      assert.equal(last.frames[0]!.outcome, null);
      assert.ok(last.frames[1]!.outcome);
      await checkFrames(last);
      const future = await fetch(`${replayUrl}?from=${completed.tick + 1}&limit=40`);
      assert.equal(future.status, 200);
      const empty = await future.json() as ReplayFrames;
      assert.deepEqual([empty.frames, empty.decisionsByRound], [[], []]);
      for (const query of ['from=0', 'from=-1&limit=1', 'from=0&limit=41']) {
        assert.equal((await fetch(`${replayUrl}?${query}`)).status, 400);
      }
      const detail = await fetch(`${app.url}/api/runs/${created.id}/rounds/0`); assert.equal(detail.status, 200);
      const round = await detail.json() as { decisions: Array<{ observation: unknown; receipts: unknown[] }>; spectatorAccess: { privateMessages: boolean } };
      assert.equal(round.spectatorAccess.privateMessages, true); assert.ok(round.decisions.every(decision => decision.observation && Array.isArray(decision.receipts)));
      const board = await fetch(`${app.url}/api/runs/${created.id}/storyboard`); assert.equal(board.status, 200); const storyboard = await board.json();
      assert.equal((await post(app, `/api/runs/${created.id}/storyboard`, storyboard)).status, 200);
      // Read results remain isolated even when their underlying durable projection is cached.
      const detailCopy = app.runs.detail(created.id), expectedTitle = detailCopy.events[0]?.title;
      assert.ok(detailCopy.events.length > 0); detailCopy.events[0]!.title = 'mutated caller copy';
      assert.equal(app.runs.detail(created.id).events[0]?.title, expectedTitle);
      const roundCopy = app.runs.round(created.id, 0), expectedOutput = roundCopy.decisions[0]?.output?.text;
      assert.ok(roundCopy.decisions[0]?.output); roundCopy.decisions[0]!.output!.text = 'mutated caller copy';
      assert.equal(app.runs.round(created.id, 0).decisions[0]?.output?.text, expectedOutput);
      const sourceCopy = app.runs.source(created.id), expectedLabel = sourceCopy.factions[0]!.label;
      sourceCopy.factions[0]!.label = 'mutated caller copy'; assert.equal(app.runs.source(created.id).factions[0]!.label, expectedLabel);
      const exportedCopy = app.runs.record(created.id), expectedEntries = exportedCopy.entries.length;
      exportedCopy.entries.length = 0; assert.equal(app.runs.record(created.id).entries.length, expectedEntries);
    });
    await t.test('pause/resume stops at a boundary and does not duplicate sealed actions', async () => {
      const created = await createRun(app, 1730);
      const pausedResponse = await post(app, `/api/runs/${created.id}/pause`); assert.equal(pausedResponse.status, 200);
      const paused = (await pausedResponse.json() as { run: RunSummary }).run; assert.equal(paused.status, 'paused');
      await delay(30); assert.equal(app.runs.get(created.id).tick, paused.tick);
      const pausedRounds = app.runs.detail(created.id).rounds.length;
      assert.equal((await app.runs.state(created.id)).run.status, 'paused');
      assert.equal((await post(app, `/api/runs/${created.id}/resume`)).status, 200);
      const completed = await app.runs.wait(created.id); assert.equal(completed.status, 'completed', completed.error);
      assert.ok(app.runs.detail(created.id).rounds.length > pausedRounds);
      assert.equal((await app.runs.state(created.id)).run.status, 'completed');
      const record = app.runs.record(created.id), decisions = record.entries.filter(entry => entry.type === 'DECISION');
      assert.equal(new Set(decisions.map(entry => entry.value.decisionId)).size, decisions.length);
      assert.equal(replayArenaRecord(record).state.tick, completed.tick);
    });
    await t.test('artifact paths reject traversal and do not expose server-owned records', async () => {
      const id = app.runs.list()[0]!.id, directory = join(app.runs.runDirectory(id), 'exports', 'fixture'); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'subtitles.srt'), '1\n00:00:00,000 --> 00:00:01,000\nRecorded fixture\n', 'utf8');
      assert.equal((await fetch(`${app.url}/api/artifacts/${id}/exports/fixture/subtitles.srt`)).status, 200);
      assert.equal(await raw(app, `/api/artifacts/${id}/exports/%2e%2e/server.json`), 400);
      assert.equal(await raw(app, `/api/artifacts/${id}/exports/%252e%252e/server.json`), 400);
      assert.equal((await fetch(`${app.url}/api/artifacts/${id}/arena/initial.json`)).status, 404);
      assert.equal((await fetch(`${app.url}/api/artifacts/${id}/exports/missing.mp4`)).status, 404);
    });
    await t.test('completed recording previews support byte seeks and preserve the download URL', async () => {
      const runId = app.runs.list()[0]!.id;
      const jobId = 'c713350c-c7d1-4ec4-864a-73e679898e93';
      const runDirectory = app.runs.runDirectory(runId);
      const exportDirectory = join(runDirectory, 'exports', jobId);
      const jobDirectory = join(runDirectory, 'jobs');
      const video = Buffer.from('video-fixture');
      const url = `/api/artifacts/${runId}/exports/${jobId}/video.mp4`;
      await mkdir(exportDirectory, { recursive: true });
      await mkdir(jobDirectory, { recursive: true });
      await writeFile(join(exportDirectory, 'video.mp4'), video);
      assert.equal((await fetch(`${app.url}${url}?inline=1`)).status, 404);
      await writeFile(join(jobDirectory, 'recording.json'), JSON.stringify({ jobId }));
      await writeFile(join(jobDirectory, `${jobId}.json`), JSON.stringify({ id: jobId, runId, status: 'completed', progress: 1, artifacts: [{ name: 'video.mp4', url }] }));

      const download = await fetch(app.url + url);
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-disposition'), 'attachment; filename="video.mp4"');
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), video);

      const previewUrl = `${app.url}${url}?inline=1`;
      const preview = await fetch(previewUrl, { headers: { Range: 'bytes=6-8' } });
      assert.equal(preview.status, 206);
      assert.equal(preview.headers.get('content-type'), 'video/mp4');
      assert.equal(preview.headers.get('content-disposition'), 'inline; filename="video.mp4"');
      assert.match(preview.headers.get('cache-control') ?? '', /\bprivate\b/);
      assert.equal(preview.headers.get('accept-ranges'), 'bytes');
      assert.equal(preview.headers.get('content-range'), `bytes 6-8/${video.length}`);
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), video.subarray(6, 9));

      const tail = await fetch(previewUrl, { method: 'HEAD', headers: { Range: 'bytes=-3' } });
      assert.equal(tail.status, 206);
      assert.equal(tail.headers.get('content-length'), '3');
      assert.equal((await tail.arrayBuffer()).byteLength, 0);
      const invalid = await fetch(previewUrl, { headers: { Range: `bytes=${video.length}-` } });
      assert.equal(invalid.status, 416);
      assert.equal(invalid.headers.get('content-range'), `bytes */${video.length}`);
    });
    await t.test('clean shutdown/restart restores saved runs paused without scheduling', async () => {
      const pending = await app.runs.create(input(1731), { start: false });
      await app.close();
      app = await startServer({ rootDir: process.cwd(), dataDir, profiles, env: {}, port: 0 });
      const recovered = app.runs.get(pending.id); assert.equal(recovered.status, 'paused'); assert.equal(recovered.tick, 0); assert.equal(recovered.calls, 0);
      await delay(30); assert.equal(app.runs.get(pending.id).calls, 0);
      await app.runs.resume(pending.id); assert.equal((await app.runs.wait(pending.id)).status, 'completed');
    });
  } finally { await app.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
});

test('cached projections follow durable commits without sharing mutable read results', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'state-cache-revision-'));
  const app = await startServer({ rootDir: process.cwd(), dataDir: join(temporary, 'runs'), profiles: profiles.slice(0, 2), env: {}, port: 0 });
  try {
    const created = await app.runs.create({ ...input(), budget: { maxCalls: 2, maxCostUsd: 0 } }, { start: false });
    assert.equal(app.runs.detail(created.id).rounds.length, 0);
    assert.equal((await app.runs.state(created.id)).snapshot.tick, 0);
    const originalSource = app.runs.source(created.id); assert.equal(originalSource.durationTicks, 0);
    await app.runs.resume(created.id);
    const paused = await app.runs.wait(created.id); assert.equal(paused.status, 'paused'); assert.equal(paused.tick, 20); assert.equal(paused.calls, 2);
    assert.equal(app.runs.detail(created.id).rounds.length, 1);
    assert.equal((await app.runs.state(created.id)).snapshot.tick, 20);
    assert.equal((await app.runs.state(created.id, 0)).snapshot.tick, 0);
    assert.equal(app.runs.source(created.id).durationTicks, 20); assert.equal(originalSource.durationTicks, 0);
    const round = app.runs.round(created.id, 0), expected = round.decisions[0]!.output!.text;
    round.decisions[0]!.output!.text = 'caller mutation'; assert.equal(app.runs.round(created.id, 0).decisions[0]!.output!.text, expected);
    const record = app.runs.record(created.id), entries = record.entries.length;
    assert.equal(replayArenaRecord(record).state.tick, 20);
    record.entries.length = 0; assert.equal(app.runs.record(created.id).entries.length, entries);
  } finally { await app.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
});

test('persistence diagnostics retain safe causes; auxiliary cache failure cannot undo a durable commit', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'state-persistence-diagnostics-'));
  const app = await startServer({ rootDir: process.cwd(), dataDir: join(temporary, 'runs'), profiles: profiles.slice(0, 2), env: {}, port: 0 });
  try {
    const created = await app.runs.create({ ...input(), budget: { maxCalls: 2, maxCostUsd: 0 } }, { start: false });
    const directory = app.runs.runDirectory(created.id);
    // An owned temporary directory makes the auxiliary checkpoint write fail deterministically.
    await mkdir(join(directory, 'arena', 'checkpoint.json.pending'));
    await app.runs.resume(created.id);
    const paused = await app.runs.wait(created.id);
    assert.equal(paused.status, 'paused'); assert.equal(paused.tick, 20); assert.equal(paused.calls, 2);
    assert.ok((paused.persistenceWarningCount ?? 0) > 0);
    const warning = paused.persistenceWarnings?.find(value => value.phase.includes('checkpoint'));
    assert.ok(warning); assert.equal(warning.durable, true); assert.ok(warning.error.some(value => value.code && value.syscall));
    const stored = JSON.parse(await readFile(join(directory, 'server.json'), 'utf8')) as { run: RunSummary };
    assert.deepEqual(stored.run.persistenceWarnings, paused.persistenceWarnings);
    assert.equal(replayArenaRecord(app.runs.record(created.id)).state.tick, 20);

    const failing = await app.runs.create({ ...input(1738), budget: { maxCalls: 2, maxCostUsd: 0 } }, { start: false });
    const failedDirectory = app.runs.runDirectory(failing.id), log = join(failedDirectory, 'arena', 'arena.jsonl');
    await rename(log, `${log}.before-fault`); await mkdir(log);
    await app.runs.resume(failing.id);
    const failed = await app.runs.wait(failing.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.tick, 0); assert.equal(failed.calls, 0);
    assert.ok(failed.errorDiagnostics?.some(value => value.code && value.syscall && value.path?.endsWith('arena.jsonl')));
    const failedStored = JSON.parse(await readFile(join(failedDirectory, 'server.json'), 'utf8')) as { run: RunSummary };
    assert.deepEqual(failedStored.run.errorDiagnostics, failed.errorDiagnostics);
  } finally { await app.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
});

test('error diagnostic serialization redacts secrets throughout the bounded cause chain', () => {
  const secret = 'local-diagnostic-placeholder';
  const cause = Object.assign(new Error(`filesystem rejected ${secret}`), { code: 'EACCES', syscall: 'rename', path: `C:/runs/${secret}/checkpoint.pending`, dest: 'C:/runs/checkpoint.json', phase: 'checkpoint.rename', durable: false });
  const error = new Error('Persistence failed', { cause });
  const diagnostics = errorDiagnostics(error, { TEST_API_KEY: secret });
  assert.equal(diagnostics.length, 2); assert.equal(diagnostics[1]?.code, 'EACCES'); assert.equal(diagnostics[1]?.syscall, 'rename');
  assert.equal(diagnostics[1]?.durable, false); assert.equal(diagnostics[1]?.phase, 'checkpoint.rename');
  assert.ok(!JSON.stringify(diagnostics).includes(secret));
});

test('dotenv settings load without exporting secrets and explicit options override the environment', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'state-environment-server-'));
  const original = process.env.STATE_AI_PORT, originalSecret = process.env.TEST_SECRET;
  await writeFile(join(temporary, '.env'), 'STATE_AI_PORT=0\nSTATE_AI_RUNS_DIR=dotenv-runs\nTTS_PROVIDER=system\nTTS_VOICE=Test Voice\nTEST_SECRET=local-placeholder\n', 'utf8');
  const app = await startServer({ rootDir: temporary, profiles: profiles.slice(0, 2), env: {} });
  try {
    assert.equal(app.runs.dataDir, join(temporary, 'dotenv-runs')); assert.equal(app.runs.env.TTS_VOICE, 'Test Voice');
    assert.equal(process.env.STATE_AI_PORT, original); assert.equal(process.env.TEST_SECRET, originalSecret);
    assert.equal((await fetch(`${app.url}/api/health`)).status, 200);
  } finally { await app.close(); }
  const explicit = await startServer({ rootDir: temporary, profiles: profiles.slice(0, 2), env: { STATE_AI_PORT: 'invalid', STATE_AI_RUNS_DIR: 'process-runs' }, port: 0, dataDir: 'explicit-runs' });
  try { assert.equal(explicit.runs.dataDir, join(temporary, 'explicit-runs')); assert.equal(explicit.runs.env.STATE_AI_RUNS_DIR, 'process-runs'); }
  finally { await explicit.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
});

test('HTTP OpenAI registrations survive restart and enforce first-round budgets', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'state-local-model-server-'));
  const apiKey = 'synthetic-local-model-credential';
  const calls: Array<{ url?: string; authorized: boolean; model: string; maxTokens: number; decisionId: string }> = [];
  let receiveRequest!: () => void, releaseReply!: () => void;
  const requestReceived = new Promise<void>(resolve => { receiveRequest = resolve; });
  const replyGate = new Promise<void>(resolve => { releaseReply = resolve; });
  const mock = createMockServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk.toString(); });
    request.on('end', async () => {
      try {
        const body = JSON.parse(text) as { model: string; max_tokens: number; messages: Array<{ content: string }> };
        const { decision_id } = JSON.parse(body.messages[1]!.content) as { decision_id: string };
        calls.push({ url: request.url, authorized: request.headers.authorization === `Bearer ${apiKey}`, model: body.model, maxTokens: body.max_tokens, decisionId: decision_id });
        receiveRequest();
        await replyGate;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ message: {
          content: JSON.stringify({ decision_id, intent: `Mock echo ${apiKey}`, memory_note: '', actions: [{ type: 'wait' }], diplomacy: [] }),
        } }] }));
      } catch { response.writeHead(400).end(); }
    });
  });
  let app: StateServer | undefined, peer: StateServer | undefined;
  try {
    await new Promise<void>(accept => mock.listen(0, '127.0.0.1', accept));
    const address = mock.address(); assert.ok(address && typeof address !== 'string');
    const options = { rootDir: process.cwd(), dataDir: join(temporary, 'runs'), profiles: profiles.slice(0, 2), env: {}, port: 0 };
    app = await startServer(options);
    peer = await startServer(options);
    const register = async (server: StateServer, name: string, usdPerMillion = 0) => {
      const response = await post(server, '/api/models', { baseUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`, model: name, apiKey,
        inputUsdPerMillion: usdPerMillion, outputUsdPerMillion: usdPerMillion, maxOutputTokens: 64, maxTokensParameter: 'max_tokens' });
      assert.equal(response.status, 201);
      const text = await response.text(); assert.ok(!text.includes(apiKey));
      const { model } = JSON.parse(text) as { model: ModelSummary }; assert.equal(model.available, true);
      return model;
    };
    const model = await register(app, 'fixture-model');
    const free = { ...input(), models: ['baseline-normal', model.id], budget: { maxCalls: 2, maxCostUsd: 0 } };
    const created = await app.runs.create(free, { start: false });
    const peerModel = await register(peer, 'other-fixture-model', 1);
    assert.notEqual(peerModel.id, model.id);
    assert.equal(created.status, 'paused'); assert.equal(calls.length, 0);
    await Promise.all([app.close(), peer.close()]);

    app = await startServer(options);
    const listed = await fetch(`${app.url}/api/models`); assert.equal(listed.status, 200);
    const text = await listed.text(); assert.ok(!text.includes(apiKey));
    const { models } = JSON.parse(text) as { models: ModelSummary[] };
    assert.deepEqual(models.find(item => item.id === model.id), model);
    assert.deepEqual(models.find(item => item.id === peerModel.id), peerModel);
    const freeQuote = await post(app, '/api/runs/start-budget', free);
    assert.equal(freeQuote.status, 200);
    assert.deepEqual(await freeQuote.json(), { startBudget: { requiredCalls: 2, requiredCostUsd: 0 } });
    assert.equal(calls.length, 0);
    assert.equal(app.runs.get(created.id).status, 'paused');
    assert.equal((await post(app, `/api/runs/${created.id}/resume`)).status, 200);
    await Promise.race([requestReceived, delay(10_000, undefined, { ref: false }).then(() => assert.fail('The loopback request did not arrive.'))]);
    const state = await fetch(`${app.url}/api/runs/${created.id}/state`); assert.equal(state.status, 200);
    const { run: waiting } = await state.json() as { run: RunSummary };
    assert.equal(waiting.status, 'waiting'); assert.equal(waiting.httpAttempts, null);
    assert.ok(waiting.uncertainCalls?.some(call => call.seat === 'B' && call.status === 'pending'));
    releaseReply();

    const resumed = await app.runs.wait(created.id);
    assert.equal(resumed.status, 'paused'); assert.equal(resumed.tick, 20); assert.equal(resumed.costUsd, 0);
    assert.equal(calls.length, 1); assert.deepEqual(resumed.uncertainCalls, []);
    assert.equal(resumed.knownHttpAttempts, calls.length); assert.equal(resumed.httpAttempts, calls.length);
    const record = app.runs.record(created.id);
    const decisions = record.entries.flatMap(entry => entry.type === 'DECISION' && entry.value.seat === 'B' ? [entry.value.decisionId] : []);
    assert.deepEqual(calls, decisions.map(decisionId => ({ url: '/v1/chat/completions', authorized: true, model: 'fixture-model', maxTokens: 64, decisionId })));
    assert.ok(!JSON.stringify(record).includes(apiKey));

    const paid = { ...input(), track: 'diplomacy', durationSeconds: 480, factionCount: 4, recordVideo: true,
      models: ['baseline-normal', peerModel.id, 'baseline-hard', peerModel.id], budget: { maxCalls: 4, maxCostUsd: 0 } };
    const directories = (await readdir(options.dataDir)).sort();
    const beforeRequests = calls.length;
    const quote = await post(app, '/api/runs/start-budget', paid);
    assert.equal(quote.status, 200);
    const { startBudget } = await quote.json() as { startBudget: StartBudget };
    assert.equal(startBudget.requiredCalls, 4);
    assert.ok(Number.isFinite(startBudget.requiredCostUsd) && startBudget.requiredCostUsd > 0);
    const assertRejected = async (response: Response) => {
      assert.equal(response.status, 400);
      const body = await response.json() as { code: string; startBudget: StartBudget };
      assert.equal(body.code, 'START_BUDGET_TOO_LOW');
      assert.deepEqual(body.startBudget, startBudget);
    };
    await assertRejected(await post(app, '/api/runs', paid));
    await assertRejected(await post(app, '/api/runs', { ...paid, budget: { maxCalls: 3, maxCostUsd: startBudget.requiredCostUsd } }));
    assert.equal(calls.length, beforeRequests);
    assert.deepEqual((await readdir(options.dataDir)).sort(), directories);
    assert.deepEqual(app.runs.list().map(run => run.id), [created.id]);

    const maxCostUsd = startBudget.requiredCostUsd - 5e-13;
    const accepted = await post(app, '/api/runs', { ...paid, budget: { maxCalls: 4, maxCostUsd } });
    assert.equal(accepted.status, 201);
    const { run: paidRun } = await accepted.json() as { run: RunSummary };
    const firstWindow = await app.runs.wait(paidRun.id);
    assert.equal(firstWindow.budget.maxCostUsd, maxCostUsd);
    assert.equal(firstWindow.status, 'paused'); assert.equal(firstWindow.tick, 20); assert.equal(firstWindow.calls, 4);
    assert.ok(firstWindow.costUsd !== null && Math.abs(firstWindow.costUsd - 0.00003) < 1e-12);
    assert.equal(firstWindow.httpAttempts, 2);
    assert.equal(calls.length, beforeRequests + 2);
    const begin = app.runs.record(paidRun.id).entries.find(entry => entry.type === 'BEGIN');
    assert.ok(begin);
    assert.equal(begin.round.seats.reduce((sum, seat) => sum + (begin.reservations[seat] ?? 0), 0), startBudget.requiredCostUsd);

    const legacy = await app.runs.create(paid, { start: false });
    const metadataFile = join(app.runs.runDirectory(created.id), 'server.json');
    await app.close();
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as { run: RunSummary };
    metadata.run.httpAttempts = null;
    await writeFile(metadataFile, JSON.stringify(metadata));
    app = await startServer(options);
    assert.equal(app.runs.get(created.id).httpAttempts, beforeRequests);
    const recovered = app.runs.get(legacy.id);
    assert.equal(recovered.status, 'paused'); assert.equal(recovered.tick, 0); assert.equal(recovered.calls, 0);
    const legacyLog = app.runs.record(legacy.id).entries;
    const resumePath = `/api/runs/${legacy.id}/resume`;
    for (const response of await Promise.all([post(app, resumePath), post(app, resumePath)])) await assertRejected(response);
    assert.equal(calls.length, beforeRequests + 2);
    assert.deepEqual(app.runs.get(legacy.id), recovered);
    assert.deepEqual(app.runs.record(legacy.id).entries, legacyLog);
  } finally {
    releaseReply();
    await Promise.all([app?.close(), peer?.close()]);
    if (mock.listening) await new Promise<void>((accept, reject) => { mock.close(error => error ? reject(error) : accept()); mock.closeIdleConnections(); });
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('provider faults and unknown accounting pause before actions; invalid reconciliation leaves the ledger unchanged', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'state-accounting-server-'));
  let requests = 0;
  const mock = createMockServer((request, response) => {
    requests++; let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { model: string };
      response.writeHead(parsed.model === 'failing' ? 503 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(parsed.model === 'failing' ? { error: { message: 'mock unavailable' } } : { choices: [{ message: { content: '{}' } }] }));
    });
  });
  await new Promise<void>(accept => mock.listen(0, '127.0.0.1', accept));
  const address = mock.address(); assert.ok(address && typeof address !== 'string');
  const remote: ServerModelProfile = { id: 'mock-remote', label: 'Mock', provider: 'openai-compatible', model: 'missing-usage', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'STATE_MOCK_KEY', maxOutputTokens: 128, maxRetries: 0, inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
  const options = { rootDir: process.cwd(), dataDir: join(temporary, 'runs'), port: 0, profiles: [profiles[0]!, remote, { ...remote, id: 'mock-failing', model: 'failing' }], env: { STATE_MOCK_KEY: 'local-test-placeholder-no-real-credential' } };
  let app = await startServer(options);
  try {
    const make = async (modelId: string) => {
      const response = await post(app, '/api/runs', { ...input(), models: ['baseline-normal', modelId], budget: { maxCalls: 10, maxCostUsd: 1 } });
      assert.equal(response.status, 201); const body = await response.json() as { run: RunSummary }; return app.runs.wait(body.run.id);
    };
    const unknown = await make('mock-remote'); assert.equal(unknown.status, 'paused'); assert.equal(unknown.tick, 0); assert.equal(unknown.costUsd, null);
    assert.equal(requests, 1); assert.equal((await post(app, `/api/runs/${unknown.id}/resume`)).status, 409);
    const before = app.runs.record(unknown.id).entries.length;
    assert.equal((await app.runs.state(unknown.id)).decisions.find(decision => decision.modelId === 'mock-remote')?.costUsd, null);
    assert.equal((await post(app, `/api/runs/${unknown.id}/reconcile`, { kind: 'response', seat: 'C', costUsd: 0 })).status, 400);
    assert.equal(app.runs.record(unknown.id).entries.length, before);
    assert.equal((await post(app, `/api/runs/${unknown.id}/reconcile`, { kind: 'response', seat: 'B', costUsd: 0 })).status, 200);
    const after = app.runs.record(unknown.id).entries.length; assert.equal(after, before + 1);
    assert.equal((await app.runs.state(unknown.id)).decisions.find(decision => decision.modelId === 'mock-remote')?.costUsd, 0);
    assert.equal((await post(app, `/api/runs/${unknown.id}/reconcile`, { kind: 'response', seat: 'B', costUsd: 0 })).status, 409);
    assert.equal(app.runs.record(unknown.id).entries.length, after); assert.equal(replayArenaRecord(app.runs.record(unknown.id)).state.tick, 0);
    const failed = await make('mock-failing'); assert.equal(failed.status, 'failed'); assert.equal(failed.errorKind, 'infrastructure'); assert.equal(failed.tick, 0); assert.equal(failed.costUsd, null);
    assert.equal(requests, 2); assert.equal((await post(app, `/api/runs/${failed.id}/resume`)).status, 409);
    const round = app.runs.round(failed.id, 0); assert.equal(round.decisions.find(decision => decision.modelId === 'mock-failing')?.status, 'error');
    assert.equal(app.runs.result(failed.id), null); assert.equal(failed.uncertainCalls?.length, 1);
    const attempt = failed.uncertainCalls![0]!;
    const response = await post(app, `/api/runs/${failed.id}/reconcile`, { kind: 'uncertain', seat: attempt.seat, attemptId: attempt.attemptId, costUsd: 0 });
    assert.equal(response.status, 200);
    const { run: settled } = await response.json() as { run: RunSummary };
    assert.deepEqual(settled.uncertainCalls, []); assert.equal(settled.knownHttpAttempts, 0); assert.equal(settled.httpAttempts, null);
    const metadataFile = join(app.runs.runDirectory(failed.id), 'server.json');
    await app.close();
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as { run: RunSummary };
    metadata.run.httpAttempts = 0;
    await writeFile(metadataFile, JSON.stringify(metadata));
    app = await startServer({ ...options, profiles: [profiles[0]!, remote, { ...profiles[0]!, id: 'mock-failing' }] });
    const recovered = app.runs.get(failed.id);
    assert.deepEqual(recovered.uncertainCalls, []); assert.equal(recovered.knownHttpAttempts, 0); assert.equal(recovered.httpAttempts, null);
  } finally {
    await app.close(); await new Promise<void>((accept, reject) => { mock.close(error => error ? reject(error) : accept()); mock.closeIdleConnections(); });
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('HTTP development tournament runs a real swapped-seat schedule and aggregates completed games', { timeout: 180_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'state-tournament-server-'));
  const app = await startServer({ rootDir: process.cwd(), dataDir: join(temporary, 'runs'), profiles: profiles.slice(0, 2), env: {}, port: 0 });
  try {
    const response = await post(app, '/api/tournaments', { track: 'strategy', durationSeconds: 180, factionCount: 2, models: ['baseline-normal', 'baseline-hard'],
      seeds: [2718, 2719], repetitions: 1, seatPolicy: 'balanced-rotations', budget: { maxCalls: 2000, maxCostUsd: 0 }, runBudget: { maxCalls: 500, maxCostUsd: 0 }, allowDevelopment: true });
    assert.equal(response.status, 201); const created = await response.json() as { tournament: { id: string } };
    const completed = await app.tournaments.wait(created.tournament.id); assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.totalGames, 4); assert.equal(completed.completedGames, 4); assert.equal(completed.report.completedGames, 4); assert.equal(completed.report.excludedRecords.length, 0);
    assert.equal(new Set(completed.schedule.games.map(game => game.gameId)).size, 4); assert.equal(completed.costUsd, 0);
    assert.ok(completed.games.every(game => game.status === 'completed')); assert.equal(completed.report.groups[0]?.models.length, 2);
  } finally { await app.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
});
