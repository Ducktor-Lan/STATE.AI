import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, writeFile, mkdir, mkdtemp, rm, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { assertStoryboard, retimeStoryboard, fingerprint } from './storyboard';
import { probeMedia, resolveTools, runProcess, throwIfAborted } from './tools';
import { resolveOutputDirectory } from './output';
import type { NarrationClip, PreparedNarration, PrepareNarrationOptions, Storyboard, SystemVoice, WindowsTtsOptions, OpenAiTtsOptions, ResolvedTools } from './types';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BLOCK_ALIGN = CHANNELS * BYTES_PER_SAMPLE;
const BYTES_PER_SECOND = SAMPLE_RATE * BLOCK_ALIGN;
const encodedCommand = (script: string) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

export async function listWindowsVoices(options: { powerShellPath?: string; signal?: AbortSignal } = {}): Promise<SystemVoice[]> {
  if (process.platform !== 'win32') throw new Error('Windows System.Speech is unavailable on this platform; choose API TTS or import a WAV/MP3 recording.');
  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { @($s.GetInstalledVoices() | ForEach-Object { [PSCustomObject]@{name=$_.VoiceInfo.Name;culture=$_.VoiceInfo.Culture.Name;enabled=$_.Enabled} }) | ConvertTo-Json -Compress } finally { $s.Dispose() }`;
  const { stdout } = await runProcess(options.powerShellPath || 'powershell.exe', encodedCommand(script), { signal: options.signal, timeoutMs: 30_000 });
  let value: unknown;
  try { value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]'); } catch { throw new Error('System.Speech returned an unreadable voice list'); }
  const array = Array.isArray(value) ? value : [value];
  return array.filter((voice): voice is SystemVoice => !!voice && typeof voice === 'object' && typeof voice.name === 'string' && typeof voice.culture === 'string' && typeof voice.enabled === 'boolean');
}
async function windowsSpeech(text: string, destination: string, options: WindowsTtsOptions, voice: string, signal?: AbortSignal): Promise<void> {
  const payload = Buffer.from(JSON.stringify({ text, destination, voice, rate: options.rate ?? 0 }), 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Speech; $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $s.SelectVoice($p.voice); $s.Rate = [int]$p.rate; $s.SetOutputToWaveFile($p.destination); $s.Speak($p.text); $s.SetOutputToNull() } finally { $s.Dispose() }`;
  await runProcess(options.powerShellPath || 'powershell.exe', encodedCommand(script), { signal, timeoutMs: 300_000 });
}
async function apiSpeech(text: string, destination: string, options: OpenAiTtsOptions, signal: AbortSignal | undefined, environment: Readonly<Record<string, string | undefined>>): Promise<void> {
  const endpoint = new URL(options.endpoint);
  if (endpoint.username || endpoint.password || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) throw new Error('TTS endpoint must use HTTPS (or a local HTTP server) without embedded credentials');
  if (!options.model?.trim() || !options.voice?.trim() || !/^[a-z_][a-z0-9_]*$/i.test(options.apiKeyEnv)) throw new Error('TTS model, voice and an API key environment variable name are required');
  const apiKey = environment[options.apiKeyEnv];
  if (!apiKey?.trim()) throw new Error(`TTS credentials are missing: set ${options.apiKeyEnv} on the server. No request was sent.`);
  if (options.speed !== undefined && (!Number.isFinite(options.speed) || options.speed < 0.25 || options.speed > 4)) throw new Error('TTS speed must be between 0.25 and 4');
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) throw new Error('TTS timeout must be between 1 and 600000 milliseconds');
  throwIfAborted(signal);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model, voice: options.voice, input: text, response_format: 'wav', ...(options.speed === undefined ? {} : { speed: options.speed }) }),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
    redirect: 'error',
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`TTS provider returned HTTP ${response.status}; no speech was accepted.`); }
  if (!response.body) throw new Error('TTS provider returned no audio body');
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 100_000_000) throw new Error('TTS response exceeds 100 MB');
      parts.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!bytes) throw new Error('TTS provider returned empty audio');
  await writeFile(destination, Buffer.concat(parts), { flag: 'wx' });
}

