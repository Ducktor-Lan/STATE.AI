import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { buildRecordingStoryboard, exportVideo, fileSha256, fingerprint, prepareNarration, probeMedia, resolveTools, runProcess } from '@state/media';
import type { ExportProgress, MediaSource, NarrationOptions, Storyboard, ToolPaths, PreparedNarration } from '@state/media';
import type { RunManager } from './runs.js';
import { HttpError, confinedFile, isObject, safeId, within } from './security.js';
import { hash } from './metadata.js';
import { sanitizeError } from './environment.js';
import { atomicWriteJson } from './atomic-json.js';
import type { ExportJob, RunSummary } from './types.js';

interface ManagedJob { job: ExportJob; controller: AbortController; task?: Promise<void> }
interface AudioAsset { assetId: string; audioUrl: string }
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac', '.webm']);
const AUDIO_LIMIT = 50 * 1024 * 1024;
const PROGRESS_RANGES = { tools: [0, 0.02], narration: [0.02, 0.2], frames: [0.2, 0.8], encoding: [0.8, 0.94], verification: [0.94, 0.99], complete: [0.99, 0.99] } as const;
const INTERRUPTED_EXPORT = 'Export interrupted by service restart. Request a new export to retry.';
const RECORDING_ARTIFACTS = ['video.mp4', 'manifest.json'] as const;
function active(job: ExportJob): boolean { return job.status === 'queued' || job.status === 'running'; }
function needsRecovery(job: ExportJob): boolean { return active(job) || (job.status === 'failed' && job.stage === 'persistence'); }

