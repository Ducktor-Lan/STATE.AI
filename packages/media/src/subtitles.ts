import type { Storyboard, SubtitleCue, SrtOptions } from './types';

function chunks(text: string, lineLength: number, maxLines: number): string[] {
  // Keep sentence punctuation and quotation marks attached; wrap long Chinese sentences by code point.
  const sentences = text.replace(/\r\n?/g, '\n').match(/[^。！？!?；;\n]+(?:[。！？!?；;]+[”’」』"']*)?|[。！？!?；;]+/gu) ?? [];
  const result: string[] = [];
  for (const sentence of sentences) {
    if (/^[。！？!?；;”’」』"'\s]+$/u.test(sentence) && result.length) { result[result.length - 1] += sentence.trim(); continue; }
    const characters = Array.from(sentence.trim());
    const lines: string[] = [];
    while (characters.length) {
      let length = Math.min(lineLength, characters.length);
      if (characters.length > lineLength) {
        const prefix = characters.slice(0, lineLength).join('');
        const punctuation = Math.max(prefix.lastIndexOf('，'), prefix.lastIndexOf('、'), prefix.lastIndexOf('：'), prefix.lastIndexOf(' '));
        if (punctuation >= Math.floor(lineLength / 2)) length = Array.from(prefix.slice(0, punctuation + 1)).length;
      }
      const line = characters.splice(0, length).join('').trim();
      if (line) lines.push(line);
    }
    while (lines.length) result.push(lines.splice(0, maxLines).join('\n'));
  }
  return result;
}

export function buildSubtitleCues(storyboard: Storyboard, options: SrtOptions = {}): SubtitleCue[] {
  const lineLength = options.maxCharactersPerLine ?? 24;
  const maxLines = options.maxLines ?? 2;
  const minimum = options.minCueSeconds ?? 0.6;
  if (!Number.isInteger(lineLength) || lineLength < 4 || !Number.isInteger(maxLines) || maxLines < 1 || !Number.isFinite(minimum) || minimum <= 0) throw new Error('Invalid subtitle layout options');
  const cues: SubtitleCue[] = [];
  let previousEndMs = 0;
  for (const segment of storyboard.segments) {
    if (!segment.caption.trim()) continue;
    const parts = chunks(segment.caption, lineLength, maxLines);
    const startMs = Math.round(segment.videoStartSeconds * 1000);
    const duration = Math.min(segment.durationSeconds, segment.narrationDurationSeconds ?? segment.durationSeconds);
    const endMs = Math.round((segment.videoStartSeconds + duration) * 1000);
    if (startMs < previousEndMs || endMs <= startMs || endMs - startMs < parts.length) throw new Error(`Subtitle clock is invalid for segment ${segment.id}`);
    const weights = parts.map(part => Math.max(1, Array.from(part.replace(/\s/g, '')).length));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const durationMs = endMs - startMs;
    const floorMs = Math.min(Math.round(minimum * 1000), Math.floor(durationMs / parts.length));
    const remainingMs = durationMs - floorMs * parts.length;
    let cumulative = 0;
    let cursorMs = startMs;
    for (const [i, text] of parts.entries()) {
      cumulative += weights[i]!;
      const cueEndMs = i === parts.length - 1 ? endMs : startMs + (i + 1) * floorMs + Math.round(remainingMs * cumulative / total);
      cues.push({ index: cues.length + 1, startSeconds: cursorMs / 1000, endSeconds: cueEndMs / 1000, text, segmentId: segment.id });
      cursorMs = cueEndMs;
    }
    previousEndMs = endMs;
  }
  return cues;
}

export function formatSrtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('SRT time must be nonnegative and finite');
  const ms = Math.round(seconds * 1000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms % 3_600_000 / 60_000);
  const wholeSeconds = Math.floor(ms % 60_000 / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function generateSrt(storyboard: Storyboard, options: SrtOptions = {}): string {
  return buildSubtitleCues(storyboard, options).map(cue => `${cue.index}\n${formatSrtTime(cue.startSeconds)} --> ${formatSrtTime(cue.endSeconds)}\n${cue.text}\n`).join('\n');
}
export function captionAtVideoTime(cues: SubtitleCue[], seconds: number): string {
  return cues.find(cue => seconds >= cue.startSeconds && seconds < cue.endSeconds)?.text ?? '';
}
