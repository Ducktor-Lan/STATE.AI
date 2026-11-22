import type {
  FrontAction,
  FrontCancelReason,
  MapPoint,
  OwnerId,
  PlayerId,
  UpgradeKind,
} from './types';

export type MatchEventType =
  | 'overflow'
  | 'capture'
  | 'upgrade'
  | 'eliminated'
  | 'cannon'
  | 'front'
  | 'defend';

/**
 * Lightweight, plain-data notification for the UI. The engine is the only
 * producer: rendering must never recompute lost troops after clamping.
 *
 * Cannon events repurpose the shared fields: `targetId` is the tower territory,
 * `amount` is the damage, `from` is the tower anchor and `to` is the point where
 * the swept army segment entered the range circle. `targetArmyId` identifies the
 * hit army (never confuse it with `targetId`).
 *
 * Front events announce a line lifecycle (`frontAction`, `frontReason`).
 * Defend events report a REAL defended wave: `targetId` is the defended
 * territory, `owner` is its defender, `amount` is the total real loss, with
 * `shieldLoss`/`troopLoss` splitting it and `targetArmyId` naming the wave.
 *
 * Capture events additionally carry the territory's REAL state immediately
 * before the ownership transfer, read right before `resetCapturedTerritory`.
 * They are optional so older callers/fixtures remain valid; the engine always
 * fills them in so renderers can collapse the defences that really fell.
 */
export interface MatchEvent {
  type: MatchEventType;
  tick: number;
  targetId: string;
  /** Troops lost to overflow, survivors garrisoned, upgrade cost or cannon damage. */
  amount: number;
  owner?: PlayerId;
  /** New production/march/defense level for 'upgrade' events. */
  level?: 1 | 2 | 3;
  /** Upgrade track for 'upgrade' events. */
  kind?: UpgradeKind;
  /** Cannon events only. */
  targetArmyId?: number;
  /** Cannon events only: tower anchor / impact point in map coordinates. */
  from?: MapPoint;
  to?: MapPoint;
  /** Front events only: lifecycle action and its cancellation reason. */
  frontAction?: FrontAction;
  frontReason?: FrontCancelReason;
  /** Front events only: the affected line id. */
  frontId?: number;
  /** Defend events only: real integer losses of this wave. */
  shieldLoss?: number;
  troopLoss?: number;
  /** Defend events only: true when the siege rule removed the last-stand floor. */
  siege?: boolean;
  /** Capture events only: real defence level before the ownership transfer. */
  previousDefenseLevel?: 0 | 1 | 2;
  /** Capture events only: real owner before the ownership transfer. */
  previousOwner?: OwnerId;
}

export const MAX_EVENTS = 256;

export function pushEvent(
  events: MatchEvent[] | undefined,
  event: MatchEvent
): void {
  if (!events) return;
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}
