import type { PlayerId, UpgradeKind } from '../core/types';

export type AiCommandType = 'move' | 'upgrade';

export interface PlannedCommand {
  type: AiCommandType;
  owner: PlayerId;
  sourceId: string;
  targetId: string;
  ratio: number;
  sent: number;
  score: number;
  reason: string;
  /** Upgrade track for 'upgrade' commands (production | march | defense). */
  kind?: UpgradeKind;
  /** Marks the second half of a coordinated two-source strike. */
  coordinated?: boolean;
}

export interface AiDecisionOptions {
  /** Ignore the per-difficulty decision cadence (tests, benchmark tools). */
  force?: boolean;
  /** Override the tuning's per-pass command cap. */
  maxCommands?: number;
}

export interface CommandReceipt {
  command: PlannedCommand;
  accepted: boolean;
  reason?: string;
}

export interface AiDecision {
  owner: PlayerId;
  tick: number;
  difficulty: string;
  /** Every accepted command, in execution order. One entry = one order. */
  commands: PlannedCommand[];
  /** Accepted and rejected orders with reasons (benchmark observability). */
  receipts: CommandReceipt[];
  /** Number of generated candidates before the Top-K cut. */
  candidateCount: number;
}
