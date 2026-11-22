import { runAi } from '../ai';
import { runAiForOwner as runPlannerForOwner } from '../ai/planner';
import { durationToTicks } from '../config/modes';
import { applyMove, applyUpgrade } from './commands';
import { resolveCannons } from './cannon';
import { TICKS_PER_SECOND } from '../config/balance';
import { noDisaster, resolveDisasterTick } from './disaster';
import { assertInvariants } from './invariants';
import { resolveArrivals } from './movement';
import { produceTick } from './production';
import { createRng, normalizeSeed } from './rng';
import { applyBetrayal } from './skills';
import type { BetrayalResult } from './skills';
import {
  acceptTruceOffer,
  breakTruce,
  expireTruces,
  invalidatePendingAiOffers,
  maintainDiplomacy,
  proposeTruce,
  rejectTruceOffer,
  scanAiTruceOffers,
  toDiplomacySnapshot,
} from './diplomacy';
import { resolveStalemate } from './stalemate';
import type { Rng } from './rng';
import { createMatchState, toMatchSnapshot } from './state';
import {
  decideTimedOutcome,
  evaluateEarlyEnd,
  updateMaxTerritories,
} from './score';
import {
  cancelFrontsForEndedTruce,
  resolveContinuousFronts,
  startFront,
  stopFront,
} from './fronts';
import type {
  Difficulty,
  FactionCount,
  FrontCommandResult,
  MatchMode,
  MatchSnapshot,
  MatchState,
  PlayerId,
  TruceDecider,
  TruceProposalResult,
  UpgradeKind,
} from './types';
import { evaluateTruceProposal } from '../ai/diplomacy-evaluate';
import type { AiDecision } from '../ai/types';
import type { MatchEvent } from './events';
import type { GameMapDefinition } from '../maps/types';
import { TUTORIAL_DURATION_SECONDS, isTutorialMapId } from '../maps/tutorial-map';

/**
 * The production decider: the receiving faction evaluates the proposal from
 * its own deterministic interest. The argument order flips because core calls
 * decide(state, proposer, target) while the evaluator scores from the
 * receiver's perspective.
 */
const engineTruceDecider: TruceDecider = function (state, proposer, target) {
  return evaluateTruceProposal(state, target, proposer);
};

export interface AdvanceOptions {
  /** Built-in AI for ai1/ai2 (default true). */
  aiEnabled?: boolean;
  /** Restrict built-in AI to these owners. */
  aiActors?: PlayerId[];
}

/** Teaching lesson window; also the full window granted when free play starts. */
const TUTORIAL_WINDOW_TICKS = TUTORIAL_DURATION_SECONDS * TICKS_PER_SECOND;

interface SimulationStepOptions {
  /** false skips production/neutral recovery (benchmark harnesses). */
  resolveProduction?: boolean;
  /** false skips the disaster warning/strike (tutorial teaching only). */
  resolveDisaster?: boolean;
  /** false skips early elimination, stalemate and timeout (tutorial only). */
  resolveEndChecks?: boolean;
  /** Runs after the disaster phase, before cannon/arrivals/production. */
  decideAi?: () => void;
}

/**
 * One fixed simulation step. All public entry points use this exact ordering;
 * normal matches always resolve disaster and end checks.
 */
