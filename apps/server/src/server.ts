import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { RunManager, StartBudgetTooLowError } from './runs.js';
import type { RunManagerOptions } from './runs.js';
import { MediaManager } from './media.js';
import { TournamentManager } from './tournaments.js';
import { assertLocalRequest, confinedFile, HttpError, json, readJson, safeId } from './security.js';
import { sanitizeError } from './environment.js';

export const DEFAULT_PORT = 4180;
export interface ServerOptions extends RunManagerOptions { port?: number; webDir?: string; autoRecordings?: boolean }
export interface StateServer {
  server: Server;
  runs: RunManager;
  media: MediaManager;
  tournaments: TournamentManager;
  readonly url: string;
  listen(port?: number): Promise<void>;
  close(): Promise<void>;
}
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.srt': 'application/x-subrip; charset=utf-8', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
async function streamFile(request: IncomingMessage, response: ServerResponse, file: string, disposition?: 'attachment' | 'inline'): Promise<void> {
  const info = await stat(file), type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  let start = 0, end = info.size - 1, status = 200;
  const headers: Record<string, string | number> = { 'Content-Type': type, 'Cache-Control': disposition === 'inline' ? 'private, max-age=3600, immutable' : 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Cross-Origin-Resource-Policy': 'same-origin' };
  if (disposition) headers['Content-Disposition'] = `${disposition}; filename="${file.split(/[\\/]/u).at(-1)?.replace(/[^A-Za-z0-9._-]/gu, '_')}"`;
  if (request.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range);
    if (!range || (!range[1] && !range[2])) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
    if (!range[1]) { const suffix = Number(range[2]); start = Math.max(0, info.size - suffix); }
    else { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1); response.writeHead(status, headers);
  if (request.method === 'HEAD' || !info.size) { response.end(); return; }
  await pipeline(createReadStream(file, { start, end }), response);
}
function integer(raw: string | null, field: string): number | undefined {
  if (raw === null) return undefined;
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw new HttpError(400, `${field} must be a nonnegative integer.`);
  return Number(raw);
}
const gzipReplay = promisify(gzip);
function replayUsesGzip(acceptEncoding: string | undefined): boolean {
  const quality = new Map<string, number>();
  for (const item of acceptEncoding?.split(',') ?? []) {
    const match = /^([\w*-]+)(?:\s*;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/u.exec(item.trim().toLowerCase());
    if (match) quality.set(match[1]!, Number(match[2] ?? 1));
  }
  const wildcard = quality.get('*');
  const compressed = quality.get('gzip') ?? wildcard ?? 0;
  const identity = quality.get('identity') ?? (wildcard === 0 ? 0 : undefined);
  if (compressed === 0 && identity === 0) throw new HttpError(406, 'Replay supports gzip and identity content encodings.', 'NOT_ACCEPTABLE');
  return compressed > 0 && compressed >= (identity ?? 0);
}
export async function createServer(options: ServerOptions = {}): Promise<StateServer> {
  let listening = false, media: MediaManager;
  const runs = await RunManager.open({ ...options, onCompleted(run) {
    if (listening && options.autoRecordings !== false) void media.queueCompletedRecording(run);
    if (options.onCompleted) void Promise.resolve().then(() => options.onCompleted?.(run)).catch(error => {
      runs.recoveryErrors.push(`${run.id} completion callback: ${sanitizeError(error, runs.env)}`);
    });
  } });
  const configuredPort = runs.env.STATE_AI_PORT ?? String(DEFAULT_PORT);
  if (options.port === undefined && !/^\d+$/u.test(configuredPort)) throw new Error('STATE_AI_PORT must be an integer.');
  let port = options.port ?? Number(configuredPort);
  const url = () => `http://127.0.0.1:${port}`;
  media = new MediaManager(runs, url);
  const tournaments = await TournamentManager.open(runs);
  const webRoot = resolve(options.webDir ?? join(runs.rootDir, 'dist', 'web'));
  let listenTask: Promise<void> | undefined, closing: Promise<void> | undefined;
  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    assertLocalRequest(request, port);
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    const rawPath = (request.url ?? '/').split('?')[0]!;
    let decoded: string;
    try { decoded = decodeURIComponent(rawPath); } catch { throw new HttpError(400, 'Malformed URL encoding.'); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(piece => piece === '..' || piece === '.')) throw new HttpError(400, 'URL path traversal is forbidden.', 'INVALID_PATH');
    const target = new URL(request.url ?? '/', url());
    const parts = decoded.split('/').filter(Boolean), method = request.method ?? 'GET';
    if (parts[0] === 'api') {
      if (parts[1] === 'health' && parts.length === 2 && method === 'GET') {
        json(response, 200, { ok: true, service: 'STATE.AI', version: 1, listener: '127.0.0.1', port, recoveryErrors: runs.recoveryErrors, budgetUnits: { maxCalls: 'actor decision invocations; provider HTTP retries are separate', costUsd: 'configured flat-rate token estimate; incomplete usage is unknown' } }); return;
      }
      if (parts[1] === 'models' && parts.length === 2) {
        if (method === 'GET') { json(response, 200, { models: runs.models() }); return; }
        if (method === 'POST') { json(response, 201, { model: await runs.registerOpenAiModel(await readJson(request)) }); return; }
      }
      if (parts[1] === 'runs') {
        if (parts.length === 2) {
          if (method === 'GET') { json(response, 200, { runs: runs.list() }); return; }
          if (method === 'POST') { json(response, 201, { run: await runs.create(await readJson(request)) }); return; }
        }
        const id = parts[2];
        if (id === 'start-budget' && parts.length === 3 && method === 'POST') {
          json(response, 200, { startBudget: runs.quoteStartBudget(await readJson(request)) }); return;
        }
        if (id) {
          safeId(id);
          if (parts.length === 3 && method === 'GET') { json(response, 200, runs.detail(id)); return; }
          if (parts.length === 4) {
            const action = parts[3];
            if (action === 'state' && method === 'GET') { json(response, 200, await runs.state(id, integer(target.searchParams.get('tick'), 'tick'))); return; }
            if (action === 'replay-frames' && method === 'GET') {
              const from = integer(target.searchParams.get('from'), 'from');
              const limit = integer(target.searchParams.get('limit'), 'limit');
              response.setHeader('Vary', 'Accept-Encoding');
              const compressed = replayUsesGzip(request.headers['accept-encoding']);
              const replay = runs.replayFrames(id, from, limit);
              if (!compressed) { json(response, 200, replay); return; }
              const body = await gzipReplay(JSON.stringify(replay), { level: 1 });
              if (response.destroyed) return;
              response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': body.length,
                'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
              response.end(body); return;
            }
            if (action === 'pause' && method === 'POST') { await readJson(request); json(response, 200, { run: await runs.pause(id) }); return; }
            if (action === 'resume' && method === 'POST') { await readJson(request); json(response, 200, { run: await runs.resume(id) }); return; }
            if (action === 'reconcile' && method === 'POST') { json(response, 200, { run: await runs.reconcile(id, await readJson(request)) }); return; }
            if (action === 'storyboard' && method === 'GET') { json(response, 200, runs.storyboard(id)); return; }
            if (action === 'storyboard' && method === 'POST') { json(response, 200, await runs.saveStoryboard(id, await readJson(request))); return; }
            if (action === 'narration' && method === 'POST') { json(response, 200, await media.narration(id, await readJson(request))); return; }
            if (action === 'audio' && method === 'POST') { json(response, 201, await media.upload(id, request)); return; }
            if (action === 'export' && method === 'POST') { json(response, 202, await media.export(id, await readJson(request))); return; }
            if (action === 'recording' && method === 'GET') { json(response, 200, { job: await media.recording(id) }); return; }
            if (action === 'recording' && method === 'POST') { json(response, 202, { job: await media.requestRecording(id, await readJson(request)) }); return; }
            if (action === 'record' && method === 'GET') { json(response, 200, { run: runs.get(id), record: runs.record(id) }); return; }
          }
          if (parts.length === 5 && parts[3] === 'rounds' && method === 'GET') {
            const index = integer(parts[4]!, 'round'); if (index === undefined) throw new HttpError(400, 'round is required.'); json(response, 200, runs.round(id, index)); return;
          }
        }
      }
      if (parts[1] === 'tournaments') {
        if (parts.length === 2 && method === 'GET') { json(response, 200, { tournaments: tournaments.list() }); return; }
        if (parts.length === 2 && method === 'POST') { json(response, 201, { tournament: await tournaments.create(await readJson(request)) }); return; }
        if (parts.length === 3 && method === 'GET') { json(response, 200, { tournament: tournaments.get(parts[2]!) }); return; }
        if (parts.length === 4 && method === 'POST' && ['pause', 'resume'].includes(parts[3]!)) {
          await readJson(request); json(response, 200, { tournament: parts[3] === 'pause' ? await tournaments.pause(parts[2]!) : await tournaments.resume(parts[2]!) }); return;
        }
      }
      if (parts[1] === 'jobs') {
        if (parts.length === 3 && method === 'GET') { json(response, 200, await media.get(parts[2]!)); return; }
        if (parts.length === 4 && parts[3] === 'cancel' && method === 'POST') { await readJson(request); json(response, 200, await media.cancel(parts[2]!)); return; }
      }
      if (parts[1] === 'artifacts' && parts.length >= 5 && (method === 'GET' || method === 'HEAD')) {
        const id = safeId(parts[2]!); runs.get(id);
        if (!['exports', 'narration', 'uploads'].includes(parts[3]!) || !MIME[extname(parts.at(-1)!).toLowerCase()]) throw new HttpError(404, 'Artifact not found.', 'NOT_FOUND');
        const preview = target.searchParams.get('inline') === '1';
        if (preview) {
          const recording = parts.length === 6 && parts[3] === 'exports' && parts[5] === 'video.mp4' ? await media.recording(id) : null;
          if (recording?.status !== 'completed' || recording.id !== parts[4] || !recording.artifacts?.some(artifact => artifact.name === 'video.mp4')) {
            throw new HttpError(404, 'Completed recording not found.', 'NOT_FOUND');
          }
        }
        const file = await confinedFile(runs.runDirectory(id), parts.slice(3));
        const attachment = ['.mp4', '.srt', '.json'].includes(extname(file).toLowerCase());
        await streamFile(request, response, file, preview ? 'inline' : attachment ? 'attachment' : undefined); return;
      }
      throw new HttpError(404, 'Unknown API route or unsupported method.', 'NOT_FOUND');
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Static resources support GET and HEAD.');
    const isRoute = parts.length === 0 || (['broadcast', 'runs', 'replay', 'studio', 'tournaments', 'watch'].includes(parts[0]!) && parts.every(piece => !piece.includes('.')));
    let file: string;
    try { file = await confinedFile(webRoot, isRoute ? ['index.html'] : parts); }
    catch (error) { if (isRoute && error instanceof HttpError && error.status === 404) throw new HttpError(503, 'Web assets are missing. Run npm run build first.', 'WEB_NOT_BUILT'); throw error; }
    await streamFile(request, response, file);
  };
  const server = createHttpServer((request, response) => {
    void route(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const known = error instanceof HttpError;
      json(response, known ? error.status : 500, { error: sanitizeError(error, runs.env), code: known ? error.code : 'INTERNAL_ERROR',
        ...(error instanceof StartBudgetTooLowError ? { startBudget: error.startBudget } : {}) });
    });
  });
  server.requestTimeout = 120_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
  return {
    server, runs, media, tournaments, get url() { return url(); },
    async listen(requestedPort = port) {
      if (closing) throw new Error('Server is shutting down.');
      if (listening) return;
      if (listenTask) return listenTask;
      if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Port must be an integer between 0 and 65535.');
      listenTask = (async () => {
        await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', () => { server.removeListener('error', reject); accept(); }); });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Cannot determine local server port.');
        port = address.port;
        listening = true;
        if (!closing && options.autoRecordings !== false) media.recoverRecordings();
      })();
      try { await listenTask; } finally { listenTask = undefined; }
    },
    close() {
      return closing ??= (async () => {
        const mediaClose = media.close();
        await listenTask?.catch(() => {});
        const httpClose = listening ? new Promise<void>((accept, reject) => {
          listening = false;
          server.close(error => error ? reject(error) : accept());
          server.closeIdleConnections();
        }) : undefined;
        const runClose = (async () => {
          try { await tournaments.close(); } finally { await runs.close(); }
        })();
        const outcomes = await Promise.allSettled([httpClose, mediaClose, runClose]);
        const failed = outcomes.find(outcome => outcome.status === 'rejected');
        if (failed) throw failed.reason;
      })();
    },
  };
}
export function installShutdown(app: StateServer): void {
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
export async function startServer(options: ServerOptions = {}): Promise<StateServer> {
  const app = await createServer(options);
  try { await app.listen(); return app; } catch (error) { await app.close(); throw error; }
}
