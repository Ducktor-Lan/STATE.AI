import type { ArenaConfig, ArenaRecord, ArenaResult, MatchSnapshot, PlayerId } from '@state/arena';
import type { Storyboard } from '@state/media';

export type RunStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed';
export interface CreateRunInput {
  track: ArenaConfig['track'];
  seed: number;
  durationSeconds: ArenaConfig['durationSeconds'];
  factionCount: ArenaConfig['factionCount'];
  models: string[];
  disaster: boolean;
  budget: { maxCalls: number; maxCostUsd: number };
  decisionTicks?: number;
  maxActions?: number;
  recordVideo?: boolean;
}
export interface StartBudget {
  requiredCalls: number;
  requiredCostUsd: number;
}
export interface Reproducibility {
  codeHEAD: string | null;
  dirty: boolean | null;
  development: boolean;
  engine: string;
  engineHash: string;
  protocolHash: string;
  promptHash: string;
  configHash: string;
  profilesHash: string;
}
export interface RunErrorDiagnostic {
  name: string;
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
  dest?: string;
  phase?: string;
  operation?: string;
  entryType?: string;
  roundIndex?: number;
  durable?: boolean;
  stack?: string;
}
export interface RunPersistenceWarning {
  severity: 'warning';
  phase: string;
  durable: true;
  entryType?: string;
  roundIndex?: number;
  tick?: number;
  error: RunErrorDiagnostic[];
}
export interface RunSummary extends CreateRunInput {
  id: string;
  status: RunStatus;
  createdAt: string;
  tick: number;
  wallElapsedMs: number;
  calls: number;
  /** Observed physical provider attempts; null if a failed/in-flight call has unknown attempts. */
  httpAttempts?: number | null;
  knownHttpAttempts?: number;
  uncertainCalls?: Array<{ seat: string; attemptId: string; status: string; roundIndex: number }>;
  costUsd: number | null;
  error?: string;
  errorKind?: 'infrastructure' | 'budget' | 'recovery' | 'cancelled';
  /** Bounded, sanitized original error/cause chain, retained for local diagnosis. */
  errorDiagnostics?: RunErrorDiagnostic[];
  persistenceWarningCount?: number;
  /** Most recent 40 auxiliary-cache warnings; durable JSONL remains authoritative. */
  persistenceWarnings?: RunPersistenceWarning[];
  pauseRequested?: boolean;
  mapName?: string;
  reproducibility: Reproducibility;
  tournamentId?: string;
}
export interface DecisionSummary {
  round: number;
  tick: number;
  owner: PlayerId;
  modelId: string;
  status: 'waiting' | 'received' | 'applied' | 'error' | 'skipped';
  intent?: string;
  receipts?: unknown[];
  latencyMs?: number;
  costUsd?: number | null;
  error?: string;
}
export interface RunEvent {
  id: string;
  tick: number;
  type: string;
  title: string;
  detail?: string;
  owner?: PlayerId;
  visibility?: 'public' | 'private';
  from?: PlayerId;
  to?: PlayerId;
  payload?: unknown;
}
export interface Outcome {
  reason: string;
  standings: Array<{ owner: PlayerId; rank: number; score: number; territories: number; troops: number }>;
}
export interface RunState {
  snapshot: MatchSnapshot;
  run: RunSummary;
  decisions: DecisionSummary[];
  events: RunEvent[];
  outcome?: Outcome | null;
}
type ReplayTerritory = MatchSnapshot['territories'][number];
type TerritoryGeometry = Pick<ReplayTerritory, 'polygon' | 'center' | 'labelAnchor' | 'labelLeader'>;
export interface ReplayMap extends Pick<MatchSnapshot, 'edges' | 'layout' | 'geog'> {
  territories: Record<string, TerritoryGeometry>;
}
export interface ReplaySnapshot extends Omit<MatchSnapshot, 'edges' | 'layout' | 'geog' | 'territories'> {
  territories: Omit<ReplayTerritory, keyof TerritoryGeometry>[];
}
export interface ReplayFrames {
  run: RunSummary;
  map: ReplayMap;
  frames: Array<{ snapshot: ReplaySnapshot; outcome: Outcome | null }>;
  decisionsByRound: Array<{ tick: number; decisions: DecisionSummary[] }>;
}
export interface StoredRun {
  version: 1;
  run: RunSummary;
  storyboard?: Storyboard;
}
export interface RunExport {
  run: RunSummary;
  record: ArenaRecord;
  outcome: ArenaResult | null;
}
export interface ModelSummary {
  id: string;
  label: string;
  provider: string;
  kind: 'baseline' | 'remote';
  available: boolean;
  unavailableReason?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}
export interface ExportJob {
  id: string;
  runId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  stage?: string;
  artifacts?: Array<{ name: string; url: string; mediaType?: string }>;
  error?: string;
}
