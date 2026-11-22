import { getMapForMatch, validateMap } from '../../../.generated/state-conquest/src/maps/index.js';
import { createMatchState } from '../../../.generated/state-conquest/src/core/state.js';
import { noDisaster } from '../../../.generated/state-conquest/src/core/disaster.js';
import { advanceOneTick } from '../../../.generated/state-conquest/src/core/engine.js';
import { computeScores, computeTerritoryCounts, computeTotalForces, isFactionAlive } from '../../../.generated/state-conquest/src/core/score.js';
import { STALEMATE_WARNING_TICKS, STALEMATE_END_TICKS, TICKS_PER_SECOND } from '../../../.generated/state-conquest/src/config/balance.js';
import type { ArenaConfig, ArenaCheckpoint, ArenaAuxState, MatchState, ArenaRank, SeatId, MatchEvent, ArenaRound, ArenaDecision } from './types.js';
import { SEATS, SEAT_TO_OWNER, OWNER_TO_SEAT } from './types.js';
import { clone, sha256 } from './canonical.js';
import { createReceipt, applyArenaAction } from './protocol.js';
import { applyDiplomacy, maintainArenaDiplomacy } from './diplomacy.js';

export function validateConfig(config: ArenaConfig): ArenaConfig {
  if (!config || !['strategy','diplomacy'].includes(config.track)) throw new Error('track must be strategy or diplomacy');
  if (!Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff) throw new Error('seed must be a uint32 integer');
  if (![180,300,480].includes(config.durationSeconds) || ![2,3,4].includes(config.factionCount)) throw new Error('invalid durationSeconds or factionCount');
  if (!Array.isArray(config.models) || config.models.length !== config.factionCount || config.models.some(m => typeof m !== 'string' || !m.length)) throw new Error('models must contain one nonempty model id per faction');
  if ((config.decisionTicks !== undefined && config.decisionTicks !== 20) || (config.maxActions !== undefined && config.maxActions !== 3)) throw new Error('arena v1 requires decisionTicks=20 and maxActions=3');
  if (config.disaster !== undefined && typeof config.disaster !== 'boolean') throw new Error('disaster must be boolean');
  if (!config.budget || !Number.isSafeInteger(config.budget.maxCalls) || config.budget.maxCalls < 0) throw new Error('maxCalls must be a nonnegative integer');
  if (config.budget.maxCostUsd !== undefined && (!Number.isFinite(config.budget.maxCostUsd) || config.budget.maxCostUsd < 0)) throw new Error('maxCostUsd must be finite and nonnegative');
  if (config.initiativeOffset !== undefined && !Number.isSafeInteger(config.initiativeOffset)) throw new Error('initiativeOffset must be an integer');
  if (config.id !== undefined && (typeof config.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(config.id))) throw new Error('id must contain 1..100 letters, digits, underscores or hyphens');
  return clone({ ...config, id: config.id ?? `arena-${sha256(config).slice(0,16)}`, decisionTicks: 20, maxActions: 3, disaster: config.disaster ?? false, initiativeOffset: config.initiativeOffset ?? 0 });
}
export function fingerprint(state: MatchState, aux: ArenaAuxState): string { return sha256({ state, aux }); }
export function checkpoint(state: MatchState, aux: ArenaAuxState, roundIndex: number): ArenaCheckpoint {
  const copy = clone({ roundIndex, state, aux });
  return { ...copy, fingerprint: fingerprint(copy.state, copy.aux) };
}
export function createInitialCheckpoint(config: ArenaConfig): ArenaCheckpoint {
  const { map } = getMapForMatch(undefined, config.durationSeconds, config.seed, config.factionCount);
  const validation = validateMap(map);
  if (!validation.ok) throw new Error(`Map validation failed: ${validation.errors.join('; ')}`);
  const state = createMatchState(map, 'normal', config.durationSeconds * TICKS_PER_SECOND, config.seed, 0, 'solo', config.factionCount, config.track === 'diplomacy');
  if (state.activeOwners.length !== config.factionCount || state.activeOwners.some((o,i) => o !== SEAT_TO_OWNER[SEATS[i]])) throw new Error('activeOwners does not match requested factionCount');
  if (!config.disaster) state.disaster = noDisaster();
  state.status = 'playing';
  const aux: ArenaAuxState = { eliminatedAt: {}, offers: [], messages: [], nextOfferId: 1, nextMessageId: 1, memoryNotes: {}, budget: { calls: 0, knownCostUsd: 0, unknownCostCalls: 0, reservedCalls: 0, reservedCostUsd: 0 }, result: null };
  return checkpoint(state, aux, -1);
}
export function canonicalizeEvents(events: MatchEvent[]): MatchEvent[] {
  // Core emits both capture and front/capture for the same wave; only the real capture remains.
  const captures=new Set(events.filter(e=>e.type==='capture').map(e=>`${e.tick}:${e.targetId}:${e.owner??''}`));
  return clone(events.filter(e => !(e.type === 'front' && e.frontAction === 'capture' && captures.has(`${e.tick}:${e.targetId}:${e.owner??''}`)) && !(e.type === 'defend' && e.amount <= 0)));
}
export function rankFactions(state: MatchState, aux: ArenaAuxState): ArenaRank[] {
  const scores = computeScores(state), lands = computeTerritoryCounts(state), forces = computeTotalForces(state);
  const rows = state.activeOwners.map(owner => ({ seat: OWNER_TO_SEAT[owner], rank: 0, alive: isFactionAlive(state, owner), score: scores[owner] ?? 0, lands: lands[owner] ?? 0, force: forces[owner] ?? 0, eliminatedAtTick: aux.eliminatedAt[OWNER_TO_SEAT[owner]] }));
  const compare = (a: ArenaRank, b: ArenaRank) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.alive) return b.score-a.score || b.lands-a.lands || b.force-a.force;
    return (b.eliminatedAtTick ?? state.tick)-(a.eliminatedAtTick ?? state.tick);
  };
  rows.sort((a,b)=>compare(a,b) || SEATS.indexOf(a.seat)-SEATS.indexOf(b.seat));
  rows.forEach((r,i)=>{ r.rank = i && compare(rows[i-1],r) === 0 ? rows[i-1].rank : i+1; });
  return rows;
}
export function adjudicate(state: MatchState, aux: ArenaAuxState): void {
  if (state.status === 'ended') return;
  for (const owner of state.activeOwners) {
    const seat = OWNER_TO_SEAT[owner];
    if (!isFactionAlive(state, owner) && aux.eliminatedAt[seat] === undefined) {
      aux.eliminatedAt[seat] = state.tick;
      state.events.push({ type: 'eliminated', tick: state.tick, targetId: '', amount: 0, owner });
    }
  }
  const alive = state.activeOwners.filter(o => isFactionAlive(state, o));
  const noProgress = state.tick - (state.lastProgressTick ?? 0);
  state.stalemateWarned = noProgress >= STALEMATE_WARNING_TICKS;
  const reason = alive.length <= 1 ? 'elimination' : noProgress >= STALEMATE_END_TICKS ? 'stalemate' : state.tick >= state.durationTicks ? 'timeout' : null;
  if (!reason) return;
  const ranking = rankFactions(state, aux);
  aux.result = { reason, tick: state.tick, ranking, winners: ranking.filter(r=>r.rank===1).map(r=>r.seat) };
  state.status = 'ended'; state.endReason = reason;
  const a = ranking.find(r=>r.seat==='A')!;
  state.result = a.rank !== 1 ? 'lose' : ranking.filter(r=>r.rank===1).length > 1 ? 'draw' : 'win';
  aux.offers = [];
}
export function initiativeOrder(seats: SeatId[], index: number, offset: number): SeatId[] {
  // Rotate over the fixed seated roster before filtering dead seats.
  const n = seats.length;
  if (!n) return [];
  const rotation = ((index + offset) % n + n) % n;
  return seats.slice(rotation).concat(seats.slice(0,rotation));
}
export function accountRound(base: ArenaAuxState, round: ArenaRound, reservations: Partial<Record<SeatId,number>>): ArenaAuxState {
  const aux = clone(base);
  aux.budget.reservedCalls = 0; aux.budget.reservedCostUsd = 0;
  for (const seat of round.seats) {
    const saved = round.responses[seat];
    if (!saved) { aux.budget.reservedCalls++; aux.budget.reservedCostUsd += reservations[seat] ?? 0; }
    const attempts = round.attempts[seat] ?? [];
    for (const attempt of attempts) {
      aux.budget.calls++;
      const cost = attempt.status === 'answered' ? saved?.response.costUsd : attempt.costUsd;
      if (cost === undefined) aux.budget.unknownCostCalls++;
      else aux.budget.knownCostUsd += cost;
    }
  }
  return aux;
}
/** Pure transaction: commands and ticks run on copies; caller publishes only after durable COMMIT. */
export function executeRound(base: ArenaCheckpoint, original: ArenaRound, config: ArenaConfig, reservations: Partial<Record<SeatId,number>>, stopAtTick?: number): { round: ArenaRound; checkpoint: ArenaCheckpoint } {
  const state = clone(base.state), round = clone(original);
  const aux = accountRound(base.aux, round, reservations);
  const decisions: Partial<Record<SeatId, ArenaDecision>> = {};
  round.events = []; round.receipts = {};
  for (const seat of round.seats) {
    const saved = round.responses[seat];
    if (!saved || saved.obsHash !== round.obsHashes[seat] || saved.decisionId !== round.observations[seat]?.decision_id) throw new Error(`Missing or mismatched sealed response for ${seat}`);
    const parsed = createReceipt(saved);
    decisions[seat] = parsed.decision; round.receipts[seat] = parsed.receipt;
    if (parsed.decision) aux.memoryNotes[seat] = parsed.decision.memory_note;
  }
  const order = initiativeOrder(SEATS.slice(0,config.factionCount), round.index, config.initiativeOffset ?? 0).filter(s=>round.seats.includes(s));
  // Diplomacy operations are sealed too; newly offered consent can only arrive next round.
  for (let i=0;i<4;i++) for (const seat of order) {
    const operation = decisions[seat]?.diplomacy?.[i];
    if (operation !== undefined) round.receipts[seat]!.diplomacy.push(applyDiplomacy(state,aux,config,seat,operation,i,round.index));
  }
  for (let i=0;i<3;i++) for (const seat of order) {
    const action = decisions[seat]?.actions[i];
    if (action !== undefined) round.receipts[seat]!.actions.push(applyArenaAction(state,seat,action,i));
  }
  const drain = () => { const events = canonicalizeEvents(state.events); state.events.length=0; if(events.length) round.events.push({ tick: state.tick, events }); };
  adjudicate(state,aux); drain();
  const limit = Math.min(round.startTick+20, state.durationTicks, stopAtTick ?? Infinity);
  while (state.status === 'playing' && state.tick < limit) {
    advanceOneTick(state, { aiEnabled: false, resolveEndChecks: false });
    maintainArenaDiplomacy(state,aux);
    adjudicate(state,aux); drain();
  }
  round.endTick = state.tick; round.committed = stopAtTick === undefined;
  const cp = checkpoint(state,aux,round.index);
  round.fingerprint = cp.fingerprint;
  return { round, checkpoint: cp };
}
