/**
 * Builds the nine built-in map variants from the generated us-atlas dataset.
 *
 * Geometry rules:
 *  - Only real shared-border arcs become gameplay edges; point contacts never do.
 *  - The map is a uniform, aspect-preserving Albers projection scaled to
 *    width 1000. Height follows the region's natural bounds.
 *  - Capacity uses the projected (equal-area) state area relative to the median
 *    mainland state area, never screen pixels.
 *  - River/ridge themes split the region into two internally connected groups
 *    and keep exactly two real shared borders as bridges/passes. Every other
 *    cross-group border is metadata-only (impassable), so no virtual bridge is
 *    invented and the map stays connected through the two real crossings.
 */

import { capacityForArea } from '../../core/capacity';
import { requiredAttackCost } from '../../core/combat';
import { US_GEOGRAPHY_META, US_SHARED_BORDERS, US_STATE_GEOMETRY } from '../generated/us-states';
import type { UsSharedBorder, UsStateGeometry } from '../generated/us-states';
import { STATE_BY_ID, STATE_ID_BY_FIPS, findRegionSpec } from './regions';
import type { GeographicRegionSpec } from './regions';
import type { EdgeKind, FactionCount, OwnerId, PlayerId, Terrain } from '../../core/types';
import type { MapThemeId } from '../types';
import { chooseSpawnsForFactions, normalizeFactionCount } from './spawn-allocation';
import type { MultiSpawnChoice } from './spawn-allocation';
import type {
  GameMapDefinition,
  MapBoundaryKind,
  MapBoundaryMetadata,
  MapEdgeDefinition,
  MapGeographyMetadata,
  MapTerritoryDefinition,
} from '../types';
import { pointInPolygon } from '../validate-map';

export const GEO_MAP_WIDTH = 1000;
export const GEO_MAP_PAD = 26;
export const NEUTRAL_TROOPS = 18;
export const HOME_TROOPS = 40;
export const CROSSING_COUNT = 2;

/** Hairline arcs are rounding contacts, not shared borders. */
const MIN_ARC_LENGTH = 0.25;

export const GEO_SOURCE_LABEL =
  '美国人口普查局 2017 年州界（us-atlas v3 / 1:10m）';
export const GEO_SOURCE_LICENSE =
  '美国人口普查局公共领域几何数据；us-atlas 工具 ISC 许可';
export const GEO_PROJECTION_LABEL = 'Albers USA 等积投影（d3.geoAlbersUsa, scale 1300）';

const THEME_DESCRIPTION: Record<MapThemeId, string> = {
  plains_crossroads:
    '以真实美国州界构成的开阔平原走廊，多路相接，适合快速扩张与提前切换攻守。',
  mountain_pass:
    '阿巴拉契亚山地两侧仅有两处真实州界作为战略山口，其余山脊不可通行。',
  river_valley:
    '密西西比河隔断两岸，只有两处真实跨河州界作为桥头，桥头争夺决定战局。',
};

const THEME_FEATURES: Record<MapThemeId, string[]> = {
  plains_crossroads: ['真实州界', '开阔多路', '大州容量'], 
  mountain_pass: ['真实州界', '两处山口', '山脊隔断'],
  river_valley: ['真实州界', '两处桥头', '两岸对峙'],
};

const STATE_BY_FIPS: Record<string, UsStateGeometry> = (function build(): Record<string, UsStateGeometry> {
  const out: Record<string, UsStateGeometry> = {};
  for (let i = 0; i < US_STATE_GEOMETRY.length; i += 1) {
    out[US_STATE_GEOMETRY[i].id] = US_STATE_GEOMETRY[i];
  }
  return out;
})();

