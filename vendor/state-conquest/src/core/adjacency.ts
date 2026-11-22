import type { Edge, MatchState } from './types';

export function getNeighborIds(state: MatchState, territoryId: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    if (edge.from === territoryId) out.push(edge.to);
    else if (edge.to === territoryId) out.push(edge.from);
  }
  return out;
}

export function findEdge(state: MatchState, a: string, b: string): Edge | null {
  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    if (
      (edge.from === a && edge.to === b) ||
      (edge.from === b && edge.to === a)
    ) {
      return edge;
    }
  }
  return null;
}

export function areAdjacent(state: MatchState, a: string, b: string): boolean {
  return findEdge(state, a, b) !== null;
}
