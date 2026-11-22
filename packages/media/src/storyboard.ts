import { createHash } from 'node:crypto';
import type { MediaSource, MediaEvent, MediaDecision, Storyboard, StorySegment, StoryboardOptions, ValidationIssue, ValidationResult } from './types';

const EPSILON = 1e-6;
const PRIORITY: Record<MediaEvent['type'], number> = { elimination: 6, leadchange: 5, break: 4, alliance: 3, capture: 2, battle: 0 };

export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }

export class MediaValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'MediaValidationError';
  }
}
const isObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function validateMediaSource(source: MediaSource): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!isObject(source)) return { valid: false, issues: [{ path: 'source', message: 'must be an object' }] };
  if (!nonempty(source.runId)) add('runId', 'must be a nonempty run id');
  if (!Number.isInteger(source.durationTicks) || source.durationTicks < 0) add('durationTicks', 'must be a nonnegative integer');
  if (source.ticksPerSecond !== undefined && (!finite(source.ticksPerSecond) || source.ticksPerSecond <= 0)) add('ticksPerSecond', 'must be positive');
  const factions = new Set<string>();
  if (!Array.isArray(source.factions) || source.factions.length < 2) add('factions', 'at least two recorded factions are required');
  else source.factions.forEach((faction, i) => {
    if (!isObject(faction) || !nonempty(faction.id) || !nonempty(faction.label) || !nonempty(faction.modelLabel)) { add(`factions[${i}]`, 'id, label and modelLabel are required'); return; }
    if (factions.has(faction.id)) add(`factions[${i}].id`, 'duplicate faction id');
    factions.add(faction.id);
  });
  const tick = (value: unknown, path: string) => { if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > source.durationTicks) add(path, 'must be an integer within the recorded run'); };
  const faction = (value: unknown, path: string) => { if (typeof value !== 'string' || !factions.has(value)) add(path, 'unknown faction'); };
  const eventIds = new Set<string>();
  if (!Array.isArray(source.events)) add('events', 'must be an array');
  else source.events.forEach((event, i) => {
    const path = `events[${i}]`;
    if (!isObject(event)) { add(path, 'must be an object'); return; }
    if (!nonempty(event.id) || eventIds.has(event.id)) add(`${path}.id`, 'must be a unique nonempty id');
    eventIds.add(event.id);
    if (!Object.hasOwn(PRIORITY, event.type)) add(`${path}.type`, 'unsupported event type; map persisted facts on the server');
    tick(event.tick, `${path}.tick`);
    faction(event.factionId, `${path}.factionId`);
    if (event.otherFactionId !== undefined) faction(event.otherFactionId, `${path}.otherFactionId`);
    if (event.fromFactionId !== undefined && event.fromFactionId !== null) faction(event.fromFactionId, `${path}.fromFactionId`);
    if (event.type === 'capture' && !nonempty(event.territoryId)) add(`${path}.territoryId`, 'capture requires a recorded territory id');
    if ((event.type === 'alliance' || event.type === 'break') && (!event.otherFactionId || event.otherFactionId === event.factionId)) add(`${path}.otherFactionId`, 'requires a different recorded faction');
    for (const field of ['damage', 'score'] as const) if (event[field] !== undefined && (!finite(event[field]) || event[field]! < 0)) add(`${path}.${field}`, 'must be nonnegative and finite');
  });
  const decisions = new Set<string>();
  if (!Array.isArray(source.decisions)) add('decisions', 'must be an array');
  else source.decisions.forEach((decision, i) => {
    const path = `decisions[${i}]`;
    if (!isObject(decision)) { add(path, 'must be an object'); return; }
    if (!nonempty(decision.id) || decisions.has(decision.id)) add(`${path}.id`, 'must be a unique nonempty id');
    decisions.add(decision.id);
    tick(decision.tick, `${path}.tick`);
    faction(decision.factionId, `${path}.factionId`);
    if (decision.intent !== undefined && typeof decision.intent !== 'string') add(`${path}.intent`, 'must be recorded text');
    if (decision.eventIds !== undefined && (!Array.isArray(decision.eventIds) || decision.eventIds.some(id => !eventIds.has(id)))) add(`${path}.eventIds`, 'must reference recorded events');
  });
  if (source.outcome !== undefined) {
    const outcome = source.outcome;
    if (!isObject(outcome) || !nonempty(outcome.reason) || !Array.isArray(outcome.standings) || outcome.standings.length === 0) add('outcome', 'reason and recorded standings are required');
    else {
      if (outcome.tick !== undefined) tick(outcome.tick, 'outcome.tick');
      const seen = new Set<string>();
      outcome.standings.forEach((standing, i) => {
        if (!isObject(standing)) { add(`outcome.standings[${i}]`, 'must be an object'); return; }
        faction(standing.factionId, `outcome.standings[${i}].factionId`);
        if (seen.has(standing.factionId)) add(`outcome.standings[${i}].factionId`, 'duplicate faction');
        seen.add(standing.factionId);
        if (!Number.isInteger(standing.rank) || standing.rank < 1) add(`outcome.standings[${i}].rank`, 'must be a positive recorded rank');
        for (const field of ['score', 'territories', 'troops'] as const) if (standing[field] !== undefined && (!finite(standing[field]) || standing[field]! < 0)) add(`outcome.standings[${i}].${field}`, 'must be nonnegative and finite');
      });
    }
  }
  if (source.fingerprints !== undefined && (!isObject(source.fingerprints) || Object.values(source.fingerprints).some(value => typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)))) add('fingerprints', 'values must be SHA-256 hex strings');
  return { valid: issues.length === 0, issues };
}
export function assertMediaSource(source: MediaSource): void { const result = validateMediaSource(source); if (!result.valid) throw new MediaValidationError(result.issues); }

