import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const help = `Production media smoke (uses the real broadcast page and recorded source facts).

node scripts/video-smoke.mjs --source <MediaSource.json> --base-url http://127.0.0.1:port [options]

  --storyboard <Storyboard.json>   Use an edited and validated script; otherwise select recorded key events.
  --output-dir <absolute path>     Must be below ignored runs/ or outputs/; defaults to outputs/video-smoke-<timestamp>.
  --max-events <integer>           Key-event limit for an automatically built script (default 1).
  --voice <installed voice name>   Windows Chinese System.Speech voice (default first enabled Chinese voice).
  --audio <local WAV or MP3>       Import a complete, already aligned recording instead of system speech.
  --ffmpeg <executable>            Override FFMPEG_PATH / PATH.
  --ffprobe <executable>           Override FFPROBE_PATH / PATH; FFmpeg decode is the fallback.
  --edge <executable>              Override EDGE_PATH / installed Edge or Playwright Chromium.
  --srt-only                      Keep captions in SRT without drawing them in the video.

This command never starts a match or calls a model. Ctrl+C cancels the export and removes temporary frames.
API TTS is available through the backend exportVideo/prepareNarration API with a server environment key.`;
const options = new Map();
const flags = new Set(['--help', '--srt-only']);
const valueOptions = new Set(['--source', '--base-url', '--storyboard', '--output-dir', '--max-events', '--voice', '--audio', '--ffmpeg', '--ffprobe', '--edge']);
let temporary;
const controller = new AbortController();
const cancel = () => controller.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  const arguments_ = process.argv.slice(2);
  for (let i = 0; i < arguments_.length; i++) {
    const argument = arguments_[i];
    if (flags.has(argument)) { options.set(argument, true); continue; }
    if (!valueOptions.has(argument) || !arguments_[i + 1] || arguments_[i + 1].startsWith('--')) throw new Error(`Unknown or missing argument: ${argument}. Use --help.`);
    if (options.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    options.set(argument, arguments_[++i]);
  }
  if (options.has('--help')) console.log(help);
  else {
    if (!options.has('--source') || !options.has('--base-url')) throw new Error('--source and --base-url are required. Use --help.');
    const source = JSON.parse(await readFile(resolve(options.get('--source')), 'utf8'));
    const maxEvents = Number(options.get('--max-events') ?? 1);
    if (!Number.isInteger(maxEvents) || maxEvents < 0) throw new Error('--max-events must be a nonnegative integer');
    const scratchRoot = join(root, 'outputs');
    await mkdir(scratchRoot, { recursive: true });
    temporary = await mkdtemp(join(scratchRoot, '.media-cli-'));
    const entry = join(temporary, 'media.mjs');
    await build({ absWorkingDir: root, entryPoints: [join(root, 'packages/media/src/index.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['playwright'], tsconfig: join(root, 'tsconfig.json'), logLevel: 'warning' });
    const { assertMediaSource, buildStoryboard, exportVideo } = await import(pathToFileURL(entry).href);
    assertMediaSource(source);
    const storyboard = options.has('--storyboard') ? JSON.parse(await readFile(resolve(options.get('--storyboard')), 'utf8')) : buildStoryboard(source, { maxEvents, preRollTicks: 15, postRollTicks: 15, openingSeconds: 3, resultSeconds: 3, intentLookbackTicks: 0 });
    const outputDir = options.has('--output-dir') ? resolve(options.get('--output-dir')) : join(root, 'outputs', `video-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    let lastLog = 0;
    const result = await exportVideo({
      source, storyboard, runId: source.runId, baseUrl: options.get('--base-url'), outputDir,
      narration: options.has('--audio') ? { provider: 'import', audioPath: resolve(options.get('--audio')) } : { provider: 'windows', ...(options.has('--voice') ? { voice: options.get('--voice') } : {}) },
      ...(options.has('--ffmpeg') ? { ffmpegPath: options.get('--ffmpeg') } : {}),
      ...(options.has('--ffprobe') ? { ffprobePath: options.get('--ffprobe') } : {}),
      ...(options.has('--edge') ? { edgePath: options.get('--edge') } : {}),
      burnSubtitles: !options.has('--srt-only'), signal: controller.signal,
      onProgress(progress) {
        const now = Date.now();
        if (now - lastLog > 1000 || progress.progress === 1) { console.log(`[media] ${progress.stage} ${Math.round(progress.progress * 100)}% ${progress.message ?? ''}`); lastLog = now; }
      },
    });
    console.log(JSON.stringify({ videoPath: result.videoPath, narrationPath: result.narrationPath, subtitlesPath: result.subtitlesPath, manifestPath: result.manifestPath, durationSeconds: result.manifest.durationSeconds, verification: result.manifest.verification }, null, 2));
  }
} catch (error) {
  console.error(`[media] ${controller.signal.aborted ? 'Export cancelled' : error instanceof Error ? error.message : String(error)}`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
