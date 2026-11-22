import type { MatchState, MatchSnapshot, PlayerId, UpgradeKind } from '../../../.generated/state-conquest/src/core/types.js';
import type { MatchEvent } from '../../../.generated/state-conquest/src/core/events.js';
import type { ArenaObservation } from './observation.js';
export type { MatchState, MatchSnapshot, MatchEvent, PlayerId, ArenaObservation };
export type SeatId = 'A' | 'B' | 'C' | 'D';
export const SEATS: readonly SeatId[] = ['A', 'B', 'C', 'D'];
export const SEAT_TO_OWNER: Readonly<Record<SeatId, PlayerId>> = { A: 'player', B: 'ai1', C: 'ai2', D: 'ai3' };
export const OWNER_TO_SEAT: Readonly<Record<PlayerId, SeatId>> = { player: 'A', ai1: 'B', ai2: 'C', ai3: 'D' };
export interface ArenaConfig {
  id?: string;
  track: 'strategy' | 'diplomacy';
  seed: number;
  durationSeconds: 180 | 300 | 480;
  factionCount: 2 | 3 | 4;
  models: string[];
  decisionTicks?: 20;
  maxActions?: 3;
  disaster?: boolean;
  /** Actor decision invocations, including baseline; provider HTTP retries are separate metadata.attempts. */
  budget: { maxCalls: number; maxCostUsd?: number };
  initiativeOffset?: number;
}
export interface ArenaAction {
  type: 'move' | 'upgrade' | 'set_front' | 'stop_front' | 'wait';
  source?: string;
  target?: string;
  ratio?: number;
  territory?: string;
  kind?: UpgradeKind;
}
export type DiplomacyAction =
  | { type: 'public'; text: string }
  | { type: 'private'; to: SeatId; text: string }
  | { type: 'offer'; to: SeatId }
  | { type: 'accept' | 'reject'; offer_id: string }
  | { type: 'break'; to: SeatId };
