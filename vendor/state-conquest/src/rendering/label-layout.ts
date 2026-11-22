import {
  clamp,
  closestPointOnPolygon,
  distanceToPolygonEdge,
  interiorPoint,
  pointInPolygon,
  polygonArea,
  polygonBounds,
} from './geometry';
import type { Point, Polygon } from './geometry';
import { mapToScreen, viewportSignature } from './viewport';
import type { Viewport } from './viewport';

export interface LabelTerritory {
  id: string;
  polygon: Polygon;
  center: Point;
  name?: string;
  shortName?: string;
  labelAnchor?: Point;
  labelLeader?: Point;
  troops?: number;
  capacity?: number;
}

export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TerritoryLabelLayout {
  id: string;
  /** World-space robust interior point, also the army route endpoint. */
  anchor: Point;
  screenAnchor: Point;
  box: LabelBox;
  /** Optional name-only halo when only the troop badge fits in a chip. */
  nameBox: LabelBox | null;
  inside: boolean;
  leader: { x1: number; y1: number; x2: number; y2: number } | null;
  numberFont: number;
  /** Capacity suffix is always painted; this is its smaller font. */
  capFont: number;
  nameFont: number;
  name: string;
  /** True when the short name is painted inside the chip. */
  showName: boolean;
  /** stack = current/cap/name lines, row = one line, compact = current/cap only. */
  mode: 'row' | 'stack' | 'compact';
  /** Retained for callers that still ask; chips are always painted now. */
  plain: boolean;
}

export interface LabelLayoutOptions {
  /** CSS px reserved around the fitted map; labels may not leave this. */
  margin?: number;
}

const MIN_NUMBER_FONT = 11;
const MAX_NUMBER_FONT = 13;
const LABEL_PAD = 6;

const anchorCache: Record<string, Point> = {};
let anchorCacheSize = 0;

function geometryKey(territory: LabelTerritory): string {
  const polygon = territory.polygon;
  const first = polygon.length > 0 ? polygon[0] : territory.center;
  const last = polygon.length > 0 ? polygon[polygon.length - 1] : territory.center;
  return (
    territory.id +
    ':' +
    polygon.length +
    ':' +
    first[0].toFixed(2) +
    ',' +
    first[1].toFixed(2) +
    ':' +
    last[0].toFixed(2) +
    ',' +
    last[1].toFixed(2) +
    ':' +
    polygonArea(polygon).toFixed(1) +
    ':' +
    (territory.labelAnchor
      ? territory.labelAnchor[0].toFixed(2) + ',' + territory.labelAnchor[1].toFixed(2)
      : '') +
    ':' +
    (territory.labelLeader
      ? territory.labelLeader[0].toFixed(2) + ',' + territory.labelLeader[1].toFixed(2)
      : '')
  );
}

function anchorFor(territory: LabelTerritory): Point {
  const key = geometryKey(territory);
  const cached = anchorCache[key];
  if (cached) return cached;
  const anchor = interiorPoint(territory.polygon, territory.labelAnchor);
  if (anchorCacheSize > 512) {
    const keys = Object.keys(anchorCache);
    for (let i = 0; i < keys.length; i += 1) delete anchorCache[keys[i]];
    anchorCacheSize = 0;
  }
  anchorCache[key] = anchor;
  anchorCacheSize += 1;
  return anchor;
}

function shortLabel(territory: LabelTerritory): string {
  if (territory.shortName && territory.shortName.length > 0) return territory.shortName;
  const name = territory.name || '';
  if (name.length === 0) return '';
  return name.length <= 4 ? name : name.slice(0, 3);
}

function boxCenter(box: LabelBox): Point {
  return [box.x + box.width / 2, box.y + box.height / 2];
}

function boxesOverlap(a: LabelBox, b: LabelBox, padding: number): boolean {
  return !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  );
}

function pointInBox(x: number, y: number, box: LabelBox): boolean {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

function boxCorners(box: LabelBox): Point[] {
  return [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height],
    [box.x + box.width / 2, box.y + box.height / 2],
    [box.x, box.y + box.height / 2],
    [box.x + box.width, box.y + box.height / 2],
    [box.x + box.width / 2, box.y],
    [box.x + box.width / 2, box.y + box.height],
  ];
}

