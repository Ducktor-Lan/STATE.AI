/**
 * v1.2 lifecycle policy: what must happen when the page is hidden or shown
 * again during every pre-match / in-match phase.
 *
 * The bug this file exists to prevent: hiding during the 3-2-1 countdown or
 * the tutorial stopped the animation loop, and the countdown's completion did
 * not restart it, so the match could never tick after returning. Hiding must
 * also never let a match start, count down, or make noise in the background.
 *
 * The decision is a pure function so all four transitions (hide/show × before/
 * after the match starts) are directly testable; the shell only applies it.
 */

export type LifecyclePhase =
  | 'idle'
  | 'pre-match'
  | 'countdown'
  | 'playing'
  | 'paused'
  | 'ended';

export interface VisibilitySnapshot {
  hidden: boolean;
  phase: LifecyclePhase;
  /** True while a requestAnimationFrame is already scheduled. */
  rafPending: boolean;
  /** A real game session exists (renderer/canvas attached). */
  hasGame: boolean;
}

export interface VisibilityPlan {
  stopLoop: boolean;
  suspendSound: boolean;
  /** Resume audio only when it was previously unlocked/enabled (shell checks). */
  resumeSound: boolean;
  /** Auto-pause a live match; the player resumes from the pause card. */
  autoPause: boolean;
  /** Cancel the running 3-2-1 timer and close its overlay. */
  cancelCountdown: boolean;
  /** Remember that the countdown must be re-run on return (never in background). */
  deferCountdown: boolean;
  /** Restart the loop for rendering only (pre-match screens). */
  startLoop: boolean;
  /** Re-run the 3-2-1 countdown from the beginning on return. */
  restartCountdown: boolean;
}

/**
 * Hiding:
 *   - always stop the loop and suspend audio;
 *   - a live match auto-pauses;
 *   - an in-flight countdown is cancelled and deferred (never started hidden).
 *
 * Showing:
 *   - audio may resume (the shell only calls resume when unlocked + enabled);
 *   - a deferred countdown restarts from 3 (clear, identical experience);
 *   - a still-live match restarts the loop only when no rAF is pending;
 *   - a paused/ended match keeps its overlay/result (no silent restart);
 *   - pre-match/tutorial screens restart the loop for rendering only.
 */
export function planVisibilityChange(state: VisibilitySnapshot): VisibilityPlan {
  const hidden = state.hidden === true;
  if (hidden) {
    return {
      stopLoop: true,
      suspendSound: true,
      resumeSound: false,
      autoPause: state.phase === 'playing',
      cancelCountdown: state.phase === 'countdown',
      deferCountdown: state.phase === 'countdown',
      startLoop: false,
      restartCountdown: false,
    };
  }
  return {
    stopLoop: false,
    suspendSound: false,
    resumeSound: true,
    autoPause: false,
    cancelCountdown: false,
    deferCountdown: false,
    startLoop:
      state.hasGame &&
      !state.rafPending &&
      (state.phase === 'playing' ||
        state.phase === 'pre-match' ||
        state.phase === 'idle'),
    restartCountdown: state.phase === 'countdown',
  };
}

/** A countdown may only begin while the document is visible. */
export function countdownStartAllowed(hidden: boolean): boolean {
  return hidden !== true;
}

/**
 * What the last 3-2-1 step may do. Hiding exactly when the countdown ends must
 * defer the kick-off instead of starting a match in the background.
 */
export function countdownFinishAction(hidden: boolean): 'start' | 'defer' {
  return hidden === true ? 'defer' : 'start';
}


/**
 * Closes a tracked countdown overlay and returns the new (null) reference.
 *
 * The order matters: closing removes it from the shell's overlay stack, and
 * only afterwards may the reference be dropped. Clearing first left the 3-2-1
 * card permanently on top of the battlefield. `close` runs before the caller's
 * assignment to null, and a throwing close keeps the reference for retry.
 */
export function closeCountdownOverlay<T>(
  overlay: T | null,
  close: (overlay: T) => void
): null {
  if (overlay) close(overlay);
  return null;
}