function advanceSimulationStep(
  state: MatchState,
  options?: SimulationStepOptions
): void {
  if (state.status !== 'playing') return;
  const production = !options || options.resolveProduction !== false;
  const disaster = !options || options.resolveDisaster !== false;
  const endChecks = !options || options.resolveEndChecks !== false;
  state.tick += 1;
  expireTruces(state);
  // Alliance bookkeeping: dead members and the two-faction endgame dissolve
  // truces automatically; each dissolved pair immediately loses its borrowed
  // routes and any continuous line that relied on them.
  const endedPairs = maintainDiplomacy(state);
  for (let i = 0; i < endedPairs.length; i += 1) {
    cancelFrontsForEndedTruce(state, endedPairs[i].a, endedPairs[i].b);
  }
  if (disaster) resolveDisasterTick(state);
  if (options && options.decideAi) options.decideAi();
  resolveCannons(state);
  resolveArrivals(state);
  // Second maintenance pass: cannon fire and landings may remove the last
  // territory or the last in-flight army of a faction INSIDE this tick, so a
  // member that was still "alive" at the top of the tick can be gone now.
  // Dissolving here keeps hasTruce and the cooldown bookkeeping consistent
  // with the end-of-tick world (same rules, never touches uses, and records
  // already dissolved this tick are skipped, so nothing cancels twice).
  const endedAfterArrivals = maintainDiplomacy(state);
  for (let i = 0; i < endedAfterArrivals.length; i += 1) {
    cancelFrontsForEndedTruce(state, endedAfterArrivals[i].a, endedAfterArrivals[i].b);
  }
  if (production) produceTick(state);
  // Continuous lines dispatch after production (so they can spend this tick's
  // fresh troops) and before the end checks (so a lost source is observed now).
  resolveContinuousFronts(state);
  updateMaxTerritories(state);

  if (!endChecks) return;
  const early = evaluateEarlyEnd(state);
  if (early !== null) {
    state.result = early;
    state.status = 'ended';
    state.endReason = 'elimination';
    invalidatePendingAiOffers(state);
    return;
  }
  if (resolveStalemate(state)) {
    invalidatePendingAiOffers(state);
    return;
  }
  if (state.tick >= state.durationTicks) {
    state.result = decideTimedOutcome(state);
    state.status = 'ended';
    state.endReason = 'timeout';
    invalidatePendingAiOffers(state);
  }
}

/** Advances one fixed simulation step without any AI decisions. */
export function advanceSimulationOnly(
  state: MatchState,
  options?: { resolveProduction?: boolean }
): void {
  advanceSimulationStep(state, {
    resolveProduction: options ? options.resolveProduction : undefined,
    resolveDisaster: true,
    resolveEndChecks: true,
  });
}

/**
 * Keeps the tutorial's order window open. Command validators reject orders once
 * `tick >= durationTicks`; a lesson may legitimately run far past the 180 s
 * scene clock while the player thinks or waits for production. Only the
 * deadline moves — `tick`, army `arrivalTick`, front send ticks and cannon
 * cooldowns are absolute and are never rewritten here.
 */
function rollTutorialDeadline(state: MatchState): void {
  if (state.tick + 1 >= state.durationTicks) {
    state.durationTicks = state.tick + 1 + TUTORIAL_WINDOW_TICKS;
  }
}

/**
 * Tutorial-only teaching step. Real cannon/arrival/production/front/event
 * resolution runs exactly as in a normal tick, but no AI, no disaster and no
 * early-end or timeout check can end the lesson. The shell freezes the scene by
 * simply not calling this function.
 */
export function advanceTutorialSimulationOnly(state: MatchState): void {
  if (state.status !== 'playing') return;
  rollTutorialDeadline(state);
  advanceSimulationStep(state, {
    resolveDisaster: false,
    resolveEndChecks: false,
  });
}

/**
 * One full engine step: tick++, built-in AI (optional), arrivals, production,
 * stats, end checks. Benchmark tools can disable AI and drive owners
 * themselves with runAiForOwner, while sharing this exact ordering.
 *
 * The RNG is required only when the built-in AI runs; `advanceOneTick(state,
 * { aiEnabled: false })` is accepted for harnesses that drive actors manually.
 */
export function advanceOneTick(
  state: MatchState,
  rngOrOptions?: Rng | AdvanceOptions,
  maybeOptions?: AdvanceOptions
): void {
  let rng: Rng | null = null;
  let options: AdvanceOptions | undefined = maybeOptions;
  if (rngOrOptions && typeof (rngOrOptions as Rng).next === 'function') {
    rng = rngOrOptions as Rng;
  } else if (rngOrOptions) {
    options = rngOrOptions as AdvanceOptions;
  }
  if (state.status !== 'playing') return;
  const aiEnabled = !options || options.aiEnabled !== false;

  if (aiEnabled && !rng) {
    throw new Error('advanceOneTick needs an Rng when AI is enabled');
  }
  advanceSimulationStep(state, {
    // The shared step resolves disaster before this callback, then applies the
    // same combat, production and end checks as advanceSimulationOnly.
    decideAi: aiEnabled
      ? function (): void {
          runAi(state, rng as Rng, options && options.aiActors ? { actors: options.aiActors } : undefined);
          scanAiTruceOffers(state, engineTruceDecider);
        }
      : undefined,
  });
}