/** Omit no-op captures, identical facts and repeated state announcements. The original source is never modified. */
export function selectKeyEvents(source: MediaSource, maxEvents = 8): MediaEvent[] {
  assertMediaSource(source);
  if (!Number.isInteger(maxEvents) || maxEvents < 0) throw new Error('maxEvents must be a nonnegative integer');
  const seen = new Set<string>();
  const territoryOwners = new Map<string, string>();
  const alliances = new Map<string, boolean>();
  const eliminated = new Set<string>();
  let leader: string | undefined;
  const candidates: MediaEvent[] = [];
  for (const event of [...source.events].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id))) {
    const semantic = fingerprint({ ...event, id: undefined });
    if (seen.has(semantic)) continue;
    seen.add(semantic);
    if (event.type === 'battle') continue;
    if (event.type === 'capture') {
      if (event.fromFactionId === event.factionId || territoryOwners.get(event.territoryId!) === event.factionId) continue;
      territoryOwners.set(event.territoryId!, event.factionId);
    }
    if (event.type === 'leadchange') { if (leader === event.factionId) continue; leader = event.factionId; }
    if (event.type === 'alliance' || event.type === 'break') {
      const pair = [event.factionId, event.otherFactionId!].sort().join('\0');
      const active = event.type === 'alliance';
      if (alliances.get(pair) === active) continue;
      alliances.set(pair, active);
    }
    if (event.type === 'elimination') { if (eliminated.has(event.factionId)) continue; eliminated.add(event.factionId); }
    candidates.push(event);
  }
  return candidates.sort((a, b) => PRIORITY[b.type] - PRIORITY[a.type] || a.tick - b.tick || a.id.localeCompare(b.id)).slice(0, maxEvents).sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
}