/** Median projected area of the 48 mainland states: the capacity reference. */
export const GEO_REFERENCE_AREA: number = (function build(): number {
  const areas: number[] = [];
  for (let i = 0; i < US_STATE_GEOMETRY.length; i += 1) {
    const area = US_STATE_GEOMETRY[i].area;
    if (isFinite(area) && area > 0) areas.push(area);
  }
  if (areas.length === 0) return 1;
  areas.sort(function (a, b) { return a - b; });
  const mid = Math.floor(areas.length / 2);
  return areas.length % 2 === 0 ? (areas[mid - 1] + areas[mid]) / 2 : areas[mid];
})();

interface Point {
  x: number;
  y: number;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function shoelaceArea(polygon: Array<[number, number]>): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const j = (i + 1) % polygon.length;
    sum += polygon[i][0] * polygon[j][1] - polygon[j][0] * polygon[i][1];
  }
  return Math.abs(sum) / 2;
}

function pathLength(points: Array<[number, number]>): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

function pathMidpoint(points: Array<[number, number]>): [number, number] {
  const total = pathLength(points);
  if (total <= 0 || points.length < 2) {
    const first = points[0] || [0, 0];
    return [first[0], first[1]];
  }
  let walked = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const segment = Math.sqrt(dx * dx + dy * dy);
    if (walked + segment >= total / 2) {
      const t = segment > 0 ? (total / 2 - walked) / segment : 0;
      return [points[i - 1][0] + dx * t, points[i - 1][1] + dy * t];
    }
    walked += segment;
  }
  const last = points[points.length - 1];
  return [last[0], last[1]];
}

function distance(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Score scales gently with real area; homes get a small objective bump. */
function scoreForArea(areaUnits: number, referenceArea: number): number {
  const ratio = referenceArea > 0 ? Math.max(0.01, areaUnits / referenceArea) : 1;
  return clamp(Math.round(8 + 4 * Math.sqrt(ratio)), 8, 20);
}

interface ArcDraft {
  points: Array<[number, number]>;
  length: number;
  midpoint: [number, number];
}

interface BorderDraft {
  from: string;
  to: string;
  key: string;
  arcs: ArcDraft[];
  totalLength: number;
}

export interface TerritoryDraft {
  id: string;
  fips: string;
  source: UsStateGeometry;
  polygon: Array<[number, number]>;
  center: [number, number];
  areaUnits: number;
  capacity: number;
  degree: number;
  axis: number;
  crossingEndpoint: boolean;
}

function borderKey(a: string, b: string): string {
  return a < b ? a + '|' + b : b + '|' + a;
}

function transformPoints(
  path: Array<[number, number]>,
  tx: (x: number) => number,
  ty: (y: number) => number
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < path.length; i += 1) {
    out.push([tx(path[i][0]), ty(path[i][1])]);
  }
  return out;
}

function normalizeBorder(border: UsSharedBorder): BorderDraft | null {
  const from = STATE_ID_BY_FIPS[border.from];
  const to = STATE_ID_BY_FIPS[border.to];
  if (!from || !to) return null;
  const arcs: ArcDraft[] = [];
  for (let i = 0; i < border.paths.length; i += 1) {
    const path = border.paths[i];
    if (!Array.isArray(path) || path.length < 2) continue;
    const length = pathLength(path);
    if (!(length >= 0.01)) continue;
    arcs.push({ points: path, length: length, midpoint: pathMidpoint(path) });
  }
  if (arcs.length === 0) return null;
  arcs.sort(function (a, b) { return b.length - a.length; });
  let totalLength = 0;
  for (let i = 0; i < arcs.length; i += 1) totalLength += arcs[i].length;
  return {
    from: from,
    to: to,
    key: borderKey(from, to),
    arcs: arcs,
    totalLength: totalLength,
  };
}

const BORDERS: BorderDraft[] = (function build(): BorderDraft[] {
  const out: BorderDraft[] = [];
  for (let i = 0; i < US_SHARED_BORDERS.length; i += 1) {
    const border = normalizeBorder(US_SHARED_BORDERS[i]);
    if (border) out.push(border);
  }
  out.sort(function (a, b) { return a.key.localeCompare(b.key); });
  return out;
})();