export interface ArenaDecision {
  decision_id: string;
  intent: string;
  actions: ArenaAction[];
  memory_note: string;
  diplomacy?: DiplomacyAction[];
}
export interface ActorResponse {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; [key: string]: unknown };
  costUsd?: number;
  metadata?: Record<string, unknown>;
}
export interface ActorRequest {
  seat: SeatId;
  decisionId: string;
  observation: ArenaObservation;
  obsHash: string;
  /** Only this seat's previous note; never other factions' memory. */
  memoryNote?: string;
  signal?: AbortSignal;
}
export type ArenaActor = (request: ActorRequest) => Promise<ActorResponse>;
export interface ArenaSessionOptions {
  actors?: Partial<Record<SeatId, ArenaActor>>;
  store?: ArenaStore;
  signal?: AbortSignal;
  /** Defaults to true whenever a USD ceiling is configured. */
  requireCostReservation?: boolean;
  /** Enforced upper bound per call; a response above it pauses the match. */
  reserveCostUsd?: number | Partial<Record<SeatId, number>> | ((request: ActorRequest) => number | undefined);
}
export interface ActionReceipt {
  seat: SeatId;
  actionIndex: number;
  action?: unknown;
  accepted: boolean;
  reason?: string;
  result?: unknown;
}
export interface DecisionReceipt {
  seat: SeatId;
  decisionId: string;
  obsHash: string;
  valid: boolean;
  parseError?: string;
  actions: ActionReceipt[];
  diplomacy: ActionReceipt[];
}
export interface StoredResponse {
  seat: SeatId;
  decisionId: string;
  obsHash: string;
  response: ActorResponse;
}
export interface ArenaAttempt { id: string; status: 'pending' | 'failed' | 'settled' | 'answered'; costUsd?: number; error?: string }
export interface ArenaRound {
  index: number;
  id: string;
  startTick: number;
  endTick: number;
  seats: SeatId[];
  observations: Partial<Record<SeatId, ArenaObservation>>;
  obsHashes: Partial<Record<SeatId, string>>;
  responses: Partial<Record<SeatId, StoredResponse>>;
  attempts: Partial<Record<SeatId, ArenaAttempt[]>>;
  memoryNotes: Partial<Record<SeatId, string>>;
  receipts: Partial<Record<SeatId, DecisionReceipt>>;
  events: Array<{ tick: number; events: MatchEvent[] }>;
  fingerprint?: string;
  committed: boolean;
}
export interface ArenaRank {
  seat: SeatId;
  rank: number;
  alive: boolean;
  score: number;
  lands: number;
  force: number;
  eliminatedAtTick?: number;
}
export interface ArenaResult { reason: 'elimination' | 'timeout' | 'stalemate'; tick: number; ranking: ArenaRank[]; winners: SeatId[] }
export interface BudgetState {
  /** Actor invocations; a provider may report multiple HTTP attempts for one invocation. */
  calls: number;
  knownCostUsd: number;
  unknownCostCalls: number;
  reservedCalls: number;
  reservedCostUsd: number;
}
export interface PendingOffer { id: string; from: SeatId; to: SeatId; createdTick: number; expiresTick: number; availableRound: number }
export interface ArenaMessage { id: string; from: SeatId; to: SeatId | 'public'; text: string; tick: number; availableRound: number }
export interface ArenaAuxState {
  eliminatedAt: Partial<Record<SeatId, number>>;
  memoryNotes: Partial<Record<SeatId, string>>;
  offers: PendingOffer[];
  messages: ArenaMessage[];
  nextOfferId: number;
  nextMessageId: number;
  budget: BudgetState;
  result: ArenaResult | null;
}
export interface ArenaCheckpoint { roundIndex: number; state: MatchState; aux: ArenaAuxState; fingerprint: string }
export interface ArenaManifest { schemaVersion: 1; engine: 'state-conquest@35d7ca7+arena.1'; config: ArenaConfig; initialFingerprint: string }
export type ArenaLogEntry =
  | { type: 'BEGIN'; round: ArenaRound; reservations: Partial<Record<SeatId, number>>; requireCostReservation: boolean }
  | { type: 'INVOKE'; roundIndex: number; seat: SeatId; attemptId: string }
  | { type: 'FAILURE'; roundIndex: number; seat: SeatId; attemptId: string; message: string }
  | { type: 'SETTLE'; roundIndex: number; seat: SeatId; attemptId: string; costUsd: number }
  | { type: 'COST'; roundIndex: number; seat: SeatId; costUsd: number }
  | { type: 'DECISION'; roundIndex: number; value: StoredResponse }
  | { type: 'COMMIT'; roundIndex: number; round: ArenaRound; checkpoint: ArenaCheckpoint }
  | { type: 'CONTROL'; status: 'paused' | 'running'; reason?: string };
export interface ArenaRecord { schemaVersion: 1; manifest: ArenaManifest; initialCheckpoint: ArenaCheckpoint; entries: ArenaLogEntry[] }
export interface ArenaFrame { tick: number; snapshot: MatchSnapshot; events: MatchEvent[]; fingerprint: string; result: ArenaResult | null }
export interface ArenaPersistenceErrorDetails {
  name: string;
  message: string;
  code?: string | number;
  syscall?: string;
  path?: string;
  dest?: string;
  phase?: string;
  cause?: ArenaPersistenceErrorDetails;
}
export interface ArenaPersistenceDiagnostic {
  severity: 'warning';
  phase: string;
  /** The authority (initial checkpoint and JSONL) is durable despite this auxiliary failure. */
  durable: true;
  entryType?: ArenaLogEntry['type'];
  roundIndex?: number;
  tick?: number;
  error: ArenaPersistenceErrorDetails;
}
export interface ArenaStore {
  initialize(record: ArenaRecord): Promise<void>;
  /** Resolve once the JSONL append is fsynced; auxiliary cache failures are diagnostics. */
  append(entry: ArenaLogEntry): Promise<void>;
  read(): Promise<ArenaRecord>;
  readonly diagnostics?: readonly ArenaPersistenceDiagnostic[];
  drainDiagnostics?(): ArenaPersistenceDiagnostic[];
}
export class ArenaInfrastructureError extends Error {
  readonly code = 'ARENA_INFRASTRUCTURE';
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ArenaInfrastructureError'; }
}
export class ArenaPausedError extends Error {
  readonly code = 'ARENA_PAUSED';
  constructor(readonly reason: string) { super(reason); this.name = 'ArenaPausedError'; }
}
