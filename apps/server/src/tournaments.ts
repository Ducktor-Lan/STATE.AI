import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSchedule, aggregateResults } from '@state/evaluation';
import type { EvaluationSchedule, EvaluationRecord, EvaluationReport, ModelOutcome, ScheduledGame, SeatPolicy } from '@state/evaluation';
import { ARENA_RULES, buildActorPrompt, createArenaSession, SEATS } from '@state/arena';
import { RunManager } from './runs.js';
import { recordedRounds } from './projection.js';
import { reproducibility } from './metadata.js';
import { sanitizeError } from './environment.js';
import { atomicWriteJson } from './atomic-json.js';
import { HttpError, isObject, safeId } from './security.js';
import { validateRunInput } from './config.js';
import type { CreateRunInput, RunStatus } from './types.js';

interface Budget { maxCalls: number; maxCostUsd: number }
export interface TournamentSummary {
  id: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed';
  createdAt: string;
  totalGames: number;
  completedGames: number;
  runIds: string[];
  budget: Budget;
  calls: number;
  costUsd: number | null;
  error?: string;
  development: boolean;
}
interface StoredTournament {
  version: 1;
  summary: TournamentSummary;
  schedule: EvaluationSchedule;
  games: Array<{ gameId: string; runId?: string }>;
  runBudget: Budget;
  disaster: boolean;
  allowDevelopment: boolean;
}
interface ManagedTournament { stored: StoredTournament; pause: boolean; task?: Promise<void>; writes: Promise<void> }
export interface TournamentDetail extends TournamentSummary {
  schedule: EvaluationSchedule;
  report: EvaluationReport;
  games: Array<{ gameId: string; runId?: string; status: 'pending' | RunStatus }>;
}
export class TournamentManager {
  private readonly tournaments = new Map<string, ManagedTournament>();
  private closing = false;
  private constructor(readonly runs: RunManager) {}
  static async open(runs: RunManager): Promise<TournamentManager> {
    const manager = new TournamentManager(runs), directory = join(runs.dataDir, 'tournaments');
    await mkdir(directory, { recursive: true });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-zA-Z0-9_-]+\.json$/u.test(entry.name)) continue;
      try {
        const value: unknown = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
        if (!isObject(value) || value.version !== 1 || !isObject(value.summary) || value.summary.id !== entry.name.slice(0, -5)) throw new Error('Invalid tournament record.');
        const stored = value as unknown as StoredTournament;
        if (stored.summary.status === 'running' || stored.summary.status === 'queued') { stored.summary.status = 'paused'; stored.summary.error = 'Recovered after service restart. Resume explicitly.'; }
        const managed: ManagedTournament = { stored, pause: true, writes: Promise.resolve() };
        manager.tournaments.set(stored.summary.id, managed); await manager.persist(managed);
      } catch (error) { runs.recoveryErrors.push(`${entry.name}: ${sanitizeError(error, runs.env)}`); }
    }
    return manager;
  }
  private lookup(id: string): ManagedTournament {
    const value = this.tournaments.get(safeId(id)); if (!value) throw new HttpError(404, 'Tournament not found.', 'NOT_FOUND'); return value;
  }
  private metrics(managed: ManagedTournament): TournamentSummary {
    const runs = managed.stored.games.flatMap(game => game.runId ? [this.runs.get(game.runId)] : []);
    return { ...managed.stored.summary, completedGames: runs.filter(run => run.status === 'completed').length, runIds: runs.map(run => run.id),
      calls: runs.reduce((sum, run) => sum + run.calls, 0), costUsd: runs.some(run => run.costUsd === null) ? null : runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) };
  }
  list(): TournamentSummary[] { return [...this.tournaments.values()].map(value => this.metrics(value)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string): TournamentDetail {
    const managed = this.lookup(id), stored = managed.stored;
    const records: EvaluationRecord[] = stored.games.flatMap(mapping => {
      if (!mapping.runId) return [];
      const game = stored.schedule.games.find(item => item.gameId === mapping.gameId)!;
      const run = this.runs.get(mapping.runId), result = this.runs.result(run.id), rounds = recordedRounds(this.runs.record(run.id));
      const outcomes: ModelOutcome[] = (result?.ranking ?? []).map(rank => {
        const summaries = rounds.flatMap(round => { const storedResponse = round.responses[rank.seat]; return storedResponse ? [storedResponse.response] : []; });
        const receipts = rounds.flatMap(round => round.receipts[rank.seat] ? [round.receipts[rank.seat]!] : []);
        const actions = receipts.flatMap(receipt => [...receipt.actions, ...receipt.diplomacy]);
        const parseErrors = receipts.filter(receipt => !receipt.valid).length;
        const latencies = summaries.flatMap(response => typeof response.metadata?.latencyMs === 'number' ? [response.metadata.latencyMs] : []);
        const attempts = rounds.flatMap(round => round.attempts[rank.seat] ?? []);
        const knownTokens = attempts.length === summaries.length && summaries.every(response => response.usage?.inputTokens !== undefined && response.usage.outputTokens !== undefined && response.metadata?.usageIsPartial !== true);
        const knownCost = attempts.every(attempt => attempt.costUsd !== undefined);
        return { modelId: run.models[SEATS.indexOf(rank.seat)]!, rank: rank.rank, score: rank.score, lands: rank.lands, forces: rank.force, eliminatedTick: rank.eliminatedAtTick ?? null,
          calls: attempts.length, actionAttempts: actions.length + parseErrors, invalidActions: actions.filter(action => !action.accepted).length + parseErrors,
          tokens: knownTokens ? summaries.reduce((sum, response) => sum + (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0), 0) : null,
          latencyMs: latencies.length === summaries.length && latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
          costMs: latencies.length === summaries.length ? latencies.reduce((sum, value) => sum + value, 0) : null,
          costUsd: knownCost ? attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0) : null, errors: parseErrors + actions.filter(action => !action.accepted).length };
      });
      return [{ game, runId: run.id, status: run.status === 'completed' && result ? 'completed' : run.status === 'failed' ? 'failed' : run.status === 'paused' ? 'interrupted' : 'incomplete', outcomes, ...(run.error ? { failureReason: run.error } : {}) }];
    });
    return { ...this.metrics(managed), schedule: structuredClone(stored.schedule), report: aggregateResults(records), games: stored.games.map(game => ({ ...game, status: game.runId ? this.runs.get(game.runId).status : 'pending' })) };
  }
  async create(value: unknown): Promise<TournamentDetail> {
    if (this.closing) throw new HttpError(503, 'Server is shutting down.');
    if (!isObject(value) || Object.keys(value).some(key => !['models', 'seeds', 'track', 'durationSeconds', 'factionCount', 'repetitions', 'seatPolicy', 'disaster', 'budget', 'runBudget', 'allowDevelopment'].includes(key))) throw new HttpError(400, 'Invalid tournament configuration.');
    if (!Array.isArray(value.models) || value.models.length < 2 || value.models.length > 8 || value.models.some(id => typeof id !== 'string') || new Set(value.models).size !== value.models.length) throw new HttpError(400, 'Tournament models must contain 2–8 distinct model ids; self-play is not ranked.');
    if (!Array.isArray(value.seeds) || !value.seeds.length || value.seeds.length > 32 || value.seeds.some(seed => !Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff) || new Set(value.seeds).size !== value.seeds.length) throw new HttpError(400, 'seeds must contain 1–32 unique positive uint32 integers.');
    const repetitions = value.repetitions ?? 1;
    if (typeof repetitions !== 'number' || !Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new HttpError(400, 'repetitions must be between 1 and 20.');
    if (value.allowDevelopment !== undefined && typeof value.allowDevelopment !== 'boolean') throw new HttpError(400, 'allowDevelopment must be boolean.');
    const seatPolicy: SeatPolicy = value.seatPolicy === undefined || value.seatPolicy === 'balanced-rotations' ? 'balanced-rotations' : value.seatPolicy === 'full-permutations' ? 'full-permutations' : (() => { throw new HttpError(400, 'Unknown seatPolicy.'); })();
    const models = this.runs.models();
    for (const id of value.models) if (!models.some(model => model.id === id && model.available)) throw new HttpError(400, `Model ${String(id)} is unavailable.`);
    const input = validateRunInput({ track: value.track, seed: value.seeds[0], durationSeconds: value.durationSeconds, factionCount: value.factionCount,
      models: value.models.slice(0, Number(value.factionCount)), disaster: value.disaster ?? false, budget: value.budget }, models);
    const runInput = validateRunInput({ ...input, budget: value.runBudget ?? input.budget }, models);
    const roster = value.models as string[];
    const profiles = this.runs.profiles.filter(profile => roster.includes(profile.id));
    const engine = createArenaSession({ ...input, decisionTicks: 20, maxActions: 3 }).exportRecord().manifest.engine;
    const identity = await reproducibility(this.runs.rootDir, { ...input, models: value.models, seeds: value.seeds, repetitions, seatPolicy, runBudget: runInput.budget }, profiles,
      engine, { rules: ARENA_RULES, prompt: buildActorPrompt.toString() });
    if (identity.development && value.allowDevelopment !== true) throw new HttpError(409, 'Formal tournaments require a clean Git HEAD. Set allowDevelopment:true to label and run this development batch.', 'DEVELOPMENT_CONFIRMATION_REQUIRED');
    const schedule = createSchedule({ models: profiles.map(profile => ({ id: profile.id, kind: profile.provider === 'baseline' ? 'baseline' : 'remote', label: profile.label })),
      factionCount: input.factionCount, track: input.track, seeds: value.seeds as number[], durationSeconds: input.durationSeconds, repetitions, seatPolicy,
      profile: { engineVersion: `${identity.engine}:${identity.engineHash}:HEAD=${identity.codeHEAD ?? 'uncommitted'}:dirty=${String(identity.dirty)}`,
        protocolVersion: identity.protocolHash, promptVersion: identity.promptHash, budget: { ...runInput.budget, callsUnit: 'actor-decisions', total: input.budget },
        context: { profilesHash: identity.profilesHash, development: identity.development, concurrentDecisions: true, inputByteLimit: 1_048_576 },
        rules: { disaster: input.disaster, decisionTicks: 20, maxActions: 3, economy: 'normal' } } });
    if (schedule.games.length > 1024) throw new HttpError(400, 'Tournament exceeds the 1024 game limit; reduce models, seeds or repetitions.');
    const id = randomUUID();
    const stored: StoredTournament = { version: 1, summary: { id, status: 'queued', createdAt: new Date().toISOString(), totalGames: schedule.games.length, completedGames: 0,
      runIds: [], budget: input.budget, calls: 0, costUsd: 0, development: identity.development }, schedule,
      games: schedule.games.map(game => ({ gameId: game.gameId })), runBudget: runInput.budget, disaster: input.disaster, allowDevelopment: value.allowDevelopment === true };
    const managed: ManagedTournament = { stored, pause: false, writes: Promise.resolve() }; this.tournaments.set(id, managed); await this.persist(managed);
    const detail = this.get(id); this.start(managed); return detail;
  }
  private persist(managed: ManagedTournament): Promise<void> {
    managed.stored.summary = this.metrics(managed);
    const text = JSON.stringify(managed.stored), path = join(this.runs.dataDir, 'tournaments', `${managed.stored.summary.id}.json`);
    managed.writes = managed.writes.then(() => atomicWriteJson(path, text)); return managed.writes;
  }
  private start(managed: ManagedTournament): void {
    if (managed.task || this.closing) return;
    managed.task = this.execute(managed).finally(() => { managed.task = undefined; }); void managed.task.catch(() => {});
  }
  private async execute(managed: ManagedTournament): Promise<void> {
    const { stored } = managed;
    stored.summary.status = 'running';
    try {
      for (const game of stored.schedule.games) {
        if (managed.pause || this.closing) break;
        const mapping = stored.games.find(item => item.gameId === game.gameId)!;
        if (mapping.runId && this.runs.get(mapping.runId).status === 'completed') continue;
        if (!mapping.runId) {
          const current = this.metrics(managed), remainingCalls = stored.summary.budget.maxCalls - current.calls;
          if (current.costUsd === null) throw new HttpError(409, 'Batch expenditure is unknown; reconcile the affected run before continuing.');
          if (remainingCalls < game.factionCount) { managed.pause = true; stored.summary.error = 'Batch decision-call budget exhausted.'; break; }
          const budget = { maxCalls: Math.min(stored.runBudget.maxCalls, remainingCalls), maxCostUsd: Math.max(0, Math.min(stored.runBudget.maxCostUsd, stored.summary.budget.maxCostUsd - current.costUsd)) };
          const run = await this.runs.create({ track: game.track, seed: game.seed, durationSeconds: game.durationSeconds, factionCount: game.factionCount,
            models: [...game.seats].sort((a, b) => a.seat - b.seat).map(seat => seat.modelId), disaster: stored.disaster, budget },
            { tournamentId: stored.summary.id, initiativeOffset: game.initiativeOffset, start: false });
          mapping.runId = run.id; await this.persist(managed);
        }
        if (managed.pause || this.closing) break;
        const identity = this.runs.get(mapping.runId).reproducibility;
        const actualEngine = `${identity.engine}:${identity.engineHash}:HEAD=${identity.codeHEAD ?? 'uncommitted'}:dirty=${String(identity.dirty)}`;
        const frozen = stored.schedule.config.profile;
        if ((!stored.allowDevelopment && identity.development) || actualEngine !== frozen.engineVersion || identity.protocolHash !== frozen.protocolVersion || identity.promptHash !== frozen.promptVersion) {
          throw new HttpError(409, 'Code/engine/protocol/prompt identity changed after scheduling. The child remains paused; create a fresh batch for the changed benchmark.', 'BENCHMARK_CHANGED');
        }
        await this.runs.resume(mapping.runId);
        const result = await this.runs.wait(mapping.runId);
        await this.persist(managed);
        if (result.status !== 'completed') { stored.summary.status = result.status === 'failed' ? 'failed' : 'paused'; stored.summary.error = result.error ?? 'Child run paused before completion.'; managed.pause = true; break; }
      }
      if (stored.games.every(game => game.runId && this.runs.get(game.runId).status === 'completed')) { stored.summary.status = 'completed'; delete stored.summary.error; }
      else if (stored.summary.status !== 'failed') stored.summary.status = 'paused';
    } catch (error) { stored.summary.status = 'failed'; stored.summary.error = sanitizeError(error, this.runs.env); managed.pause = true; }
    finally { await this.persist(managed); }
  }
  async pause(id: string): Promise<TournamentDetail> {
    const managed = this.lookup(id); managed.pause = true;
    for (const game of managed.stored.games) if (game.runId && ['queued', 'running', 'waiting'].includes(this.runs.get(game.runId).status)) await this.runs.pause(game.runId);
    if (managed.task) await managed.task;
    if (managed.stored.summary.status !== 'completed') managed.stored.summary.status = 'paused';
    await this.persist(managed); return this.get(id);
  }
  async resume(id: string): Promise<TournamentDetail> {
    const managed = this.lookup(id);
    if (managed.stored.summary.status === 'completed' || managed.task) return this.get(id);
    managed.pause = false; managed.stored.summary.status = 'queued'; delete managed.stored.summary.error;
    await this.persist(managed); const detail = this.get(id); this.start(managed); return detail;
  }
  async wait(id: string): Promise<TournamentDetail> { const managed = this.lookup(id); await managed.task; return this.get(id); }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.tournaments.values()].map(async managed => {
      if (managed.task || ['queued', 'running'].includes(managed.stored.summary.status)) await this.pause(managed.stored.summary.id);
      else await managed.writes;
    }));
  }
}
