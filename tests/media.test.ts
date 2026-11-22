import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { buildRecordingStoryboard, buildStoryboard, selectKeyEvents, validateMediaSource, validateStoryboard, retimeStoryboard, fingerprint, videoToGameTick, gameToVideoTime, gameTickToVideoRange, buildSubtitleCues, generateSrt, formatSrtTime, validatePngFrame, listWindowsVoices, prepareNarration, resolveTools, probeMedia, runProcess, fileSha256 } from '../packages/media/src/index';
import type { BroadcastRenderApi, ExportVideoOptions, ExportVideoResult, MediaSource, PrepareNarrationOptions, Storyboard } from '../packages/media/src/index';

// Small, explicit event-record fixture. It is test data, never an acceptance battle or rendered map.
const facts: MediaSource = {
  runId: 'media-record-fixture', durationTicks: 300, ticksPerSecond: 10,
  factions: [{ id: 'A', label: '甲方', modelLabel: '记录模型甲' }, { id: 'B', label: '乙方', modelLabel: '记录模型乙' }, { id: 'C', label: '丙方', modelLabel: '记录模型丙' }],
  events: [
    { id: 'capture-10', tick: 10, type: 'capture', factionId: 'A', fromFactionId: 'B', territoryId: 'T03', territoryLabel: '桥头' },
    { id: 'capture-copy', tick: 10, type: 'capture', factionId: 'A', fromFactionId: 'B', territoryId: 'T03', territoryLabel: '桥头' },
    { id: 'capture-repeat', tick: 20, type: 'capture', factionId: 'A', territoryId: 'T03' },
    { id: 'capture-noop', tick: 30, type: 'capture', factionId: 'B', fromFactionId: 'B', territoryId: 'T04' },
    { id: 'zero-damage', tick: 40, type: 'battle', factionId: 'B', damage: 0 },
    { id: 'lead-50', tick: 50, type: 'leadchange', factionId: 'A', score: 6 },
    { id: 'lead-repeat', tick: 60, type: 'leadchange', factionId: 'A', score: 7 },
    { id: 'alliance-80', tick: 80, type: 'alliance', factionId: 'A', otherFactionId: 'C' },
    { id: 'alliance-repeat', tick: 81, type: 'alliance', factionId: 'C', otherFactionId: 'A' },
    { id: 'break-100', tick: 100, type: 'break', factionId: 'A', otherFactionId: 'C', reason: '盟期结束' },
    { id: 'elimination-200', tick: 200, type: 'elimination', factionId: 'B' },
    { id: 'elimination-repeat', tick: 210, type: 'elimination', factionId: 'B' },
    { id: 'neutral-capture', tick: 240, type: 'capture', factionId: 'C', fromFactionId: null, territoryId: 'T08', damage: 0 },
  ],
  decisions: [{ id: 'intent-A', tick: 8, factionId: 'A', intent: '先稳住桥头，再从后方增援。', eventIds: ['capture-10'] }],
  outcome: { tick: 300, reason: '时间结束', standings: [{ factionId: 'A', rank: 1, score: 10 }, { factionId: 'C', rank: 2, score: 8 }, { factionId: 'B', rank: 3, score: 0 }] },
};

test('key events preserve genuine transitions and remove repeated/zero-effect records', () => {
  assert.deepEqual(selectKeyEvents(facts).map(e => e.id), ['capture-10', 'lead-50', 'alliance-80', 'break-100', 'elimination-200', 'neutral-capture']);
  assert.deepEqual(selectKeyEvents(facts, 2).map(e => e.id), ['lead-50', 'elimination-200']);
  assert.equal(facts.events.length, 13, 'selection must not mutate persisted records');
});