function boxIntersectsPolygon(box: LabelBox, polygon: Polygon): boolean {
  const corners = boxCorners(box);
  for (let i = 0; i < corners.length; i += 1) {
    if (pointInPolygon(corners[i][0], corners[i][1], polygon)) return true;
  }
  const bounds = polygonBounds(polygon);
  if (
    bounds.maxX < box.x ||
    bounds.minX > box.x + box.width ||
    bounds.maxY < box.y ||
    bounds.minY > box.y + box.height
  ) {
    return false;
  }
  for (let i = 0; i < polygon.length; i += 1) {
    if (pointInBox(polygon[i][0], polygon[i][1], box)) return true;
  }
  return false;
}

function boxFitsInside(box: LabelBox, polygon: Polygon): boolean {
  const samples = boxCorners(box);
  for (let i = 0; i < samples.length; i += 1) {
    if (!pointInPolygon(samples[i][0], samples[i][1], polygon)) return false;
  }
  return true;
}

function insideCount(box: LabelBox, polygon: Polygon): number {
  let count = 0;
  const corners = boxCorners(box);
  for (let i = 0; i < corners.length; i += 1) {
    if (pointInPolygon(corners[i][0], corners[i][1], polygon)) count += 1;
  }
  return count;
}

function nearestBoxPoint(box: LabelBox, point: Point): Point {
  const x = clamp(point[0], box.x, box.x + box.width);
  const y = clamp(point[1], box.y, box.y + box.height);
  return [x, y];
}

function labelBoxAt(centerX: number, centerY: number, width: number, height: number): LabelBox {
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width: width,
    height: height,
  };
}

function screenPolygon(viewport: Viewport, polygon: Polygon): Polygon {
  const out: Polygon = [];
  for (let i = 0; i < polygon.length; i += 1) {
    out.push(mapToScreen(viewport, polygon[i][0], polygon[i][1]));
  }
  return out;
}

interface Placement {
  id: string;
  territory: LabelTerritory;
  anchor: Point;
  screenAnchor: Point;
  polygon: Polygon;
  area: number;
  numberFont: number;
  capFont: number;
  compactFont: number;
  nameFont: number;
  name: string;
  numberWidth: number;
  capWidth: number;
  compactDigits: number;
  width: number;
  height: number;
  stackWidth: number;
  stackHeight: number;
  compactWidth: number;
  compactHeight: number;
  minDimension: number;
  clearance: number;
}

/**
 * Chooses robust label/chip positions in CSS pixels. Large territories keep a
 * two-line chip at their interior anchor; narrow or tiny ones get an external
 * chip with a short leader so no neighbour or sea area becomes a click target.
 *
 * The function is deterministic and shared by the renderer and hit-testing so
 * the visual chip and its touch target can never drift apart.
 */
