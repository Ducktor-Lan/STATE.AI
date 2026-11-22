import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createArenaSession, createInitialCheckpoint, loadArenaSession, createFileArenaStore, createBaselineActor, buildActorPrompt, ARENA_RULES, SEAT_TO_OWNER, SEATS, ArenaPausedError } from '@state/arena';
import type { ActorRequest, ArenaActor, ArenaConfig, ArenaRecord, ArenaRound, ArenaSessionOptions, ArenaStore, SeatId } from '@state/arena';
import { createRound, frameWindowFromRecord } from '@state/arena/replay';
import { invokeModel } from '@state/providers';
import type { ModelProfile } from '@state/providers';
import type { MediaSource, Storyboard } from '@state/media';
import { buildStoryboard, validateStoryboard } from '@state/media';
import { errorDiagnostics, loadEnvironment, sanitizeError } from './environment.js';
import { atomicWriteJson } from './atomic-json.js';
import { loadProfiles, modelSummaries, validateRunInput } from './config.js';
import type { ServerModelProfile } from './config.js';
import { hash, reproducibility } from './metadata.js';
import { HttpError, isObject, safeId } from './security.js';
import { decisionSummary, recordedRounds, eventsFromRecord, outcome, mediaSource, replayDecisionSummary, replayMap, replaySnapshot, SPECTATOR_ACCESS } from './projection.js';
import { LocalModels } from './local-models.js';
import type { CreateRunInput, ModelSummary, ReplayFrames, RunEvent, RunSummary, StoredRun, RunState, StartBudget } from './types.js';

