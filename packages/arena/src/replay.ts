import { toMatchSnapshot } from '../../../.generated/state-conquest/src/core/state.js';
import { isFactionAlive } from '../../../.generated/state-conquest/src/core/score.js';
import { advanceOneTick } from '../../../.generated/state-conquest/src/core/engine.js';
import type { ArenaCheckpoint, ArenaConfig, ArenaRecord, ArenaLogEntry, ArenaRound, SeatId, ActorResponse, ArenaFrame } from './types.js';
import { OWNER_TO_SEAT, SEAT_TO_OWNER } from './types.js';
import { clone, sha256, canonicalJson } from './canonical.js';
import { buildObservation } from './observation.js';
import { adjudicate, checkpoint, executeRound, validateConfig, createInitialCheckpoint } from './scheduler.js';
import { maintainArenaDiplomacy } from './diplomacy.js';
import { createReceipt } from './protocol.js';

export function createRound(base: ArenaCheckpoint, config: ArenaConfig): ArenaRound {
  const index = base.roundIndex + 1;
  const id = `${config.id}:r${index}`;
  const seats = base.state.activeOwners.filter(o=>isFactionAlive(base.state,o)).map(o=>OWNER_TO_SEAT[o]);
  const round: ArenaRound = { index,id,startTick:base.state.tick,endTick:base.state.tick,seats,observations:{},obsHashes:{},responses:{},attempts:{},memoryNotes:{},receipts:{},events:[],committed:false };
  for (const seat of seats) {
    const decisionId = `${id}:${seat}`;
    const observation = buildObservation(base.state,config,base.aux,seat,index,decisionId);
    const memoryNote = base.aux.memoryNotes[seat] ?? '';
    round.observations[seat]=observation; round.memoryNotes[seat]=memoryNote;
    round.obsHashes[seat]=sha256({ observation,memoryNote });
  }
  return round;
}
export function validateActorResponse(response: ActorResponse): void {
  if (!response || typeof response.text !== 'string') throw new Error('Actor must return {text:string}');
  if (response.costUsd !== undefined && (!Number.isFinite(response.costUsd) || response.costUsd < 0)) throw new Error('costUsd must be finite and nonnegative, or absent when unknown');
  if (response.usage !== undefined && (!response.usage || typeof response.usage !== 'object')) throw new Error('usage must be an object');
  if (response.usage) for (const key of ['inputTokens','outputTokens']) {
    const value = response.usage[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error(`Invalid usage.${key}`);
  }
  canonicalJson(response);
}
export interface RecordState {
  checkpoint: ArenaCheckpoint;
  pending?: ArenaRound;
  reservations: Partial<Record<SeatId,number>>;
  requireCostReservation: boolean;
  paused: boolean;
  pauseReason?: string;
  rounds: ArenaRound[];
}
export function applyLogEntry(current: RecordState, entry: ArenaLogEntry, config: ArenaConfig, verifyCommit = true): void {
  if (entry.type === 'CONTROL') { current.paused=entry.status==='paused'; current.pauseReason=entry.reason; return; }
  if (entry.type === 'BEGIN') {
    if (current.pending || current.checkpoint.aux.result) throw new Error('Unexpected BEGIN');
    const expected=createRound(current.checkpoint,config);
    if (canonicalJson(entry.round)!==canonicalJson(expected)) throw new Error('BEGIN does not match the frozen checkpoint and observation hashes');
    for (const [seat,cost] of Object.entries(entry.reservations)) if (!expected.seats.includes(seat as SeatId) || !Number.isFinite(cost) || cost < 0) throw new Error('Invalid cost reservation in BEGIN');
    current.pending=clone(entry.round);current.reservations=clone(entry.reservations);current.requireCostReservation=entry.requireCostReservation;return;
  }
  const round=current.pending;
  if (!round || entry.roundIndex!==round.index) throw new Error(`${entry.type} has no matching BEGIN`);
  if (entry.type === 'COMMIT') {
    if (round.seats.some(s=>!round.responses[s])) throw new Error('COMMIT before all decisions were sealed');
    if (verifyCommit) {
      const replayed=executeRound(current.checkpoint,round,config,current.reservations);
      if (canonicalJson(entry.round)!==canonicalJson(replayed.round) || canonicalJson(entry.checkpoint)!==canonicalJson(replayed.checkpoint)) throw new Error(`Replay fingerprint/checkpoint mismatch at round ${round.index}`);
    } else if (entry.checkpoint.fingerprint!==checkpoint(entry.checkpoint.state,entry.checkpoint.aux,entry.checkpoint.roundIndex).fingerprint) throw new Error('Checkpoint fingerprint mismatch');
    current.checkpoint=clone(entry.checkpoint);current.rounds.push(clone(entry.round));current.pending=undefined;current.reservations={};return;
  }
  const seat=entry.type==='DECISION'?entry.value.seat:entry.seat;
  if (!round.seats.includes(seat)) throw new Error('Unseated decision actor');
  const attempts=round.attempts[seat] ?? (round.attempts[seat]=[]);
  if (entry.type==='INVOKE') {
    if (round.responses[seat] || attempts.some(a=>a.status==='pending'||a.status==='failed') || attempts.some(a=>a.id===entry.attemptId)) throw new Error('Duplicate or uncertain invocation');
    attempts.push({id:entry.attemptId,status:'pending'});return;
  }
  if (entry.type==='DECISION') {
    if (round.responses[seat] || entry.value.obsHash!==round.obsHashes[seat] || entry.value.decisionId!==round.observations[seat]?.decision_id) throw new Error('Duplicate/mismatched DECISION');
    const attempt=attempts.at(-1);
    if (!attempt || attempt.status!=='pending') throw new Error('DECISION without pending invocation');
    validateActorResponse(entry.value.response);attempt.status='answered';attempt.costUsd=entry.value.response.costUsd;round.responses[seat]=clone(entry.value);round.receipts[seat]=createReceipt(entry.value).receipt;return;
  }
  if (entry.type==='COST') {
    const stored=round.responses[seat];
    if (!stored || stored.response.costUsd!==undefined || !Number.isFinite(entry.costUsd) || entry.costUsd<0) throw new Error('COST requires an unknown saved response cost');
    stored.response.costUsd=entry.costUsd;attempts.at(-1)!.costUsd=entry.costUsd;return;
  }
  const attempt=attempts.find(a=>a.id===entry.attemptId);
  if (!attempt || (attempt.status!=='pending'&&attempt.status!=='failed')) throw new Error('Attempt is not uncertain');
  if (entry.type==='FAILURE') { attempt.status='failed';attempt.error=entry.message;return; }
  if (entry.type==='SETTLE') {
    if (!Number.isFinite(entry.costUsd)||entry.costUsd<0) throw new Error('Invalid settlement cost');
    attempt.status='settled';attempt.costUsd=entry.costUsd;return;
  }
}
export function readRecord(record: ArenaRecord, verifyCommit=true): RecordState {
  if (!record || record.schemaVersion!==1 || record.manifest.schemaVersion!==1 || record.manifest.engine!=='state-conquest@35d7ca7+arena.1') throw new Error('Unsupported arena record version');
  const config=validateConfig(record.manifest.config);
  const initial=record.initialCheckpoint;
  if (initial.fingerprint!==checkpoint(initial.state,initial.aux,-1).fingerprint || initial.fingerprint!==record.manifest.initialFingerprint || initial.fingerprint!==createInitialCheckpoint(config).fingerprint) throw new Error('Initial checkpoint mismatch');
  const state: RecordState={checkpoint:clone(initial),reservations:{},requireCostReservation:false,paused:false,rounds:[]};
  for(const entry of record.entries) applyLogEntry(state,entry,config,verifyCommit);
  return state;
}
export function replayArenaRecord(record: ArenaRecord) {
  const result=readRecord(record,true);
  return { fingerprint:result.checkpoint.fingerprint,state:clone(result.checkpoint.state),result:clone(result.checkpoint.aux.result),pending:result.pending?clone(result.pending):undefined };
}
/** Seek from the nearest committed internal checkpoint; at most 20 original engine ticks are replayed. */
export function frameFromRecord(record: ArenaRecord, tick?: number): ArenaFrame {
  const commits=record.entries.filter((entry):entry is Extract<ArenaLogEntry,{type:'COMMIT'}>=>entry.type==='COMMIT');
  const latest=commits.at(-1)?.checkpoint??record.initialCheckpoint;
  const target=tick??latest.state.tick;
  if(!Number.isSafeInteger(target)||target<0||target>latest.state.tick)throw new Error('Frame tick must be a committed simulation tick');
  const prior=commits.findLast(entry=>entry.checkpoint.state.tick<=target);
  let base=prior?.checkpoint??record.initialCheckpoint;
  if(base.fingerprint!==checkpoint(base.state,base.aux,base.roundIndex).fingerprint)throw new Error('Frame checkpoint fingerprint mismatch');
  let events:ArenaFrame['events']=prior?.round.events.filter(e=>e.tick===target).flatMap(e=>e.events)??[];
  if(base.state.tick<target){
    const next=commits.find(entry=>entry.round.startTick===base.state.tick&&entry.checkpoint.state.tick>target);
    if(!next)throw new Error('No committed round contains the requested tick');
    const begin=record.entries.find((entry):entry is Extract<ArenaLogEntry,{type:'BEGIN'}>=>entry.type==='BEGIN'&&entry.round.index===next.roundIndex);
    if(!begin)throw new Error('Missing BEGIN for frame replay');
    const partial=executeRound(base,next.round,record.manifest.config,begin.reservations,target);
    base=partial.checkpoint;events=partial.round.events.filter(e=>e.tick===target).flatMap(e=>e.events);
  }
  return {tick:base.state.tick,snapshot:toMatchSnapshot(base.state),events:clone(events),fingerprint:base.fingerprint,result:clone(base.aux.result)};
}

/** Project a window from a verified record, limited to the session's published tick. */
export function frameWindowFromRecord(record: ArenaRecord, from: number, to: number, publishedTick: number): {
  frames: Pick<ArenaFrame, 'snapshot' | 'result'>[];
  rounds: ArenaRound[];
} {
  const frames: Pick<ArenaFrame, 'snapshot' | 'result'>[] = [];
  const rounds: ArenaRound[] = [];
  if (from > to) return { frames, rounds };

  const begins = new Map<number, Extract<ArenaLogEntry, { type: 'BEGIN' }>>();
  const commits: Extract<ArenaLogEntry, { type: 'COMMIT' }>[] = [];
  for (const entry of record.entries) {
    if (entry.type === 'BEGIN') begins.set(entry.round.index, entry);
    if (entry.type !== 'COMMIT') continue;
    if (entry.checkpoint.state.tick > publishedTick || entry.round.startTick > to) break;
    commits.push(entry);
  }

  const firstRound = commits.findLastIndex(({ round }) => round.startTick <= from);
  for (let index = Math.max(0, firstRound); index < commits.length; index++) rounds.push(commits[index]!.round);

  let index = commits.findLastIndex(({ checkpoint }) => checkpoint.state.tick <= from);
  let base = commits[index]?.checkpoint ?? record.initialCheckpoint;
  if (base.state.tick === from) frames.push({ snapshot: toMatchSnapshot(base.state), result: clone(base.aux.result) });

  while (frames.length < to - from + 1) {
    const commit = commits[++index];
    if (!commit || commit.round.startTick !== base.state.tick) throw new Error('No committed round contains the requested tick');
    const boundary = commit.checkpoint.state.tick;
    const interiorEnd = Math.min(to, boundary - 1);
    if (base.state.tick < interiorEnd) {
      const begin = begins.get(commit.roundIndex);
      if (!begin) throw new Error('Missing BEGIN for frame replay');
      // Apply sealed commands once. The scheduler and replay advance the same core tick,
      // diplomacy maintenance and adjudication. Snapshot events are drained by both paths.
      const { checkpoint: { state, aux } } = executeRound(base, commit.round, record.manifest.config, begin.reservations, base.state.tick);
      while (state.tick < interiorEnd) {
        if (state.status !== 'playing') throw new Error('Replay ended before the committed boundary');
        advanceOneTick(state, { aiEnabled: false, resolveEndChecks: false });
        maintainArenaDiplomacy(state, aux);
        adjudicate(state, aux);
        state.events.length = 0;
        if (state.tick >= from) frames.push({ snapshot: toMatchSnapshot(state), result: clone(aux.result) });
      }
    }
    if (boundary <= to) {
      // At the boundary use the last commit at that tick, before any following round's commands.
      while (commits[index + 1]?.checkpoint.state.tick === boundary) index++;
      base = commits[index]!.checkpoint;
      frames.push({ snapshot: toMatchSnapshot(base.state), result: clone(base.aux.result) });
    }
  }
  return { frames, rounds };
}