function label(source: MediaSource, id: string): string { const faction = source.factions.find(f => f.id === id)!; return `${faction.label}（${faction.modelLabel}）`; }
function fact(source: MediaSource, event: MediaEvent): string {
  const who = label(source, event.factionId);
  switch (event.type) {
    case 'capture': return `${who}占领${event.territoryLabel || event.territoryId}${event.fromFactionId ? `，该领地此前属于${label(source, event.fromFactionId)}` : event.fromFactionId === null ? '，该领地此前为中立' : ''}。`;
    case 'leadchange': return `${who}在记录中成为领先方${event.score === undefined ? '' : `，控地分为${event.score}`}。`;
    case 'alliance': return `${who}与${label(source, event.otherFactionId!)}正式结盟。`;
    case 'break': return `${who}与${label(source, event.otherFactionId!)}的盟约解除${event.reason ? `，记录原因为“${event.reason}”` : ''}。`;
    case 'elimination': return `${who}被淘汰。`;
    case 'battle': return `${who}发生交战${event.damage === undefined ? '' : `，记录伤害为${event.damage}`}。`;
  }
}
function actualDecisions(source: MediaSource, events: MediaEvent[], lookback: number): MediaDecision[] {
  const found = new Map<string, MediaDecision>();
  for (const event of events) {
    const decision = source.decisions.filter(d => d.factionId === event.factionId && d.intent?.trim() && d.tick <= event.tick && (d.eventIds?.includes(event.id) || event.tick - d.tick <= lookback)).sort((a, b) => Number(Boolean(b.eventIds?.includes(event.id))) - Number(Boolean(a.eventIds?.includes(event.id))) || b.tick - a.tick)[0];
    if (decision) found.set(decision.id, decision);
  }
  return [...found.values()];
}
function positive(value: number, name: string, allowZero = false): number { if (!finite(value) || (allowZero ? value < 0 : value <= 0)) throw new Error(`${name} must be ${allowZero ? 'nonnegative' : 'positive'}`); return value; }

function openingCaption(source: MediaSource): string {
  return `本局参赛方为${source.factions.map(f => `${f.label}（${f.modelLabel}）`).join('、')}。`;
}
function resultCaption(source: MediaSource): string {
  if (!source.outcome) return '本段回放记录到此结束，尚无已确认的终局结果。';
  const winners = source.outcome.standings.filter(s => s.rank === 1).map(s => label(source, s.factionId));
  return `本局已结束。${winners.length ? `${winners.join('、')}排名第一。` : ''}裁判记录的结束原因为“${source.outcome.reason}”。`;
}
function hasFinalOutcome(source: MediaSource): boolean {
  return !!source.outcome && (source.outcome.tick ?? source.durationTicks) === source.durationTicks;
}
function finishStoryboard(source: MediaSource, segments: StorySegment[]): Storyboard {
  const storyboard = retimeStoryboard({ version: 1, runId: source.runId, durationTicks: source.durationTicks, ticksPerSecond: source.ticksPerSecond ?? 10, durationSeconds: 0, sourceFingerprint: fingerprint(source), segments });
  assertStoryboard(storyboard, source);
  return storyboard;
}