test('story facts cite only recorded events, labels, outcomes and actual model statements', () => {
  const board = buildStoryboard(facts, { preRollTicks: 2, postRollTicks: 2, intentLookbackTicks: 5 });
  assert.equal(validateStoryboard(board, facts).valid, true);
  assert.equal(board.segments[0]!.kind, 'opening');
  assert.equal(board.segments.at(-1)!.kind, 'result');
  const capture = board.segments.find(s => s.eventIds.includes('capture-10'))!;
  assert.match(capture.narration, /甲方（记录模型甲）占领桥头/);
  assert.match(capture.narration, /第8刻的原始战术声明是：“先稳住桥头，再从后方增援。”/);
  assert.deepEqual(capture.decisionIds, ['intent-A']);
  assert.match(board.segments.at(-1)!.narration, /时间结束/);
  const unfinished = structuredClone(facts); delete unfinished.outcome;
  assert.match(buildStoryboard(unfinished).segments.at(-1)!.narration, /尚无已确认的终局结果/);
  assert.equal(fingerprint(facts), board.sourceFingerprint);
});

test('validation rejects fabricated references, changed source, reversed clocks and hidden speech truncation', () => {
  const board = buildStoryboard(facts);
  const invalid = (edit: (draft: Storyboard) => void) => { const draft = structuredClone(board); edit(draft); assert.equal(validateStoryboard(draft, facts).valid, false); };
  invalid(b => { b.segments[1]!.eventIds.push('not-recorded'); });
  invalid(b => { b.segments[1]!.gameEndTick = facts.durationTicks + 1; });
  invalid(b => { b.segments[1]!.videoStartSeconds += 1; });
  invalid(b => { b.segments[1]!.gameStartTick = -1; });
  invalid(b => { b.segments[1]!.playbackRate = 0; });
  invalid(b => { b.segments[1]!.decisionIds = ['not-recorded']; });
  invalid(b => { b.segments[1]!.narrationDurationSeconds = b.segments[1]!.durationSeconds + 1; });
  invalid(b => { b.segments[2]!.eventIds.push(b.segments[1]!.eventIds[0]!); });
  const changed = structuredClone(facts); changed.decisions[0]!.intent = '被修改的记录';
  assert.equal(validateStoryboard(board, changed).valid, false);
  const duplicate = structuredClone(facts); duplicate.events[1]!.id = duplicate.events[0]!.id;
  assert.equal(validateMediaSource(duplicate).valid, false);
  const unknown = structuredClone(facts); unknown.events[0]!.factionId = 'unknown';
  assert.equal(validateMediaSource(unknown).valid, false);
  assert.equal(validateStoryboard({ ...board, segments: [null, null] } as unknown as Storyboard, facts).valid, false);
});

test('compression, slow motion, skipped ticks and end holds share one invertible clock', () => {
  const board = buildStoryboard(facts, { maxEvents: 1, preRollTicks: 10, postRollTicks: 10, playbackRate: 2, minSegmentSeconds: 3, openingSeconds: 1, resultSeconds: 1 });
  const event = board.segments[1]!;
  assert.equal(event.gameStartTick, 190);
  assert.equal(event.gameEndTick, 210);
  assert.equal(event.durationSeconds, 3);
  assert.equal(event.hold?.durationSeconds, 2);
  assert.equal(videoToGameTick(board, 1.5), 200);
  assert.equal(videoToGameTick(board, 2.9), 210);
  assert.equal(gameToVideoTime(board, 200), 1.5);
  assert.deepEqual(gameTickToVideoRange(board, 210), { startSeconds: 2, endSeconds: 4 });
  assert.deepEqual(gameTickToVideoRange(board, 0), { startSeconds: 0, endSeconds: 1 });
  assert.equal(gameToVideoTime(board, 100), null);
  assert.equal(videoToGameTick(board, board.durationSeconds), 300);
  assert.throws(() => videoToGameTick(board, -1), RangeError);
  const slow = structuredClone(board);
  slow.segments[1]!.playbackRate = 0.5; slow.segments[1]!.durationSeconds = 4; delete slow.segments[1]!.hold;
  const retimed = retimeStoryboard(slow);
  assert.equal(validateStoryboard(retimed, facts).valid, true);
  assert.equal(videoToGameTick(retimed, 3), 200);
  assert.equal(gameToVideoTime(retimed, 200), 3);
});

