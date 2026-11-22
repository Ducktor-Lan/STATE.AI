import type { MatchSnapshot } from '../../../.generated/state-conquest/src/game-api';
import type { Storyboard, StorySegment } from '@state/media/types';
export type { Storyboard, StorySegment };
import type { EvaluationReport, EvaluationSchedule, SeatPolicy } from '@state/evaluation/types';
export interface CreateTournamentInput {
  track: Track;
  models: string[];
  seeds: number[];
  durationSeconds: 180 | 300 | 480;
  factionCount: 2 | 3 | 4;
  repetitions: number;
  seatPolicy: SeatPolicy;
  disaster: boolean;
  budget: Budget;
  runBudget?: Budget;
  allowDevelopment?: boolean;
}
export interface TournamentSummary {
  id: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed';
  totalGames: number;
  completedGames: number;
  createdAt: string;
  runIds: string[];
  budget: Budget;
  calls: number;
  costUsd: number | null;
  httpAttempts?: number;
  development: boolean;
  error?: string;
}
export interface TournamentDetail extends TournamentSummary {
  schedule: EvaluationSchedule;
  report: EvaluationReport;
  games: Array<{ gameId: string; runId?: string; status: 'pending' | RunStatus }>;
}

/** Browser/server contract. All money, results and model metadata come from the server. */
export type Track = 'strategy' | 'diplomacy';
export type Seat = 'player' | 'ai1' | 'ai2' | 'ai3';
export type RunStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed';
export interface Budget { maxCalls: number; maxCostUsd: number }
export interface StartBudget { requiredCalls: number; requiredCostUsd: number }
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
export interface RegisterModelInput {
  baseUrl: string;
  model: string;
  apiKey: string;
  label?: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxOutputTokens?: number;
  maxTokensParameter?: 'max_completion_tokens' | 'max_tokens';
}
export interface CreateRunInput {
  track: Track;
  seed: number;
  durationSeconds: 180 | 300 | 480;
  factionCount: 2 | 3 | 4;
  models: string[];
  disaster: boolean;
  budget: Budget;
  recordVideo?: boolean;
}
export interface RunSummary extends CreateRunInput {
  id: string;
  status: RunStatus;
  createdAt: string;
  tick: number;
  wallElapsedMs: number;
  calls: number;
  httpAttempts?: number | null;
  /** null means the provider has not supplied reliable usage pricing. */
  costUsd: number | null;
  error?: string;
  mapName?: string;
}
export interface DecisionSummary {
  round: number;
  tick: number;
  owner: Seat;
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
  owner?: Seat;
  visibility?: 'public' | 'private';
  from?: Seat;
  to?: Seat;
  /** Original engine receipt, when this event was produced by the engine. */
  payload?: unknown;
}
export interface Outcome {
  reason: string;
  standings: Array<{ owner: Seat; rank: number; score: number; territories: number; troops: number }>;
}
export interface RoundIndex { round: number; tick: number }
export interface SpectatorAccess { privateMessages: boolean; note: string }
export interface RunDetail {
  run: RunSummary;
  rounds: RoundIndex[];
  events: RunEvent[];
  outcome?: Outcome | null;
  spectatorAccess?: SpectatorAccess;
}
export interface StateFrame {
  snapshot: MatchSnapshot;
  run: RunSummary;
  decisions: DecisionSummary[];
  events: RunEvent[];
  outcome?: Outcome | null;
}
export interface ReplayFrame {
  snapshot: MatchSnapshot;
  outcome: Outcome | null;
}
export interface ReplayFrames {
  run: RunSummary;
  frames: ReplayFrame[];
  decisionsByRound: Array<{ tick: number; decisions: DecisionSummary[] }>;
}
type TerritorySnapshot = MatchSnapshot['territories'][number];
type TerritoryGeometry = Pick<TerritorySnapshot, 'polygon' | 'center' | 'labelAnchor' | 'labelLeader'>;
type ReplayMapFields = Pick<MatchSnapshot, 'edges' | 'layout' | 'geog'>;
interface ReplayFramesResponse extends Pick<ReplayFrames, 'run' | 'decisionsByRound'> {
  map: ReplayMapFields & { territories: Record<string, TerritoryGeometry> };
  frames: Array<Omit<ReplayFrame, 'snapshot'> & {
    snapshot: Omit<MatchSnapshot, keyof ReplayMapFields | 'territories'> & {
      territories: Array<Omit<TerritorySnapshot, keyof TerritoryGeometry>>;
    };
  }>;
}
export interface RoundDecision extends DecisionSummary {
  observation?: unknown;
  output?: unknown;
  messages?: RunEvent[];
}
export interface RoundDetail {
  round: number;
  tick: number;
  decisions: RoundDecision[];
  spectatorAccess: SpectatorAccess;
}
export interface ExportInput {
  format: 'mp4';
  width: 1920;
  height: 1080;
  fps: 30;
  narration?: { provider: 'import'; assetId: string } | { provider: 'windows' };
}
export interface Artifact { name: string; url: string; mediaType?: string }
export interface ExportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Completed fraction, from 0 to 1. */
  progress: number;
  stage?: string;
  artifacts?: Artifact[];
  error?: string;
}
export type { MatchSnapshot };

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly startBudget?: StartBudget) {
    super(message);
    this.name = 'ApiError';
  }
}
function readStartBudget(value: unknown): StartBudget | undefined {
  if (!value || typeof value !== 'object') return;
  const { requiredCalls, requiredCostUsd } = value as Record<string, unknown>;
  if (typeof requiredCalls === 'number' && Number.isSafeInteger(requiredCalls) && requiredCalls >= 0
    && typeof requiredCostUsd === 'number' && Number.isFinite(requiredCostUsd) && requiredCostUsd >= 0) {
    return { requiredCalls, requiredCostUsd };
  }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
    const message = typeof record?.error === 'string' ? record.error : typeof record?.message === 'string' ? record.message : `请求失败（HTTP ${response.status}）`;
    const code = typeof record?.code === 'string' ? record.code : undefined;
    throw new ApiError(message, response.status, code, readStartBudget(record?.startBudget));
  }
  if (body === null) throw new ApiError('服务器未返回 JSON 数据。', response.status);
  return body as T;
}
const runPath = (id: string): string => `/api/runs/${encodeURIComponent(id)}`;
export const api = {
  tournaments: () => request<{ tournaments: TournamentSummary[] }>('/api/tournaments'),
  createTournament: (input: CreateTournamentInput) => request<{ tournament: TournamentSummary }>('/api/tournaments', { method: 'POST', body: JSON.stringify(input) }),
  tournament: (id: string) => request<{ tournament: TournamentDetail }>(`/api/tournaments/${encodeURIComponent(id)}`),
  pauseTournament: (id: string) => request<{ tournament: TournamentSummary }>(`/api/tournaments/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  resumeTournament: (id: string) => request<{ tournament: TournamentSummary }>(`/api/tournaments/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  models: (signal?: AbortSignal) => request<{ models: ModelSummary[] }>('/api/models', { signal }),
  registerModel: (input: RegisterModelInput) => request<{ model: ModelSummary }>('/api/models', { method: 'POST', body: JSON.stringify(input), redirect: 'error' }),
  runs: (signal?: AbortSignal) => request<{ runs: RunSummary[] }>('/api/runs', { signal }),
  startBudget: async (input: CreateRunInput, signal?: AbortSignal): Promise<StartBudget> => {
    const result = await request<{ startBudget: unknown }>('/api/runs/start-budget', { method: 'POST', body: JSON.stringify(input), signal });
    const startBudget = readStartBudget(result.startBudget);
    if (!startBudget) throw new Error('服务未返回有效的首轮门槛。');
    return startBudget;
  },
  createRun: (input: CreateRunInput) => request<{ run: RunSummary }>('/api/runs', { method: 'POST', body: JSON.stringify(input) }),
  recording: (id: string, signal?: AbortSignal) => request<{ job: ExportJob | null }>(`${runPath(id)}/recording`, { signal }),
  createRecording: (id: string, signal?: AbortSignal) => request<{ job: ExportJob }>(`${runPath(id)}/recording`, { method: 'POST', body: '{}', signal }),
  detail: (id: string, signal?: AbortSignal) => request<RunDetail>(runPath(id), { signal }),
  state: (id: string, tick?: number, signal?: AbortSignal) => request<StateFrame>(`${runPath(id)}/state${tick === undefined ? '' : `?tick=${Math.max(0, Math.floor(tick))}`}`, { signal }),
  replayFrames: async (id: string, from: number, limit: number, signal?: AbortSignal): Promise<ReplayFrames> => {
    const { run, map, frames, decisionsByRound } = await request<ReplayFramesResponse>(`${runPath(id)}/replay-frames?from=${from}&limit=${limit}`, { signal });
    const { territories, ...geometry } = map;
    return { run, decisionsByRound, frames: frames.map(({ snapshot, outcome }) => ({
      outcome,
      snapshot: { ...snapshot, ...geometry, territories: snapshot.territories.map(territory => {
        const shape = territories[territory.id];
        if (!shape) throw new Error(`回放缺少领地 ${territory.id} 的地图几何。`);
        return { ...territory, ...shape };
      }) },
    })) };
  },
  pause: (id: string) => request<{ run: RunSummary }>(`${runPath(id)}/pause`, { method: 'POST' }),
  resume: (id: string) => request<{ run: RunSummary }>(`${runPath(id)}/resume`, { method: 'POST' }),
  round: (id: string, round: number, signal?: AbortSignal) => request<RoundDetail>(`${runPath(id)}/rounds/${round}`, { signal }),
  storyboard: (id: string, signal?: AbortSignal) => request<Storyboard>(`${runPath(id)}/storyboard`, { signal }),
  saveStoryboard: (id: string, storyboard: Storyboard) => request<Storyboard>(`${runPath(id)}/storyboard`, { method: 'POST', body: JSON.stringify(storyboard) }),
  narration: (id: string) => request<{ audioUrl: string; storyboard?: Storyboard }>(`${runPath(id)}/narration`, { method: 'POST', body: '{}' }),
  uploadAudio: async (id: string, file: File): Promise<{ audioUrl: string; assetId: string }> => {
    const response = await fetch(`${runPath(id)}/audio`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Audio-Filename': encodeURIComponent(file.name) }, body: file });
    const body = await response.json() as { audioUrl: string; assetId: string; error?: string };
    if (!response.ok) throw new ApiError(body.error ?? `音轨上传失败（HTTP ${response.status}）`, response.status);
    return body;
  },
  export: (id: string, input: ExportInput) => request<{ jobId: string }>(`${runPath(id)}/export`, { method: 'POST', body: JSON.stringify(input) }),
  job: (id: string, signal?: AbortSignal) => request<ExportJob>(`/api/jobs/${encodeURIComponent(id)}`, { signal }),
};

/** Only same-origin server artifacts may be embedded or downloaded. */
export function artifactUrl(raw: string, origin = window.location.origin): string | null {
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/artifacts/')) return null;
    return url.pathname + url.search;
  } catch { return null; }
}