export class MediaManager {
  private readonly jobs = new Map<string, ManagedJob>();
  private readonly narrationTasks = new Map<string, Promise<PreparedNarration>>();
  private readonly recordings = new Map<string, ExportJob>();
  private readonly recordingOperations = new Map<string, Promise<unknown>>();
  private recordingWorker = Promise.resolve();
  private recordingRecovery?: Promise<void>;
  private closing = false;
  private closeTask?: Promise<void>;
  constructor(readonly runs: RunManager, readonly baseUrl: () => string) {}
  private assertOpen(): void {
    if (this.closing) throw new HttpError(503, 'Server is shutting down.');
  }
  private toolOptions(): ToolPaths { return { ffmpegPath: this.runs.env.FFMPEG_PATH, ffprobePath: this.runs.env.FFPROBE_PATH, edgePath: this.runs.env.EDGE_PATH }; }
  private audioUrl(runId: string, path: string): string {
    const root = this.runs.runDirectory(runId);
    if (!within(root, path)) throw new Error('Media artifact escaped its run directory.');
    return `/api/artifacts/${encodeURIComponent(runId)}/${relative(root, path).split(/[\\/]/u).map(encodeURIComponent).join('/')}`;
  }
  private assertStable(runId: string): void {
    const status = this.runs.get(runId).status;
    if (status !== 'completed' && status !== 'paused' && status !== 'failed') throw new HttpError(409, 'Pause the run or wait for completion before preparing media.');
  }
  private systemNarration(): NarrationOptions {
    const voice = this.runs.env.TTS_VOICE || this.runs.env.STATE_TTS_VOICE;
    return { provider: 'windows', ...(voice ? { voice } : {}) };
  }
  private configuredNarration(): NarrationOptions {
    const env = this.runs.env, provider = env.TTS_PROVIDER || 'system';
    if (provider === 'system' || provider === 'windows') return this.systemNarration();
    if (provider !== 'openai-compatible') throw new HttpError(400, 'TTS_PROVIDER must be system, windows or openai-compatible.', 'TTS_CONFIGURATION');
    if (!env.TTS_ENDPOINT || !env.TTS_MODEL || !env.TTS_VOICE || !env.TTS_API_KEY_ENV) throw new HttpError(400, 'Cloud TTS requires TTS_ENDPOINT, TTS_MODEL, TTS_VOICE and TTS_API_KEY_ENV on the backend.', 'TTS_CONFIGURATION');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(env.TTS_API_KEY_ENV) || !env[env.TTS_API_KEY_ENV]?.trim()) throw new HttpError(400, 'Configured backend TTS credentials are missing; no request was sent.', 'TTS_CONFIGURATION');
    return { provider: 'openai-compatible', endpoint: env.TTS_ENDPOINT, model: env.TTS_MODEL, voice: env.TTS_VOICE, apiKeyEnv: env.TTS_API_KEY_ENV };
  }
  private async assetPath(runId: string, assetId: string): Promise<string> {
    safeId(assetId);
    const root = join(this.runs.runDirectory(runId), 'uploads', assetId);
    let value: unknown;
    try { value = JSON.parse(await readFile(join(root, 'asset.json'), 'utf8')); } catch { throw new HttpError(404, 'Imported audio asset not found.', 'NOT_FOUND'); }
    if (!isObject(value) || typeof value.name !== 'string') throw new HttpError(404, 'Invalid imported audio asset.', 'NOT_FOUND');
    return confinedFile(root, [value.name]);
  }
  private async narrationOptions(runId: string, input: unknown): Promise<NarrationOptions> {
    if (input === undefined) return this.configuredNarration();
    if (isObject(input) && input.provider === 'windows' && Object.keys(input).every(key => key === 'provider')) return this.systemNarration();
    if (isObject(input) && input.provider === 'import' && typeof input.assetId === 'string' && Object.keys(input).every(key => ['provider', 'assetId'].includes(key))) {
      return { provider: 'import', audioPath: await this.assetPath(runId, input.assetId) };
    }
    throw new HttpError(400, 'narration must be {provider:"windows"} or {provider:"import",assetId}.');
  }
  private async prepared(runId: string, narration: NarrationOptions, signal?: AbortSignal): Promise<PreparedNarration> {
    const source = this.runs.source(runId), storyboard = this.runs.storyboard(runId);
    const key = hash({ source, storyboard, narration });
    const directory = join(this.runs.runDirectory(runId), 'narration', key);
    const cached = async (): Promise<PreparedNarration | undefined> => {
      try {
        const value: unknown = JSON.parse(await readFile(join(directory, 'prepared.json'), 'utf8'));
        if (!isObject(value) || !isObject(value.storyboard) || !Array.isArray(value.clips) || typeof value.audioDurationSeconds !== 'number') return undefined;
        const audioKey = typeof value.audioKey === 'string' && /^[a-f0-9]{64}$/u.test(value.audioKey) ? value.audioKey : key;
        const audioPath = await confinedFile(join(this.runs.runDirectory(runId), 'narration'), [audioKey, 'narration.wav']);
        return { storyboard: value.storyboard as unknown as Storyboard, audioPath, audioDurationSeconds: value.audioDurationSeconds,
          clips: value.clips as PreparedNarration['clips'], provider: narration.provider };
      } catch { return undefined; }
    };
    const existing = await cached(); if (existing) return existing;
    const pending = this.narrationTasks.get(key); if (pending) return pending;
    const task = (async () => {
      // A cache without complete metadata is an interrupted, server-owned attempt.
      await rm(directory, { recursive: true, force: true });
      const result = await prepareNarration({ ...this.toolOptions(), source, storyboard, outputDir: directory, narration, signal, environment: this.runs.env });
      await mkdir(directory, { recursive: true });
      const metadata = JSON.stringify({ ...result, audioPath: basename(result.audioPath), audioKey: key });
      await writeFile(join(directory, 'prepared.json'), metadata, 'utf8');
      // Speech may lengthen segment holds. Reuse this measured audio for the saved, retimed board too.
      const measuredKey = hash({ source, storyboard: result.storyboard, narration });
      if (measuredKey !== key) {
        const alias = join(this.runs.runDirectory(runId), 'narration', measuredKey);
        await mkdir(alias, { recursive: true }); await writeFile(join(alias, 'prepared.json'), metadata, 'utf8');
      }
      return result;
    })();
    this.narrationTasks.set(key, task);
    try { return await task; } finally { this.narrationTasks.delete(key); }
  }
  async narration(runId: string, input: unknown) {
    this.assertStable(runId);
    if (!isObject(input) || Object.keys(input).some(key => key !== 'narration')) throw new HttpError(400, 'Narration request accepts only narration options.');
    const options = await this.narrationOptions(runId, input.narration);
    const prepared = await this.prepared(runId, options);
    await this.runs.saveStoryboard(runId, prepared.storyboard);
    return { audioUrl: this.audioUrl(runId, prepared.audioPath), storyboard: prepared.storyboard };
  }
  private async verifyAudio(runId: string, assetId: string, file: string): Promise<AudioAsset> {
    try {
      const info = await stat(file);
      if (info.size < 1 || info.size > AUDIO_LIMIT) throw new HttpError(400, 'Imported audio must be nonempty and at most 50 MiB.', 'INVALID_AUDIO');
      const tools = await resolveTools(this.toolOptions());
      const probe = await probeMedia(file, tools);
      if (!probe.hasAudio || probe.hasVideo || probe.durationSeconds > 3600) throw new HttpError(400, 'Import requires an audio-only track with duration at most one hour.', 'INVALID_AUDIO');
      await runProcess(tools.ffmpegPath, ['-v', 'error', '-xerror', '-nostdin', '-i', file, '-map', '0:a:0', '-vn', '-f', 'null', '-'], { timeoutMs: 120_000 });
      let audio = file;
      if (!['.wav', '.mp3'].includes(extname(file).toLowerCase())) {
        audio = join(this.runs.runDirectory(runId), 'uploads', assetId, 'normalized.wav');
        await runProcess(tools.ffmpegPath, ['-v', 'error', '-xerror', '-nostdin', '-n', '-i', file, '-map', '0:a:0', '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', audio], { timeoutMs: 120_000 });
      }
      await writeFile(join(this.runs.runDirectory(runId), 'uploads', assetId, 'asset.json'), JSON.stringify({ assetId, name: basename(audio), durationSeconds: probe.durationSeconds }), 'utf8');
      return { assetId, audioUrl: this.audioUrl(runId, audio) };
    } catch (error) {
      await rm(join(this.runs.runDirectory(runId), 'uploads', assetId), { recursive: true, force: true });
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, `Audio validation failed: ${sanitizeError(error, this.runs.env)}`, 'INVALID_AUDIO');
    }
  }
  async upload(runId: string, request: IncomingMessage): Promise<AudioAsset> {
    this.runs.get(runId);
    const header = request.headers['x-audio-filename'];
    const extension = typeof header === 'string' ? extname(header).toLowerCase() : '';
    if (!AUDIO_EXTENSIONS.has(extension)) throw new HttpError(400, 'X-Audio-Filename must have a supported audio extension.');
    const declared = request.headers['content-length'];
    if (declared && (!/^\d+$/u.test(declared) || Number(declared) > AUDIO_LIMIT)) { request.resume(); throw new HttpError(413, 'Audio upload exceeds 50 MiB.'); }
    const assetId = randomUUID(), directory = join(this.runs.runDirectory(runId), 'uploads', assetId);
    await mkdir(directory, { recursive: true });
    const file = join(directory, `audio${extension}`), handle = await open(file, 'wx');
    let bytes = 0;
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); bytes += buffer.length;
        if (bytes > AUDIO_LIMIT) throw new HttpError(413, 'Audio upload exceeds 50 MiB.');
        await handle.write(buffer);
      }
      if (!bytes) throw new HttpError(400, 'Audio upload is empty.');
    } catch (error) { await handle.close(); await rm(directory, { recursive: true, force: true }); throw error; }
    await handle.close(); return this.verifyAudio(runId, assetId, file);
  }
  async importAudio(runId: string, sourcePath: string): Promise<AudioAsset> {
    this.runs.get(runId);
    const extension = extname(sourcePath).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(extension)) throw new HttpError(400, 'Unsupported audio extension.');
    const assetId = randomUUID(), directory = join(this.runs.runDirectory(runId), 'uploads', assetId);
    await mkdir(directory, { recursive: true }); const file = join(directory, `audio${extension}`);
    await copyFile(sourcePath, file); return this.verifyAudio(runId, assetId, file);
  }
  async export(runId: string, input: unknown): Promise<{ jobId: string }> {
    this.assertOpen();
    this.assertStable(runId);
    if (!isObject(input) || Object.keys(input).some(key => !['format', 'width', 'height', 'fps', 'narration'].includes(key))
      || (input.format !== undefined && input.format !== 'mp4') || (input.width !== undefined && input.width !== 1920)
      || (input.height !== undefined && input.height !== 1080) || (input.fps !== undefined && input.fps !== 30)) throw new HttpError(400, 'Export supports mp4, 1920x1080, 30 fps only.');
    const narration = await this.narrationOptions(runId, input.narration);
    this.assertOpen();
    const managed = this.newJob(runId);
    const saved = this.persist(managed.job);
    managed.task = saved.then(() => this.runExport(managed, narration), error => this.persistenceFailure(managed.job, error));
    await saved;
    return { jobId: managed.job.id };
  }
  async recording(runId: string): Promise<ExportJob | null> {
    this.runs.get(runId);
    this.assertOpen();
    return this.withRecording(runId, async () => structuredClone(await this.readRecording(runId)));
  }
  async requestRecording(runId: string, input: unknown): Promise<ExportJob> {
    if (!isObject(input) || Object.keys(input).length) throw new HttpError(400, 'Recording requires an empty JSON object.');
    if (this.runs.get(runId).status !== 'completed' || !this.runs.result(runId)) {
      throw new HttpError(409, 'Recording is available after the run completes.', 'RUN_NOT_COMPLETED');
    }
    this.assertOpen();
    return this.withRecording(runId, () => this.createRecording(runId, true));
  }
  queueCompletedRecording(run: RunSummary): Promise<void> | undefined {
    if (this.closing || run.status !== 'completed' || run.recordVideo !== true) return;
    return this.withRecording(run.id, async () => {
      if (!this.closing && this.runs.result(run.id)) await this.createRecording(run.id, false);
    }).catch(error => this.reportStorageError(run.id, error));
  }
  recoverRecordings(): void {
    if (this.closing || this.recordingRecovery) return;
    this.recordingRecovery = Promise.resolve().then(async () => {
      if (this.closing) return;
      for (const run of this.runs.list()) {
        if (this.closing) break;
        await this.queueCompletedRecording(run);
      }
    }).catch(error => {
      this.runs.recoveryErrors.push(`Recordings: ${sanitizeError(error, this.runs.env)}`);
    });
  }
  private withRecording<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.recordingOperations.get(runId) ?? Promise.resolve();
    const pending = previous.then(operation, operation);
    this.recordingOperations.set(runId, pending);
    const release = () => { if (this.recordingOperations.get(runId) === pending) this.recordingOperations.delete(runId); };
    void pending.then(release, release);
    return pending;
  }
  private recordingPath(runId: string): string {
    return join(this.runs.runDirectory(runId), 'jobs', 'recording.json');
  }
  private async readRecording(runId: string, expectedId?: string): Promise<ExportJob | null> {
    const cached = this.recordings.get(runId);
    if (cached) return !expectedId || cached.id === expectedId ? cached : null;
    const pointer = await this.readJsonFile(this.recordingPath(runId));
    if (pointer === undefined) return null;
    if (!isObject(pointer) || typeof pointer.jobId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(pointer.jobId)) throw new Error('Invalid recording job pointer.');
    const id = pointer.jobId;
    if (expectedId && id !== expectedId) return null;
    const managed = this.jobs.get(id);
    const job = managed?.job ?? await this.readJob(runId, id);
    if (!job || job.runId !== runId) throw new Error('The recording job file is missing or invalid.');
    if (!managed && needsRecovery(job)) await this.recoverJob(job, true);
    this.recordings.set(runId, job);
    return job;
  }
  private async createRecording(runId: string, retry: boolean): Promise<ExportJob> {
    this.assertOpen();
    const existing = await this.readRecording(runId);
    if (existing && (!retry || active(existing) || existing.status === 'completed')) return structuredClone(existing);
    this.assertOpen();
    const managed = this.newJob(runId);
    const { job } = managed;
    this.recordings.set(runId, job);
    try {
      await this.persist(job);
      await atomicWriteJson(this.recordingPath(runId), JSON.stringify({ jobId: job.id }));
    } catch (error) {
      await this.persistenceFailure(job, error);
      return structuredClone(job);
    }
    // Serialize whole-match renders to keep simultaneous requests from multiplying render processes and disk usage.
    managed.task = this.recordingWorker.then(() => this.runExport(managed)).catch(error => this.persistenceFailure(job, error));
    this.recordingWorker = managed.task;
    return structuredClone(job);
  }
  private newJob(runId: string): ManagedJob {
    const job: ExportJob = { id: randomUUID(), runId, status: 'queued', progress: 0, stage: 'queued' };
    const managed: ManagedJob = { job, controller: new AbortController() };
    this.jobs.set(job.id, managed);
    return managed;
  }
  private updateProgress(job: ExportJob, progress: ExportProgress): void {
    const [start, end] = PROGRESS_RANGES[progress.stage];
    job.progress = Math.max(job.progress, start + (end - start) * Math.max(0, Math.min(1, progress.progress)));
    job.stage = progress.stage;
  }
  private async runExport(managed: ManagedJob, narration?: NarrationOptions): Promise<void> {
    const { job, controller } = managed, { signal } = controller;
    const outputRoot = this.runs.runDirectory(job.runId);
    const outputDir = join(outputRoot, 'exports', job.id);
    let outcome: ExportJob;
    try {
      signal.throwIfAborted();
      job.status = 'running'; job.stage = narration ? 'narration' : 'tools';
      try { await this.persist(job); } catch (error) { await this.persistenceFailure(job, error); return; }
      signal.throwIfAborted();
      let source: MediaSource, storyboard: Storyboard, exportNarration: NarrationOptions;
      if (narration) {
        const prepared = await this.prepared(job.runId, narration, signal);
        signal.throwIfAborted();
        await this.runs.saveStoryboard(job.runId, prepared.storyboard);
        source = this.runs.source(job.runId);
        storyboard = prepared.storyboard;
        exportNarration = { provider: 'import', audioPath: prepared.audioPath };
      } else {
        source = this.runs.source(job.runId);
        storyboard = buildRecordingStoryboard(source);
        exportNarration = { provider: 'none' };
      }
      const result = await exportVideo({ ...this.toolOptions(), baseUrl: this.baseUrl(), runId: job.runId, source, storyboard, outputDir,
        ...(!narration ? { outputRoot } : {}), narration: exportNarration,
        width: 1920, height: 1080, fps: 30, signal, environment: this.runs.env,
        onProgress: progress => { if (!signal.aborted) this.updateProgress(job, progress); } });
      const names = narration ? [result.videoPath, result.subtitlesPath, result.narrationPath, result.manifestPath].map(path => basename(path)) : RECORDING_ARTIFACTS;
      const files = await Promise.all(names.map(name => this.exportArtifact(job, name)));
      const artifacts = files.map(file => file.download);
      signal.throwIfAborted();
      outcome = { ...job, status: 'completed', progress: 1, stage: 'complete', artifacts };
    } catch (error) {
      const status = signal.aborted ? 'cancelled' : 'failed';
      const message = signal.aborted && this.closing ? 'Export cancelled during service shutdown. Request a new export to retry.' : sanitizeError(error, this.runs.env);
      outcome = { ...job, status, stage: status === 'cancelled' ? 'cancelled' : job.stage, error: message };
    }
    job.stage = 'publishing';
    try { await this.persist(outcome); }
    catch (error) { await this.persistenceFailure(job, error, outcome.error); return; }
    Object.assign(job, outcome);
  }
  private async exportArtifact(job: ExportJob, name: string) {
    const root = this.runs.runDirectory(job.runId), pieces = ['exports', job.id, name];
    const path = await confinedFile(root, pieces);
    return { path, download: { name, url: this.audioUrl(job.runId, join(root, ...pieces)) } };
  }
  private async recoverRecordingArtifacts(job: ExportJob): Promise<NonNullable<ExportJob['artifacts']>> {
    // The exporter publishes the manifest last, after verifying and publishing the MP4.
    const [video, manifestFile] = await Promise.all([
      this.exportArtifact(job, RECORDING_ARTIFACTS[0]),
      this.exportArtifact(job, RECORDING_ARTIFACTS[1]),
    ]);
    const manifest = await this.readJsonFile(manifestFile.path);
    if (!isObject(manifest) || manifest.version !== 1 || manifest.runId !== job.runId
      || !isObject(manifest.narration) || manifest.narration.provider !== 'none'
      || !isObject(manifest.verification) || manifest.verification.fullDecode !== true || !isObject(manifest.artifacts)) {
      throw new Error('Recording manifest is invalid.');
    }
    const source = this.runs.source(job.runId);
    if (manifest.sourceFingerprint !== fingerprint(source) || manifest.storyboardFingerprint !== fingerprint(buildRecordingStoryboard(source))) {
      throw new Error('Recording manifest does not match the recorded match.');
    }
    const expected = manifest.artifacts['video.mp4'];
    if (!isObject(expected) || typeof expected.bytes !== 'number' || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0
      || typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expected.sha256)
      || (await stat(video.path)).size !== expected.bytes || await fileSha256(video.path) !== expected.sha256) {
      throw new Error('MP4 does not match the recording manifest.');
    }
    return [video.download, manifestFile.download];
  }
  private async recoverJob(job: ExportJob, recording: boolean): Promise<ExportJob> {
    let error = INTERRUPTED_EXPORT;
    if (recording) {
      try {
        const artifacts = await this.recoverRecordingArtifacts(job);
        Object.assign(job, { status: 'completed', stage: 'complete', progress: 1, artifacts });
        delete job.error;
      } catch (cause) {
        error = `${error} ${sanitizeError(cause, this.runs.env)}`;
      }
    }
    if (active(job)) {
      job.status = 'failed'; job.stage = 'interrupted'; job.error = error;
      delete job.artifacts;
    }
    await this.persist(job).catch(cause => this.reportStorageError(job.runId, cause));
    return job;
  }
  private persist(job: ExportJob): Promise<void> {
    return atomicWriteJson(join(this.runs.runDirectory(job.runId), 'jobs', `${job.id}.json`), JSON.stringify(job));
  }
  private async persistenceFailure(job: ExportJob, error: unknown, exportError?: string): Promise<void> {
    job.status = 'failed'; job.stage = 'persistence';
    job.error = `Cannot save export job status: ${sanitizeError(error, this.runs.env)}${exportError ? ` (${exportError})` : ''}`;
    await this.persist(job).catch(failure => this.reportStorageError(job.runId, failure));
  }
  private reportStorageError(runId: string, error: unknown): void {
    this.runs.recoveryErrors.push(`${runId} media: ${sanitizeError(error, this.runs.env)}`);
  }
  private async readJsonFile(path: string): Promise<unknown> {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private async readJob(runId: string, id: string): Promise<ExportJob | undefined> {
    const value = await this.readJsonFile(join(this.runs.runDirectory(runId), 'jobs', `${id}.json`));
    if (!isObject(value) || value.id !== id || value.runId !== runId || typeof value.progress !== 'number'
      || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(value.status))) return;
    return value as unknown as ExportJob;
  }
  async get(id: string): Promise<ExportJob> {
    safeId(id); const managed = this.jobs.get(id); if (managed) return structuredClone(managed.job);
    for (const run of this.runs.list()) {
      const job = await this.readJob(run.id, id);
      if (!job) continue;
      if (!needsRecovery(job)) return job;
      this.assertOpen();
      return this.withRecording(run.id, async () => {
        const recording = await this.readRecording(run.id, id).catch(error => {
          this.reportStorageError(run.id, error);
          return null;
        });
        if (recording?.id === id) return structuredClone(recording);
        return active(job) ? this.recoverJob(job, false) : job;
      });
    }
    throw new HttpError(404, 'Export job not found.', 'NOT_FOUND');
  }
  private abort(managed: ManagedJob): void {
    if (active(managed.job) && managed.job.stage !== 'publishing') {
      managed.controller.abort();
      managed.job.stage = 'cancelling';
    }
  }
  async cancel(id: string): Promise<ExportJob> {
    const managed = this.jobs.get(safeId(id));
    if (!managed) return this.get(id);
    this.abort(managed);
    return structuredClone(managed.job);
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    for (const managed of this.jobs.values()) this.abort(managed);
    return this.closeTask = (async () => {
      await Promise.allSettled([...this.recordingOperations.values(), this.recordingRecovery]);
      await Promise.allSettled([...this.jobs.values()].map(managed => managed.task));
    })();
  }
}
