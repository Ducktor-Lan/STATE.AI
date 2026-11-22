import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { assertStoryboard, fingerprint, segmentAtVideoTime, videoToGameTick } from './storyboard';
import { buildSubtitleCues, captionAtVideoTime, generateSrt } from './subtitles';
import { fileSha256, prepareNarration } from './narration';
import { resolveTools, runProcess, throwIfAborted, toolVersion, verifyVideo } from './tools';
import { resolveOutputDirectory } from './output';
import type { BroadcastRenderApi, ExportManifest, ExportVideoOptions, ExportVideoResult, RenderFrameInput } from './types';

export { assertExportDirectory } from './output';

const FINAL_NAMES = ['video.mp4', 'subtitles.srt', 'narration.wav', 'manifest.json'];
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function bounded<T>(task: Promise<T>, milliseconds: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${description} timed out after ${milliseconds}ms`)), milliseconds); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export function validatePngFrame(buffer: Buffer, width = 1920, height = 1080): void {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Broadcast renderer returned an invalid PNG frame');
  const actualWidth = buffer.readUInt32BE(16);
  const actualHeight = buffer.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) throw new Error(`Broadcast frame dimensions are ${actualWidth}x${actualHeight}; expected ${width}x${height}. The export will not stretch the image.`);
}

/** Production offline renderer. It only reads the recorded replay and never asks models to play again. */
export async function exportVideo(options: ExportVideoOptions): Promise<ExportVideoResult> {
  assertStoryboard(options.storyboard, options.source);
  if (options.runId !== options.source.runId) throw new Error('Export runId does not match the persisted media source');
  if ((options.width ?? 1920) !== 1920 || (options.height ?? 1080) !== 1080 || (options.fps ?? 30) !== 30) throw new Error('Production export requires 1920x1080 at 30 fps');
  const timeout = options.renderTimeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300_000) throw new Error('renderTimeoutMs must be between 1 and 300000');
  const maxFrames = options.maxFrames ?? 108_000;
  if (!Number.isInteger(maxFrames) || maxFrames <= 0) throw new Error('maxFrames must be a positive integer');
  const origin = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('baseUrl must be an HTTP(S) server URL without credentials');
  const broadcastUrl = new URL(options.broadcastPath ?? `/broadcast/${encodeURIComponent(options.runId)}?render=1`, origin);
  if (broadcastUrl.origin !== origin.origin) throw new Error('The broadcast page must have the same origin as baseUrl');
  broadcastUrl.searchParams.set('render', '1');
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: 'tools', progress: 0, message: '检查 FFmpeg 与浏览器' });
  const tools = await resolveTools(options);
  const versions: Record<string, string> = { ffmpeg: await toolVersion(tools.ffmpegPath, options.signal) };
  if (tools.ffprobePath) versions.ffprobe = await toolVersion(tools.ffprobePath, options.signal);
  let browserPath = tools.edgePath;
  if (!browserPath) {
    const installedChromium = chromium.executablePath();
    if (await exists(installedChromium)) browserPath = installedChromium;
    else throw new Error('No Edge/Chromium executable was found. Set EDGE_PATH, pass edgePath, install Edge, or explicitly provision Playwright Chromium. No browser download was attempted.');
  }
  const output = await resolveOutputDirectory(options.outputDir, options.outputRoot);
  await mkdir(output, { recursive: true });
  const lockPath = path.join(output, '.media-export.lock');
  try { await mkdir(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another media export owns this output directory'); throw error; }
  let work: string | undefined;
  let browser: Browser | undefined;
  const ownedFiles: string[] = [];
  const onAbort = () => { void browser?.close().catch(() => {}); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (const name of FINAL_NAMES) if (await exists(path.join(output, name))) throw new Error(`Output artifact already exists: ${name}. Use a new export directory.`);
    work = await mkdtemp(path.join(output, '.render-'));
    const prepared = await prepareNarration({ ...options, outputDir: work, outputRoot: options.outputRoot === undefined ? undefined : output });
    const storyboard = prepared.storyboard;
    const totalFrames = Math.round(storyboard.durationSeconds * 30);
    if (totalFrames < 1 || totalFrames > maxFrames) throw new Error(`Export needs ${totalFrames} frames, exceeding the configured limit of ${maxFrames}`);
    const subtitles = generateSrt(storyboard);
    const cues = buildSubtitleCues(storyboard);
    const stagedSubtitles = path.join(work, 'subtitles.srt');
    await writeFile(stagedSubtitles, subtitles, { flag: 'wx' });
    throwIfAborted(options.signal);
    browser = await chromium.launch({ executablePath: browserPath, headless: true, timeout, args: ['--disable-background-networking', '--disable-component-update', '--disable-features=Translate', '--force-color-profile=srgb'] });
    versions.browser = browser.version();
    throwIfAborted(options.signal);
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, screen: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', colorScheme: 'light', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    // This production read-only page cannot invoke a provider or mutate a run as a side effect.
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if ((['http:', 'https:'].includes(url.protocol) && url.origin !== origin.origin) || !['GET', 'HEAD'].includes(request.method())) { await route.abort('blockedbyclient'); return; }
      await route.continue();
    });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const response = await page.goto(broadcastUrl.href, { waitUntil: 'domcontentloaded', timeout });
    if (!response?.ok()) throw new Error(`Broadcast page failed: HTTP ${response?.status() ?? 'no response'}`);
    await page.waitForFunction(() => {
      const api = (window as unknown as { __STATE_AI_RENDER__?: BroadcastRenderApi }).__STATE_AI_RENDER__;
      if (api?.error) throw new Error(api.error);
      return !!api && typeof api.renderFrame === 'function' && (api.ready === true || typeof (api.ready as Promise<void>)?.then === 'function');
    }, undefined, { timeout });
    const loadedRecord = await bounded(page.evaluate(async () => {
      const api = (window as unknown as { __STATE_AI_RENDER__: BroadcastRenderApi }).__STATE_AI_RENDER__;
      await api.ready;
      if (api.error) throw new Error(api.error);
      return { runId: api.runId, sourceFingerprint: api.sourceFingerprint, canvasSelector: api.canvasSelector };
    }), timeout, 'Broadcast readiness');
    if (loadedRecord.runId !== options.runId || loadedRecord.sourceFingerprint !== fingerprint(options.source)) throw new Error('Broadcast record identity mismatch: the loaded runId/sourceFingerprint does not match the export source.');
    await bounded(page.evaluate(async () => { await document.fonts.ready; }), timeout, 'Broadcast fonts');
    const selector = options.canvasSelector ?? loadedRecord.canvasSelector ?? '[data-testid="broadcast-frame"]';
    const frameElement = page.locator(selector);
    if (await frameElement.count() !== 1) throw new Error(`Broadcast requires exactly one render surface matching ${selector}`);
    const dimensions = await frameElement.boundingBox();
    if (!dimensions || Math.abs(dimensions.width - 1920) > 0.01 || Math.abs(dimensions.height - 1080) > 0.01) throw new Error(`Broadcast render surface must be exactly 1920x1080 CSS pixels: ${JSON.stringify(dimensions)}`);
    async function* renderFrames(): AsyncGenerator<Buffer> {
      for (let frame = 0; frame < totalFrames; frame++) {
        throwIfAborted(options.signal);
        if (pageErrors.length) throw new Error(`Broadcast page error: ${pageErrors[0]}`);
        const videoTime = frame / 30;
        const segment = segmentAtVideoTime(storyboard, videoTime);
        const input: RenderFrameInput = { gameTick: videoToGameTick(storyboard, videoTime), videoTime, frameTime: videoTime * 1000, caption: options.burnSubtitles === false ? '' : captionAtVideoTime(cues, videoTime), narration: segment.narration, segment };
        await bounded(page.evaluate(async payload => {
          const api = (window as unknown as { __STATE_AI_RENDER__: BroadcastRenderApi }).__STATE_AI_RENDER__;
          if (api.error) throw new Error(api.error);
          await api.renderFrame(payload);
          if (api.error) throw new Error(api.error);
        }, input), timeout, `Broadcast frame ${frame}`);
        const png = await frameElement.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', timeout });
        validatePngFrame(png);
        yield png;
        if (frame % 15 === 0 || frame === totalFrames - 1) options.onProgress?.({ stage: 'frames', progress: (frame + 1) / totalFrames, frame: frame + 1, totalFrames, message: '渲染真实战局回放' });
      }
      if (pageErrors.length) throw new Error(`Broadcast page error: ${pageErrors[0]}`);
      await browser?.close(); browser = undefined;
      throwIfAborted(options.signal);
      options.onProgress?.({ stage: 'encoding', progress: 0, message: '编码 H.264 与 AAC' });
    }
    const streamFrames = prepared.provider === 'none' || storyboard.segments.some(segment => segment.kind === 'replay');
    const renderedFrames = renderFrames();
    let videoInput = ['-f', 'image2pipe', '-framerate', '30', '-c:v', 'png', '-i', 'pipe:0'];
    if (!streamFrames) {
      const frames = path.join(work, 'frames');
      await mkdir(frames);
      let frame = 0;
      for await (const png of renderedFrames) {
        await writeFile(path.join(frames, `${String(frame).padStart(8, '0')}.png`), png, { flag: 'wx' });
        frame++;
      }
      videoInput = ['-framerate', '30', '-start_number', '0', '-i', path.join(frames, '%08d.png')];
    }
    const stagedVideo = path.join(work, 'video.mp4');
    await runProcess(tools.ffmpegPath, [
      '-v', 'error', '-xerror', '-nostdin', '-n', ...videoInput, '-i', prepared.audioPath, '-map', '0:v:0', '-map', '1:a:0',
      ...(streamFrames ? [] : ['-frames:v', String(totalFrames)]), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      // Whole-match recordings need a seek point at least every second.
      ...(prepared.provider === 'none' ? ['-g', '30'] : []),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', stagedVideo,
    ], { signal: options.signal, timeoutMs: 600_000, ...(streamFrames ? { input: renderedFrames } : {}) });
    options.onProgress?.({ stage: 'verification', progress: 0, message: '检查时长、音轨并完整解码' });
    const verification = await verifyVideo(stagedVideo, totalFrames / 30, tools, options.signal);
    const artifacts: ExportManifest['artifacts'] = {};
    for (const [name, staged] of [['video.mp4', stagedVideo], ['subtitles.srt', stagedSubtitles], ['narration.wav', prepared.audioPath]]) artifacts[name!] = { sha256: await fileSha256(staged!), bytes: (await stat(staged!)).size };
    const manifest: ExportManifest = { version: 1, runId: options.runId, sourceFingerprint: fingerprint(options.source), sourceFingerprints: { ...(options.source.fingerprints ?? {}) }, storyboardFingerprint: fingerprint(storyboard), width: 1920, height: 1080, fps: 30, frames: totalFrames, durationSeconds: totalFrames / 30, tools: versions, narration: { provider: prepared.provider, clips: prepared.clips }, subtitles: { burnedIn: options.burnSubtitles !== false, cueCount: cues.length }, verification, artifacts };
    await writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    throwIfAborted(options.signal);
    for (const name of FINAL_NAMES) {
      const destination = path.join(output, name);
      if (await exists(destination)) throw new Error(`An output appeared during export: ${name}`);
      throwIfAborted(options.signal);
      await rename(path.join(work, name), destination);
      ownedFiles.push(destination);
      throwIfAborted(options.signal);
    }
    throwIfAborted(options.signal);
    options.onProgress?.({ stage: 'complete', progress: 1, message: '成片已通过全片解码检查' });
    throwIfAborted(options.signal);
    return { videoPath: path.join(output, 'video.mp4'), subtitlesPath: path.join(output, 'subtitles.srt'), narrationPath: path.join(output, 'narration.wav'), manifestPath: path.join(output, 'manifest.json'), storyboard, manifest };
  } catch (error) {
    for (const owned of ownedFiles) await rm(owned, { force: true });
    if (options.signal?.aborted) throw new DOMException('Media export was cancelled', 'AbortError');
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => {});
    try { if (work) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    finally { await rm(lockPath, { recursive: true, force: true }); }
  }
}