const BORDER_BY_KEY: Record<string, BorderDraft> = (function build(): Record<string, BorderDraft> {
  const out: Record<string, BorderDraft> = {};
  for (let i = 0; i < BORDERS.length; i += 1) out[BORDERS[i].key] = BORDERS[i];
  return out;
})();

/** Deterministic pair selection: the two crossings farthest apart. */
function chooseCrossings(candidates: BorderDraft[], spec: GeographicRegionSpec): BorderDraft[] {
  if (candidates.length < CROSSING_COUNT) {
    throw new Error(
      'Region ' + spec.themeId + '/' + spec.size + ' has only ' + candidates.length +
        ' real cross-group borders; need ' + CROSSING_COUNT
    );
  }
  let best: BorderDraft[] | null = null;
  let bestDistance = -1;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      const d = distance(a.arcs[0].midpoint, b.arcs[0].midpoint);
      if (d > bestDistance + 1e-9 ||
          (Math.abs(d - bestDistance) <= 1e-9 &&
           a.totalLength + b.totalLength > (best ? best[0].totalLength + best[1].totalLength : -1))) {
        bestDistance = d;
        best = [a, b];
      }
    }
  }
  return best || candidates.slice(0, CROSSING_COUNT);
}

interface PairMetrics {
  capSum: number;
  degreeSum: number;
  frontierCost: number;
  frontierScore: number;
  ids: string[];
}

function pairMetrics(pair: TerritoryDraft[], byId: Record<string, TerritoryDraft>, edges: MapEdgeDefinition[]): PairMetrics {
  const capSum = pair[0].capacity + pair[1].capacity;
  const degreeSum = pair[0].degree + pair[1].degree;
  const inPair: Record<string, boolean> = {};
  for (let i = 0; i < pair.length; i += 1) inPair[pair[i].id] = true;
  const frontier: Record<string, boolean> = {};
  for (let i = 0; i < pair.length; i += 1) {
    for (let e = 0; e < edges.length; e += 1) {
      const edge = edges[e];
      let other = '';
      if (edge.from === pair[i].id) other = edge.to;
      else if (edge.to === pair[i].id) other = edge.from;
      if (!other || inPair[other]) continue;
      frontier[other] = true;
    }
  }
  let frontierCost = 0;
  let frontierScore = 0;
  for (const id in frontier) {
    if (!Object.prototype.hasOwnProperty.call(frontier, id)) continue;
    const territory = byId[id];
    if (!territory) continue;
    frontierCost += requiredAttackCost(NEUTRAL_TROOPS, 'plain');
    frontierScore += scoreForArea(territory.areaUnits, GEO_REFERENCE_AREA);
  }
  return {
    capSum: capSum,
    degreeSum: degreeSum,
    frontierCost: frontierCost,
    frontierScore: frontierScore,
    ids: pair.map(function (item) { return item.id; }),
  };
}

interface SpawnChoice {
  player: string[];
  ai1: string[];
  homeTroops: number;
}

/**
 * Chooses two homes per side at opposite geographic extremes. Preference order:
 * cap totals within 10 %, similar degree/frontier cost, then maximum separation.
 * No mirrored resources, fake production or hand-tuned capacity.
 */