type Session = Awaited<ReturnType<typeof createArenaSession>>;
interface ReadRevision { value: number; record?: ArenaRecord }
interface ReadProjection { revision: number; record: ArenaRecord; rounds: ArenaRound[]; events: RunEvent[]; source?: MediaSource }
interface ManagedRun {
  stored: StoredRun;
  session: Session;
  revision: ReadRevision;
  reads?: ReadProjection;
  task?: Promise<void>;
  pause: boolean;
  startedAt?: number;
  persist: Promise<void>;
  baselineSeats: ReadonlySet<SeatId>;
  httpAttemptsIncomplete: boolean;
}
export interface RunManagerOptions {
  rootDir?: string;
  dataDir?: string;
  profiles?: ServerModelProfile[];
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Used for bounded offline tests; HTTP defaults to one run at a time. */
  maxConcurrentRuns?: number;
  onCompleted?: (run: RunSummary) => void;
}
const INPUT_BYTE_LIMIT = 1_048_576;
function baselineSeats(profiles: readonly (ModelProfile | undefined)[]): ReadonlySet<SeatId> {
  return new Set(SEATS.filter((_, index) => profiles[index]?.provider === 'baseline'));
}
function httpAttemptsInRound(round: ArenaRound): number {
  return round.seats.reduce((sum, seat) => {
    const attempts = round.responses[seat]?.response.metadata?.attempts;
    return sum + (typeof attempts === 'number' ? attempts : 0);
  }, 0);
}
/** UTF-8 bytes bound text tokens conservatively; reserve every configured retry and output cap. */
function reservation(profile: ModelProfile, request: ActorRequest): number {
  if (profile.provider === 'baseline') return 0;
  if (profile.inputUsdPerMillion === undefined || profile.outputUsdPerMillion === undefined || profile.maxOutputTokens === undefined) {
    throw new HttpError(400, `Model ${profile.id} needs input/output prices and maxOutputTokens for a USD-bounded run.`, 'UNBOUNDED_MODEL');
  }
  const prompt = buildActorPrompt(request);
  const inputBytes = Buffer.byteLength(prompt.system, 'utf8') + Buffer.byteLength(prompt.user, 'utf8');
  if (inputBytes > INPUT_BYTE_LIMIT) throw new Error('Model prompt exceeds the configured one MiB input limit; no API request was sent.');
  const protocolBytes = Buffer.byteLength(JSON.stringify(profile.requestOptions ?? {}), 'utf8') + 8_192;
  const cost = ((inputBytes + protocolBytes) * profile.inputUsdPerMillion + profile.maxOutputTokens * profile.outputUsdPerMillion)
    * ((profile.maxRetries ?? 2) + 1) / 1_000_000;
  if (!Number.isFinite(cost) || cost < 0) throw new Error(`Invalid cost reservation for ${request.seat}`);
  return cost;
}
function arenaConfig(input: CreateRunInput, id: string, initiativeOffset = 0): ArenaConfig {
  const { recordVideo, ...battleInput } = input;
  return { ...battleInput, id, decisionTicks: 20, maxActions: 3, initiativeOffset };
}
function startBudgetForRound(round: ArenaRound, profiles: readonly ServerModelProfile[]): StartBudget {
  const requiredCostUsd = round.seats.reduce((sum, seat) => {
    const observation = round.observations[seat]!;
    return sum + reservation(profiles[SEATS.indexOf(seat)]!, {
      seat, observation, decisionId: observation.decision_id,
      obsHash: round.obsHashes[seat]!, memoryNote: round.memoryNotes[seat] ?? '',
    });
  }, 0);
  if (!Number.isFinite(requiredCostUsd)) throw new Error('Invalid total cost reservation for the first round.');
  return { requiredCalls: round.seats.length, requiredCostUsd };
}
export class StartBudgetTooLowError extends HttpError {
  constructor(readonly startBudget: StartBudget) {
    super(400, `The first round requires ${startBudget.requiredCalls} decision calls and a USD budget of ${startBudget.requiredCostUsd}.`, 'START_BUDGET_TOO_LOW');
    this.name = 'StartBudgetTooLowError';
  }
}
function assertStartBudget(startBudget: StartBudget, budget: ArenaConfig['budget']): void {
  // Match the arena's decision-call ceiling and USD tolerance.
  if (startBudget.requiredCalls > budget.maxCalls || (budget.maxCostUsd !== undefined && startBudget.requiredCostUsd > budget.maxCostUsd + 1e-12)) {
    throw new StartBudgetTooLowError(startBudget);
  }
}
export class RunManager {
  readonly rootDir: string;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly profiles: readonly ServerModelProfile[];
  readonly recoveryErrors: string[] = [];
  private readonly runs = new Map<string, ManagedRun>();
  private readonly maxConcurrent: number;
  private readonly onCompleted?: (run: RunSummary) => void;
  private closing = false;
  private constructor(options: RunManagerOptions, rootDir: string, dataDir: string, env: NodeJS.ProcessEnv, private readonly localModels: LocalModels) {
    this.rootDir = rootDir;
    this.dataDir = dataDir;
    this.env = env; this.profiles = localModels.profiles;
    this.maxConcurrent = Math.max(1, Math.min(8, options.maxConcurrentRuns ?? 1));
    this.onCompleted = options.onCompleted;
  }
  static async open(options: RunManagerOptions = {}): Promise<RunManager> {
    const root = resolve(options.rootDir ?? process.cwd());
    const [env, profiles] = await Promise.all([loadEnvironment(root, options.env ?? process.env), options.profiles ? Promise.resolve(options.profiles) : loadProfiles(root, options.configPath)]);
    const dataDir = resolve(root, options.dataDir ?? env.STATE_AI_RUNS_DIR ?? 'runs');
    await mkdir(dataDir, { recursive: true });
    const localModels = await LocalModels.open(dataDir, profiles, env);
    const manager = new RunManager(options, root, dataDir, env, localModels);
    for (const entry of await readdir(manager.dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/u.test(entry.name) || entry.name === 'tournaments') continue;
      try {
        const parsed: unknown = JSON.parse(await readFile(join(manager.dataDir, entry.name, 'server.json'), 'utf8'));
        if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.run) || parsed.run.id !== entry.name) throw new Error('Invalid server record.');
        const stored = parsed as unknown as StoredRun;
        const currentProfiles = stored.run.models.map(id => manager.profiles.find(profile => profile.id === id));
        const profilesMatch = currentProfiles.every(profile => profile !== undefined)
          && hash(currentProfiles) === stored.run.reproducibility?.profilesHash;
        // Only matching profiles can establish that a historical seat made no HTTP calls.
        const historicalBaselines = baselineSeats(profilesMatch ? currentProfiles : []);
        const { store, revision } = manager.arenaStore(entry.name);
        const session = await loadArenaSession(store, manager.sessionOptions(currentProfiles));
        revision.record = session.exportRecord();
        let knownHttpAttempts = 0, httpAttemptsIncomplete = false;
        for (const item of revision.record.entries) {
          if (item.type === 'COMMIT') knownHttpAttempts += httpAttemptsInRound(item.round);
          if (item.type === 'SETTLE' && !historicalBaselines.has(item.seat)) httpAttemptsIncomplete = true;
        }
        stored.run.knownHttpAttempts = knownHttpAttempts;
        const recovered = !['completed', 'failed', 'paused'].includes(stored.run.status);
        if (session.result) stored.run.status = 'completed';
        else if (recovered) {
          stored.run.status = 'paused'; stored.run.errorKind = 'recovery';
          stored.run.error = 'Recovered after interruption. Recorded replies will be reused; requests without durable replies may already have incurred charges. Resume explicitly.';
        }
        const managed: ManagedRun = { stored, session, revision, pause: true, persist: Promise.resolve(), baselineSeats: historicalBaselines, httpAttemptsIncomplete };
        manager.runs.set(entry.name, managed);
        manager.update(managed);
        await manager.persist(managed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') manager.recoveryErrors.push(`${entry.name}: ${sanitizeError(error, env)}`);
      }
    }
    return manager;
  }
  models() { return modelSummaries(this.profiles, this.env); }
  async registerOpenAiModel(value: unknown): Promise<ModelSummary> {
    if (this.closing) throw new HttpError(503, 'Server is shutting down.');
    return this.localModels.register(value);
  }
  list(): RunSummary[] { return [...this.runs.values()].map(run => this.summary(run)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  runDirectory(id: string): string { return join(this.dataDir, safeId(id)); }
  private lookup(id: string): ManagedRun {
    safeId(id); const managed = this.runs.get(id);
    if (!managed) throw new HttpError(404, 'Run not found.', 'NOT_FOUND');
    return managed;
  }
  /** Track only successful durable appends; the session remains the sole rule and ledger owner. */
  private arenaStore(id: string): { store: ArenaStore; revision: ReadRevision } {
    const durable = createFileArenaStore(join(this.runDirectory(id), 'arena'));
    const revision: ReadRevision = { value: 0 };
    return { revision, store: {
      initialize: record => durable.initialize(record),
      read: () => durable.read(),
      get diagnostics() { return durable.diagnostics; },
      drainDiagnostics: () => durable.drainDiagnostics?.() ?? [],
      append: async entry => {
        await durable.append(entry);
        // Keep one isolated read record and clone only the newly written entry, never all history.
        if (revision.record) revision.record.entries.push(structuredClone(entry));
        revision.value++;
      },
    } };
  }
  private readProjection(managed: ManagedRun): ReadProjection {
    if (managed.reads?.revision === managed.revision.value) return managed.reads;
    const record = managed.revision.record ??= managed.session.exportRecord();
    const rounds = recordedRounds(record);
    const events = eventsFromRecord(record, rounds);
    return managed.reads = { revision: managed.revision.value, record, rounds, events };
  }
  private selected(config: Pick<CreateRunInput, 'models'>): ServerModelProfile[] {
    return config.models.map(id => { const profile = this.profiles.find(item => item.id === id); if (!profile) throw new HttpError(409, `Model profile ${id} is no longer configured.`, 'MODEL_UNAVAILABLE'); return profile; });
  }
  private sessionOptions(profiles: readonly (ServerModelProfile | undefined)[]): ArenaSessionOptions {
    const actors: Partial<Record<SeatId, ArenaActor>> = {};
    for (const [index, profile] of profiles.entries()) {
      const seat = SEATS[index]!;
      if (!profile) { actors[seat] = async () => { throw new Error('The original model profile is no longer configured; no request was sent.'); }; continue; }
      if (profile.provider === 'baseline') actors[seat] = createBaselineActor(profile.model === 'hard' ? 'hard' : 'normal');
      else actors[seat] = async request => {
        const prompt = buildActorPrompt(request);
        reservation(profile, request); // Validate the exact outgoing request before invoking a provider.
        const result = await invokeModel(profile, { ...prompt, decisionId: request.decisionId, signal: request.signal }, this.env);
        const incomplete = result.usageIsPartial === true || result.costEstimateIncomplete === true;
        return { text: result.text, usage: { ...result.usage }, ...(!incomplete && result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          metadata: { latencyMs: result.latencyMs, attempts: result.attempts, requestId: result.requestId, model: result.model,
            usageIsPartial: result.usageIsPartial, costIsEstimate: result.costIsEstimate, costEstimateIncomplete: result.costEstimateIncomplete } };
      };
    }
    return { actors, requireCostReservation: true, reserveCostUsd: request => {
      const profile = profiles[SEATS.indexOf(request.seat)];
      return profile ? reservation(profile, request) : undefined;
    } };
  }
  quoteStartBudget(value: unknown): StartBudget {
    const input = validateRunInput(value, this.models());
    const profiles = this.selected(input);
    // Quote with a UUID so the decision IDs use the same number of prompt bytes as a real run.
    const config = arenaConfig(input, randomUUID());
    return startBudgetForRound(createRound(createInitialCheckpoint(config), config), profiles);
  }
  async create(value: unknown, extra: { tournamentId?: string; initiativeOffset?: number; start?: boolean } = {}): Promise<RunSummary> {
    if (this.closing) throw new HttpError(503, 'Server is shutting down.');
    const input = validateRunInput(value, this.models());
    const profiles = this.selected(input);
    for (const profile of profiles) if (profile.provider !== 'baseline' && (profile.inputUsdPerMillion === undefined || profile.outputUsdPerMillion === undefined || profile.maxOutputTokens === undefined)) {
      throw new HttpError(400, `Model ${profile.id} needs input/output prices and maxOutputTokens for a USD-bounded run.`, 'UNBOUNDED_MODEL');
    }
    const id = randomUUID();
    const config = arenaConfig(input, id, extra.initiativeOffset);
    if (extra.start !== false) {
      assertStartBudget(startBudgetForRound(createRound(createInitialCheckpoint(config), config), profiles), config.budget);
    }
    const { store, revision } = this.arenaStore(id);
    const session = await createArenaSession(config, { ...this.sessionOptions(profiles), store });
    await session.pause('Created; awaiting explicit scheduler start.');
    const record = revision.record = session.exportRecord();
    const metadata = await reproducibility(this.rootDir, session.config, profiles, record.manifest.engine, { prompt: buildActorPrompt.toString(), rules: ARENA_RULES });
    const stored: StoredRun = { version: 1, run: { ...input, id, status: extra.start === false ? 'paused' : 'queued', createdAt: new Date().toISOString(),
      tick: 0, wallElapsedMs: 0, calls: 0, costUsd: 0, reproducibility: metadata, ...(extra.tournamentId ? { tournamentId: extra.tournamentId } : {}) } };
    const managed: ManagedRun = { stored, session, revision, pause: extra.start === false, persist: Promise.resolve(), baselineSeats: baselineSeats(profiles), httpAttemptsIncomplete: false };
    this.runs.set(id, managed);
    await this.persist(managed);
    const initial = this.summary(managed);
    if (extra.start !== false) this.pump();
    return initial;
  }
  get(id: string): RunSummary { return this.summary(this.lookup(id)); }
  record(id: string): ArenaRecord { return structuredClone(this.readProjection(this.lookup(id)).record); }
  result(id: string) { return this.lookup(id).session.result; }
  private summary(managed: ManagedRun): RunSummary {
    this.update(managed);
    const run = managed.stored.run;
    const wallElapsedMs = run.wallElapsedMs + (managed.startedAt === undefined ? 0 : Date.now() - managed.startedAt);
    const pending = managed.session.pendingRound;
    const pendingHttpAttempts = pending ? httpAttemptsInRound(pending) : 0;
    const knownHttpAttempts = (run.knownHttpAttempts ?? 0) + pendingHttpAttempts;
    return structuredClone({ ...run, wallElapsedMs, knownHttpAttempts, httpAttempts: run.httpAttempts === null ? null : knownHttpAttempts,
      uncertainCalls: managed.session.uncertainCalls, ...(managed.pause && managed.task ? { pauseRequested: true } : {}) });
  }
  private collectPersistenceDiagnostics(managed: ManagedRun): void {
    const diagnostics = managed.session.drainPersistenceDiagnostics();
    if (!diagnostics.length) return;
    const run = managed.stored.run;
    run.persistenceWarningCount = (run.persistenceWarningCount ?? 0) + diagnostics.length;
    run.persistenceWarnings = [...(run.persistenceWarnings ?? []), ...diagnostics.map(diagnostic => ({
      severity: 'warning' as const, phase: sanitizeError(diagnostic.phase, this.env), durable: true as const,
      ...(diagnostic.entryType ? { entryType: diagnostic.entryType } : {}),
      ...(diagnostic.roundIndex !== undefined ? { roundIndex: diagnostic.roundIndex } : {}),
      ...(diagnostic.tick !== undefined ? { tick: diagnostic.tick } : {}),
      error: errorDiagnostics(diagnostic.error, this.env),
    }))].slice(-40);
  }
  private update(managed: ManagedRun): void {
    this.collectPersistenceDiagnostics(managed);
    const budget = managed.session.budget;
    managed.stored.run.tick = managed.session.tick;
    managed.stored.run.calls = budget.calls;
    managed.stored.run.costUsd = budget.unknownCostCalls > 0 ? null : budget.knownCostUsd;
    managed.stored.run.knownHttpAttempts ??= 0;
    const unresolvedHttp = managed.session.uncertainCalls.some(call => !managed.baselineSeats.has(call.seat));
    managed.stored.run.httpAttempts = managed.httpAttemptsIncomplete || unresolvedHttp ? null : managed.stored.run.knownHttpAttempts;
  }
  private persist(managed: ManagedRun): Promise<void> {
    this.collectPersistenceDiagnostics(managed);
    const file = join(this.runDirectory(managed.stored.run.id), 'server.json');
    const text = JSON.stringify(managed.stored, null, 2);
    managed.persist = managed.persist.then(() => atomicWriteJson(file, text));
    return managed.persist;
  }
  private pump(): void {
    if (this.closing) return;
    let active = [...this.runs.values()].filter(run => run.task).length;
    for (const managed of this.runs.values()) {
      if (active >= this.maxConcurrent) break;
      if (managed.stored.run.status !== 'queued' || managed.task || managed.pause) continue;
      active++;
      managed.task = this.execute(managed).finally(() => { managed.task = undefined; this.pump(); });
      // The task records errors in the run. Keep an explicit rejection handler for storage failures.
      void managed.task.catch(error => {
        managed.stored.run.status = 'failed'; managed.stored.run.errorKind = 'infrastructure'; managed.stored.run.error = sanitizeError(error, this.env);
        managed.stored.run.errorDiagnostics = errorDiagnostics(error, this.env);
      });
    }
  }
  private async execute(managed: ManagedRun): Promise<void> {
    const run = managed.stored.run;
    managed.startedAt = Date.now();
    try {
      await managed.session.resume();
      while (!this.closing && !managed.pause && !managed.session.result) {
        run.status = 'waiting'; await this.persist(managed);
        const round = await managed.session.step();
        run.knownHttpAttempts = (run.knownHttpAttempts ?? 0) + httpAttemptsInRound(round);
        this.update(managed);
        if (managed.session.budget.unknownCostCalls > 0) {
          run.status = 'paused'; run.errorKind = 'budget'; run.error = 'Provider accounting is incomplete; USD expenditure is unknown. The run is paused and cannot safely continue under its USD ceiling.';
          managed.pause = true; break;
        }
        run.status = managed.session.result ? 'completed' : 'running';
        await this.persist(managed);
        await yieldTurn();
      }
      if (managed.session.result) { run.status = 'completed'; delete run.error; delete run.errorKind; delete run.errorDiagnostics; }
      else { await managed.session.pause(this.closing ? 'Server shutdown at a committed window boundary.' : run.error ?? 'Paused by user at a window boundary.'); run.status = 'paused'; }
    } catch (error) {
      this.update(managed);
      run.status = error instanceof ArenaPausedError ? 'paused' : 'failed';
      run.errorKind = error instanceof ArenaPausedError ? 'budget' : 'infrastructure';
      run.error = sanitizeError(error, this.env); run.errorDiagnostics = errorDiagnostics(error, this.env); managed.pause = true;
    } finally {
      run.wallElapsedMs += Date.now() - (managed.startedAt ?? Date.now()); managed.startedAt = undefined;
      this.update(managed); await this.persist(managed);
    }
    if (run.status === 'completed') this.onCompleted?.(this.summary(managed));
  }
  async pause(id: string): Promise<RunSummary> {
    const managed = this.lookup(id);
    if (managed.stored.run.status === 'completed') return this.summary(managed);
    managed.pause = true;
    if (managed.task) await managed.task;
    else { await managed.session.pause('Paused by user.'); managed.stored.run.status = 'paused'; await this.persist(managed); }
    return this.summary(managed);
  }
  async resume(id: string): Promise<RunSummary> {
    const managed = this.lookup(id);
    if (managed.task || managed.stored.run.status === 'completed') return this.summary(managed);
    validateRunInput({ ...Object.fromEntries(['track', 'seed', 'durationSeconds', 'factionCount', 'models', 'disaster', 'budget', 'decisionTicks', 'maxActions'].map(key => [key, managed.stored.run[key as keyof RunSummary]])) }, this.models());
    if (managed.session.uncertainCalls.length) throw new HttpError(409, 'An invocation has an uncertain charge. Reconcile each listed attempt before explicitly resuming.', 'UNCERTAIN_CALL');
    const { session } = managed;
    const budget = session.budget;
    if (budget.unknownCostCalls > 0) throw new HttpError(409, 'Unknown provider expenditure prevents resuming this USD-bounded run.', 'UNKNOWN_COST');
    const profiles = this.selected(managed.stored.run);
    if (hash(profiles) !== managed.stored.run.reproducibility?.profilesHash) throw new HttpError(409, 'Model profiles changed since this run was created. Restore the original configuration before resuming.', 'CONFIG_CHANGED');
    if (session.tick === 0 && budget.calls === 0) {
      const initial = (managed.revision.record ?? session.exportRecord()).initialCheckpoint;
      const round = session.pendingRound ?? createRound(initial, session.config);
      assertStartBudget(startBudgetForRound(round, profiles), session.config.budget);
    }
    managed.pause = false; managed.stored.run.status = 'queued'; delete managed.stored.run.error; delete managed.stored.run.errorKind; delete managed.stored.run.errorDiagnostics;
    await this.persist(managed); const result = this.summary(managed); this.pump(); return result;
  }
  async reconcile(id: string, value: unknown): Promise<RunSummary> {
    const managed = this.lookup(id);
    if (managed.task) throw new HttpError(409, 'Pause the run before reconciling charges.');
    if (!isObject(value) || (value.kind !== 'uncertain' && value.kind !== 'response') || typeof value.seat !== 'string' || !SEATS.includes(value.seat as SeatId)
      || typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0 || Object.keys(value).some(key => !['kind', 'seat', 'attemptId', 'costUsd'].includes(key))) {
      throw new HttpError(400, 'Reconciliation requires kind, seat and an actual nonnegative costUsd; uncertain calls also require attemptId.');
    }
    const seat = value.seat as SeatId;
    if (!SEATS.slice(0, managed.stored.run.factionCount).includes(seat)) throw new HttpError(400, 'Reconciliation seat is not active in this run.');
    if (value.kind === 'uncertain') {
      const attempt = managed.session.uncertainCalls.find(call => call.seat === seat);
      if (!attempt || value.attemptId !== attempt.attemptId) throw new HttpError(409, 'attemptId must match the unresolved invocation.');
      await managed.session.settleUncertainCall(seat, value.costUsd);
      if (!managed.baselineSeats.has(seat)) managed.httpAttemptsIncomplete = true;
    } else {
      const saved = managed.session.pendingRound?.responses[seat];
      if (!saved || saved.response.costUsd !== undefined) throw new HttpError(409, 'Only a pending saved response with unknown cost can be reconciled.');
      await managed.session.setResponseCost(seat, value.costUsd);
    }
    this.update(managed); await this.persist(managed); return this.summary(managed);
  }
  detail(id: string) {
    const managed = this.lookup(id), reads = this.readProjection(managed);
    return { run: this.summary(managed), rounds: reads.rounds.map(round => ({ round: round.index, tick: round.startTick })), events: structuredClone(reads.events), outcome: outcome(managed.session.result), spectatorAccess: SPECTATOR_ACCESS };
  }
  async state(id: string, tick?: number): Promise<RunState> {
    const managed = this.lookup(id);
    if (tick !== undefined && (!Number.isSafeInteger(tick) || tick < 0 || tick > managed.session.tick)) throw new HttpError(400, 'tick must address a recorded tick between zero and the current run tick.');
    const frame = await managed.session.getFrame(tick);
    const reads = this.readProjection(managed);
    const round = reads.rounds.findLast(item => item.startTick <= frame.tick);
    return { snapshot: frame.snapshot, run: this.summary(managed), decisions: round ? structuredClone(round.seats.map(seat => decisionSummary(round, seat, managed.stored.run.models))) : [],
      events: structuredClone(reads.events.filter(event => event.tick <= frame.tick)), outcome: outcome(frame.result) };
  }
  replayFrames(id: string, from: number | undefined, limit: number | undefined): ReplayFrames {
    const managed = this.lookup(id);
    if (from === undefined || !Number.isSafeInteger(from) || from < 0) throw new HttpError(400, 'from must be a nonnegative integer.');
    if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1 || limit > 40) throw new HttpError(400, 'limit must be an integer between 1 and 40.');
    const run = this.summary(managed);
    const record = managed.revision.record ??= managed.session.exportRecord();
    const { frames, rounds } = frameWindowFromRecord(record, from, Math.min(run.tick, from + limit - 1), run.tick);
    return {
      run,
      map: replayMap(frames[0]?.snapshot ?? managed.session.getFrame().snapshot),
      frames: frames.map(frame => ({ snapshot: replaySnapshot(frame.snapshot), outcome: outcome(frame.result) })),
      decisionsByRound: rounds.map(round => ({ tick: round.startTick, decisions: round.seats.map(seat => replayDecisionSummary(round, seat, run.models)) })),
    };
  }
  round(id: string, index: number) {
    const managed = this.lookup(id);
    if (!Number.isSafeInteger(index) || index < 0) throw new HttpError(400, 'round must be a nonnegative integer.');
    const reads = this.readProjection(managed);
    const round = reads.rounds.find(item => item.index === index);
    if (!round) throw new HttpError(404, 'Recorded round not found.', 'NOT_FOUND');
    const messages = reads.events.filter(event => event.tick >= round.startTick && event.tick < round.endTick && event.type.endsWith('_message'));
    return { round: round.index, tick: round.startTick, spectatorAccess: SPECTATOR_ACCESS, decisions: structuredClone(round.seats.map(seat => ({ ...decisionSummary(round, seat, managed.stored.run.models), observation: round.observations[seat], memoryNote: round.memoryNotes[seat], obsHash: round.obsHashes[seat], output: round.responses[seat]?.response, messages: messages.filter(message => message.visibility === 'public' || message.from === SEAT_TO_OWNER[seat] || message.to === SEAT_TO_OWNER[seat]) }))) };
  }
  source(id: string): MediaSource {
    const managed = this.lookup(id), reads = this.readProjection(managed);
    reads.source ??= mediaSource(this.summary(managed), reads.record, managed.session.result,
      new Map(this.profiles.map(profile => [profile.id, profile.label])), reads);
    return structuredClone(reads.source);
  }
  storyboard(id: string): Storyboard {
    const managed = this.lookup(id), source = this.source(id);
    if (managed.stored.storyboard && validateStoryboard(managed.stored.storyboard, source).valid) return structuredClone(managed.stored.storyboard);
    return buildStoryboard(source);
  }
  async saveStoryboard(id: string, value: unknown): Promise<Storyboard> {
    const managed = this.lookup(id);
    if (!isObject(value) || value.runId !== id) throw new HttpError(400, 'Storyboard must belong to this run.');
    const storyboard = value as unknown as Storyboard;
    const validation = validateStoryboard(storyboard, this.source(id));
    if (!validation.valid) throw new HttpError(400, validation.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '), 'INVALID_STORYBOARD');
    managed.stored.storyboard = structuredClone(storyboard); await this.persist(managed); return structuredClone(storyboard);
  }
  async wait(id: string): Promise<RunSummary> {
    for (;;) { const managed = this.lookup(id); if (!managed.task && managed.stored.run.status !== 'queued') return this.summary(managed); await managed.task; await yieldTurn(); }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const managed of this.runs.values()) managed.pause = true;
    const runs = [...this.runs.values()].map(async managed => {
      if (managed.task) await managed.task;
      else if (!['completed', 'failed', 'paused'].includes(managed.stored.run.status)) {
        managed.stored.run.status = 'paused'; await managed.session.pause('Server shutdown.'); await this.persist(managed);
      }
    });
    await Promise.all([this.localModels.flush(), ...runs]);
  }
}