export function computeTerritoryLabelLayouts(
  viewport: Viewport,
  territories: LabelTerritory[],
  mapId: string,
  options?: LabelLayoutOptions
): Record<string, TerritoryLabelLayout> {
  const margin = options && typeof options.margin === 'number' ? options.margin : 3;
  const denseMap = territories.length >= 20 && viewport.width < 350;
  // Short-canvas guard (v1.4.1): when the fitted map is a thin centred band
  // (game card over a very short canvas), fixed-pixel badges can never sit
  // inside any polygon. The viewport-wide external/leader fallback then
  // scatters badges across the whole canvas with screen-spanning leaders, so
  // in that geometry every badge is pinned onto the map's own footprint
  // instead. Pure presentation; hit-testing reads the same layouts.
  const mapScreenHeight = viewport.mapHeight * viewport.scale;
  const shortMap = mapScreenHeight < 160;
  const placements: Placement[] = [];

  for (let i = 0; i < territories.length; i += 1) {
    const territory = territories[i];
    if (territory.polygon.length < 3) continue;
    const polygon = screenPolygon(viewport, territory.polygon);
    const bounds = polygonBounds(polygon);
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    const anchor = anchorFor(territory);
    const screenAnchor = mapToScreen(viewport, anchor[0], anchor[1]);
    const minDimension = Math.min(bounds.width, bounds.height);
    const numberFont = clamp(minDimension * 0.24, MIN_NUMBER_FONT, MAX_NUMBER_FONT);
    const capFont = clamp(numberFont * 0.6, 8, 8.5);
    const compactFont = clamp(numberFont * 0.86, MIN_NUMBER_FONT, MAX_NUMBER_FONT);
    const nameFont = clamp(numberFont * 0.62, 7.5, 9);
    const name = shortLabel(territory);
    const troopDigits = Math.max(
      2,
      Math.min(3, String(typeof territory.troops === 'number' ? territory.troops : 40).length)
    );
    // Reserve a stable three-digit slot for current and capacity. 99 -> 100
    // therefore never reflows the map labels.
    const numberWidth = numberFont * 0.64 * 3;
    const capWidth = capFont * 0.62 * 4;
    const nameWidth = name.length * nameFont * 1.02;
    const width = numberWidth + capWidth + 4 + nameWidth + LABEL_PAD * 2;
    const height = Math.max(numberFont, capFont, nameFont) + 8;
    const stackWidth = Math.max(numberWidth, capWidth, nameWidth) + LABEL_PAD * 2;
    const stackHeight =
      numberFont * 1.05 + capFont * 1.24 + (name.length > 0 ? nameFont * 1.18 + 2 : 0) + 8;
    // Two-line minimum chip: current on top, "/cap" directly below. Width is
    // one stable three-digit slot plus padding, not a wide "18/30" row.
    const compactWidth = Math.max(compactFont * 0.6 * 3, capFont * 0.62 * 4) + 2;
    const compactHeight = compactFont * 1.0 + capFont * 1.16 + 4;
    const clearance = distanceToPolygonEdge(anchor[0], anchor[1], territory.polygon) * viewport.scale;

    placements.push({
      id: territory.id,
      territory: territory,
      anchor: anchor,
      screenAnchor: screenAnchor,
      polygon: polygon,
      area: polygonArea(polygon),
      numberFont: numberFont,
      capFont: capFont,
      compactFont: compactFont,
      nameFont: nameFont,
      name: name,
      numberWidth: numberWidth,
      capWidth: capWidth,
      compactDigits: troopDigits,
      width: width,
      height: height,
      stackWidth: stackWidth,
      stackHeight: stackHeight,
      compactWidth: compactWidth,
      compactHeight: compactHeight,
      minDimension: minDimension,
      clearance: clearance,
    });
  }

  placements.sort(function (a, b) {
    return b.area - a.area;
  });

  // The map's on-screen footprint, used by the short-canvas fallback to keep
  // badges ON the map instead of clamping them to the whole viewport.
  let landMinX = Infinity;
  let landMinY = Infinity;
  let landMaxX = -Infinity;
  let landMaxY = -Infinity;
  for (let i = 0; i < placements.length; i += 1) {
    const bounds = polygonBounds(placements[i].polygon);
    if (bounds.minX < landMinX) landMinX = bounds.minX;
    if (bounds.minY < landMinY) landMinY = bounds.minY;
    if (bounds.maxX > landMaxX) landMaxX = bounds.maxX;
    if (bounds.maxY > landMaxY) landMaxY = bounds.maxY;
  }
  const hasLand = isFinite(landMinX) && isFinite(landMaxY);

  const placed: LabelBox[] = [];
  const layouts: Record<string, TerritoryLabelLayout> = {};

  for (let i = 0; i < placements.length; i += 1) {
    const placement = placements[i];
    let box: LabelBox | null = null;
    let inside = false;
    let showName = placement.name.length > 0;
    let mode: TerritoryLabelLayout['mode'] = 'row';
    let chosenNumberFont = placement.numberFont;
    let chosenCapFont = placement.capFont;

    function available(candidate: LabelBox): boolean {
      if (!boxFitsInside(candidate, placement.polygon)) return false;
      for (let p = 0; p < placed.length; p += 1) {
        if (boxesOverlap(candidate, placed[p], 4)) return false;
      }
      return true;
    }

    const offsets: Point[] = [
      [0, 0],
      [0, -5],
      [0, 5],
      [-5, 0],
      [5, 0],
      [-6, -6],
      [6, -6],
      [-6, 6],
      [6, 6],
      [0, -10],
      [0, 10],
      [-10, 0],
      [10, 0],
    ];

    function availableRelaxed(candidate: LabelBox): boolean {
      const center = boxCenter(candidate);
      if (!pointInPolygon(center[0], center[1], placement.polygon)) return false;
      // Tiny/narrow states cannot contain a full chip. Let the cream badge
      // overhang the border by a few pixels rather than sending it to a far
      // map-edge leader; the centre still belongs to the real state.
      if (insideCount(candidate, placement.polygon) < 4) return false;
      for (let p = 0; p < placed.length; p += 1) {
        if (boxesOverlap(candidate, placed[p], 1)) return false;
      }
      return true;
    }

    function placeAt(width: number, height: number): LabelBox | null {
      for (let o = 0; o < offsets.length; o += 1) {
        const candidate = labelBoxAt(
          placement.screenAnchor[0] + offsets[o][0],
          placement.screenAnchor[1] + offsets[o][1],
          width,
          height
        );
        if (available(candidate)) return candidate;
      }
      return null;
    }

    function placeAtRelaxed(width: number, height: number): LabelBox | null {
      for (let o = 0; o < offsets.length; o += 1) {
        const candidate = labelBoxAt(
          placement.screenAnchor[0] + offsets[o][0],
          placement.screenAnchor[1] + offsets[o][1],
          width,
          height
        );
        if (availableRelaxed(candidate)) return candidate;
      }
      return null;
    }

    function searchInside(width: number, height: number): LabelBox | null {
      const bounds = polygonBounds(placement.polygon);
      let best: LabelBox | null = null;
      let bestDistance = Infinity;
      const step = 4;
      for (let y = bounds.minY + height / 2; y <= bounds.maxY - height / 2; y += step) {
        for (let x = bounds.minX + width / 2; x <= bounds.maxX - width / 2; x += step) {
          const candidate = labelBoxAt(x, y, width, height);
          if (!available(candidate)) continue;
          const dx = x - placement.screenAnchor[0];
          const dy = y - placement.screenAnchor[1];
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
          }
        }
      }
      return best;
    }

    const compactFont = placement.compactFont;

    function commit(candidate: LabelBox, nextMode: TerritoryLabelLayout['mode'], withName: boolean): void {
      box = candidate;
      inside = true;
      mode = nextMode;
      showName = withName;
      chosenNumberFont = nextMode === 'compact' ? compactFont : placement.numberFont;
      chosenCapFont = placement.capFont;
    }

    function searchInsideRelaxed(width: number, height: number): LabelBox | null {
      const bounds = polygonBounds(placement.polygon);
      let best: LabelBox | null = null;
      let bestDistance = Infinity;
      const step = 3;
      for (let y = bounds.minY + height / 2; y <= bounds.maxY - height / 2; y += step) {
        for (let x = bounds.minX + width / 2; x <= bounds.maxX - width / 2; x += step) {
          const candidate = labelBoxAt(x, y, width, height);
          if (!availableRelaxed(candidate)) continue;
          const dx = x - placement.screenAnchor[0];
          const dy = y - placement.screenAnchor[1];
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
          }
        }
      }
      return best;
    }

    function tryCompact(): boolean {
      const candidate =
        placeAt(placement.compactWidth, placement.compactHeight) ||
        searchInside(placement.compactWidth, placement.compactHeight) ||
        placeAtRelaxed(placement.compactWidth, placement.compactHeight) ||
        searchInsideRelaxed(placement.compactWidth, placement.compactHeight);
      if (!candidate) return false;
      commit(candidate, 'compact', false);
      return true;
    }

    function stackBox(withName: boolean): LabelBox | null {
      const width = withName
        ? placement.stackWidth
        : Math.max(placement.numberWidth, placement.capWidth) + 12;
      const height = withName
        ? placement.stackHeight
        : placement.numberFont * 1.05 + placement.capFont * 1.24 + 8;
      return placeAt(width, height) || searchInside(width, height);
    }

    function tryStack(withName: boolean): boolean {
      const candidate = stackBox(withName);
      if (!candidate) return false;
      commit(candidate, 'stack', withName);
      return true;
    }

    // Current/capacity is mandatory in every mode. Small/dense states use the
    // narrow two-line chip so the badge stays inside the real state shape;
    // only large states may spend a third line on the short name. A wide
    // current/cap row is never preferred, because it forces external labels.
    const named = placement.name.length > 0;
    const roomy = placement.minDimension >= 42 && placement.area >= 1500;
    if (named && !denseMap && roomy) {
      if (!tryStack(true)) tryCompact();
    } else if (!tryCompact()) {
      if (named && !denseMap) tryStack(true);
    }

    if (!box) {
      // In a short canvas the viewport-wide external search is exactly the
      // unusable scatter: skip it and pin the badge near its own anchor.
      const external = shortMap
        ? null
        : findExternalBox(placement, placements, placed, viewport, margin);
      if (external) {
        box = external;
        mode = 'compact';
        showName = false;
        chosenNumberFont = compactFont;
        chosenCapFont = placement.capFont;
      } else {
        const fallbackWidth = placement.compactWidth;
        const fallbackHeight = placement.compactHeight;
        // Short canvas: clamp into the map's own screen footprint (never the
        // bare viewport edges), so every badge visually belongs to its state.
        const minX = shortMap && hasLand ? landMinX + fallbackWidth / 2 : margin + fallbackWidth / 2;
        const maxX = shortMap && hasLand
          ? landMaxX - fallbackWidth / 2
          : viewport.width - margin - fallbackWidth / 2;
        const minY = shortMap && hasLand ? landMinY + fallbackHeight / 2 : margin + fallbackHeight / 2;
        const maxY = shortMap && hasLand
          ? landMaxY - fallbackHeight / 2
          : viewport.height - margin - fallbackHeight / 2;
        const fallbackX = clamp(
          placement.screenAnchor[0],
          Math.min(minX, maxX),
          Math.max(minX, maxX)
        );
        const fallbackY = clamp(
          placement.screenAnchor[1] - fallbackHeight,
          Math.min(minY, maxY),
          Math.max(minY, maxY)
        );
        box = labelBoxAt(fallbackX, fallbackY, fallbackWidth, fallbackHeight);
        mode = 'compact';
        showName = false;
        chosenNumberFont = compactFont;
        chosenCapFont = placement.capFont;
      }
    }

    placed.push(box);
    let leader: TerritoryLabelLayout['leader'] = null;
    if (!inside && !shortMap) {
      const center = boxCenter(box);
      const closest = closestPointOnPolygon(center[0], center[1], placement.polygon);
      if (!pointInBox(closest.point[0], closest.point[1], box)) {
        const edge = nearestBoxPoint(box, closest.point);
        leader = {
          x1: closest.point[0],
          y1: closest.point[1],
          x2: edge[0],
          y2: edge[1],
        };
      }
    }

    layouts[placement.id] = {
      id: placement.id,
      anchor: placement.anchor,
      screenAnchor: placement.screenAnchor,
      box: box,
      nameBox: null,
      inside: inside,
      leader: leader,
      numberFont: chosenNumberFont,
      capFont: chosenCapFont,
      nameFont: placement.nameFont,
      name: placement.name,
      showName: showName,
      mode: mode,
      plain: false,
    };
  }

  void mapId;
  return layouts;
}

