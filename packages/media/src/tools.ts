import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ProbeResult, ToolPaths, ResolvedTools } from './types';

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Media export was cancelled', 'AbortError');
}
export interface ProcessResult { stdout: string; stderr: string }
export async function runProcess(executable: string, args: string[], options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; cwd?: string; input?: AsyncIterable<Buffer> } = {}): Promise<ProcessResult> {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}) });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killedForOutput = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const limit = options.maxOutputBytes ?? 2_000_000;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      forceKill ??= setTimeout(() => child.kill('SIGKILL'), 2000);
      forceKill.unref();
    };
    const append = (stream: 'stdout' | 'stderr', buffer: Buffer) => {
      if (stream === 'stdout') stdout += buffer.toString('utf8'); else stderr += buffer.toString('utf8');
      // Keep the end of FFmpeg diagnostics without allowing unbounded progress output.
      if (stderr.length > limit) stderr = stderr.slice(-limit);
      if (stdout.length > limit) { killedForOutput = true; terminate(); }
    };
    child.stdout!.on('data', buffer => append('stdout', buffer));
    child.stderr!.on('data', buffer => append('stderr', buffer));
    const onAbort = () => terminate();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs ?? 120_000);
    timeout.unref();
    const stream = options.input && Readable.from(options.input, { objectMode: false, highWaterMark: 0 });
    let inputError: Error | undefined;
    if (stream && child.stdin) {
      // A render may legitimately outlast the encoder timeout while frames keep arriving.
      stream.on('data', () => timeout.refresh());
      stream.on('error', (error: NodeJS.ErrnoException) => {
        // A broken pipe is caused by the consumer. Keep its exit diagnostics in that case.
        if (error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        inputError = error;
        terminate();
      });
      void pipeline(stream, child.stdin).catch(() => {});
    }
    const cleanup = () => { clearTimeout(timeout); if (forceKill) clearTimeout(forceKill); options.signal?.removeEventListener('abort', onAbort); stream?.destroy(); };
    child.on('error', error => { cleanup(); reject(new Error(`Cannot start ${path.basename(executable)}: ${error.message}`)); });
    child.on('close', (code, signal) => {
      // Report child exit without waiting for an in-flight frame so the caller can close the browser.
      cleanup();
      if (options.signal?.aborted) return reject(new DOMException('Media export was cancelled', 'AbortError'));
      if (timedOut) return reject(new Error(`${path.basename(executable)} timed out`));
      if (killedForOutput) return reject(new Error(`${path.basename(executable)} exceeded its output limit`));
      if (inputError) return reject(inputError);
      if (code !== 0) return reject(new Error(`${path.basename(executable)} exited with ${code ?? signal}: ${stderr.slice(-6000)}`));
      if (child.stdin && !child.stdin.writableFinished) return reject(new Error(`${path.basename(executable)} exited before consuming the full input`));
      resolve({ stdout, stderr });
    });
    if (options.signal?.aborted) terminate();
  });
}
async function executableExists(candidate: string): Promise<boolean> { try { await access(candidate); return (await stat(candidate)).isFile(); } catch { return false; } }
async function findExecutable(name: string, explicit?: string, environment?: string): Promise<string | undefined> {
  const configured = explicit || environment;
  if (configured) {
    if (await executableExists(configured)) return path.resolve(configured);
    // A configured bare command is resolved from PATH, never interpreted by a shell.
    if (path.basename(configured) !== configured) throw new Error(`Configured ${name} executable does not exist: ${configured}`);
  }
  const command = configured || name;
  const suffixes = process.platform === 'win32' && !path.extname(command) ? ['', '.exe', '.cmd'] : [''];
  for (const directory of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) { const candidate = path.join(directory.replace(/^"|"$/g, ''), command + suffix); if (await executableExists(candidate)) return candidate; }
  }
  if (configured) throw new Error(`Configured ${name} executable was not found on PATH`);
  return undefined;
}
export async function resolveTools(options: ToolPaths = {}): Promise<ResolvedTools> {
  const ffmpegPath = await findExecutable('ffmpeg', options.ffmpegPath, process.env.FFMPEG_PATH);
  if (!ffmpegPath) throw new Error('FFmpeg is required. Set FFMPEG_PATH, pass ffmpegPath, or put ffmpeg on PATH.');
  const ffprobePath = await findExecutable('ffprobe', options.ffprobePath, process.env.FFPROBE_PATH);
  let edgePath = await findExecutable('msedge', options.edgePath, process.env.EDGE_PATH);
  if (!edgePath && process.platform === 'win32') {
    for (const base of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]) {
      if (base && await executableExists(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))) { edgePath = path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'); break; }
    }
  }
  return { ffmpegPath, ...(ffprobePath ? { ffprobePath } : {}), ...(edgePath ? { edgePath } : {}) };
}
export async function toolVersion(executable: string, signal?: AbortSignal): Promise<string> {
  const result = await runProcess(executable, ['-version'], { signal, timeoutMs: 15_000 });
  return (result.stdout || result.stderr).split(/\r?\n/)[0]!.trim();
}
const numeric = (value: unknown): number | undefined => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : undefined; };
function frameRate(value?: string): number | undefined { if (!value) return undefined; const [a, b = '1'] = value.split('/'); const n = Number(a) / Number(b); return Number.isFinite(n) ? n : undefined; }

