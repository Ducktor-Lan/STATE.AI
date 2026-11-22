/**
 * v1.2 per-pane event presentation.
 *
 * A versus match drains ONE engine event stream but paints two panes. Every
 * pane must read an event from its own owner's perspective: a red capture is
 * good news on the red pane and bad news on the blue pane. Keeping the decision
 * here (instead of inline in the shell) makes the two-pane rule directly
 * testable and impossible to apply with a single shared viewer.
 */
import { FACTION_COLOR_NAME } from './factions';

export type PaneOwner = 'player' | 'ai1';
export type FloaterTone = 'good' | 'bad';

/** Tone for a capture floater, judged by the pane that will draw it. */
export function captureTone(
  eventOwner: string | undefined,
  paneOwner: PaneOwner,
  versus: boolean
): FloaterTone {
  if (versus) return eventOwner === paneOwner ? 'good' : 'bad';
  return eventOwner === 'player' ? 'good' : 'bad';
}

/**
 * Floater copy. Versus names the capturing side exactly: blue = player,
 * red = ai1, and any third owner (ai2/neutral) is described by its real role
 * so a map with a third faction never gets mislabelled as red.
 */
export function captureLabel(
  eventOwner: string | undefined,
  amount: number,
  versus: boolean,
  blueName: string,
  redName: string
): string {
  if (versus) {
    return captureOwnerName(eventOwner, blueName, redName) + '占领 · 驻军 ' + amount;
  }
  return eventOwner === 'player' ? '占领 · 驻军 ' + amount : '失守';
}

/**
 * Exact side name for a capture owner. The blue/red pane names come from the
 * caller (versus convention); every further faction uses the unified colour
 * names from ui/factions.ts so a gold/purple capture never collapses into red
 * and stays mappable to the HUD chips.
 */
export function captureOwnerName(
  eventOwner: string | undefined,
  blueName: string,
  redName: string
): string {
  if (eventOwner === 'player') return blueName;
  if (eventOwner === 'ai1') return redName;
  if (eventOwner === 'ai2') return FACTION_COLOR_NAME.ai2;
  if (eventOwner === 'ai3') return FACTION_COLOR_NAME.ai3;
  return '中立';
}

/**
 * The owner a renderer should use as its own viewpoint for a defense receipt.
 * The blue/red pane never shares a viewer: that was the reversed-receipt bug.
 */
export function defenseViewerFor(paneOwner: PaneOwner): PaneOwner {
  return paneOwner;
}