function findExternalBox(
  placement: Placement,
  all: Placement[],
  placed: LabelBox[],
  viewport: Viewport,
  margin: number
): LabelBox | null {
  const candidates: Array<{ box: LabelBox; score: number }> = [];
  let landMinX = Infinity;
  let landMinY = Infinity;
  let landMaxX = -Infinity;
  let landMaxY = -Infinity;
  for (let i = 0; i < all.length; i += 1) {
    const bounds = polygonBounds(all[i].polygon);
    landMinX = Math.min(landMinX, bounds.minX);
    landMinY = Math.min(landMinY, bounds.minY);
    landMaxX = Math.max(landMaxX, bounds.maxX);
    landMaxY = Math.max(landMaxY, bounds.maxY);
  }
  const landCenterX = (landMinX + landMaxX) / 2;
  const landCenterY = (landMinY + landMaxY) / 2;
  // External chips always keep current/capacity and drop the name; this is the
  // smallest form that still satisfies the "capacity everywhere" rule.
  const externalWidth = placement.compactWidth;
  const externalHeight = placement.compactHeight;
  const zoomRect: LabelBox = {
    x: viewport.width - 62,
    y: 0,
    width: 62,
    height: 118,
  };
  const hintRect: LabelBox = {
    x: viewport.width * 0.16,
    y: viewport.height - 46,
    width: viewport.width * 0.68,
    height: 46,
  };

  function consider(centerX: number, centerY: number, baseScore: number): void {
    const box = labelBoxAt(centerX, centerY, externalWidth, externalHeight);
    if (
      box.x < margin ||
      box.y < margin ||
      box.x + box.width > viewport.width - margin ||
      box.y + box.height > viewport.height - margin
    ) {
      return;
    }
    if (boxesOverlap(box, zoomRect, 4) || boxesOverlap(box, hintRect, 4)) return;
    for (let t = 0; t < all.length; t += 1) {
      if (all[t].id === placement.id) continue;
      if (boxIntersectsPolygon(box, all[t].polygon)) return;
    }
    for (let p = 0; p < placed.length; p += 1) {
      if (boxesOverlap(box, placed[p], 6)) return;
    }
    const ownInside = insideCount(box, placement.polygon);
    if (ownInside >= 3) return;
    const center = boxCenter(box);
    if (pointInPolygon(center[0], center[1], placement.polygon)) return;
    const insideLandBox =
      center[0] > landMinX && center[0] < landMaxX && center[1] > landMinY && center[1] < landMaxY;
    const outward =
      Math.abs(center[0] - landCenterX) + Math.abs(center[1] - landCenterY);
    candidates.push({
      box: box,
      score: baseScore + ownInside * 9 + (insideLandBox ? 42 : 0) - outward * 0.03,
    });
  }

  if (placement.territory.labelLeader) {
    const leaderPoint = mapToScreen(
      viewport,
      placement.territory.labelLeader[0],
      placement.territory.labelLeader[1]
    );
    consider(leaderPoint[0], leaderPoint[1], -80);
  }

  const anchorX = placement.screenAnchor[0];
  const anchorY = placement.screenAnchor[1];

  // Nearby rings first: if the tiny state has a real sea/lake pocket beside
  // it, keep the leader short instead of jumping to a map edge.
  const radii = [
    Math.max(externalWidth, externalHeight) * 0.75 + 8,
    Math.max(externalWidth, externalHeight) * 0.75 + 20,
    Math.max(externalWidth, externalHeight) * 0.75 + 36,
  ];
  const angles = [0, Math.PI, -0.6, 0.6, Math.PI + 0.6, Math.PI - 0.6, Math.PI / 2, -Math.PI / 2];
  for (let r = 0; r < radii.length; r += 1) {
    for (let a = 0; a < angles.length; a += 1) {
      const angle = angles[a];
      consider(
        anchorX + Math.cos(angle) * radii[r],
        anchorY + Math.sin(angle) * radii[r],
        radii[r] * 0.7
      );
    }
  }

  // Then the nearest point on the map's outer edge, not an arbitrary slot in a
  // full-width top/bottom band. This keeps leaders short and avoids the
  // criss-crossing 300px lines seen on dense 24-state maps.
  const step = externalWidth + 5;
  const slots = 6;
  for (let s = -slots; s <= slots; s += 1) {
    const offsetX = clamp(anchorX + s * step, margin + externalWidth / 2, viewport.width - margin - externalWidth / 2);
    const offsetY = clamp(anchorY + s * step, margin + externalHeight / 2, viewport.height - margin - externalHeight / 2);
    const edgeCandidates: Array<[number, number]> = [
      [offsetX, margin + externalHeight / 2],
      [offsetX, viewport.height - margin - externalHeight / 2],
      [margin + externalWidth / 2, offsetY],
      [viewport.width - margin - externalWidth / 2, offsetY],
    ];
    for (let e = 0; e < edgeCandidates.length; e += 1) {
      const x = edgeCandidates[e][0];
      const y = edgeCandidates[e][1];
      const distance = Math.abs(x - anchorX) + Math.abs(y - anchorY);
      const sidePenalty = s * s * 0.4;
      consider(x, y, distance * 0.16 + sidePenalty);
    }
  }

  if (candidates.length === 0) {
    // Last resort: nearest free slot anywhere, still ranked by distance.
    for (let y = margin + externalHeight / 2; y <= viewport.height - margin - externalHeight / 2; y += 7) {
      for (let x = margin + externalWidth / 2; x <= viewport.width - margin - externalWidth / 2; x += 7) {
        const distance = Math.abs(x - anchorX) + Math.abs(y - anchorY);
        consider(x, y, 40 + distance * 0.2);
      }
    }
  }

  if (candidates.length === 0) return null;
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i += 1) {
    if (candidates[i].score < best.score) best = candidates[i];
  }
  return best.box;
}

