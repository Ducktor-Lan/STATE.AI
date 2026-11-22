import type { MoveRouteInspection, PlannedMovement } from '../game-api';
import type { MatchView } from './view-model';
import { factionDisplayName } from './factions';

/** Wording follows core diagnosis, never infers a path from screen geometry. */
export function routeFailureText(route: MoveRouteInspection | null | undefined): string {
  if (!route || route.ok) return '';
  switch (route.reason) {
    case 'source-not-owned': return '兵源须为己方 · 不能调动盟友驻军';
    case 'ally-target': return '盟友仅供借道 · 请拖向其后的敌方或中立目标';
    case 'blocked-boundary': return '通路被山河阻断 · 须走可通行边界';
    case 'disconnected': return '兵源与前沿断连 · 须连通己方或盟友领地';
    case 'no-frontier': return '目标未接壤己方或当前盟友前沿';
    case 'truce-ended': return '盟约已结束 · 原借道通路不可用';
    case 'self': return '请拖向其他领地';
    default: return '领地或路线无效';
  }
}

export function routePassageText(
  view: Pick<MatchView, 'territories'>,
  movement: PlannedMovement | null | undefined
): string {
  if (!movement || !movement.transitOwners || movement.transitOwners.length === 0) return '';
  function label(id: string): string {
    for (let i = 0; i < view.territories.length; i += 1) {
      if (view.territories[i].id === id) return ('0' + (i + 1)).slice(-2);
    }
    return id;
  }
  return '借道' + movement.transitOwners.map(factionDisplayName).join('、') +
    ' · 前沿 ' + label(movement.frontierId) + ' → ' + label(movement.targetId);
}
