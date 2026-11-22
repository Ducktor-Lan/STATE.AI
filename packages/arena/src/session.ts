import { toMatchSnapshot } from '../../../.generated/state-conquest/src/core/state.js';
import type { ActorRequest, ArenaActor, ArenaConfig, ArenaSessionOptions, ArenaRecord, ArenaLogEntry, ArenaRound, SeatId, ArenaStore, ArenaFrame, ArenaPersistenceDiagnostic } from './types.js';
import { ArenaInfrastructureError, ArenaPausedError } from './types.js';
import { clone, freeze } from './canonical.js';
import { validateConfig, createInitialCheckpoint, accountRound, executeRound } from './scheduler.js';
import { applyLogEntry, readRecord, createRound, frameFromRecord, validateActorResponse } from './replay.js';
import type { RecordState } from './replay.js';
import { bindBaselineContext } from './baseline.js';

export class ArenaSession {
  readonly config: Readonly<ArenaConfig>;
  private record: ArenaRecord;
  private current: RecordState;
  private readonly options: ArenaSessionOptions;
  private initialized?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private writeFailure: unknown;
  private stepping = false;
  private pauseRevision = 0;
  constructor(config: ArenaConfig, options: ArenaSessionOptions = {}, record?: ArenaRecord) {
    this.config = freeze(validateConfig(config)); this.options=options;
    if(record) { this.record=clone(record);this.current=readRecord(record,true); }
    else {
      const initialCheckpoint=createInitialCheckpoint(this.config);
      this.record={schemaVersion:1,manifest:{schemaVersion:1,engine:'state-conquest@35d7ca7+arena.1',config:clone(this.config),initialFingerprint:initialCheckpoint.fingerprint},initialCheckpoint,entries:[]};
      this.current={checkpoint:initialCheckpoint,reservations:{},requireCostReservation:false,paused:false,rounds:[]};
    }
    if(this.uncertainCalls.length) { this.current.paused=true;this.current.pauseReason='uncertain_call_requires_settlement'; }
  }
  get status(): 'running'|'paused'|'ended' { return this.current.checkpoint.aux.result?'ended':this.current.paused?'paused':'running'; }
  get tick():number{return this.current.checkpoint.state.tick;}
  get result(){return clone(this.current.checkpoint.aux.result);}
  get budget(){return clone(this.current.pending?accountRound(this.current.checkpoint.aux,this.current.pending,this.current.reservations).budget:this.current.checkpoint.aux.budget);}
  get pauseReason(){return this.current.pauseReason;}
  get uncertainCalls():Array<{seat:SeatId;attemptId:string;status:'pending'|'failed';roundIndex:number}> {
    const round=this.current?.pending;
    return round?round.seats.flatMap(seat=>(round.attempts[seat]??[]).filter(a=>a.status==='pending'||a.status==='failed').map(a=>({seat,attemptId:a.id,status:a.status as 'pending'|'failed',roundIndex:round.index}))):[];
  }
  get pendingRound():ArenaRound|undefined {return this.current.pending?clone(this.current.pending):undefined;}
  get persistenceDiagnostics():ArenaPersistenceDiagnostic[] {return clone([...(this.options.store?.diagnostics??[])]);}
  drainPersistenceDiagnostics():ArenaPersistenceDiagnostic[] {return clone([...(this.options.store?.drainDiagnostics?.()??this.options.store?.diagnostics??[])]);}
  private persistenceFailure():ArenaInfrastructureError {
    const cause=this.writeFailure;
    return new ArenaInfrastructureError(`Persistence failed; reload the durable store before continuing: ${cause instanceof Error?cause.message:String(cause)}`,{cause});
  }
  private failPersistence(error:unknown):never {
    this.writeFailure??=error;
    this.current.paused=true;this.current.pauseReason='persistence_failure';
    throw this.persistenceFailure();
  }
  private ensureStore():Promise<void> {
    return this.initialized??=Promise.resolve().then(()=>this.options.store?.initialize(this.exportRecord())).catch(error=>this.failPersistence(error));
  }
  private persist(entry:ArenaLogEntry):Promise<void> {
    const operation=this.writes.then(async()=>{
      if(this.writeFailure)throw this.persistenceFailure();
      const saved=clone(entry);
      // Validate against the latest serialized state before touching the ledger.
      // Checkpoints and completed rounds are immutable; only pending/control fields can change.
      const staged:RecordState={...this.current,pending:this.current.pending?clone(this.current.pending):undefined,rounds:saved.type==='COMMIT'?[...this.current.rounds]:this.current.rounds};
      applyLogEntry(staged,saved,this.config,false);
      const revision=this.pauseRevision;
      try {
        await this.ensureStore();
        await this.options.store?.append(saved);
      }catch(error){if(this.writeFailure)throw this.persistenceFailure();this.failPersistence(error);}
      // A pause requested during fsync must stay visible before the next queued CONTROL.
      if(revision!==this.pauseRevision){staged.paused=this.current.paused;staged.pauseReason=this.current.pauseReason;}
      this.current=staged;
      this.record.entries.push(saved);
    });
    // Validation errors reject the request without disabling future valid transactions.
    this.writes=operation.catch(()=>{});
    return operation;
  }
  async pause(reason='user_pause'):Promise<void> {
    if(this.status==='ended')return;
    // Immediate flag prevents publication when an already running Promise.all completes.
    this.pauseRevision++;
    this.current.paused=true;this.current.pauseReason=reason;
    await this.persist({type:'CONTROL',status:'paused',reason});
  }
  async resume():Promise<void> {
    if(this.status==='ended')return;
    if(this.stepping)throw new ArenaPausedError('decision_window_still_running');
    if(this.uncertainCalls.length)throw new ArenaPausedError('uncertain_call_requires_settlement');
    await this.persist({type:'CONTROL',status:'running'});
  }
  /** A caller must reconcile the actual charge for a crashed/failed invocation before retrying it. */
  async settleUncertainCall(seat:SeatId, costUsd:number):Promise<void> {
    if(this.stepping)throw new Error('Cannot settle a call while its decision window is running');
    if(!Number.isFinite(costUsd)||costUsd<0)throw new Error('A finite, actual costUsd is required');
    const uncertain=this.uncertainCalls.find(c=>c.seat===seat);
    if(!uncertain)throw new Error('No uncertain invocation for this seat');
    await this.persist({type:'SETTLE',roundIndex:uncertain.roundIndex,seat,attemptId:uncertain.attemptId,costUsd});
  }
  /** Fill an initially unknown successful response cost; the original DECISION remains in the audit log. */
  async setResponseCost(seat:SeatId,costUsd:number):Promise<void> {
    if(this.stepping)throw new Error('Cannot price a response while the decision window is running');
    const round=this.current.pending;
    if(!round)throw new Error('No pending decision window');
    if(!round.seats.includes(seat))throw new Error('Unseated decision actor');
    const saved=round.responses[seat];
    if(!saved||saved.response.costUsd!==undefined||!Number.isFinite(costUsd)||costUsd<0)throw new Error('COST requires an unknown saved response cost and a finite nonnegative costUsd');
    await this.persist({type:'COST',roundIndex:round.index,seat,costUsd});
  }
  private request(round:ArenaRound,seat:SeatId):ActorRequest {
    const request:ActorRequest=Object.freeze({seat,decisionId:round.observations[seat]!.decision_id,observation:freeze(clone(round.observations[seat]!)),obsHash:round.obsHashes[seat]!,memoryNote:round.memoryNotes[seat]??'',signal:this.options.signal});
    bindBaselineContext(request,this.current.checkpoint.state);
    return request;
  }
  private reservation(request:ActorRequest):number|undefined {
    const value=this.options.reserveCostUsd;
    const result=typeof value==='function'?value(request):typeof value==='number'?value:value?.[request.seat];
    if(result!==undefined&&(!Number.isFinite(result)||result<0))throw new Error(`Invalid cost reservation for ${request.seat}`);
    return result;
  }
  private async stop(reason:string):Promise<never>{await this.pause(reason);throw new ArenaPausedError(reason);}
  async step(actors:Partial<Record<SeatId,ArenaActor>>=this.options.actors??{}):Promise<ArenaRound> {
    if(this.stepping)throw new Error('ArenaSession.step is already running');
    if(this.writeFailure)throw this.persistenceFailure();
    if(this.status==='ended')throw new Error('Arena match has ended');
    if(this.status==='paused')throw new ArenaPausedError(this.pauseReason??'paused');
    this.stepping=true;
    try {
      await this.ensureStore();
      if(this.options.signal?.aborted)return await this.stop('aborted');
      if(this.uncertainCalls.length)return await this.stop('uncertain_call_requires_settlement');
      let round=this.current.pending;
      const fresh=!round;
      if(!round)round=createRound(this.current.checkpoint,this.config);
      const missing=round.seats.filter(seat=>!round!.responses[seat]);
      const requests=new Map(missing.map(seat=>[seat,this.request(round!,seat)]));
      for(const seat of missing)if(typeof actors[seat]!=='function')throw new ArenaInfrastructureError(`Missing actor callback for seat ${seat}`);
      const reservations=fresh?{}:{...this.current.reservations};
      const requireCostReservation=this.options.requireCostReservation??(this.config.budget.maxCostUsd!==undefined);
      try { for(const seat of missing) {
        const amount=this.reservation(requests.get(seat)!);
        if(amount!==undefined)reservations[seat]=amount;
        if(this.config.budget.maxCostUsd!==undefined&&requireCostReservation&&amount===undefined)return await this.stop(`cost_reservation_required:${seat}`);
      }} catch(error) {if(error instanceof ArenaPausedError)throw error;return await this.stop(`invalid_cost_reservation:${(error as Error).message}`);}
      const budget=fresh?this.current.checkpoint.aux.budget:accountRound(this.current.checkpoint.aux,round,reservations).budget;
      if(budget.calls+missing.length>this.config.budget.maxCalls)return await this.stop('max_calls_budget');
      const ceiling=this.config.budget.maxCostUsd;
      if(ceiling!==undefined) {
        if(budget.unknownCostCalls>0)return await this.stop('unknown_cost_requires_pricing');
        const needed=missing.reduce((sum,seat)=>sum+(reservations[seat]??0),0);
        if(budget.knownCostUsd+needed>ceiling+1e-12)return await this.stop('max_cost_reservation_budget');
      }
      if(fresh) {
        await this.persist({type:'BEGIN',round, reservations,requireCostReservation});
        round=this.current.pending!;
      } else {
        // Persisted reservations belong to this frozen observation. A restored provider may not increase them silently.
        for(const seat of missing)if((reservations[seat]??null)!==(this.current.reservations[seat]??null))throw new ArenaInfrastructureError('Reservation changed for a pending round; restore the original provider limits');
      }
      const window=round;
      // All calls see the same state; the simulation remains untouched until every arrival is durably sealed.
      const outcomes=await Promise.all(missing.map(async seat=>{
        const attemptId=`${window.id}:${seat}:attempt${(window.attempts[seat]?.length??0)+1}`;
        let invoked=false;
        try {
          await this.persist({type:'INVOKE',roundIndex:window.index,seat,attemptId});invoked=true;
          const response=await actors[seat]!(requests.get(seat)!);
          validateActorResponse(response);
          await this.persist({type:'DECISION',roundIndex:window.index,value:{seat,decisionId:requests.get(seat)!.decisionId,obsHash:requests.get(seat)!.obsHash,response:clone(response)}});
          return undefined;
        }catch(error){
          if(invoked&&!this.writeFailure)await this.persist({type:'FAILURE',roundIndex:window.index,seat,attemptId,message:(error as Error)?.message??String(error)});
          return {seat,error};
        }
      }));
      const failures=outcomes.filter(Boolean);
      if(failures.length){
        await this.pause('actor_infrastructure_failure');
        throw new ArenaInfrastructureError(`Actor infrastructure failure for ${failures.map(f=>f!.seat).join(', ')}; no actions applied`,{cause:failures[0]!.error});
      }
      if(this.current.paused)throw new ArenaPausedError(this.pauseReason??'paused');
      if(this.options.signal?.aborted)return await this.stop('aborted');
      const sealed=this.current.pending!;
      const total=accountRound(this.current.checkpoint.aux,sealed,this.current.reservations).budget;
      if(ceiling!==undefined) {
        if(total.unknownCostCalls>0)return await this.stop('unknown_cost_requires_pricing');
        if(total.knownCostUsd>ceiling+1e-12)return await this.stop('max_cost_exceeded');
        for(const seat of sealed.seats)if(this.current.reservations[seat]!==undefined&&sealed.responses[seat]!.response.costUsd!>this.current.reservations[seat]!+1e-12)return await this.stop(`cost_reservation_exceeded:${seat}`);
      }
      const transaction=executeRound(this.current.checkpoint,sealed,this.config,this.current.reservations);
      await this.persist({type:'COMMIT',roundIndex:sealed.index,round:transaction.round,checkpoint:transaction.checkpoint});
      return clone(transaction.round);
    }catch(error){
      if(this.writeFailure)throw this.persistenceFailure();
      throw error;
    }finally{this.stepping=false;}
  }
  getFrame(tick?:number):ArenaFrame {
    if(tick!==undefined&&tick!==this.tick)return frameFromRecord(this.record,tick);
    const cp=this.current.checkpoint;
    const last=this.current.rounds.at(-1);
    return {tick:cp.state.tick,snapshot:toMatchSnapshot(cp.state),events:clone(last?.events.filter(e=>e.tick===cp.state.tick).flatMap(e=>e.events)??[]),fingerprint:cp.fingerprint,result:clone(cp.aux.result)};
  }
  getRound(index:number):ArenaRound|undefined {
    const round=this.current.rounds.find(r=>r.index===index)??(this.current.pending?.index===index?this.current.pending:undefined);
    return round?clone(round):undefined;
  }
  exportRecord():ArenaRecord{return clone(this.record);}
}
export function createArenaSession(config:ArenaConfig,options?:ArenaSessionOptions):ArenaSession{return new ArenaSession(config,options);}
export function restoreArenaSession(record:ArenaRecord,options?:ArenaSessionOptions):ArenaSession{return new ArenaSession(record.manifest.config,options,record);}
export async function loadArenaSession(store:ArenaStore,options:Omit<ArenaSessionOptions,'store'>={}):Promise<ArenaSession>{return restoreArenaSession(await store.read(),{...options,store});}