/**
 * Two split canvases request different viewports on every tick. Each pane uses
 * two keys: the renderer passes the real mapId and hit-testing passes ''. That
 * is four steady-state keys, so an 8-slot LRU leaves headroom for a resize or
 * camera step without evicting the work set (Chrome 61 compatible Map).
 */
export const LABEL_LAYOUT_CACHE_LIMIT = 8;
const layoutCache = new Map<string, Record<string, TerritoryLabelLayout>>();

function trimLayoutCache(): void {
  while (layoutCache.size > LABEL_LAYOUT_CACHE_LIMIT) {
    const oldest = layoutCache.keys().next();
    if (oldest.done) break;
    layoutCache.delete(oldest.value);
  }
}

/** Shared cache: a view is rebuilt each tick, but labels only depend on shape. */
export function territoryLabelLayouts(
  viewport: Viewport,
  territories: LabelTerritory[],
  mapId: string
): Record<string, TerritoryLabelLayout> {
  let shapeKey = '';
  for (let i = 0; i < territories.length; i += 1) {
    const territory = territories[i];
    const first = territory.polygon.length > 0 ? territory.polygon[0] : territory.center;
    shapeKey +=
      territory.id +
      ':' +
      territory.polygon.length +
      ':' +
      first[0].toFixed(2) +
      ',' +
      first[1].toFixed(2) +
      ':' +
      polygonArea(territory.polygon).toFixed(1) +
      ':' +
      String(typeof territory.troops === 'number' ? territory.troops : 40).length +
      ':' +
      String(typeof territory.capacity === 'number' ? territory.capacity : 0) +
      ':' +
      (territory.shortName || territory.name || '') +
      ':' +
      (territory.labelAnchor ? territory.labelAnchor[0] + ',' + territory.labelAnchor[1] : '') +
      ':' +
      (territory.labelLeader ? territory.labelLeader[0] + ',' + territory.labelLeader[1] : '') +
      ';';
  }
  const key = viewportSignature(viewport) + '|' + mapId + '|' + shapeKey;
  const cached = layoutCache.get(key);
  if (cached) {
    // Refresh recency so two alternating panes both stay resident.
    layoutCache.delete(key);
    layoutCache.set(key, cached);
    return cached;
  }
  const value = computeTerritoryLabelLayouts(viewport, territories, mapId);
  layoutCache.set(key, value);
  trimLayoutCache();
  return value;
}

export function clearLabelLayoutCache(): void {
  layoutCache.clear();
}
