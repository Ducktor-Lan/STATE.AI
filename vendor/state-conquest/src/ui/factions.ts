/**
 * Single source of truth for multi-faction display (v1.4.0).
 *
 * A match is 1 human player against 1-3 AI factions in a free-for-all. The
 * participating roster is FIXED at match start (adapter-filled `activeOwners`);
 * a faction that has temporarily lost every territory stays in the roster, so
 * no UI may shrink the board by looking at who currently owns land.
 *
 * Every HUD/result/label surface reads this module instead of re-deriving
 * faction lists, so the blue/red/gold/purple mapping lives in exactly one file.
 * The view fields (`factionCount`, `activeOwners`, `aliveOwners`) are optional
 * on MatchView: old fixtures without them read as the historical 2-faction
 * match, and the shell's adapter always fills them for real matches.
 */
import type { FactionCount, MatchView, OwnerId } from './view-model';

/** UI-side mirror of the core `FactionCount`; re-exported to avoid drift. */
export type { FactionCount };

export const FACTION_COUNTS: readonly FactionCount[] = [2, 3, 4];

/** The four faction owners in roster order; `neutral` is never a faction. */
export type FactionOwner = 'player' | 'ai1' | 'ai2' | 'ai3';

export const FACTION_OWNERS: readonly FactionOwner[] = ['player', 'ai1', 'ai2', 'ai3'];

export function isFactionOwner(value: unknown): value is FactionOwner {
  return (
    value === 'player' || value === 'ai1' || value === 'ai2' || value === 'ai3'
  );
}

export function isFactionCount(value: unknown): value is FactionCount {
  return value === 2 || value === 3 || value === 4;
}

/** Unknown/missing values degrade to `fallback` (the legacy 2-faction match). */
export function normalizeFactionCount(
  value: unknown,
  fallback: FactionCount = 2
): FactionCount {
  return isFactionCount(value) ? value : fallback;
}

/** Fixed roster per match size; never derived from current ownership. */
const FACTION_ROSTERS: Record<FactionCount, FactionOwner[]> = {
  2: ['player', 'ai1'],
  3: ['player', 'ai1', 'ai2'],
  4: ['player', 'ai1', 'ai2', 'ai3'],
};

/** A copy of the fixed roster for a match size. */
export function factionRoster(count: FactionCount): FactionOwner[] {
  return FACTION_ROSTERS[count].slice();
}

/**
 * The match's participating factions, fixed at match start. Prefers the
 * adapter-filled `activeOwners`; falls back to the roster of the recorded
 * `factionCount`. Never drops a faction for having no territory right now.
 */
export function activeFactions(view: MatchView): FactionOwner[] {
  if (Array.isArray(view.activeOwners) && view.activeOwners.length > 0) {
    const out: FactionOwner[] = [];
    for (let i = 0; i < view.activeOwners.length; i += 1) {
      const owner = view.activeOwners[i];
      if (isFactionOwner(owner) && out.indexOf(owner) < 0) out.push(owner);
    }
    if (out.length > 0) return out;
  }
  return factionRoster(factionCountOf(view));
}

/** Recorded match size; old fixtures without the field read as 2. */
export function factionCountOf(view: MatchView): FactionCount {
  return normalizeFactionCount(view.factionCount);
}

/**
 * The factions still in the match. Prefers the core-provided `aliveOwners`
 * (which already counts armies in flight); the legacy fallback keeps a faction
 * alive while it holds land OR has troops marching, so territory 0 alone is
 * never an elimination.
 */
export function isFactionAlive(view: MatchView, owner: FactionOwner): boolean {
  if (Array.isArray(view.aliveOwners)) {
    return view.aliveOwners.indexOf(owner as OwnerId) >= 0;
  }
  return factionTerritoriesOf(view, owner) > 0 || hasArmiesInFlight(view, owner);
}

/** True while at least one of the faction's armies is still marching. */
export function hasArmiesInFlight(view: MatchView, owner: FactionOwner): boolean {
  for (let i = 0; i < view.armies.length; i += 1) {
    if (view.armies[i].owner === owner) return true;
  }
  return false;
}

/** Final score of one faction; `ai3` is 0 outside a 4-faction match. */
export function factionScoreOf(view: MatchView, owner: FactionOwner): number {
  const value = (view.scores as Record<string, unknown>)[owner];
  return typeof value === 'number' && isFinite(value) ? value : 0;
}