export async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const buffer of createReadStream(filePath)) hash.update(buffer);
  return hash.digest('hex');
}
async function normalizeAudio(input: string, output: string, tools: ResolvedTools, signal?: AbortSignal): Promise<{ duration: number; bytes: number }> {
  const measured = await probeMedia(input, tools, signal);
  if (!measured.hasAudio) throw new Error(`Input contains no audio stream: ${path.basename(input)}`);
  await runProcess(tools.ffmpegPath, ['-v', 'error', '-xerror', '-nostdin', '-n', '-i', input, '-map', '0:a:0', '-vn', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', output], { signal, timeoutMs: 300_000 });
  const bytes = (await stat(output)).size;
  if (!bytes || bytes % BLOCK_ALIGN) throw new Error('Decoded audio has no complete PCM samples');
  const duration = bytes / BYTES_PER_SECOND;
  // MP3's declared duration includes encoder padding; decoding is the authoritative speech length.
  if (Math.abs(duration - measured.durationSeconds) > Math.max(0.25, measured.durationSeconds * 0.02)) throw new Error(`Audio duration changed unexpectedly while decoding: ${measured.durationSeconds}s versus ${duration}s`);
  return { duration, bytes };
}
function extendSegment(storyboard: Storyboard, index: number, minimumDuration: number): void {
  const segment = storyboard.segments[index]!;
  if (minimumDuration <= segment.durationSeconds) return;
  const extra = minimumDuration - segment.durationSeconds;
  segment.durationSeconds += extra;
  segment.hold = { at: 'end', durationSeconds: (segment.hold?.durationSeconds ?? 0) + extra };
}
function wavHeader(dataBytes: number): Buffer {
  if (dataBytes > 0xffff_ffff - 36) throw new Error('Narration exceeds the standard WAV size limit');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(BLOCK_ALIGN, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  return header;
}
async function assembleWav(destination: string, duration: number, clips: Array<{ path: string; start: number; bytes: number }>, signal: AbortSignal | undefined, onCreated: () => void): Promise<void> {
  const dataBytes = Math.ceil(duration * SAMPLE_RATE) * BLOCK_ALIGN;
  const output = await open(destination, 'wx');
  onCreated();
  try {
    await output.write(wavHeader(dataBytes), 0, 44, 0);
    await output.truncate(44 + dataBytes); // Sparse zero-filled regions are intentional silence between clips.
    for (const clip of clips) {
      const start = Math.round(clip.start * SAMPLE_RATE) * BLOCK_ALIGN;
      if (start + clip.bytes > dataBytes) throw new Error('Narration would be truncated by the output clock');
      let position = 44 + start;
      for await (const chunk of createReadStream(clip.path)) {
        throwIfAborted(signal);
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let written = 0;
        while (written < buffer.length) { const result = await output.write(buffer, written, buffer.length - written, position + written); if (!result.bytesWritten) throw new Error('Could not write narration audio'); written += result.bytesWritten; }
        position += buffer.length;
      }
    }
  } finally { await output.close(); }
}

export async function prepareNarration(options: PrepareNarrationOptions): Promise<PreparedNarration> {
  assertStoryboard(options.storyboard, options.source);
  throwIfAborted(options.signal);
  const outputDirectory = await resolveOutputDirectory(options.outputDir, options.outputRoot, 'Narration output');
  const tools = await resolveTools(options);
  const destination = path.join(outputDirectory, 'narration.wav');
  await mkdir(outputDirectory, { recursive: true });
  try { await access(destination); throw new Error('narration.wav already exists; use a new export directory'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const work = await mkdtemp(path.join(outputDirectory, '.speech-'));
  let created = false;
  try {
    const configuration = options.narration;
    let selectedVoice: string | undefined;
    if (configuration.provider === 'windows') {
      if (!Number.isInteger(configuration.rate ?? 0) || (configuration.rate ?? 0) < -10 || (configuration.rate ?? 0) > 10) throw new Error('System.Speech rate must be an integer from -10 to 10');
      const voices = await listWindowsVoices({ powerShellPath: configuration.powerShellPath, signal: options.signal });
      const voice = voices.find(v => v.enabled && /^zh(?:-|$)/i.test(v.culture) && (!configuration.voice || v.name === configuration.voice));
      if (!voice) throw new Error('No enabled Chinese System.Speech voice matches the selection. Install a Chinese voice or choose API TTS/import.');
      selectedVoice = voice.name;
    } else if (configuration.provider !== 'openai-compatible' && configuration.provider !== 'import' && configuration.provider !== 'none') throw new Error('Unsupported narration provider');
    const padding = options.paddingSeconds ?? 0.2;
    if (!Number.isFinite(padding) || padding < 0 || padding > 10) throw new Error('Speech padding must be between 0 and 10 seconds');
    let storyboard: Storyboard = structuredClone(options.storyboard);
    const records: Array<{ index: number; pcmPath: string; bytes: number; duration: number; sha256: string }> = [];
    let wholeTrack: { pcmPath: string; bytes: number; duration: number; sha256: string } | undefined;
    if (configuration.provider === 'import' && configuration.audioPath) {
      if (configuration.segments && Object.keys(configuration.segments).length) throw new Error('Choose a complete imported track or per-segment recordings, not both');
      if (!/\.(wav|mp3)$/i.test(configuration.audioPath)) throw new Error('Imported narration must be a local WAV or MP3 file');
      const pcmPath = path.join(work, 'whole.pcm');
      const decoded = await normalizeAudio(path.resolve(configuration.audioPath), pcmPath, tools, options.signal);
      wholeTrack = { pcmPath, ...decoded, sha256: await fileSha256(configuration.audioPath) };
      if (decoded.duration > storyboard.durationSeconds + 1 / SAMPLE_RATE) extendSegment(storyboard, storyboard.segments.length - 1, storyboard.segments.at(-1)!.durationSeconds + decoded.duration + padding - storyboard.durationSeconds);
    } else if (configuration.provider !== 'none') {
      if (configuration.provider === 'import' && !configuration.segments) throw new Error('Provide a WAV/MP3 track or segment recordings');
      const narrated = storyboard.segments.filter(s => s.narration.trim());
      for (const [index, segment] of storyboard.segments.entries()) {
        throwIfAborted(options.signal);
        if (!segment.narration.trim()) continue;
        options.onProgress?.({ stage: 'narration', progress: records.length / Math.max(1, narrated.length), message: `配音：${segment.id}` });
        let input: string;
        if (configuration.provider === 'import') {
          input = configuration.segments![segment.id]!;
          if (!input || !/\.(wav|mp3)$/i.test(input)) throw new Error(`Missing local WAV/MP3 narration for segment ${segment.id}`);
          input = path.resolve(input);
        } else {
          input = path.join(work, `speech-${index}.wav`);
          if (configuration.provider === 'windows') await windowsSpeech(segment.narration, input, configuration, selectedVoice!, options.signal);
          else await apiSpeech(segment.narration, input, configuration, options.signal, options.environment ?? process.env);
        }
        const pcmPath = path.join(work, `speech-${index}.pcm`);
        const decoded = await normalizeAudio(input, pcmPath, tools, options.signal);
        records.push({ index, pcmPath, ...decoded, sha256: await fileSha256(input) });
        segment.narrationDurationSeconds = decoded.duration;
        extendSegment(storyboard, index, decoded.duration + padding);
      }
      if (!records.length) throw new Error('Storyboard has no narrated segments. Supply a real imported track or narration text.');
    }
    storyboard = retimeStoryboard(storyboard);
    // Quantize the last hold to the production frame clock without altering a word of speech.
    const frameDuration = Math.ceil((storyboard.durationSeconds - 1e-8) * 30) / 30;
    extendSegment(storyboard, storyboard.segments.length - 1, storyboard.segments.at(-1)!.durationSeconds + Math.max(0, frameDuration - storyboard.durationSeconds));
    storyboard = retimeStoryboard(storyboard);
    assertStoryboard(storyboard, options.source);
    const clips: NarrationClip[] = records.map(record => {
      const segment = storyboard.segments[record.index]!;
      return { segmentId: segment.id, provider: configuration.provider, durationSeconds: record.duration, videoStartSeconds: segment.videoStartSeconds, sourceSha256: record.sha256, textSha256: fingerprint(segment.narration) };
    });
    if (wholeTrack) clips.push({ segmentId: '*', provider: 'import', durationSeconds: wholeTrack.duration, videoStartSeconds: 0, sourceSha256: wholeTrack.sha256, textSha256: fingerprint(storyboard.segments.map(s => s.narration)) });
    await assembleWav(destination, storyboard.durationSeconds, wholeTrack ? [{ path: wholeTrack.pcmPath, start: 0, bytes: wholeTrack.bytes }] : records.map(record => ({ path: record.pcmPath, start: storyboard.segments[record.index]!.videoStartSeconds, bytes: record.bytes })), options.signal, () => { created = true; });
    const finalAudio = await probeMedia(destination, tools, options.signal);
    if (!finalAudio.hasAudio || Math.abs(finalAudio.durationSeconds - storyboard.durationSeconds) > 0.025) throw new Error('Final narration duration does not match its measured timeline');
    options.onProgress?.({ stage: 'narration', progress: 1, message: configuration.provider === 'none' ? '静音音轨已生成并校验时长' : '旁白已生成并实测排期' });
    return { storyboard, audioPath: destination, audioDurationSeconds: finalAudio.durationSeconds, clips, provider: configuration.provider };
  } catch (error) {
    if (created) await rm(destination, { force: true });
    throw error;
  } finally { await rm(work, { recursive: true, force: true }); }
}