/**
 * Deterministic fixed-step engine. There is exactly one tick clock; renderers
 * and input never advance it. Command order per tick:
 *   1. tick += 1
 *   2. disaster warning/strike (independent seed RNG)
 *   3. AI decisions (validated commands)
 *   4. cannon shots (before landing)
 *   5. arrivals sorted by arrivalTick, then army id
 *   6. production / neutral recovery (exactly one pass)
 *   7. running stats + win/time-out checks
 */
export class MatchEngine {
  readonly state: MatchState;
  readonly rng: Rng;

  constructor(
    map: GameMapDefinition,
    difficulty: Difficulty,
    durationSeconds: number,
    seed: number,
    betrayalLevel: number = 0,
    mode: MatchMode = 'solo',
    factionCount: FactionCount = 2,
    diplomacyEnabled: boolean = true
  ) {
    const normalizedSeed = normalizeSeed(seed);
    this.state = createMatchState(
      map,
      difficulty,
      durationToTicks(durationSeconds),
      normalizedSeed,
      betrayalLevel,
      mode,
      factionCount,
      diplomacyEnabled
    );
    // The teaching lesson must be disaster-free for every seed. The override is
    // scoped to the dedicated tutorial map id; normal matches keep the exact
    // seed-derived schedule they had before.
    if (isTutorialMapId(map.id)) this.state.disaster = noDisaster();
    this.rng = createRng(normalizedSeed);
  }

  start(): void {
    if (this.state.status === 'ready') this.state.status = 'playing';
  }

  pause(): void {
    if (this.state.status === 'playing') this.state.status = 'paused';
  }

  resume(): void {
    if (this.state.status === 'paused') this.state.status = 'playing';
  }

  issueMove(sourceId: string, targetId: string, ratio: number): boolean {
    return this.issueMoveForOwner('player', sourceId, targetId, ratio);
  }

  /**
   * Owner-aware command boundary used by the local versus mode. The shared
   * `applyMove` validator is the authority: it rejects a source that is not
   * owned by `owner`, a non-active owner, and non-playing matches atomically.
   */
  issueMoveForOwner(
    owner: PlayerId,
    sourceId: string,
    targetId: string,
    ratio: number
  ): boolean {
    return applyMove(this.state, owner, sourceId, targetId, ratio).ok;
  }

  /**
   * Starts (or re-targets) a continuous supply line for `owner`. Same target as
   * the current line stops it instead; see `core/fronts.ts` for the full
   * lifecycle contract.
   */
  issueFrontForOwner(
    owner: PlayerId,
    sourceId: string,
    targetId: string,
    ratio: number
  ): FrontCommandResult {
    return startFront(this.state, owner, sourceId, targetId, ratio);
  }

  issueFront(sourceId: string, targetId: string, ratio: number): FrontCommandResult {
    return this.issueFrontForOwner('player', sourceId, targetId, ratio);
  }

  stopFrontForOwner(owner: PlayerId, sourceId: string): boolean {
    return stopFront(this.state, owner, sourceId);
  }

  stopFront(sourceId: string): boolean {
    return this.stopFrontForOwner('player', sourceId);
  }

  upgrade(territoryId: string, kind: UpgradeKind = 'production'): boolean {
    return applyUpgrade(this.state, 'player', territoryId, kind).ok;
  }

  /**
   * Player active skill. Target selection consumes the main match RNG, so the
   * order of player commands stays part of the deterministic replay.
   *
   * Versus has no AI rival: neither human may betray anyone, so the call is
   * refused before any RNG draw (replays stay identical).
   */
  issueBetrayal(): BetrayalResult {
    if (this.state.mode === 'versus') {
      return {
        ok: false,
        reason: 'locked',
        removed: 0,
        captured: false,
        survivors: 0,
        uses: this.state.skill.uses,
        readyTick: this.state.skill.readyTick,
      };
    }
    return applyBetrayal(this.state, this.rng);
  }

  resign(): boolean {
    if (this.state.status !== 'playing' && this.state.status !== 'paused') return false;
    this.state.result = 'lose';
    this.state.status = 'ended';
    this.state.endReason = 'resign';
    invalidatePendingAiOffers(this.state);
    return true;
  }

