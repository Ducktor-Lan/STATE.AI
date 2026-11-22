import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { artifactUrl } from '../apps/web/src/api';
import type { CreateRunInput, MatchSnapshot, ModelSummary, ReplayFrames, RunEvent, RunSummary } from '../apps/web/src/api';
import { ReplayPlayback, replayEventsBetween } from '../apps/web/src/replay';
import { addStoryEvent, defaultModels, formatUsd, parseSeeds, recordedTick, roundAt, validateRun, visibleEvents } from '../apps/web/src/model';
import { escapeHtml } from '../apps/web/src/dom';
import { buildStoryboard, validateStoryboard } from '../packages/media/src/storyboard';
import type { MediaSource } from '../packages/media/src/types';

// Test fixtures exercise UI boundaries only; they are never application data.
const models: ModelSummary[] = [
  { id: 'baseline-normal', label: 'Normal fixture', provider: 'builtin', kind: 'baseline', available: true },
  { id: 'baseline-hard', label: 'Hard fixture', provider: 'builtin', kind: 'baseline', available: true },
  { id: 'unavailable-fixture', label: 'Unavailable fixture', provider: 'test', kind: 'remote', available: false },
];
const config: CreateRunInput = { track: 'strategy', seed: 17, durationSeconds: 180, factionCount: 2, models: ['baseline-normal', 'baseline-hard'], disaster: false, budget: { maxCalls: 200, maxCostUsd: 0 } };

test('creation uses available baselines and rejects unavailable or illegal seats and budgets', () => {
  assert.deepEqual(defaultModels(models, 4), Array(4).fill('baseline-normal'));
  assert.deepEqual(defaultModels([], 2), ['', '']);
  assert.deepEqual(validateRun(config, models), []);
  assert.ok(validateRun({ ...config, track: 'diplomacy' }, models).some(error => error.includes('至少三方')));
  assert.ok(validateRun({ ...config, models: ['baseline-normal', 'unavailable-fixture'] }, models).some(error => error.includes('不可用')));
  assert.ok(validateRun({ ...config, budget: { maxCalls: 1.5, maxCostUsd: -1 } }, models).length >= 2);
  assert.ok(validateRun({ ...config, seed: 0 }, models).length > 0);
});

test('replay requests the exact event tick within the recorded run and selects its preceding decision round', () => {
  const rounds = [{ round: 1, tick: 20 }, { round: 2, tick: 40 }];
  assert.equal(recordedTick(39.5, 50), 39);
  assert.equal(recordedTick(-4, 50), 0);
  assert.equal(recordedTick(100, 50), 50);
  assert.equal(roundAt(39, rounds)?.round, 1);
  assert.equal(roundAt(0, rounds), undefined);
});

function replayHarness(t: TestContext, maximum: number) {
  const raf = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame;
  const queued = new Map<number, FrameRequestCallback>();
  let lastId = 0, now = 0;
  globalThis.requestAnimationFrame = callback => { queued.set(++lastId, callback); return lastId; };
  globalThis.cancelAnimationFrame = id => { queued.delete(id); };
  t.mock.method(performance, 'now', () => now);
  t.after(() => { globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = cancel; });
  const frames: Array<{ tick: number; seek: boolean }> = [];
  const statuses: RunSummary['status'][] = [];
  const errors: unknown[] = [];
  const windows: Array<{ from: number; limit: number; signal: AbortSignal; resolve: (status?: RunSummary['status']) => Promise<void>; reject: () => Promise<void> }> = [];
  let position = 0;
  const replay = new ReplayPlayback(maximum, {
    load: (from, limit, signal) => new Promise<ReplayFrames>((resolve, reject) => {
      windows.push({ from, limit, signal, resolve: async (status = 'failed') => {
        const run: RunSummary = { ...config, id: 'recording', status, createdAt: '', tick: maximum, wallElapsedMs: 0, calls: 0, costUsd: 0 };
        const batch = Array.from({ length: limit }, (_, index) => ({ snapshot: { tick: from + index } as MatchSnapshot, outcome: null }));
        resolve({ run, frames: batch, decisionsByRound: [] });
      }, reject: async () => { reject(new Error('fixture connection reset')); } });
    }),
    frame: (frame, seek) => { frames.push({ tick: frame.snapshot.tick, seek }); statuses.push(frame.run.status); },
    clock: tick => { position = tick; },
    status: () => {},
    error: error => { errors.push(error); },
  });
  return { replay, windows, frames, statuses, errors, get position() { return position; }, advance(nextTime: number) {
    now = nextTime;
    const callbacks = [...queued.values()];
    queued.clear();
    callbacks.forEach(callback => callback(now));
  } };
}

test('replay advances at 10 ticks/second, keeps fractional time and pauses at the exact last frame', async t => {
  const clock = replayHarness(t, 45);
  const { replay, windows, frames, statuses, advance } = clock;
  replay.seek(0);
  await windows[0]!.resolve('waiting');
  replay.play();
  assert.equal(replay.buffering, true);
  assert.deepEqual(windows.map(({ from, limit }) => [from, limit]), [[0, 1], [1, 40]]);
  advance(5000);
  await windows[1]!.resolve('waiting');
  assert.equal(replay.buffering, false);
  advance(5100);
  advance(5250);
  assert.equal(replay.tick, 1);
  assert.equal(clock.position, 1.5);
  replay.setSpeed(8);
  advance(5350);
  assert.equal(replay.tick, 9);
  assert.equal(clock.position, 9.5);
  assert.deepEqual(windows.map(({ from, limit }) => [from, limit]), [[0, 1], [1, 40], [41, 5]]);
  advance(6000);
  assert.equal(replay.tick, 40);
  assert.equal(replay.buffering, true);
  await windows[2]!.resolve('completed');
  advance(6500);
  advance(6600);
  assert.deepEqual(frames, [{ tick: 0, seek: true }, { tick: 1, seek: false }, { tick: 9, seek: false }, { tick: 40, seek: false }, { tick: 45, seek: false }]);
  assert.equal(replay.playing, false);
  assert.equal(replay.buffering, false);
  replay.seek(39);
  assert.equal(windows.length, 3);
  assert.deepEqual(frames.at(-1), { tick: 39, seek: true });
  assert.equal(statuses.at(-1), 'completed');
});

