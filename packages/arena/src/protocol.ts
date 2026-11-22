import { applyMove, applyUpgrade } from '../../../.generated/state-conquest/src/core/commands.js';
import { computeFrontPlan, frontForSource, startFront, stopFront } from '../../../.generated/state-conquest/src/core/fronts.js';
import type { ArenaAction, ArenaDecision, DecisionReceipt, MatchState, SeatId, StoredResponse } from './types.js';
import { SEAT_TO_OWNER } from './types.js';
import { createAliases } from './observation.js';
import { clone } from './canonical.js';
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export function parseDecision(text: string, decisionId: string): { decision?: ArenaDecision; error?: string } {
  if (typeof text !== 'string' || text.length > 65536) return { error: 'response must be a string of at most 65536 characters' };
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { error: 'invalid JSON' }; }
  if (!plain(v) || !fields(v, ['decision_id','intent','actions','memory_note','diplomacy'])) return { error: 'unexpected decision fields or non-object response' };
  if (v.decision_id !== decisionId) return { error: 'decision_id mismatch' };
  if (typeof v.intent !== 'string' || v.intent.length > 2000 || typeof v.memory_note !== 'string' || v.memory_note.length > 2000) return { error: 'intent and memory_note must be strings of at most 2000 characters' };
  if (!Array.isArray(v.actions) || v.actions.length > 3) return { error: 'actions must be an array of at most 3 actions' };
  if (v.diplomacy !== undefined && (!Array.isArray(v.diplomacy) || v.diplomacy.length > 4)) return { error: 'diplomacy must be an array of at most 4 operations' };
  // Each command is retained and validated individually; no strategy correction.
  return { decision: v as unknown as ArenaDecision };
}
export function validateAction(value: unknown): string | undefined {
  if (!plain(value) || !fields(value, ['type','source','target','ratio','territory','kind'])) return 'invalid action fields';
  const a = value as unknown as ArenaAction;
  if (!['move','upgrade','set_front','stop_front','wait'].includes(a.type)) return 'unknown action type';
  const keys: Record<ArenaAction['type'], string[]> = { move:['type','source','target','ratio'], set_front:['type','source','target','ratio'], upgrade:['type','territory','kind'], stop_front:['type','source'], wait:['type'] };
  if (!fields(value, keys[a.type])) return 'unexpected fields for action type';
  if (a.type === 'move' || a.type === 'set_front') {
    if (typeof a.source !== 'string' || typeof a.target !== 'string' || typeof a.ratio !== 'number' || !Number.isFinite(a.ratio) || a.ratio < 0 || a.ratio > 1) return 'source, target and finite ratio in [0,1] required';
  } else if (a.type === 'upgrade') {
    if (typeof a.territory !== 'string' || !['production','march','defense'].includes(a.kind as string)) return 'territory and valid kind required';
  } else if (a.type === 'stop_front' && typeof a.source !== 'string') return 'source required';
  return undefined;
}
export function applyArenaAction(state: MatchState, seat: SeatId, value: unknown, actionIndex: number) {
  const base = { seat, actionIndex, action: clone(value) };
  const error = validateAction(value);
  if (error) return { ...base, accepted: false, reason: error };
  const a = value as ArenaAction, owner = SEAT_TO_OWNER[seat];
  const { toId } = createAliases(state);
  const source = a.source ? toId[a.source] : undefined;
  const target = a.target ? toId[a.target] : undefined;
  if (a.type === 'wait') return { ...base, accepted: true };
  if (a.type === 'upgrade') {
    const id = toId[a.territory!];
    if (!id) return { ...base, accepted: false, reason: 'unknown territory alias' };
    const result = applyUpgrade(state, owner, id, a.kind);
    return { ...base, accepted: result.ok, reason: result.reason, result };
  }
  if (!source || ((a.type === 'move' || a.type === 'set_front') && !target)) return { ...base, accepted: false, reason: 'unknown territory alias' };
  if (a.type === 'move') {
    const result = applyMove(state, owner, source, target!, a.ratio!);
    return { ...base, accepted: result.ok, reason: result.reason, result };
  }
  if (a.type === 'stop_front') {
    if (state.status !== 'playing' || state.tick >= state.durationTicks || state.territories[source]?.owner !== owner) return { ...base, accepted: false, reason: 'not_own_or_not_playing' };
    const stopped = stopFront(state, owner, source);
    return { ...base, accepted: true, result: { stopped } };
  }
  const plan = computeFrontPlan(state, owner, source, target!, a.ratio!);
  if (!plan.ok) return { ...base, accepted: false, reason: plan.reason };
  const existing = frontForSource(state, owner, source);
  if (existing && existing.targetId === target) {
    // Preserve id, cadence, waves and paid armies; an explicit set is never a UI toggle.
    existing.ratio = a.ratio!;
    return { ...base, accepted: true, result: { action: 'set', frontId: existing.id } };
  }
  const result = startFront(state, owner, source, target!, a.ratio!);
  return { ...base, accepted: result.ok, reason: result.reason, result };
}
export function createReceipt(stored: StoredResponse): { decision?: ArenaDecision; receipt: DecisionReceipt } {
  const parsed = parseDecision(stored.response.text, stored.decisionId);
  return { decision: parsed.decision, receipt: { seat: stored.seat, decisionId: stored.decisionId, obsHash: stored.obsHash, valid: !!parsed.decision, parseError: parsed.error, actions: [], diplomacy: [] } };
}