export async function probeMedia(filePath: string, tools: ResolvedTools, signal?: AbortSignal): Promise<ProbeResult> {
  if (tools.ffprobePath) {
    const { stdout } = await runProcess(tools.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,duration', '-of', 'json', filePath], { signal });
    let data: { format?: { duration?: string }; streams?: Array<Record<string, any>> };
    try { data = JSON.parse(stdout); } catch { throw new Error('FFprobe returned invalid JSON'); }
    const video = data.streams?.find(s => s.codec_type === 'video');
    const audio = data.streams?.find(s => s.codec_type === 'audio');
    const duration = numeric(data.format?.duration) ?? numeric(audio?.duration) ?? numeric(video?.duration);
    if (duration === undefined || duration <= 0) throw new Error(`Cannot measure media duration: ${path.basename(filePath)}`);
    return { durationSeconds: duration, hasVideo: !!video, hasAudio: !!audio, ...(video ? { width: numeric(video.width), height: numeric(video.height), fps: frameRate(video.avg_frame_rate), videoCodec: video.codec_name } : {}), ...(audio ? { audioCodec: audio.codec_name, audioDurationSeconds: numeric(audio.duration) ?? duration } : {}) };
  }
  // FFmpeg's demuxer and full decode are an equivalent fallback when ffprobe is unavailable.
  const { stderr } = await runProcess(tools.ffmpegPath, ['-hide_banner', '-nostdin', '-i', filePath, '-map', '0', '-f', 'null', '-'], { signal, timeoutMs: 600_000 });
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const video = /Video:\s*([^\s,(]+)[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b[^\r\n]*?([\d.]+) fps/.exec(stderr);
  const audio = /Audio:\s*([^\s,(]+)/.exec(stderr);
  if (!duration) throw new Error(`Cannot measure media duration with FFmpeg: ${path.basename(filePath)}`);
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  if (seconds <= 0) throw new Error('Media file has no measurable duration');
  return { durationSeconds: seconds, hasVideo: !!video, hasAudio: !!audio, ...(video ? { videoCodec: video[1], width: Number(video[2]), height: Number(video[3]), fps: Number(video[4]) } : {}), ...(audio ? { audioCodec: audio[1], audioDurationSeconds: seconds } : {}) };
}
export async function verifyVideo(filePath: string, expectedSeconds: number, tools: ResolvedTools, signal?: AbortSignal): Promise<ProbeResult & { fullDecode: true }> {
  const probe = await probeMedia(filePath, tools, signal);
  const tolerance = 0.12;
  if (!probe.hasVideo || !probe.hasAudio || probe.width !== 1920 || probe.height !== 1080 || probe.fps === undefined || Math.abs(probe.fps - 30) > 0.001 || probe.videoCodec !== 'h264' || probe.audioCodec !== 'aac') throw new Error(`Export stream validation failed: ${JSON.stringify(probe)}`);
  if (Math.abs(probe.durationSeconds - expectedSeconds) > tolerance || probe.audioDurationSeconds === undefined || Math.abs(probe.audioDurationSeconds - expectedSeconds) > tolerance) throw new Error(`Export duration mismatch: expected ${expectedSeconds}s, video ${probe.durationSeconds}s, audio ${probe.audioDurationSeconds}s`);
  await runProcess(tools.ffmpegPath, ['-v', 'error', '-xerror', '-nostdin', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { signal, timeoutMs: 600_000 });
  return { ...probe, fullDecode: true };
}