test('only the latest seek applies and playback can continue after a failed seek', async t => {
  const { replay, windows, frames, errors, advance } = replayHarness(t, 100);
  replay.seek(11);
  replay.seek(30);
  assert.equal(windows[0]!.signal.aborted, true);
  await windows[0]!.resolve();
  assert.deepEqual(frames, []);
  await windows[1]!.resolve();
  replay.seek(1);
  await windows[2]!.reject();
  assert.equal(errors.length, 1);
  assert.equal(replay.seekTick, 1);
  assert.deepEqual(frames, [{ tick: 30, seek: true }]);
  replay.play();
  assert.equal(replay.seekTick, null);
  assert.equal(windows[3]!.from, 31);
  await windows[3]!.resolve();
  advance(100);
  advance(200);
  assert.equal(replay.tick, 31);
  replay.seek(100);
  await windows[4]!.resolve();
  replay.play();
  assert.equal(windows[5]!.from, 0);
  replay.pause();
  assert.equal(windows[5]!.signal.aborted, true);
  await windows[5]!.resolve();
  assert.equal(replay.tick, 100);
  replay.seek(0);
  replay.destroy();
  assert.equal(windows[6]!.signal.aborted, true);
  await windows[6]!.resolve();
  assert.equal(replay.tick, 100);
});

test('replay forwards each recorded event between displayed ticks in original order', () => {
  const events = [1, 2, 2, 4, 5].map((tick, index) => ({ id: String(index), tick, type: 'capture', title: '' }));
  assert.deepEqual(replayEventsBetween(events, 1, 4), events.slice(1, 4));
  assert.deepEqual(replayEventsBetween(events, 4, 4), []);
});

test('private messages are hidden unless spectator access explicitly grants them', () => {
  const events: RunEvent[] = [
    { id: 'public', tick: 20, type: 'message', title: 'public', visibility: 'public' },
    { id: 'private', tick: 20, type: 'message', title: 'private', visibility: 'private' },
  ];
  assert.deepEqual(visibleEvents(events).map(event => event.id), ['public']);
  assert.deepEqual(visibleEvents(events, { privateMessages: false, note: '' }).map(event => event.id), ['public']);
  assert.deepEqual(visibleEvents(events, { privateMessages: true, note: '' }).map(event => event.id), ['public', 'private']);
});

test('unknown prices remain unknown and artifact addresses stay on the local artifact API', () => {
  assert.equal(formatUsd(null), '未计价');
  assert.equal(formatUsd(0), '$0.000');
  assert.equal(artifactUrl('/api/artifacts/run/audio.wav', 'http://localhost:4180'), '/api/artifacts/run/audio.wav');
  assert.equal(artifactUrl('https://outside.invalid/api/artifacts/run/audio.wav', 'http://localhost:4180'), null);
  assert.equal(artifactUrl('javascript:alert(1)', 'http://localhost:4180'), null);
  assert.equal(artifactUrl('/api/runs/private', 'http://localhost:4180'), null);
  assert.equal(escapeHtml('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
});

test('event editing preserves the actual media validator boundaries and avoids duplicate references', () => {
  const source: MediaSource = {
    runId: 'test-fixture', durationTicks: 300, ticksPerSecond: 10,
    factions: [{ id: 'player', label: 'A', modelLabel: 'fixture A' }, { id: 'ai1', label: 'B', modelLabel: 'fixture B' }],
    events: [
      { id: 'early', tick: 40, type: 'capture', factionId: 'player', territoryId: 'one' },
      { id: 'middle', tick: 140, type: 'capture', factionId: 'ai1', territoryId: 'two' },
      { id: 'late', tick: 250, type: 'capture', factionId: 'player', territoryId: 'three' },
    ], decisions: [],
  };
  const initial = buildStoryboard(source, { maxEvents: 1, preRollTicks: 10, postRollTicks: 10 });
  assert.equal(validateStoryboard(initial, source).valid, true);
  let board = initial;
  for (const sourceEvent of [...source.events].reverse()) {
    const event: RunEvent = { id: sourceEvent.id, tick: sourceEvent.tick, type: sourceEvent.type, title: sourceEvent.id };
    const added = addStoryEvent(board, event, `added-${sourceEvent.id}`);
    board = added.board;
    assert.equal(validateStoryboard(board, source).valid, true, JSON.stringify(validateStoryboard(board, source).issues));
    const repeated = addStoryEvent(board, event, 'must-not-duplicate');
    assert.equal(repeated.board, board);
  }
  assert.equal(board.segments[0]?.kind, 'opening');
  assert.equal(board.segments.at(-1)?.kind, 'result');
  assert.equal(board.segments.flatMap(segment => segment.eventIds).length, 3);
  assert.throws(() => addStoryEvent(board, { id: 'private', tick: 50, type: 'message', title: '', visibility: 'private' }, 'invalid'));
});

test('seed lists reject ambiguous values and keep a unique finite integer schedule', () => {
  assert.deepEqual(parseSeeds('17, 29，17\n43'), [17, 29, 43]);
  for (const input of ['', 'NaN', '0', '1.5', '4294967296']) assert.throws(() => parseSeeds(input));
});