export function buildStoryboard(source: MediaSource, options: StoryboardOptions = {}): Storyboard {
  assertMediaSource(source);
  const tps = source.ticksPerSecond ?? 10;
  const pre = positive(options.preRollTicks ?? Math.round(tps * 1.5), 'preRollTicks', true);
  const post = positive(options.postRollTicks ?? Math.round(tps * 2), 'postRollTicks', true);
  if (!Number.isInteger(pre) || !Number.isInteger(post)) throw new Error('preRollTicks and postRollTicks must be integers');
  const rate = positive(options.playbackRate ?? 1, 'playbackRate');
  const minimum = positive(options.minSegmentSeconds ?? 3, 'minSegmentSeconds');
  const openingDuration = positive(options.openingSeconds ?? 4, 'openingSeconds');
  const resultDuration = positive(options.resultSeconds ?? 4, 'resultSeconds');
  const lookback = positive(options.intentLookbackTicks ?? 100, 'intentLookbackTicks', true);
  const events = selectKeyEvents(source, options.maxEvents ?? 8);
  const groups: Array<{ start: number; end: number; events: MediaEvent[] }> = [];
  for (const event of events) {
    const start = Math.max(0, event.tick - pre);
    const end = Math.min(source.durationTicks, event.tick + post);
    const previous = groups.at(-1);
    if (previous && start <= previous.end) { previous.end = Math.max(previous.end, end); previous.events.push(event); }
    else groups.push({ start, end, events: [event] });
  }
  const openingText = openingCaption(source);
  const segments: StorySegment[] = [{ id: 'opening', kind: 'opening', eventIds: [], gameStartTick: 0, gameEndTick: 0, videoStartSeconds: 0, durationSeconds: openingDuration, caption: openingText, narration: openingText, playbackRate: 0, hold: { at: 'end', durationSeconds: openingDuration } }];
  for (const [i, group] of groups.entries()) {
    const decisions = actualDecisions(source, group.events, lookback);
    const text = group.events.map(event => fact(source, event)).join('') + decisions.map(d => `${label(source, d.factionId)}在第${d.tick}刻的原始战术声明是：“${d.intent!.trim()}”。`).join('');
    const movingDuration = (group.end - group.start) / tps / rate;
    const duration = Math.max(minimum, movingDuration);
    segments.push({ id: `event-${i + 1}`, kind: 'event', eventIds: group.events.map(e => e.id), decisionIds: decisions.map(d => d.id), gameStartTick: group.start, gameEndTick: group.end, videoStartSeconds: 0, durationSeconds: duration, caption: text, narration: text, playbackRate: movingDuration === 0 ? 0 : rate, ...(duration > movingDuration ? { hold: { at: 'end' as const, durationSeconds: duration - movingDuration } } : {}) });
  }
  const resultText = resultCaption(source);
  segments.push({ id: 'result', kind: 'result', eventIds: [], gameStartTick: source.durationTicks, gameEndTick: source.durationTicks, videoStartSeconds: 0, durationSeconds: resultDuration, caption: resultText, narration: resultText, playbackRate: 0, hold: { at: 'end', durationSeconds: resultDuration } });
  return finishStoryboard(source, segments);
}

/** Play the original match clock continuously, including runs with no key events. */
export function buildRecordingStoryboard(source: MediaSource): Storyboard {
  assertMediaSource(source);
  if (!hasFinalOutcome(source)) throw new MediaValidationError([{ path: 'outcome', message: 'full recording requires a recorded outcome at the final tick' }]);
  const end = source.durationTicks;
  const segments: StorySegment[] = [{
    id: 'opening', kind: 'opening', eventIds: [], gameStartTick: 0, gameEndTick: 0,
    videoStartSeconds: 0, durationSeconds: 1, playbackRate: 0, hold: { at: 'end', durationSeconds: 1 },
    caption: openingCaption(source), narration: '',
  }];
  if (end > 0) segments.push({
    id: 'replay', kind: 'replay', eventIds: [], gameStartTick: 0, gameEndTick: end,
    videoStartSeconds: 0, durationSeconds: end / (source.ticksPerSecond ?? 10), playbackRate: 1,
    caption: '', narration: '',
  });
  segments.push({
    id: 'result', kind: 'result', eventIds: [], gameStartTick: end, gameEndTick: end,
    videoStartSeconds: 0, durationSeconds: 3, playbackRate: 0, hold: { at: 'end', durationSeconds: 3 },
    caption: resultCaption(source), narration: '',
  });
  return finishStoryboard(source, segments);
}

/** Recompute video starts after an approved edit or measured narration extension. */
export function retimeStoryboard(storyboard: Storyboard): Storyboard {
  let time = 0;
  const segments = storyboard.segments.map(segment => { const next = { ...segment, eventIds: [...segment.eventIds], ...(segment.decisionIds ? { decisionIds: [...segment.decisionIds] } : {}), ...(segment.hold ? { hold: { ...segment.hold } } : {}), videoStartSeconds: time }; time += segment.durationSeconds; return next; });
  return { ...storyboard, segments, durationSeconds: time };
}