/** Current territory count of one faction; `ai3` is 0 outside a 4-faction match. */
export function factionTerritoriesOf(view: MatchView, owner: FactionOwner): number {
  const value = (view.territoryCounts as Record<string, unknown>)[owner];
  return typeof value === 'number' && isFinite(value) ? value : 0;
}

/** Total garrison + marching troops of one faction (rank tiebreak, result rows). */
export function factionForceOf(view: MatchView, owner: FactionOwner): number {
  let force = 0;
  for (let i = 0; i < view.territories.length; i += 1) {
    if (view.territories[i].owner === owner) force += view.territories[i].troops;
  }
  for (let i = 0; i < view.armies.length; i += 1) {
    if (view.armies[i].owner === owner) force += view.armies[i].troops;
  }
  return force;
}

/** Territories held by every AI faction combined (any match size). */
export function aiTerritoriesOf(view: MatchView): number {
  let total = 0;
  for (let i = 1; i < FACTION_OWNERS.length; i += 1) {
    total += factionTerritoriesOf(view, FACTION_OWNERS[i]);
  }
  return total;
}

/** Score held by every AI faction combined (any match size). */
export function aiScoreOf(view: MatchView): number {
  let total = 0;
  for (let i = 1; i < FACTION_OWNERS.length; i += 1) {
    total += factionScoreOf(view, FACTION_OWNERS[i]);
  }
  return total;
}

/**
 * Territories owned by no faction. The map's total is fixed, so the remainder
 * is charged against every faction equally (each faction's capture removed it
 * from the shared neutral pool).
 */
export function neutralTerritoriesOf(view: MatchView): number {
  const factions = activeFactions(view);
  let held = 0;
  for (let i = 0; i < factions.length; i += 1) {
    held += factionTerritoriesOf(view, factions[i]);
  }
  return Math.max(0, view.territories.length - held);
}

/**
 * Honest rank of one faction inside its fixed roster: by score, then
 * territories, then total force; equal values share the same rank
 * (competition ranking, so the next rank is skipped). Display-only.
 */
export function factionRankOf(view: MatchView, owner: FactionOwner): number {
  const factions = activeFactions(view);
  const mine = [
    factionScoreOf(view, owner),
    factionTerritoriesOf(view, owner),
    factionForceOf(view, owner),
  ];
  let rank = 1;
  for (let i = 0; i < factions.length; i += 1) {
    const other = factions[i];
    if (other === owner) continue;
    const theirs = [
      factionScoreOf(view, other),
      factionTerritoriesOf(view, other),
      factionForceOf(view, other),
    ];
    let better = false;
    for (let k = 0; k < 3; k += 1) {
      if (theirs[k] !== mine[k]) {
        better = theirs[k] > mine[k];
        break;
      }
    }
    if (better) rank += 1;
  }
  return rank;
}

/** Unified faction display names (player keeps the solo 我方 convention). */
export const FACTION_NAME: Record<FactionOwner, string> = {
  player: '我方',
  ai1: '红方',
  ai2: '金方',
  ai3: '紫方',
};

/** Unified colour-word mapping (blue/red/gold/purple), shared with the palette. */
export const FACTION_COLOR_NAME: Record<FactionOwner, string> = {
  player: '蓝方',
  ai1: '红方',
  ai2: '金方',
  ai3: '紫方',
};

export const NEUTRAL_NAME = '中立';

export function factionDisplayName(owner: FactionOwner): string {
  return FACTION_NAME[owner];
}

/** Short sub label on a setup faction button (free-for-all, never "1 v N"). */
export const FACTION_OPTION_SUB: Record<FactionCount, string> = {
  2: '经典',
  3: '三方混战',
  4: '四方混战',
};

export function factionOptionSub(count: FactionCount): string {
  return FACTION_OPTION_SUB[count];
}

/**
 * One line under the setup faction row. States the "1 player + N AI" shape and
 * that every faction fights independently — the AIs never team up against the
 * player, so no wording may read as "1 v N".
 */
export function factionNoteText(count: FactionCount): string {
  if (count === 2) return '经典对战 · 1 名玩家对 1 个 AI';
  if (count === 3) return '1 名玩家 + 2 个 AI · 三方独立计分，各自争胜';
  return '1 名玩家 + 3 个 AI · 四方独立计分，各自争胜';
}