test('recording covers every tick at 1× with short endpoint holds and no key events', () => {
  const source: MediaSource = { ...facts, durationTicks: 371, ticksPerSecond: 20, events: [], decisions: [], outcome: { ...facts.outcome!, tick: 371 } };
  const board = buildRecordingStoryboard(source);
  const resultStart = 1 + source.durationTicks / 20;
  assert.deepEqual(board.segments.map(s => s.kind), ['opening', 'replay', 'result']);
  assert.equal(validateStoryboard(board, source).valid, true);
  assert.equal(board.durationSeconds, resultStart + 3);
  assert.ok(board.segments.every(s => s.narration === '' && s.eventIds.length === 0));
  assert.deepEqual(gameTickToVideoRange(board, 0), { startSeconds: 0, endSeconds: 1 });
  assert.deepEqual(gameTickToVideoRange(board, 371), { startSeconds: resultStart, endSeconds: resultStart + 3 });
  for (let tick = 1; tick <= source.durationTicks; tick++) {
    const seconds = 1 + tick / 20;
    assert.equal(gameToVideoTime(board, tick), seconds);
    assert.ok(Math.abs(videoToGameTick(board, seconds) - tick) < 1e-6);
  }
  const skipped = structuredClone(board);
  skipped.segments[1]!.gameStartTick = 1;
  skipped.segments[1]!.durationSeconds -= 1 / 20;
  assert.equal(validateStoryboard(retimeStoryboard(skipped), source).valid, false);
  assert.throws(() => buildRecordingStoryboard({ ...source, outcome: undefined }), /recorded outcome/);
  assert.throws(() => buildRecordingStoryboard({ ...source, outcome: { ...source.outcome!, tick: 370 } }), /final tick/);
});

test('SRT uses measured segment clocks, sentence boundaries, UTF-8 and contiguous indices', () => {
  const board = buildStoryboard(facts, { maxEvents: 1 });
  board.segments[0]!.caption = '真实回放。模型自述：“稳住桥头！”\n下一句，保留中文标点。';
  board.segments[0]!.narrationDurationSeconds = 2;
  const cues = buildSubtitleCues(board, { maxCharactersPerLine: 12, maxLines: 2 });
  assert.deepEqual(cues.map(c => c.index), cues.map((_, i) => i + 1));
  assert.equal(cues[0]!.text, '真实回放。');
  assert.equal(cues.filter(c => c.segmentId === 'opening').at(-1)!.endSeconds, 2);
  assert.ok(cues.every((cue, i) => cue.endSeconds > cue.startSeconds && (i === 0 || cue.startSeconds >= cues[i - 1]!.endSeconds)));
  const srt = generateSrt(board);
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.match(srt, /真实回放。/);
  assert.equal(formatSrtTime(3599.9996), '01:00:00,000');
});

test('render validation refuses incorrect pixel dimensions rather than stretching', () => {
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.write('IHDR', 12); png.writeUInt32BE(1920, 16); png.writeUInt32BE(1080, 20);
  validatePngFrame(png);
  png.writeUInt32BE(1280, 16);
  assert.throws(() => validatePngFrame(png), /1280x1080/);
});

test('cancelled narration stops before producing files or invoking any provider', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareNarration({ source: facts, storyboard: buildStoryboard(facts), outputDir: path.resolve('outputs', 'must-not-exist'), narration: { provider: 'windows' }, signal: controller.signal }), { name: 'AbortError' });
});

