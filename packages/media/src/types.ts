/** Media's public input contract. The server maps persisted arena records into these facts. */
export interface MediaFaction {
  id: string;
  label: string;
  modelLabel: string;
  modelId?: string;
}

export interface MediaEvent {
  id: string;
  tick: number;
  type: 'capture' | 'leadchange' | 'alliance' | 'break' | 'elimination' | 'battle';
  factionId: string;
  otherFactionId?: string;
  fromFactionId?: string | null;
  territoryId?: string;
  territoryLabel?: string;
  damage?: number;
  score?: number;
  reason?: string;
}

export interface MediaDecision {
  id: string;
  tick: number;
  factionId: string;
  /** The recorded model statement, never inferred from the action or result. */
  intent?: string;
  eventIds?: string[];
}

export interface MediaOutcome {
  tick?: number;
  reason: string;
  standings: Array<{
    factionId: string;
    rank: number;
    score?: number;
    territories?: number;
    troops?: number;
  }>;
}

export interface MediaSource {
  runId: string;
  durationTicks: number;
  /** Original engine clock; STATE uses ten ticks per second. */
  ticksPerSecond?: number;
  factions: MediaFaction[];
  events: MediaEvent[];
  decisions: MediaDecision[];
  outcome?: MediaOutcome;
  /** SHA-256 fingerprints supplied by the persisted run, not model-generated claims. */
  fingerprints?: Record<string, string>;
}

export interface SegmentHold {
  /** Hold the last real replay tick after the moving portion of this segment. */
  at: 'end';
  durationSeconds: number;
}

export interface StorySegment {
  id: string;
  kind: 'opening' | 'event' | 'replay' | 'result';
  eventIds: string[];
  decisionIds?: string[];
  gameStartTick: number;
  gameEndTick: number;
  videoStartSeconds: number;
  durationSeconds: number;
  caption: string;
  narration: string;
  /** Measured speech length, populated after successful synthesis/import. */
  narrationDurationSeconds?: number;
  /** Game seconds per video second; zero is allowed only for a complete still frame. */
  playbackRate: number;
  hold?: SegmentHold;
}

export interface Storyboard {
  version: 1;
  runId: string;
  durationTicks: number;
  ticksPerSecond: number;
  durationSeconds: number;
  sourceFingerprint: string;
  segments: StorySegment[];
}

export interface StoryboardOptions {
  maxEvents?: number;
  preRollTicks?: number;
  postRollTicks?: number;
  playbackRate?: number;
  minSegmentSeconds?: number;
  openingSeconds?: number;
  resultSeconds?: number;
  intentLookbackTicks?: number;
}

export interface ValidationIssue { path: string; message: string }
export interface ValidationResult { valid: boolean; issues: ValidationIssue[] }
export interface SubtitleCue { index: number; startSeconds: number; endSeconds: number; text: string; segmentId: string }
export interface SrtOptions { maxCharactersPerLine?: number; maxLines?: number; minCueSeconds?: number }

export interface ToolPaths {
  ffmpegPath?: string;
  ffprobePath?: string;
  edgePath?: string;
}
export interface ResolvedTools { ffmpegPath: string; ffprobePath?: string; edgePath?: string }
export interface SystemVoice { name: string; culture: string; enabled: boolean }

export interface WindowsTtsOptions {
  provider: 'windows';
  voice?: string;
  /** System.Speech rate, from -10 to 10. */
  rate?: number;
  powerShellPath?: string;
}
export interface OpenAiTtsOptions {
  provider: 'openai-compatible';
  /** Explicit endpoint, e.g. https://api.openai.com/v1/audio/speech. */
  endpoint: string;
  model: string;
  voice: string;
  /** Only the server resolves this environment variable. Never put a key in the storyboard. */
  apiKeyEnv: string;
  speed?: number;
  timeoutMs?: number;
}
export interface ImportedTtsOptions {
  provider: 'import';
  /** A complete, already aligned track. If it is longer, the result hold is extended. */
  audioPath?: string;
  /** Or individual local recordings, one per narrated segment. */
  segments?: Record<string, string>;
}
export type NarrationOptions = WindowsTtsOptions | OpenAiTtsOptions | ImportedTtsOptions | { provider: 'none' };

export interface NarrationClip {
  segmentId: string;
  provider: NarrationOptions['provider'];
  durationSeconds: number;
  videoStartSeconds: number;
  sourceSha256: string;
  textSha256: string;
}
export interface PreparedNarration {
  storyboard: Storyboard;
  audioPath: string;
  audioDurationSeconds: number;
  clips: NarrationClip[];
  provider: NarrationOptions['provider'];
}
export interface PrepareNarrationOptions extends ToolPaths {
  source: MediaSource;
  storyboard: Storyboard;
  outputDir: string;
  /** Trusted absolute server directory containing outputDir. */
  outputRoot?: string;
  narration: NarrationOptions;
  /** Server-owned environment snapshot; credentials are read only and never serialized. */
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  paddingSeconds?: number;
}

/** Contract implemented by the production broadcast page. */
export interface RenderFrameInput {
  gameTick: number;
  videoTime: number;
  /** Explicit deterministic effect clock, in milliseconds. */
  frameTime: number;
  caption: string;
  narration: string;
  segment: StorySegment;
}
export interface BroadcastRenderApi {
  ready: boolean | Promise<void>;
  /** Identity of the actual record loaded by the page, populated before ready resolves. */
  runId: string;
  /** Loaded from that run's validated storyboard, never echoed from export parameters. */
  sourceFingerprint: string;
  error?: string;
  canvasSelector?: string;
  renderFrame(input: RenderFrameInput): void | Promise<void>;
}
export interface ExportProgress {
  stage: 'tools' | 'narration' | 'frames' | 'encoding' | 'verification' | 'complete';
  progress: number;
  message?: string;
  frame?: number;
  totalFrames?: number;
}
export interface ExportVideoOptions extends ToolPaths {
  baseUrl: string;
  runId: string;
  source: MediaSource;
  storyboard: Storyboard;
  /** Absolute server-owned directory. Defaults to allowing paths under runs/ or outputs/. Must not already contain final artifacts. */
  outputDir: string;
  /** Trusted absolute server directory containing outputDir. */
  outputRoot?: string;
  narration: NarrationOptions;
  /** Server-owned environment snapshot; credentials are read only and never serialized. */
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  broadcastPath?: string;
  canvasSelector?: string;
  width?: 1920;
  height?: 1080;
  fps?: 30;
  /** Captions are drawn by the broadcast page when true; SRT is always written. */
  burnSubtitles?: boolean;
  renderTimeoutMs?: number;
  maxFrames?: number;
}
export interface ProbeResult {
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioDurationSeconds?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}
export interface ExportManifest {
  version: 1;
  runId: string;
  sourceFingerprint: string;
  sourceFingerprints: Record<string, string>;
  storyboardFingerprint: string;
  width: 1920;
  height: 1080;
  fps: 30;
  frames: number;
  durationSeconds: number;
  tools: Record<string, string>;
  narration: { provider: NarrationOptions['provider']; clips: NarrationClip[] };
  subtitles: { burnedIn: boolean; cueCount: number };
  verification: ProbeResult & { fullDecode: true };
  artifacts: Record<string, { sha256: string; bytes: number }>;
}
export interface ExportVideoResult {
  videoPath: string;
  subtitlesPath: string;
  narrationPath: string;
  manifestPath: string;
  storyboard: Storyboard;
  manifest: ExportManifest;
}