export function validateStoryboard(storyboard: Storyboard, source: MediaSource): ValidationResult {
  const checked = validateMediaSource(source);
  if (!checked.valid) return checked;
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!isObject(storyboard)) return { valid: false, issues: [{ path: 'storyboard', message: 'must be an object' }] };
  if (storyboard.version !== 1) add('version', 'unsupported storyboard version');
  if (storyboard.runId !== source.runId || storyboard.durationTicks !== source.durationTicks || storyboard.ticksPerSecond !== (source.ticksPerSecond ?? 10)) add('source', 'run id or original clock does not match the persisted source');
  if (storyboard.sourceFingerprint !== fingerprint(source)) add('sourceFingerprint', 'source facts have changed');
  if (!Array.isArray(storyboard.segments) || storyboard.segments.length < 2) return { valid: false, issues: [...issues, { path: 'segments', message: 'opening and result segments are required' }] };
  const fullRecording = storyboard.segments.some(segment => segment?.kind === 'replay');
  if (fullRecording && !hasFinalOutcome(source)) add('outcome', 'full recording requires a recorded outcome at the final tick');
  const events = new Map(source.events.map(e => [e.id, e]));
  const decisions = new Map(source.decisions.map(d => [d.id, d]));
  const ids = new Set<string>();
  const usedEvents = new Set<string>();
  let previousTick = 0;
  let time = 0;
  storyboard.segments.forEach((segment, i) => {
    const path = `segments[${i}]`;
    if (!isObject(segment)) { add(path, 'must be an object'); return; }
    if (!nonempty(segment.id) || ids.has(segment.id)) add(`${path}.id`, 'must be unique and nonempty');
    ids.add(segment.id);
    if (!['opening', 'event', 'replay', 'result'].includes(segment.kind)) add(`${path}.kind`, 'unsupported segment kind');
    if (segment.kind === 'opening' && i !== 0 || segment.kind === 'result' && i !== storyboard.segments.length - 1) add(`${path}.kind`, 'opening/result must be the first/last segment');
    if (segment.kind === 'replay') {
      if (i !== 1 || storyboard.segments.length !== 3) add(`${path}.kind`, 'replay must be the single segment between opening and result');
      if (segment.gameStartTick !== 0 || segment.gameEndTick !== source.durationTicks || segment.playbackRate !== 1 || segment.hold !== undefined) add(`${path}.gameStartTick`, 'replay must cover the full recorded game clock at 1× without a hold');
      if (segment.eventIds?.length || segment.decisionIds?.length) add(`${path}.eventIds`, 'replay cannot cite individual event or decision records');
    }
    if (!Number.isInteger(segment.gameStartTick) || !Number.isInteger(segment.gameEndTick) || segment.gameStartTick < previousTick || segment.gameEndTick < segment.gameStartTick || segment.gameEndTick > source.durationTicks) add(`${path}.gameStartTick`, 'game intervals must be ordered, nonoverlapping and within the recorded run');
    previousTick = segment.gameEndTick;
    if (!finite(segment.videoStartSeconds) || Math.abs(segment.videoStartSeconds - time) > EPSILON) add(`${path}.videoStartSeconds`, 'video intervals must be contiguous and ordered');
    if (!finite(segment.durationSeconds) || segment.durationSeconds <= 0) add(`${path}.durationSeconds`, 'must be positive and finite');
    if (!finite(segment.playbackRate) || segment.playbackRate < 0) add(`${path}.playbackRate`, 'must be nonnegative and finite');
    if (typeof segment.caption !== 'string' || typeof segment.narration !== 'string') add(`${path}.caption`, 'caption and narration must be strings');
    if (segment.narrationDurationSeconds !== undefined && (!finite(segment.narrationDurationSeconds) || segment.narrationDurationSeconds <= 0 || segment.narrationDurationSeconds > segment.durationSeconds + EPSILON)) add(`${path}.narrationDurationSeconds`, 'measured speech must fit completely inside its segment');
    let hold = 0;
    if (segment.hold !== undefined) {
      if (!isObject(segment.hold) || segment.hold.at !== 'end' || !finite(segment.hold.durationSeconds) || segment.hold.durationSeconds <= 0) add(`${path}.hold`, 'requires at=end and a positive duration');
      else hold = segment.hold.durationSeconds;
    }
    const ticks = segment.gameEndTick - segment.gameStartTick;
    const movement = ticks === 0 ? 0 : ticks / storyboard.ticksPerSecond / segment.playbackRate;
    if (ticks > 0 && segment.playbackRate <= 0 || ticks === 0 && segment.playbackRate !== 0 || !finite(movement) || Math.abs(movement + hold - segment.durationSeconds) > EPSILON) add(`${path}.durationSeconds`, 'must equal game span / ticksPerSecond / playbackRate plus the explicit end hold');
    if (!Array.isArray(segment.eventIds)) add(`${path}.eventIds`, 'must be an array of recorded event ids');
    else {
      if (segment.kind === 'event' && segment.eventIds.length === 0) add(`${path}.eventIds`, 'event segments need a recorded event');
      for (const id of segment.eventIds) {
        const event = events.get(id);
        if (!event) add(`${path}.eventIds`, `unknown event ${String(id)}`);
        else if (event.tick < segment.gameStartTick || event.tick > segment.gameEndTick) add(`${path}.eventIds`, `event ${id} is outside the game interval`);
        if (usedEvents.has(id)) add(`${path}.eventIds`, `duplicate event reference ${id}`);
        usedEvents.add(id);
      }
    }
    if (segment.decisionIds !== undefined) {
      if (!Array.isArray(segment.decisionIds) || new Set(segment.decisionIds).size !== segment.decisionIds.length) add(`${path}.decisionIds`, 'must be unique recorded decision ids');
      else for (const id of segment.decisionIds) { const decision = decisions.get(id); if (!decision || !decision.intent?.trim() || decision.tick > segment.gameEndTick) add(`${path}.decisionIds`, `missing, empty or future decision ${String(id)}`); }
    }
    time += segment.durationSeconds;
  });
  const first = storyboard.segments[0];
  const last = storyboard.segments.at(-1)!;
  if (first?.kind !== 'opening' || first.gameStartTick !== 0) add('segments[0]', 'must open at the first real replay tick');
  if (last?.kind !== 'result' || last.gameEndTick !== source.durationTicks) add('segments[last]', 'must show the last recorded replay tick');
  if (!finite(storyboard.durationSeconds) || Math.abs(time - storyboard.durationSeconds) > EPSILON) add('durationSeconds', 'does not match segment durations');
  return { valid: issues.length === 0, issues };
}
export function assertStoryboard(storyboard: Storyboard, source: MediaSource): void { const result = validateStoryboard(storyboard, source); if (!result.valid) throw new MediaValidationError(result.issues); }