// Compile the actual module with isolated I/O substitutes. No browser, encoder or provider is invoked.
async function withMediaModule<T>(entry: 'export' | 'narration', state: unknown, replacements: Record<string, string>, run: (module: Record<string, any>) => Promise<T>): Promise<T> {
  const key = `state-media-regression-${randomUUID()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = state;
  try {
    const result = await build({
      absWorkingDir: process.cwd(), entryPoints: [path.resolve('packages/media/src', `${entry}.ts`)], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', tsconfig: path.resolve('tsconfig.json'), logLevel: 'silent',
      plugins: [{ name: 'media-regression-io', setup(builder) {
        builder.onResolve({ filter: /^(playwright|node:fs\/promises|\.\/narration|\.\/tools)$/ }, args => Object.hasOwn(replacements, args.path) ? { path: args.path, namespace: 'media-regression-io' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'media-regression-io' }, args => ({ contents: `const state = globalThis[${JSON.stringify(key)}];\n${replacements[args.path]}`, loader: 'js' }));
      } }],
    });
    return await run(await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`));
  } finally { delete globals[key]; }
}

async function withMemoryExport<T>(settings: { identity?: Partial<Pick<BroadcastRenderApi, 'runId' | 'sourceFingerprint'>>; broadcastPath?: string; abortAfterRename?: number; abortOnComplete?: boolean }, run: (state: any, invoke: () => Promise<ExportVideoResult>) => Promise<T>): Promise<T> {
  const outputDir = path.resolve('outputs', `media-memory-${randomUUID()}`);
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();
  const controller = new AbortController();
  const environment = Object.freeze({ STATE_MEDIA_MEMORY_KEY: 'test-only-environment-value' });
  const source = structuredClone(facts);
  const storyboard = buildStoryboard(source, { maxEvents: 0, openingSeconds: 1 / 30, resultSeconds: 1 / 30 });
  const importedAudio = path.join(outputDir, 'user-recording.wav');
  files.set(importedAudio, Buffer.from('unchanged user-owned recording fixture'));
  files.set(path.join(outputDir, 'keep.txt'), Buffer.from('unrelated output'));
  const missing = () => Object.assign(new Error('No such fixture file'), { code: 'ENOENT' });
  const state: any = { files, directories, outputDir, importedAudio, controller, environment, renamed: [] as string[], stages: [] as string[], frames: 0, screenshots: 0, closed: 0 };
  state.fs = {
    async access(file: string) { if (!files.has(file) && !directories.has(file)) throw missing(); },
    async mkdir(directory: string, options?: { recursive?: boolean }) { if (directories.has(directory) && !options?.recursive) throw Object.assign(new Error('Already exists'), { code: 'EEXIST' }); directories.add(directory); },
    async mkdtemp(prefix: string) { const directory = prefix + 'fixture'; directories.add(directory); return directory; },
    async writeFile(file: string, data: string | Buffer, options?: { flag?: string }) { if (options?.flag === 'wx' && files.has(file)) throw Object.assign(new Error('Already exists'), { code: 'EEXIST' }); files.set(file, Buffer.from(data)); },
    async stat(file: string) { const buffer = files.get(file); if (!buffer) throw missing(); return { size: buffer.length }; },
    async rename(from: string, destination: string) {
      const buffer = files.get(from); if (!buffer) throw missing();
      files.delete(from); files.set(destination, buffer); state.renamed.push(destination);
      if (settings.abortAfterRename === state.renamed.length) controller.abort();
    },
    async rm(file: string, options?: { recursive?: boolean }) {
      files.delete(file); directories.delete(file);
      if (options?.recursive) {
        for (const candidate of files.keys()) if (candidate.startsWith(file + path.sep)) files.delete(candidate);
        for (const candidate of directories) if (candidate.startsWith(file + path.sep)) directories.delete(candidate);
      }
    },
  };
  const api: BroadcastRenderApi = { ready: false, runId: '', sourceFingerprint: '', canvasSelector: '[data-testid="broadcast-frame"]', renderFrame() { state.frames++; } };
  // Populate the page identity only when its own ready promise resolves.
  api.ready = Promise.resolve().then(() => { api.runId = settings.identity ? settings.identity.runId! : source.runId; api.sourceFingerprint = settings.identity ? settings.identity.sourceFingerprint! : fingerprint(source); });
  const fakeWindow = { __STATE_AI_RENDER__: api };
  const fakeDocument = { fonts: { ready: Promise.resolve() } };
  const evaluate = (callback: Function, payload?: unknown) => new Function('window', 'document', 'payload', `return (${callback.toString()})(payload);`)(fakeWindow, fakeDocument, payload);
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.write('IHDR', 12); png.writeUInt32BE(1920, 16); png.writeUInt32BE(1080, 20);
  const page = {
    setDefaultTimeout() {}, async route() {}, on() {},
    async goto(url: string) { state.visitedUrl = url; return { ok: () => true }; },
    async waitForFunction(callback: Function) { assert.ok(await evaluate(callback)); },
    async evaluate(callback: Function, payload?: unknown) { return evaluate(callback, payload); },
    locator() { return { count: async () => 1, boundingBox: async () => ({ width: 1920, height: 1080 }), screenshot: async () => { state.screenshots++; return png; } }; },
  };
  state.browser = { version: () => 'memory-browser', newContext: async () => ({ newPage: async () => page }), close: async () => { state.closed++; } };
  state.prepare = async (options: PrepareNarrationOptions) => {
    state.preparedEnvironment = options.environment;
    const audioPath = path.join(options.outputDir, 'narration.wav'); files.set(audioPath, Buffer.from('staged narration fixture'));
    return { storyboard: options.storyboard, audioPath, audioDurationSeconds: storyboard.durationSeconds, clips: [], provider: 'import' };
  };
  state.encode = async (_executable: string, args: string[]) => { files.set(args.at(-1)!, Buffer.from('encoded video fixture')); return { stdout: '', stderr: '' }; };
  const replacements = {
    'node:fs/promises': 'export const {access,mkdir,mkdtemp,rename,rm,stat,writeFile}=state.fs;',
    playwright: 'export const chromium={launch:async()=>state.browser, executablePath:()=>"unused-browser"};',
    './narration': 'import {createHash} from "node:crypto"; export const prepareNarration=options=>state.prepare(options); export const fileSha256=async file=>createHash("sha256").update(state.files.get(file)).digest("hex");',
    './tools': 'export const resolveTools=async()=>({ffmpegPath:"memory-ffmpeg",edgePath:"memory-browser"}); export const toolVersion=async()=>"memory-tool"; export const throwIfAborted=signal=>{if(signal?.aborted)throw new DOMException("cancelled","AbortError");}; export const runProcess=(...args)=>state.encode(...args); export const verifyVideo=async(file,duration)=>({durationSeconds:duration,width:1920,height:1080,fps:30,videoCodec:"h264",audioCodec:"aac",audioDurationSeconds:duration,hasVideo:true,hasAudio:true,fullDecode:true});',
  };
  const options: ExportVideoOptions = { source, storyboard, runId: source.runId, outputDir, baseUrl: 'http://127.0.0.1:4321', narration: { provider: 'import', audioPath: importedAudio }, environment, signal: controller.signal, ...(settings.broadcastPath ? { broadcastPath: settings.broadcastPath } : {}), onProgress(progress) { state.stages.push(progress.stage); if (settings.abortOnComplete && progress.stage === 'complete') controller.abort(); } };
  return withMediaModule('export', state, replacements, module => run(state, () => module.exportVideo(options)));
}