function chooseSpawns(
  drafts: TerritoryDraft[],
  byId: Record<string, TerritoryDraft>,
  edges: MapEdgeDefinition[],
  spec: GeographicRegionSpec,
  mapHeight: number,
  groupOf: Record<string, string>
): SpawnChoice {
  let eligible = drafts.filter(function (d) {
    return !d.crossingEndpoint && d.capacity >= HOME_TROOPS && d.degree >= 2;
  });
  if (eligible.length < 4) {
    eligible = drafts.filter(function (d) {
      return d.capacity >= HOME_TROOPS && d.degree >= 2;
    });
  }
  if (eligible.length < 4) {
    eligible = drafts.filter(function (d) { return d.capacity >= HOME_TROOPS; });
  }

  const pairs: TerritoryDraft[][] = [];
  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      // River/ridge sides start as coherent groups: both homes on one bank
      // (or one side of the ridge), so the two real crossings matter.
      if (spec.groups && groupOf[eligible[i].id] !== groupOf[eligible[j].id]) continue;
      pairs.push([eligible[i], eligible[j]]);
    }
  }
  if (pairs.length === 0) {
    throw new Error('Region ' + spec.themeId + '/' + spec.size + ' has too few spawn candidates');
  }

  // Two homes per side; the side with the lower axis coordinate is the player.
  const diagonal = Math.sqrt(GEO_MAP_WIDTH * GEO_MAP_WIDTH + mapHeight * mapHeight);
  const combos: Array<{
    player: TerritoryDraft[];
    ai1: TerritoryDraft[];
    cost: number;
    capDiff: number;
    separation: number;
  }> = [];

  for (let p = 0; p < pairs.length; p += 1) {
    const playerPair = pairs[p];
    const playerAxis = (playerPair[0].axis + playerPair[1].axis) / 2;
    const pm = pairMetrics(playerPair, byId, edges);
    for (let a = 0; a < pairs.length; a += 1) {
      const aiPair = pairs[a];
      if (playerPair[0].id === aiPair[0].id ||
          playerPair[0].id === aiPair[1].id ||
          playerPair[1].id === aiPair[0].id ||
          playerPair[1].id === aiPair[1].id) continue;
      if (spec.groups && groupOf[playerPair[0].id] === groupOf[aiPair[0].id]) continue;
      const aiAxis = (aiPair[0].axis + aiPair[1].axis) / 2;
      // Player must be on the lower (south/west) side; the gap keeps both
      // sides at genuinely different geographic extremes.
      if (playerAxis > aiAxis - 0.08) continue;
      const am = pairMetrics(aiPair, byId, edges);
      const capDiff = Math.abs(pm.capSum - am.capSum) / Math.max(1, Math.max(pm.capSum, am.capSum));
      const degreeDiff = Math.abs(pm.degreeSum - am.degreeSum) / Math.max(1, Math.max(pm.degreeSum, am.degreeSum));
      const costDiff = Math.abs(pm.frontierCost - am.frontierCost) / Math.max(1, Math.max(pm.frontierCost, am.frontierCost));
      const scoreDiff = Math.abs(pm.frontierScore - am.frontierScore) / Math.max(1, Math.max(pm.frontierScore, am.frontierScore));

      let separation = Infinity;
      for (let i = 0; i < playerPair.length; i += 1) {
        for (let j = 0; j < aiPair.length; j += 1) {
          const d = distance(playerPair[i].center, aiPair[j].center);
          if (d < separation) separation = d;
        }
      }
      // Regions differ in aspect; require a clear opposing placement rather
      // than a fixed share of the bounding diagonal.
      if (separation < diagonal * 0.12) continue;
      const separationNorm = separation / diagonal;
      const axisGapPenalty =
        Math.max(0, playerAxis + 0.05) + Math.max(0, 0.05 - aiAxis);
      const cost =
        5 * capDiff +
        1.5 * degreeDiff +
        1.5 * costDiff +
        0.5 * scoreDiff -
        2 * separationNorm +
        2 * axisGapPenalty;
      combos.push({
        player: playerPair,
        ai1: aiPair,
        cost: cost,
        capDiff: capDiff,
        separation: separation,
      });
    }
  }

  if (combos.length === 0) {
    throw new Error('Region ' + spec.themeId + '/' + spec.size + ' found no spawn pairing');
  }
  const tight = combos.filter(function (item) { return item.capDiff <= 0.1; });
  const pool = tight.length > 0 ? tight : combos;
  pool.sort(function (a, b) {
    if (Math.abs(a.cost - b.cost) > 1e-9) return a.cost - b.cost;
    return b.separation - a.separation;
  });
  const best = pool[0];
  const allHomes = best.player.concat(best.ai1);
  let homeTroops = HOME_TROOPS;
  for (let i = 0; i < allHomes.length; i += 1) {
    if (allHomes[i].capacity < homeTroops) homeTroops = allHomes[i].capacity;
  }
  return {
    player: best.player.map(function (item) { return item.id; }),
    ai1: best.ai1.map(function (item) { return item.id; }),
    homeTroops: homeTroops,
  };
}

