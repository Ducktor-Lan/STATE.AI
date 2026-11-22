import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createFileArenaStore, replayArenaRecord } from '@state/arena';
import type { ArenaRecord } from '@state/arena';
import { RunManager } from '../../server/src/runs.js';
import { TournamentManager } from '../../server/src/tournaments.js';
import { startServer, installShutdown } from '../../server/src/server.js';
import { isObject } from '../../server/src/security.js';
import { sanitizeError } from '../../server/src/environment.js';

const HELP = `STATE.AI — reproducible local arena CLI
Usage: node dist/cli.mjs COMMAND [options]

  baseline smoke             Run a credential-free normal/hard baseline game and verify replay.
  run --config FILE          Run a JSON CreateRunInput; saves durable records under runs/.
  run --resume ID            Explicitly resume a paused run; never bypasses uncertain costs.
  replay verify PATH         Verify a run directory or an exported ArenaRecord JSON file.
  tournament --config FILE   Create and execute an evaluation schedule and print real aggregation.
  tournament --resume ID     Explicitly resume a saved batch.
  serve [--port 4180]        Serve HTTP and dist/web on 127.0.0.1 only.
  video --run ID             Export a persisted stable run using the real broadcast page.

Common options: --root DIRECTORY (default cwd), --data-dir DIRECTORY, --models FILE.
Video options: --audio FILE (import an audio-only local recording), --storyboard FILE,
               --ffmpeg FILE, --ffprobe FILE, --edge FILE, --voice NAME.
Tournament config: models (unique ids), seeds, track, factionCount, durationSeconds,
  repetitions, seatPolicy, budget (batch totals), runBudget (per game), allowDevelopment.
  Formal batches require a clean Git HEAD; allowDevelopment:true labels development data.
Budget maxCalls counts actor decision invocations, including retries explicitly restarted
  at the arena layer. Provider HTTP retries are reported separately as httpAttempts;
  per-window USD reservations include all configured provider retry attempts.
Remote models require backend keys, token prices and maxOutputTokens. Missing keys never
  select a baseline. Unknown/uncertain charges pause the run; reconcile via the local API.
Use --help with any command for this reference. No command sends keys to the browser.
`;
interface Arguments { command: string[]; options: Map<string, string> }
function parse(args: string[]): Arguments {
  const command: string[] = [], options = new Map<string, string>();
  const allowed = new Set(['root', 'data-dir', 'models', 'config', 'resume', 'port', 'run', 'audio', 'storyboard', 'ffmpeg', 'ffprobe', 'edge', 'voice']);
  for (let i = 0; i < args.length; i++) {
    const part = args[i]!;
    if (!part.startsWith('--')) { command.push(part); continue; }
    const key = part.slice(2), value = args[++i];
    if (!allowed.has(key) || !value || value.startsWith('--') || options.has(key)) throw new Error(`Invalid option ${part}. Use --help.`);
    options.set(key, value);
  }
  return { command, options };
}
async function jsonFile(file: string): Promise<unknown> { return JSON.parse((await readFile(resolve(file), 'utf8')).replace(/^\uFEFF/u, '')) as unknown; }
async function recordFrom(path: string): Promise<ArenaRecord> {
  const absolute = resolve(path);
  if ((await stat(absolute)).isDirectory()) {
    const direct = createFileArenaStore(absolute);
    try { return await direct.read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return createFileArenaStore(join(absolute, 'arena')).read();
  }
  const value = await jsonFile(absolute);
  return (isObject(value) && isObject(value.record) ? value.record : value) as ArenaRecord;
}
export async function cliMain(argv = process.argv.slice(2)): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return; }
  const { command, options } = parse(argv), name = command[0];
  const required = (key: string): string => { const value = options.get(key); if (!value) throw new Error(`--${key} is required. Use --help.`); return value; };
  const rootDir = resolve(options.get('root') ?? process.cwd());
  const environment = { ...process.env,
    ...(options.has('ffmpeg') ? { FFMPEG_PATH: resolve(required('ffmpeg')) } : {}), ...(options.has('ffprobe') ? { FFPROBE_PATH: resolve(required('ffprobe')) } : {}),
    ...(options.has('edge') ? { EDGE_PATH: resolve(required('edge')) } : {}), ...(options.has('voice') ? { TTS_VOICE: required('voice'), STATE_TTS_VOICE: required('voice') } : {}) };
  const common = { rootDir, env: environment, ...(options.has('data-dir') ? { dataDir: resolve(required('data-dir')) } : {}), ...(options.has('models') ? { configPath: resolve(required('models')) } : {}) };
  if (name === 'serve') {
    if (command.length !== 1) throw new Error('serve takes no positional arguments.');
    const raw = options.get('port'); if (raw !== undefined && !/^\d+$/u.test(raw)) throw new Error('--port must be an integer.');
    const app = await startServer({ ...common, ...(raw !== undefined ? { port: Number(raw) } : {}) }); console.log(`STATE.AI listening at ${app.url}`); installShutdown(app); return;
  }
  if (name === 'replay' && command[1] === 'verify') {
    if (!command[2] || command.length !== 3) throw new Error('Usage: replay verify PATH');
    const record = await recordFrom(command[2]), verified = replayArenaRecord(record);
    console.log(JSON.stringify({ verified: true, fingerprint: verified.fingerprint, tick: verified.state.tick, result: verified.result }, null, 2)); return;
  }
  if (name === 'video') {
    const app = await startServer({ ...common, port: 0, autoRecordings: false });
    try {
      const id = required('run');
      if (options.has('storyboard')) await app.runs.saveStoryboard(id, await jsonFile(required('storyboard')));
      const asset = options.has('audio') ? await app.media.importAudio(id, resolve(required('audio'))) : undefined;
      const { jobId } = await app.media.export(id, { format: 'mp4', width: 1920, height: 1080, fps: 30,
        ...(asset ? { narration: { provider: 'import', assetId: asset.assetId } } : {}) });
      const cancel = () => { void app.media.cancel(jobId); }; process.once('SIGINT', cancel);
      try {
        for (;;) {
          const job = await app.media.get(jobId);
          if (['completed', 'failed', 'cancelled'].includes(job.status)) {
            console.log(JSON.stringify({ ...job, directory: join(app.runs.runDirectory(id), 'exports', jobId) }, null, 2));
            if (job.status !== 'completed') process.exitCode = 1; break;
          }
          await delay(250);
        }
      } finally { process.removeListener('SIGINT', cancel); }
    } finally { await app.close(); }
    return;
  }
  if (name !== 'run' && name !== 'tournament' && !(name === 'baseline' && command[1] === 'smoke')) throw new Error('Unknown command. Use --help.');
  const runs = await RunManager.open(common);
  let tournaments: TournamentManager | undefined;
  try {
    if (name === 'tournament') {
      tournaments = await TournamentManager.open(runs);
      const created = options.has('resume') ? await tournaments.resume(required('resume')) : await tournaments.create(await jsonFile(required('config')));
      const result = await tournaments.wait(created.id); console.log(JSON.stringify({ tournament: result }, null, 2)); if (result.status !== 'completed') process.exitCode = 2;
      return;
    }
    const baseline = name === 'baseline';
    const presets = runs.models().filter(model => model.kind === 'baseline' && model.available);
    if (baseline && !presets.length) throw new Error('No available baseline preset is configured.');
    const input = baseline ? { track: 'strategy', seed: 1729, durationSeconds: 180, factionCount: 2,
      models: [presets[0]!.id, presets[1]?.id ?? presets[0]!.id], disaster: false, budget: { maxCalls: 1000, maxCostUsd: 0 } } : options.has('resume') ? undefined : await jsonFile(required('config'));
    const created = options.has('resume') ? await runs.resume(required('resume')) : await runs.create(input);
    const result = await runs.wait(created.id);
    if (baseline) {
      const record = runs.record(result.id), verification = replayArenaRecord(record);
      console.log(JSON.stringify({ run: result, replay: { verified: true, fingerprint: verification.fingerprint, tick: verification.state.tick }, recordDirectory: runs.runDirectory(result.id) }, null, 2));
    } else console.log(JSON.stringify({ run: result, recordDirectory: runs.runDirectory(result.id) }, null, 2));
    if (result.status !== 'completed') process.exitCode = 2;
  } finally { await tournaments?.close(); await runs.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void cliMain().catch(error => { console.error(sanitizeError(error, process.env)); process.exitCode = 1; });
}