test('export rejects actual page run/source mismatches for default and custom broadcast paths before capturing frames', async () => {
  const sourceHash = fingerprint(facts);
  for (const settings of [
    { identity: { runId: 'other-run', sourceFingerprint: sourceHash } },
    { identity: { runId: 'other-run', sourceFingerprint: sourceHash }, broadcastPath: '/broadcast/other-run?render=1' },
    { identity: { runId: facts.runId, sourceFingerprint: '0'.repeat(64) }, broadcastPath: '/custom-render-route' },
    { identity: {}, broadcastPath: '/legacy-render-route' },
  ]) await withMemoryExport(settings, async (state, invoke) => {
    await assert.rejects(invoke(), /Broadcast record identity mismatch/);
    assert.equal(state.frames, 0); assert.equal(state.screenshots, 0); assert.deepEqual(state.renamed, []);
    assert.ok(!state.stages.includes('complete'));
    assert.equal(state.files.size, 2, 'only the pre-existing user recording and unrelated file remain');
    assert.ok([...state.directories].every((directory: string) => !directory.includes('.render-') && !directory.endsWith('.media-export.lock')));
  });
  await withMemoryExport({ broadcastPath: '/custom-render-route' }, async (state, invoke) => {
    const result = await invoke();
    assert.equal(result.manifest.runId, facts.runId);
    assert.equal(result.manifest.sourceFingerprint, sourceHash);
    assert.equal(state.frames, 2); assert.equal(state.screenshots, 2);
    assert.equal(state.preparedEnvironment, state.environment, 'export forwards the exact readonly environment to narration');
    assert.ok(!state.files.get(result.manifestPath).toString().includes(state.environment.STATE_MEDIA_MEMORY_KEY));
    assert.equal(state.files.get(state.importedAudio).toString(), 'unchanged user-owned recording fixture');
  });
});