function labelLeaderFor(
  polygon: Array<[number, number]>,
  center: [number, number],
  width: number,
  height: number,
  areaRatio: number
): [number, number] | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    if (polygon[i][0] < minX) minX = polygon[i][0];
    if (polygon[i][1] < minY) minY = polygon[i][1];
    if (polygon[i][0] > maxX) maxX = polygon[i][0];
    if (polygon[i][1] > maxY) maxY = polygon[i][1];
  }
  const boxW = maxX - minX;
  const boxH = maxY - minY;
  if (areaRatio >= 0.35 && boxW >= 46 && boxH >= 46) return undefined;
  let dx = center[0] - width / 2;
  let dy = center[1] - height / 2;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) {
    dx = 1;
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  const reach = Math.max(boxW, boxH) * 0.9 + 34;
  const leader: [number, number] = [
    clamp(center[0] + dx * reach, 10, width - 10),
    clamp(center[1] + dy * reach, 10, height - 10),
  ];
  if (pointInPolygon(leader[0], leader[1], polygon)) return undefined;
  return leader;
}

export function buildGeographicMap(
  spec: GeographicRegionSpec,
  durationSeconds: number,
  factionCount?: FactionCount
): GameMapDefinition;
/** Legacy entry point: resolves the built-in region catalogue by theme+size. */
export function buildGeographicMap(
  themeId: MapThemeId,
  size: number,
  durationSeconds: number,
  factionCount?: FactionCount
): GameMapDefinition;
export function buildGeographicMap(
  specOrTheme: GeographicRegionSpec | MapThemeId,
  sizeOrDuration: number,
  legacyDurationOrFactionCount?: number,
  maybeFactionCount?: FactionCount
): GameMapDefinition {
  const spec = typeof specOrTheme === 'string'
    ? findRegionSpec(specOrTheme, sizeOrDuration)
    : specOrTheme;
  const durationSeconds = typeof specOrTheme === 'string'
    ? (legacyDurationOrFactionCount as number)
    : sizeOrDuration;
  const factionCount = normalizeFactionCount(
    typeof specOrTheme === 'string' ? maybeFactionCount : legacyDurationOrFactionCount
  );
  const themeId = spec.themeId;
  const size = spec.size;
  const mapId = spec.id || themeId + '_' + size;

  const geometries: UsStateGeometry[] = [];
  for (let i = 0; i < spec.states.length; i += 1) {
    const state = STATE_BY_ID[spec.states[i]];
    if (!state) throw new Error('Unknown state ' + spec.states[i]);
    const geometry = STATE_BY_FIPS[state.fips];
    if (!geometry || !Array.isArray(geometry.polygon) || geometry.polygon.length < 3) {
      throw new Error('Missing/empty geometry for ' + state.id + ' (' + state.fips + ')');
    }
    geometries.push(geometry);
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < geometries.length; i += 1) {
    const polygon = geometries[i].polygon;
    for (let p = 0; p < polygon.length; p += 1) {
      if (polygon[p][0] < minX) minX = polygon[p][0];
      if (polygon[p][1] < minY) minY = polygon[p][1];
      if (polygon[p][0] > maxX) maxX = polygon[p][0];
      if (polygon[p][1] > maxY) maxY = polygon[p][1];
    }
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = (GEO_MAP_WIDTH - GEO_MAP_PAD * 2) / spanX;
  const height = Math.max(1, Math.round(GEO_MAP_PAD * 2 + spanY * scale));
  // us-atlas already pre-projects Albers USA into screen coordinates with y
  // increasing southward. Translate only; do not flip, or each state lands in
  // the wrong hemisphere (Texas top-left / North Dakota bottom-left).
  const tx = function (x: number): number { return round3(GEO_MAP_PAD + (x - minX) * scale); };
  const ty = function (y: number): number { return round3(GEO_MAP_PAD + (y - minY) * scale); };

  const axisCenterX = (minX + maxX) / 2;
  const axisCenterY = (minY + maxY) / 2;
  const halfW = Math.max(1e-6, spanX / 2);
  const halfH = Math.max(1e-6, spanY / 2);

  const includedFips: Record<string, boolean> = {};
  const drafts: TerritoryDraft[] = [];
  const draftById: Record<string, TerritoryDraft> = {};
  for (let i = 0; i < spec.states.length; i += 1) {
    const state = STATE_BY_ID[spec.states[i]];
    const geometry = STATE_BY_FIPS[state.fips];
    includedFips[state.fips] = true;
    const polygon: Array<[number, number]> = [];
    for (let p = 0; p < geometry.polygon.length; p += 1) {
      polygon.push([tx(geometry.polygon[p][0]), ty(geometry.polygon[p][1])]);
    }
    const center: [number, number] = [tx(geometry.center[0]), ty(geometry.center[1])];
    if (!pointInPolygon(center[0], center[1], polygon)) {
      // The generated polylabel is guaranteed inside; this guards data drift.
      throw new Error('Label center outside polygon for ' + state.id);
    }
    const areaUnits = isFinite(geometry.area) && geometry.area > 0
      ? geometry.area
      : shoelaceArea(polygon);
    const east = (geometry.center[0] - axisCenterX) / halfW;
    const north = (axisCenterY - geometry.center[1]) / halfH;
    let axis: number;
    if (spec.spawnAxis === 's-n') axis = north;
    else if (spec.spawnAxis === 'w-e') axis = east;
    else axis = (east + north) / 2;
    const draft: TerritoryDraft = {
      id: state.id,
      fips: state.fips,
      source: geometry,
      polygon: polygon,
      center: center,
      areaUnits: areaUnits,
      capacity: capacityForArea(areaUnits, GEO_REFERENCE_AREA),
      degree: 0,
      axis: axis,
      crossingEndpoint: false,
    };
    drafts.push(draft);
    draftById[draft.id] = draft;
  }

  const regionBorders: BorderDraft[] = [];
  for (let i = 0; i < BORDERS.length; i += 1) {
    const border = BORDERS[i];
    if (!includedFips[STATE_BY_ID[border.from].fips]) continue;
    if (!includedFips[STATE_BY_ID[border.to].fips]) continue;
    regionBorders.push(border);
  }
  for (let i = 0; i < regionBorders.length; i += 1) {
    const border = regionBorders[i];
    draftById[border.from].degree += 1;
    draftById[border.to].degree += 1;
  }

  const groupOf: Record<string, string> = {};
  if (spec.groups) {
    for (let g = 0; g < spec.groups.length; g += 1) {
      const group = spec.groups[g];
      for (let s = 0; s < group.states.length; s += 1) groupOf[group.states[s]] = group.id;
    }
  }

  const crossCandidates: BorderDraft[] = [];
  if (spec.groups) {
    for (let i = 0; i < regionBorders.length; i += 1) {
      const border = regionBorders[i];
      if (groupOf[border.from] !== groupOf[border.to]) crossCandidates.push(border);
    }
  }
  const passableCross: Record<string, boolean> = {};
  let crossings: BorderDraft[] = [];
  if (spec.groups) {
    crossings = chooseCrossings(crossCandidates, spec);
    for (let i = 0; i < crossings.length; i += 1) {
      passableCross[crossings[i].key] = true;
      draftById[crossings[i].from].crossingEndpoint = true;
      draftById[crossings[i].to].crossingEndpoint = true;
    }
  }

  const edges: MapEdgeDefinition[] = [];
  const boundaries: MapBoundaryMetadata[] = [];
  for (let i = 0; i < regionBorders.length; i += 1) {
    const border = regionBorders[i];
    const cross = spec.groups !== undefined && groupOf[border.from] !== groupOf[border.to];
    const passable = !cross || passableCross[border.key] === true;
    const kind: MapBoundaryKind = cross
      ? (spec.barrier ? spec.barrier.kind : 'open')
      : 'open';
    const edgeKind: EdgeKind = cross && spec.barrier && spec.barrier.kind === 'river'
      ? 'bridge'
      : 'land';
    const edgeId = passable ? border.from + '-' + border.to : undefined;
    if (passable) {
      edges.push({
        id: edgeId,
        from: border.from,
        to: border.to,
        kind: edgeKind,
        travelFactor: 1,
      });
    }
    const arcs: ArcDraft[] = [];
    for (let a = 0; a < border.arcs.length; a += 1) {
      const points = transformPoints(border.arcs[a].points, tx, ty);
      const length = pathLength(points);
      if (length < MIN_ARC_LENGTH) continue;
      arcs.push({ points: points, length: length, midpoint: pathMidpoint(points) });
    }
    if (arcs.length === 0) continue;
    for (let a = 0; a < arcs.length; a += 1) {
      const boundary: MapBoundaryMetadata = {
        id: border.from + '-' + border.to + (a === 0 ? '' : '#' + (a + 1)),
        from: border.from,
        to: border.to,
        points: arcs[a].points,
        kind: kind,
        passable: passable,
        edgeId: edgeId,
        length: round3(arcs[a].length),
        midpoint: [round3(arcs[a].midpoint[0]), round3(arcs[a].midpoint[1])],
      };
      if (cross && passable && a === 0) {
        boundary.crossing = [round3(arcs[a].midpoint[0]), round3(arcs[a].midpoint[1])];
      }
      boundaries.push(boundary);
    }
  }
  edges.sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
  boundaries.sort(function (a, b) {
    const byPair = (a.from + a.to).localeCompare(b.from + b.to);
    return byPair !== 0 ? byPair : a.id.localeCompare(b.id);
  });

  // Terrain is a strategic abstraction: only crossing-landing states get a
  // defensive terrain; homes are forced back to plain for an even start.
  const terrainById: Record<string, Terrain> = {};
  for (let i = 0; i < drafts.length; i += 1) terrainById[drafts[i].id] = 'plain';
  if (spec.barrier) {
    for (let i = 0; i < crossings.length; i += 1) {
      const terrain: Terrain = spec.barrier.kind === 'river' ? 'forest' : 'hill';
      terrainById[crossings[i].from] = terrain;
      terrainById[crossings[i].to] = terrain;
    }
  }

  // 2-faction maps keep the legacy chooseSpawns route verbatim; 3/4 factions
  // use the bounded deterministic multi-faction allocator (same pair metrics).
  const spawn = factionCount === 2
    ? chooseSpawns(drafts, draftById, edges, spec, height, groupOf)
    : chooseSpawnsForFactions(factionCount, drafts, edges, spec, groupOf, {
        homeTroops: HOME_TROOPS,
        diagonal: Math.sqrt(GEO_MAP_WIDTH * GEO_MAP_WIDTH + height * height),
        pairMetrics: function (pair) { return pairMetrics(pair, draftById, edges); },
      });
  const multi = factionCount >= 3 ? (spawn as MultiSpawnChoice) : undefined;

  // Every declared faction gets its real owner, plain homes, home troops and
  // the +2 home score bonus; neutral stays everything else.
  const factionHomes: Array<{ owner: PlayerId; ids: string[] }> = [
    { owner: 'player', ids: spawn.player },
    { owner: 'ai1', ids: spawn.ai1 },
  ];
  if (multi) factionHomes.push({ owner: 'ai2', ids: multi.ai2 });
  if (multi && multi.ai3) factionHomes.push({ owner: 'ai3', ids: multi.ai3 });

  const homeOwnerOf: Record<string, PlayerId> = {};
  for (let f = 0; f < factionHomes.length; f += 1) {
    const homeIds = factionHomes[f].ids;
    for (let i = 0; i < homeIds.length; i += 1) {
      terrainById[homeIds[i]] = 'plain';
      homeOwnerOf[homeIds[i]] = factionHomes[f].owner;
    }
  }

  const renderedAreas: number[] = [];
  for (let i = 0; i < drafts.length; i += 1) renderedAreas.push(shoelaceArea(drafts[i].polygon));
  const medianRendered = median(renderedAreas);

  const territories: MapTerritoryDefinition[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i];
    const state = STATE_BY_ID[draft.id];
    const homeOwner = homeOwnerOf[draft.id];
    const home = homeOwner !== undefined;
    const owner: OwnerId = home ? homeOwner : 'neutral';
    const renderedArea = shoelaceArea(draft.polygon);
    const labelLeader = labelLeaderFor(
      draft.polygon,
      draft.center,
      GEO_MAP_WIDTH,
      height,
      medianRendered > 0 ? renderedArea / medianRendered : 1
    );
    territories.push({
      id: draft.id,
      name: state.name,
      shortName: state.shortName,
      polygon: draft.polygon,
      center: draft.center,
      labelAnchor: [draft.center[0], draft.center[1]],
      labelLeader: labelLeader,
      areaUnits: draft.areaUnits,
      terrain: terrainById[draft.id],
      owner: owner,
      initialTroops: home ? spawn.homeTroops : NEUTRAL_TROOPS,
      scoreValue: scoreForArea(draft.areaUnits, GEO_REFERENCE_AREA) + (home ? 2 : 0),
    });
  }

  const groups = spec.groups
    ? spec.groups.map(function (group) {
        return {
          id: group.id,
          label: group.label,
          territoryIds: group.states.slice(),
        };
      })
    : undefined;

  const geography: MapGeographyMetadata = {
    country: 'US',
    sourceLabel: GEO_SOURCE_LABEL,
    sourceLicense: GEO_SOURCE_LICENSE,
    projection: GEO_PROJECTION_LABEL,
    regionLabel: spec.regionLabel,
    regionNote: spec.regionNote,
    states: spec.states.slice(),
    groups: groups,
    barrier: spec.barrier
      ? {
          kind: spec.barrier.kind,
          label: spec.barrier.label,
          crossingCount: CROSSING_COUNT,
          crossKind: spec.barrier.kind === 'river' ? 'bridge' : 'land',
          note: spec.barrier.note,
        }
      : undefined,
  };

  return {
    id: mapId,
    name: spec.regionLabel,
    width: GEO_MAP_WIDTH,
    height: height,
    referenceArea: GEO_REFERENCE_AREA,
    supportedDurations: [durationSeconds],
    territories: territories,
    edges: edges,
    spawnTerritories: {
      player: spawn.player.slice(),
      ai1: spawn.ai1.slice(),
      ...(multi ? { ai2: multi.ai2.slice() } : {}),
      ...(multi && multi.ai3 ? { ai3: multi.ai3.slice() } : {}),
    },
    themeId: themeId,
    variantSize: size,
    durationSeconds: durationSeconds,
    description: THEME_DESCRIPTION[themeId],
    features: THEME_FEATURES[themeId].slice(),
    layout: {
      geography: geography,
      boundaries: boundaries,
    },
    geog: {
      regionLabel: spec.regionLabel,
      sourceLabel: GEO_SOURCE_LABEL,
    },
  };
}

/** Data-provenance summary for diagnostics/tests (no download at runtime). */
export const GEO_DATA_META = {
  source: US_GEOGRAPHY_META.source,
  sourceEdition: US_GEOGRAPHY_META.sourceEdition,
  sourceSha256: US_GEOGRAPHY_META.sourceSha256,
  sourceBytes: US_GEOGRAPHY_META.sourceBytes,
  stateCount: US_GEOGRAPHY_META.stateCount,
  sharedBorderCount: US_GEOGRAPHY_META.sharedBorderCount,
};
