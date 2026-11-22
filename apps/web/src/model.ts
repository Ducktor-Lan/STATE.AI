import type { CreateRunInput, ModelSummary, RoundIndex, RunEvent, RunSummary, Seat, SpectatorAccess, StartBudget, Storyboard } from './api';

export const SEATS: readonly Seat[] = ['player', 'ai1', 'ai2', 'ai3'];
export const SEAT_LABELS: Record<Seat, string> = { player: '蓝方', ai1: '红方', ai2: '橙方', ai3: '紫方' };
export const RUN_LABELS: Record<RunSummary['status'], string> = {
  queued: '待开局', running: '进行中', waiting: '模型思考中', paused: '已暂停', completed: '已结束', failed: '运行失败',
};
export function formatClock(ticks: number): string {
  const seconds = Math.floor(Math.max(0, ticks) / 10);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
export function formatElapsed(ms: number): string { return formatClock(Math.max(0, ms) / 100); }
export function formatUsd(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '未计价' : `$${value.toFixed(value > 0 && value < 0.01 ? 6 : 3)}`;
}
export function formatStartBudgetUsd(value: number): string {
  const cents = Math.floor(value * 100);
  // A cent-aligned USD value can multiply to slightly above its integer cents.
  const lower = cents / 100;
  const rounded = lower >= value ? lower : (cents + 1) / 100;
  return `$${rounded.toFixed(2)}`;
}
export function startBudgetStopField(run: RunSummary, resumeBudget?: StartBudget): 'maxCalls' | 'maxCostUsd' | undefined {
  if (run.status !== 'paused' || run.tick !== 0 || run.calls !== 0) return;
  if (run.error === 'max_calls_budget' || resumeBudget && run.budget.maxCalls < resumeBudget.requiredCalls) return 'maxCalls';
  if (run.error === 'max_cost_reservation_budget' || resumeBudget && run.budget.maxCostUsd < resumeBudget.requiredCostUsd) return 'maxCostUsd';
}
export function modelLabel(id: string, models: ModelSummary[]): string {
  return models.find(model => model.id === id)?.label ?? id;
}
export function defaultModels(models: ModelSummary[], count: number): string[] {
  const available = models.filter(model => model.available);
  const first = available.find(model => model.kind === 'baseline') ?? available[0];
  return Array.from({ length: count }, () => first?.id ?? '');
}
export function validateRun(input: CreateRunInput, models: ModelSummary[]): string[] {
  const errors: string[] = [];
  if (!['strategy', 'diplomacy'].includes(input.track)) errors.push('请选择比赛赛道。');
  if (![2, 3, 4].includes(input.factionCount)) errors.push('阵营数量应为 2 至 4 方。');
  if (input.track === 'diplomacy' && input.factionCount < 3) errors.push('外交赛需要至少三方参赛。');
  if (![180, 300, 480].includes(input.durationSeconds)) errors.push('请选择 180、300 或 480 秒。');
  if (!Number.isSafeInteger(input.seed) || input.seed < 1 || input.seed > 0xffffffff) errors.push('种子须为 1 至 4294967295 的整数。');
  if (input.models.length !== input.factionCount) errors.push('每个阵营都需要选择一个模型。');
  input.models.forEach((id, index) => {
    if (!models.some(model => model.id === id && model.available)) errors.push(`${SEAT_LABELS[SEATS[index] ?? 'player']}的模型当前不可用。`);
  });
  if (!Number.isSafeInteger(input.budget.maxCalls) || input.budget.maxCalls < 1) errors.push('调用上限须为正整数。');
  if (!Number.isFinite(input.budget.maxCostUsd) || input.budget.maxCostUsd < 0) errors.push('USD 预算须为非负数。');
  return errors;
}
/** Bound an API request to the persisted run. Only the server supplies the actual state. */
export function recordedTick(requested: number, maximum: number): number {
  return Math.min(Math.max(0, Math.floor(requested)), Math.max(0, maximum));
}
export function roundAt(tick: number, rounds: RoundIndex[]): RoundIndex | undefined {
  return rounds.filter(round => round.tick <= tick).sort((a, b) => b.tick - a.tick || b.round - a.round)[0];
}
export function visibleEvents(events: RunEvent[], access?: SpectatorAccess): RunEvent[] {
  return events.filter(event => event.visibility !== 'private' || access?.privateMessages === true);
}
/** Add an actual event without duplicating references or overlapping source intervals. */
export function addStoryEvent(board: Storyboard, event: RunEvent, id: string): { board: Storyboard; segmentId: string } {
  if (event.visibility === 'private') throw new Error('节目仅能引用公开事件。');
  if (!Number.isInteger(event.tick) || event.tick < 0 || event.tick > board.durationTicks) throw new Error('事件不在已记录战局范围内。');
  const segments = board.segments.map(segment => ({ ...segment, eventIds: [...segment.eventIds] }));
  const duplicate = segments.find(segment => segment.eventIds.includes(event.id));
  if (duplicate) return { board, segmentId: duplicate.id };
  const enclosing = segments.find(segment => segment.kind === 'event' && segment.gameStartTick <= event.tick && segment.gameEndTick >= event.tick);
  let segmentId = id;
  if (enclosing) { enclosing.eventIds.push(event.id); segmentId = enclosing.id; }
  else {
    const events = segments.filter(segment => segment.kind === 'event');
    const previous = events.filter(segment => segment.gameEndTick < event.tick).sort((a, b) => b.gameEndTick - a.gameEndTick)[0];
    const next = events.filter(segment => segment.gameStartTick > event.tick).sort((a, b) => a.gameStartTick - b.gameStartTick)[0];
    const start = Math.max(0, event.tick - 20, previous?.gameEndTick ?? 0);
    const end = Math.min(board.durationTicks, event.tick + 40, next?.gameStartTick ?? board.durationTicks);
    const movingSeconds = (end - start) / board.ticksPerSecond;
    segments.push({ id, kind: 'event', eventIds: [event.id], gameStartTick: start, gameEndTick: end, videoStartSeconds: 0, durationSeconds: movingSeconds || 2, playbackRate: movingSeconds ? 1 : 0, caption: eventTitle(event), narration: '', ...(!movingSeconds ? { hold: { at: 'end' as const, durationSeconds: 2 } } : {}) });
  }
  const order = { opening: 0, event: 1, replay: 1, result: 2 };
  segments.sort((a, b) => order[a.kind] - order[b.kind] || a.gameStartTick - b.gameStartTick);
  let durationSeconds = 0;
  for (const segment of segments) { segment.videoStartSeconds = durationSeconds; durationSeconds += segment.durationSeconds; }
  return { board: { ...board, segments, durationSeconds }, segmentId };
}
export function parseSeeds(raw: string): number[] {
  const seeds = [...new Set(raw.split(/[\s,，]+/).filter(Boolean).map(Number))];
  if (!seeds.length || seeds.some(seed => !Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff)) throw new Error('种子列表须为 1 至 4294967295 的整数，以逗号或空格分隔。');
  return seeds;
}
export function isLive(run: RunSummary): boolean { return ['queued', 'running', 'waiting'].includes(run.status); }
export function eventTitle(event: RunEvent): string { return event.title || event.type; }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