test('cancellation during final artifact publication rolls back only this export and never returns success', async () => {
  for (const abortAfterRename of [1, 4]) await withMemoryExport({ abortAfterRename }, async (state, invoke) => {
    await assert.rejects(invoke(), { name: 'AbortError' });
    assert.equal(state.renamed.length, abortAfterRename);
    assert.ok(!state.stages.includes('complete'));
    assert.equal(state.files.size, 2);
    assert.equal(state.files.get(state.importedAudio).toString(), 'unchanged user-owned recording fixture');
    assert.equal(state.files.get(path.join(state.outputDir, 'keep.txt')).toString(), 'unrelated output');
    assert.ok([...state.directories].every((directory: string) => !directory.includes('.render-') && !directory.endsWith('.media-export.lock')));
  });
  await withMemoryExport({ abortOnComplete: true }, async (state, invoke) => {
    await assert.rejects(invoke(), { name: 'AbortError' });
    assert.equal(state.files.size, 2, 'even a cancellation raised by the final progress callback retracts owned artifacts');
  });
});

test('API narration reads a frozen environment snapshot without mutating process.env or calling a real provider', async t => {
  const root = path.resolve('outputs'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'media-env-regression-'));
  const keyName = `STATE_MEDIA_TEST_${randomUUID().replaceAll('-', '_')}`;
  const previous = process.env[keyName];
  const environment = Object.freeze({ [keyName]: 'test-only-readonly-key' });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    requests++;
    assert.equal(String(input), 'https://tts.invalid.test/audio/speech');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${environment[keyName]}`);
    assert.equal(JSON.parse(String(init?.body)).response_format, 'wav');
    return new Response('mock provider failure', { status: 418 });
  });
  const replacements = { './tools': 'export const resolveTools=async()=>({ffmpegPath:"unused-test-tool"}); export const throwIfAborted=signal=>{if(signal?.aborted)throw new DOMException("cancelled","AbortError");}; export const probeMedia=async()=>{throw new Error("unexpected decode");}; export const runProcess=async()=>{throw new Error("unexpected encoder");};' };
  try {
    await withMediaModule('narration', {}, replacements, async module => {
      const options: PrepareNarrationOptions = { source: facts, storyboard: buildStoryboard(facts, { maxEvents: 0 }), outputDir: directory, environment, narration: { provider: 'openai-compatible', endpoint: 'https://tts.invalid.test/audio/speech', model: 'test-model', voice: 'test-voice', apiKeyEnv: keyName } };
      await assert.rejects(module.prepareNarration(options), /HTTP 418/);
      assert.equal(requests, 1);
      await assert.rejects(module.prepareNarration({ ...options, environment: Object.freeze({}) }), /No request was sent/);
      assert.equal(requests, 1, 'an explicit empty snapshot does not send a request');
    });
    assert.equal(process.env[keyName], previous);
    assert.deepEqual(environment, { [keyName]: 'test-only-readonly-key' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real Windows Chinese speech is measured, extended without truncation and can be re-imported', { skip: process.env.MEDIA_TTS_SMOKE !== '1' || process.platform !== 'win32', timeout: 180_000 }, async () => {
  const voices = await listWindowsVoices();
  const voice = voices.find(v => v.enabled && v.culture === 'zh-CN');
  assert.ok(voice, 'an actual enabled Chinese voice is required');
  const tools = await resolveTools();
  const root = path.resolve('outputs'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'media-tts-smoke-'));
  const board = buildStoryboard(facts, { maxEvents: 0, openingSeconds: 0.1, resultSeconds: 0.1 });
  board.segments[0]!.narration = board.segments[0]!.caption = '中文语音验收。';
  board.segments[1]!.narration = board.segments[1]!.caption = '这是一段真实合成的系统语音。';
  const result = await prepareNarration({ source: facts, storyboard: board, outputDir: directory, narration: { provider: 'windows', voice: voice.name, rate: 2 } });
  assert.equal(validateStoryboard(result.storyboard, facts).valid, true);
  assert.ok(result.audioDurationSeconds > 0.2);
  assert.ok(result.clips.every(clip => clip.durationSeconds > 0 && clip.durationSeconds <= result.storyboard.segments.find(s => s.id === clip.segmentId)!.durationSeconds));
  const wav = await readFile(result.audioPath);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 48_000);
  assert.equal(wav.readUInt16LE(22), 2);
  const probe = await probeMedia(result.audioPath, tools);
  assert.equal(probe.audioCodec, 'pcm_s16le');
  assert.ok(Math.abs(probe.durationSeconds - result.storyboard.durationSeconds) < 0.025);
  const originalSha = await fileSha256(result.audioPath);
  const mp3 = path.join(directory, 'user-recording.mp3');
  await runProcess(tools.ffmpegPath, ['-v', 'error', '-nostdin', '-n', '-i', result.audioPath, '-c:a', 'libmp3lame', mp3]);
  const importedDirectory = path.join(directory, 'imported');
  const imported = await prepareNarration({ source: facts, storyboard: result.storyboard, outputDir: importedDirectory, narration: { provider: 'import', audioPath: mp3 } });
  assert.equal(imported.provider, 'import');
  assert.equal(await fileSha256(result.audioPath), originalSha, 'the user source track must not be changed or deleted');
  assert.ok((await stat(mp3)).size > 0);
  const noKey = path.join(directory, 'missing-key');
  await assert.rejects(prepareNarration({ source: facts, storyboard: board, outputDir: noKey, environment: Object.freeze({}), narration: { provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1/audio/speech', model: 'gpt-4o-mini-tts', voice: 'alloy', apiKeyEnv: 'STATE_MEDIA_TEST_MISSING_KEY' } }), /No request was sent/);
  await writeFile(path.join(directory, 'tts-result.json'), JSON.stringify({ voice: voice.name, durationSeconds: probe.durationSeconds, sampleRate: wav.readUInt32LE(24), channels: wav.readUInt16LE(22), clips: result.clips, sha256: originalSha }, null, 2));
  console.log(`[media-tts-smoke] ${JSON.stringify({ directory, voice: voice.name, durationSeconds: probe.durationSeconds, sampleRate: 48_000, channels: 2, clips: result.clips.map(c => c.durationSeconds), mp3ImportDuration: imported.audioDurationSeconds })}`);
});