  /**
   * Player truce/alliance proposal. Legality is enforced by core, and the
   * built-in AI always decides from its own interest (accept with a reason +
   * score, or reject with an anti-spam cooldown). There is no injection seam
   * on the public engine/session surface: dependency injection for unit
   * fixtures lives on the pure core helper (core/diplomacy.proposeTruce).
   */
  proposeTruce(target: PlayerId): TruceProposalResult {
    if (this.state.mode === 'versus' || !this.state.diplomacy || !this.state.diplomacy.enabled) {
      return { ok: false, accepted: false, reason: 'disabled' };
    }
    return proposeTruce(this.state, 'player', target, engineTruceDecider);
  }

  /**
   * Boolean compatibility projection of `proposeTruce`: same legality rules,
   * same AI judgment, no unconditional-accept bypass.
   */
  offerTruce(target: PlayerId): boolean {
    return this.proposeTruce(target).accepted;
  }

  /** Accepts a pending AI invitation by its exact deterministic id. */
  acceptTruceOffer(offerId: string): TruceProposalResult {
    return acceptTruceOffer(this.state, offerId);
  }

  /** Rejects a pending AI invitation by its exact deterministic id. */
  rejectTruceOffer(offerId: string): boolean {
    return rejectTruceOffer(this.state, offerId);
  }

  breakTruce(target: PlayerId): boolean {
    if (!this.state.diplomacy || !this.state.diplomacy.enabled) return false;
    const broke = breakTruce(this.state, 'player', target);
    if (broke) cancelFrontsForEndedTruce(this.state, 'player', target);
    return broke;
  }

  diplomacy() {
    return toDiplomacySnapshot(this.state);
  }

  tick(): void {
    if (this.state.status !== 'playing') return;
    // Versus is the same fixed-step world without the built-in planner: both
    // sides are human-driven through issueMoveForOwner. Solo keeps the exact
    // existing RNG + AI ordering.
    if (this.state.mode === 'versus') {
      advanceOneTick(this.state, { aiEnabled: false });
      return;
    }
    advanceOneTick(this.state, this.rng);
  }

  /** Steps the simulation with all built-in AI suppressed. */
  advanceSimulationOnly(): void {
    advanceSimulationOnly(this.state);
  }

  /** True only for the dedicated, fixed tutorial battlefield. */
  isTutorial(): boolean {
    return isTutorialMapId(this.state.mapId);
  }

  /**
   * Tutorial teaching step: the real world advances (arrivals, production,
   * lines, cannons, events) with no AI, no disaster and no end check, so the
   * lesson can wait and run past the scene clock safely. Ordinary matches are
   * rejected — this switch is never available to a normal game.
   *
   * Returns false when the lesson is not in progress.
   */
  tickWithoutAi(): boolean {
    if (!this.isTutorial()) {
      throw new Error('tickWithoutAi is reserved for the tutorial battlefield');
    }
    if (this.state.status !== 'playing') return false;
    advanceTutorialSimulationOnly(this.state);
    return true;
  }

  /**
   * Switches the tutorial from teaching to free play. Only the timeout deadline
   * is moved to one full window after the current absolute tick, so normal
   * `tick()` (AI + early end + timeout) resumes without ending on the old
   * lesson clock. Existing armies, fronts and cannon cooldowns keep their
   * absolute tick values and land exactly when they would have.
   *
   * Returns false when the match already ended.
   */
  enterTutorialFreeplay(): boolean {
    if (!this.isTutorial()) {
      throw new Error('enterTutorialFreeplay is reserved for the tutorial battlefield');
    }
    if (this.state.status === 'ended') return false;
    this.state.durationTicks = this.state.tick + TUTORIAL_WINDOW_TICKS;
    return true;
  }

  /** Manual AI pass for any actor (benchmark / tests); no cadence duties here. */
  runAiForOwner(owner: PlayerId, force: boolean = true): AiDecision {
    return runPlannerForOwner(this.state, owner, this.rng, { force: force });
  }

  snapshot(): MatchSnapshot {
    return toMatchSnapshot(this.state);
  }

  /** Returns and clears the pending UI events (overflow/capture/upgrade). */
  drainEvents(): MatchEvent[] {
    const events = this.state.events.slice();
    this.state.events.length = 0;
    return events;
  }

  lastEvents(): MatchEvent[] {
    return this.state.events.slice();
  }

  /** Debug/test helper; not part of the public UI session contract. */
  assertHealthy(): void {
    assertInvariants(this.state);
  }

  remainSeconds(): number {
    return Math.max(0, this.state.durationTicks - this.state.tick) / TICKS_PER_SECOND;
  }
}