export function segmentAtVideoTime(storyboard: Storyboard, seconds: number): StorySegment {
  if (!finite(seconds) || seconds < 0 || seconds > storyboard.durationSeconds + EPSILON) throw new RangeError('Video time is outside the storyboard');
  return storyboard.segments.find(s => seconds < s.videoStartSeconds + s.durationSeconds - EPSILON) ?? storyboard.segments.at(-1)!;
}
export function videoToGameTick(storyboard: Storyboard, seconds: number): number {
  const segment = segmentAtVideoTime(storyboard, seconds);
  return Math.min(segment.gameEndTick, segment.gameStartTick + Math.max(0, seconds - segment.videoStartSeconds) * storyboard.ticksPerSecond * segment.playbackRate);
}
/** A replay tick can have a range during a hold, or no image at all when the edit skips it. */
export function gameTickToVideoRange(storyboard: Storyboard, tick: number): { startSeconds: number; endSeconds: number } | null {
  if (!finite(tick) || tick < 0 || tick > storyboard.durationTicks) throw new RangeError('Game tick is outside the recorded run');
  const matches = storyboard.segments.filter(s => tick >= s.gameStartTick && tick <= s.gameEndTick);
  if (!matches.length) return null;
  const ranges = matches.map(s => {
    const start = s.videoStartSeconds + (s.playbackRate === 0 ? 0 : (tick - s.gameStartTick) / storyboard.ticksPerSecond / s.playbackRate);
    return { startSeconds: start, endSeconds: start + (tick === s.gameEndTick ? s.hold?.durationSeconds ?? 0 : 0) };
  });
  return { startSeconds: Math.min(...ranges.map(r => r.startSeconds)), endSeconds: Math.max(...ranges.map(r => r.endSeconds)) };
}
export function gameToVideoTime(storyboard: Storyboard, tick: number): number | null { return gameTickToVideoRange(storyboard, tick)?.startSeconds ?? null; }
