import { mapToScreen, screenToMap } from '../rendering/viewport';
import type { Viewport } from '../rendering/viewport';
import { polygonArea, pointInPolygon as geometryPointInPolygon } from '../rendering/geometry';
import type { Point } from '../rendering/geometry';
import { territoryLabelLayouts } from '../rendering/label-layout';

export interface HitTarget {
  id: string;
  polygon: Array<[number, number]>;
  center: [number, number];
  name?: string;
  shortName?: string;
  labelAnchor?: [number, number];
  labelLeader?: [number, number];
  troops?: number;
  capacity?: number;
}

export function pointInPolygon(x: number, y: number, polygon: Array<[number, number]>): boolean {
  return geometryPointInPolygon(x, y, polygon);
}

/**
 * Hit-test in CSS pixels.
 *
 * A tap is claimed only by the real polygon under the finger, or by the
 * explicit on-map chip/leader label that the renderer drew for that territory.
 * There is deliberately no nearest-centre grace radius: at a shared state
 * border that would silently hand touches to a neighbour across the line.
 */
export function hitTestTerritory(
  viewport: Viewport,
  territories: HitTarget[],
  cssX: number,
  cssY: number,
  toleranceCssPx: number
): string | null {
  if (territories.length === 0) return null;
  const point = screenToMap(viewport, cssX, cssY);

  // The chip is painted above the polygon fills, so it must win the tap even
  // when a tiny state's chip is placed over a neighbour or water. Chip boxes
  // are non-overlapping, so this cannot steal a shared-border tap.
  const labels = territoryLabelLayouts(viewport, territories, '');
  const grace = Math.min(6, Math.max(0, toleranceCssPx * 0.3));
  let labelHit: string | null = null;
  let labelDistance = Infinity;
  for (let i = 0; i < territories.length; i += 1) {
    const target = territories[i];
    const label = labels[target.id];
    if (!label) continue;
    const box = label.box;
    if (
      cssX < box.x - grace ||
      cssX > box.x + box.width + grace ||
      cssY < box.y - grace ||
      cssY > box.y + box.height + grace
    ) {
      continue;
    }
    const center = mapToScreen(
      viewport,
      target.center[0],
      target.center[1]
    );
    const dx = center[0] - cssX;
    const dy = center[1] - cssY;
    const distance = dx * dx + dy * dy;
    if (distance < labelDistance) {
      labelDistance = distance;
      labelHit = target.id;
    }
  }
  if (labelHit) return labelHit;

  let exact: HitTarget | null = null;
  let exactArea = Infinity;
  for (let i = 0; i < territories.length; i += 1) {
    const target = territories[i];
    if (!pointInPolygon(point[0], point[1], target.polygon)) continue;
    const area = polygonArea(target.polygon);
    if (area < exactArea) {
      exactArea = area;
      exact = target;
    }
  }
  return exact ? exact.id : null;
}

/** Exposed for tests that need the exact chip centre the renderer will use. */
export function labelBoxCenter(
  viewport: Viewport,
  territories: HitTarget[],
  id: string
): Point | null {
  const labels = territoryLabelLayouts(viewport, territories, '');
  const label = labels[id];
  if (!label) return null;
  return [label.box.x + label.box.width / 2, label.box.y + label.box.height / 2];
}
