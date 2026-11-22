import type { MapThemeId } from './templates';
import { plainsCrossroads12 } from './plains-12';
import {
  TUTORIAL_DURATION_SECONDS,
  TUTORIAL_MAP_ID,
  tutorialFirstSteps,
} from './tutorial-map';
import { validateMap } from './validate-map';
import { buildGeographicMap, GEO_SOURCE_LABEL } from './geographic-map/build';
import { findRegionSpec } from './geographic-map/regions';
import type { GeographicRegionSpec } from './geographic-map/regions';
import { normalizeFactionCount } from './geographic-map/spawn-allocation';
import type { FactionCount } from '../core/types';
import { MAP_LIBRARY_META, MAP_LIBRARY_SPECS } from './generated/map-library';
import type {
  GameMapDefinition,
  MapValidationResult,
} from './types';
import type {
  MapCatalog,
  MapResolution,
  MapThemeInfo,
  MapVariantInfo,
} from './catalog-types';
import type { MapLibraryRecord, MapLibrarySummary } from './library-types';
import { durationLabel } from '../config/modes';

export const DEFAULT_MAP_ID = 'plains_crossroads_12';
/** Explicit sentinel for "pick a library map from the match seed". */
export const RANDOM_MAP_ID = 'random';

interface VariantSpec {
  themeId: MapThemeId;
  size: number;
  durationSeconds: number;
  subtitle: string;
}

/** 3 themes x 3 duration scales = 9 fixed variants. */
export const VARIANT_SPECS: VariantSpec[] = [
  { themeId: 'plains_crossroads', size: 12, durationSeconds: 180, subtitle: '速战 · 小规模' },
  { themeId: 'plains_crossroads', size: 18, durationSeconds: 300, subtitle: '标准 · 中规模' },
  { themeId: 'plains_crossroads', size: 24, durationSeconds: 480, subtitle: '持久 · 大规模' },
  { themeId: 'mountain_pass', size: 12, durationSeconds: 180, subtitle: '速战 · 山口夺控' },
  { themeId: 'mountain_pass', size: 18, durationSeconds: 300, subtitle: '标准 · 山脊攻防' },
  { themeId: 'mountain_pass', size: 24, durationSeconds: 480, subtitle: '持久 · 高地鏖战' },
  { themeId: 'river_valley', size: 12, durationSeconds: 180, subtitle: '速战 · 抢桥' },
  { themeId: 'river_valley', size: 18, durationSeconds: 300, subtitle: '标准 · 桥头拉锯' },
  { themeId: 'river_valley', size: 24, durationSeconds: 480, subtitle: '持久 · 河谷决战' },
];

const THEME_META: Record<MapThemeId, { name: string; subtitle: string; features: string[] }> = {
  plains_crossroads: {
    name: '大平原走廊',
    subtitle: '真实州界开阔战场',
    features: ['真实州界', '开阔多路', '大州容量'],
  },
  mountain_pass: {
    name: '阿巴拉契亚山口',
    subtitle: '山脉两侧两处山口',
    features: ['真实州界', '两处山口', '山脊隔断'],
  },
  river_valley: {
    name: '密西西比河渡口',
    subtitle: '两岸两处桥头',
    features: ['真实州界', '两处桥头', '两岸对峙'],
  },
};

const LEGACY_DESCRIPTION: Record<MapThemeId, string> = {
  plains_crossroads:
    '以真实美国州界构成的开阔平原走廊，多路相接，适合快速扩张与提前切换攻守。',
  mountain_pass:
    '阿巴拉契亚山地两侧仅有两处真实州界作为战略山口，其余山脊不可通行。',
  river_valley:
    '密西西比河隔断两岸，只有两处真实跨河州界作为桥头，桥头争夺决定战局。',
};

interface LegacyVariantInfo {
  id: string;
  themeId: MapThemeId;
  size: number;
  durationSeconds: number;
  edgeCount: number;
  bridgeCount: number;
  mountainCount: number;
}

/**
 * Static metadata for the nine legacy variants. Their geometry is built only
 * when a legacy id is explicitly requested; the homepage/random path does not
 * pay for nine eager builds.
 */
const LEGACY_META: Record<string, { edgeCount: number; bridgeCount: number; mountainCount: number }> = {
  plains_crossroads_12: { edgeCount: 21, bridgeCount: 0, mountainCount: 0 },
  plains_crossroads_18: { edgeCount: 35, bridgeCount: 0, mountainCount: 0 },
  plains_crossroads_24: { edgeCount: 52, bridgeCount: 0, mountainCount: 0 },
  mountain_pass_12: { edgeCount: 16, bridgeCount: 0, mountainCount: 2 },
  mountain_pass_18: { edgeCount: 25, bridgeCount: 0, mountainCount: 2 },
  mountain_pass_24: { edgeCount: 36, bridgeCount: 0, mountainCount: 2 },
  river_valley_12: { edgeCount: 14, bridgeCount: 2, mountainCount: 0 },
  river_valley_18: { edgeCount: 28, bridgeCount: 2, mountainCount: 0 },
  river_valley_24: { edgeCount: 43, bridgeCount: 2, mountainCount: 0 },
};

const LEGACY_BY_ID: Record<string, LegacyVariantInfo> = (function build(): Record<string, LegacyVariantInfo> {
  const out: Record<string, LegacyVariantInfo> = {};
  for (let i = 0; i < VARIANT_SPECS.length; i += 1) {
    const spec = VARIANT_SPECS[i];
    const id = spec.themeId + '_' + spec.size;
    const meta = LEGACY_META[id];
    out[id] = {
      id: id,
      themeId: spec.themeId,
      size: spec.size,
      durationSeconds: spec.durationSeconds,
      edgeCount: meta.edgeCount,
      bridgeCount: meta.bridgeCount,
      mountainCount: meta.mountainCount,
    };
  }
  return out;
})();

/** Explicitly built legacy maps; at most one baseline map is eager. */
const LEGACY_CACHE: Record<string, GameMapDefinition> = {
  [plainsCrossroads12.id]: plainsCrossroads12,
};

/**
 * Legacy variants cache per (id, factionCount). The 2-faction instance keeps
 * the bare id key (and its eager prebuilt instances); other counts are keyed
 * `id#count` so cached 2-faction maps are never rebuilt or mutated.
 */
function legacyMap(id: string, factionCount: FactionCount = 2): GameMapDefinition | undefined {
  const key = factionCount === 2 ? id : id + '#' + factionCount;
  const cached = LEGACY_CACHE[key];
  if (cached) return cached;
  const info = LEGACY_BY_ID[id];
  if (!info) return undefined;
  const spec = findRegionSpec(info.themeId, info.size);
  const map = buildGeographicMap(spec, info.durationSeconds, factionCount);
  LEGACY_CACHE[key] = map;
  return map;
}

/* ------------------------------------------------------------------ */
/* Generated 144-map atlas library (metadata only, geometry lazy)      */
/* ------------------------------------------------------------------ */

const LIBRARY_BY_ID: Record<string, GeographicRegionSpec> = {};
const LIBRARY_BY_SIZE: Record<string, GeographicRegionSpec[]> = { '12': [], '18': [], '24': [] };
for (let i = 0; i < MAP_LIBRARY_SPECS.length; i += 1) {
  const spec = MAP_LIBRARY_SPECS[i];
  if (!spec.id) throw new Error('Atlas library spec at index ' + i + ' has no stable id');
  if (LIBRARY_BY_ID[spec.id]) throw new Error('Duplicate atlas library id ' + spec.id);
  LIBRARY_BY_ID[spec.id] = spec;
  const bucket = LIBRARY_BY_SIZE[String(spec.size)];
  if (!bucket) throw new Error('Unexpected atlas library size ' + spec.size);
  bucket.push(spec);
}

function libraryRecord(spec: GeographicRegionSpec): MapLibraryRecord {
  const record: MapLibraryRecord = {
    id: spec.id as string,
    name: spec.regionLabel,
    themeId: spec.themeId,
    size: spec.size,
    durationSeconds: spec.size === 12 ? 180 : spec.size === 18 ? 300 : 480,
    regionLabel: spec.regionLabel,
    states: spec.states.slice(),
    spawnAxis: spec.spawnAxis,
  };
  if (spec.groups) record.groupIds = spec.groups.map(function (group) { return group.id; });
  return record;
}

/** Compact generated map catalogue: ids/states/groups only, never polygons. */
export const MAP_LIBRARY: MapLibraryRecord[] = MAP_LIBRARY_SPECS.map(libraryRecord);

const MAP_LIBRARY_SUMMARY: MapLibrarySummary = (function build(): MapLibrarySummary {
  const bySize: Record<string, number> = { '12': 0, '18': 0, '24': 0 };
  const byTheme: Record<string, number> = {};
  for (let i = 0; i < MAP_LIBRARY_SPECS.length; i += 1) {
    const spec = MAP_LIBRARY_SPECS[i];
    bySize[String(spec.size)] = (bySize[String(spec.size)] || 0) + 1;
    byTheme[spec.themeId] = (byTheme[spec.themeId] || 0) + 1;
  }
  return { count: MAP_LIBRARY_SPECS.length, bySize: bySize, byTheme: byTheme };
})();

export function listMapLibrary(): MapLibraryRecord[] {
  return MAP_LIBRARY.map(function (record) {
    const copy: MapLibraryRecord = {
      id: record.id,
      name: record.name,
      themeId: record.themeId,
      size: record.size,
      durationSeconds: record.durationSeconds,
      regionLabel: record.regionLabel,
      states: record.states.slice(),
      spawnAxis: record.spawnAxis,
    };
    if (record.groupIds) copy.groupIds = record.groupIds.slice();
    return copy;
  });
}

export function getMapLibrarySummary(): MapLibrarySummary {
  return {
    count: MAP_LIBRARY_SUMMARY.count,
    bySize: Object.assign({}, MAP_LIBRARY_SUMMARY.bySize),
    byTheme: Object.assign({}, MAP_LIBRARY_SUMMARY.byTheme),
  };
}

export { MAP_LIBRARY_META };

/** Bounded lazy cache: a session may preview a few maps, never all 144. */
const LIBRARY_CACHE_LIMIT = 6;
const LIBRARY_CACHE: Record<string, GameMapDefinition> = {};
const LIBRARY_CACHE_ORDER: string[] = [];

function cacheLibraryMap(map: GameMapDefinition, key: string): GameMapDefinition {
  if (!LIBRARY_CACHE[key]) {
    LIBRARY_CACHE[key] = map;
    LIBRARY_CACHE_ORDER.push(key);
    while (LIBRARY_CACHE_ORDER.length > LIBRARY_CACHE_LIMIT) {
      const evicted = LIBRARY_CACHE_ORDER.shift() as string;
      delete LIBRARY_CACHE[evicted];
    }
  }
  return LIBRARY_CACHE[key];
}

/** Atlas builds cache per (map id, factionCount); 2-faction stays the default. */
function buildLibraryMap(spec: GeographicRegionSpec, factionCount: FactionCount = 2): GameMapDefinition {
  const key = (spec.id as string) + '#' + factionCount;
  const cached = LIBRARY_CACHE[key];
  if (cached) return cached;
  const duration = spec.size === 12 ? 180 : spec.size === 18 ? 300 : 480;
  return cacheLibraryMap(buildGeographicMap(spec, duration, factionCount), key);
}

/** Local pure hash; does not touch or consume the gameplay PRNG. */
function seedHash(seed: number, durationSeconds: number): number {
  const safeSeed = isFinite(seed) ? (Math.floor(seed) >>> 0) : 0;
  let hash = 0x811c9dc5;
  const text = safeSeed + ':' + durationSeconds;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function libraryPool(durationSeconds: number): GeographicRegionSpec[] {
  if (durationSeconds === 180) return LIBRARY_BY_SIZE['12'];
  if (durationSeconds === 300) return LIBRARY_BY_SIZE['18'];
  if (durationSeconds === 480) return LIBRARY_BY_SIZE['24'];
  return [];
}

/** One deterministic draw for a (seed, duration) pair. */
function pickLibrarySpec(seed: number, durationSeconds: number): GeographicRegionSpec {
  const pool = libraryPool(durationSeconds);
  if (pool.length === 0) {
    throw new Error('No atlas library maps for duration ' + durationSeconds);
  }
  const safeSeed = isFinite(seed) ? (Math.floor(seed) >>> 0) : 0;
  // A coprime stride gives every consecutive seed a different map while the
  // per-duration offset still mixes the catalogue order. No gameplay PRNG use.
  const stride = durationSeconds === 180 ? 5 : durationSeconds === 300 ? 7 : 11;
  const offset = seedHash(0, durationSeconds) % pool.length;
  return pool[(offset + safeSeed * stride) % pool.length];
}

/** Selects and lazily builds exactly one atlas map for a match seed. */
export function selectSeededMap(seed: number, durationSeconds: number): GameMapDefinition {
  return buildLibraryMap(pickLibrarySpec(seed, durationSeconds));
}

/** Compact records for selection/audit UI (no geometry, no eager builds). */
export { MAP_LIBRARY_SPECS };

export const MAP_CATALOG: MapCatalog = (function build(): MapCatalog {
  const themes: MapThemeInfo[] = [];
  const variants: MapVariantInfo[] = [];
  const themeIds: MapThemeId[] = ['plains_crossroads', 'mountain_pass', 'river_valley'];
  for (let t = 0; t < themeIds.length; t += 1) {
    const themeId = themeIds[t];
    const meta = THEME_META[themeId];
    const specs = VARIANT_SPECS.filter(function (spec) {
      return spec.themeId === themeId;
    });
    const sizes: number[] = [];
    const durations: number[] = [];
    for (let s = 0; s < specs.length; s += 1) {
      const spec = specs[s];
      const info = LEGACY_BY_ID[spec.themeId + '_' + spec.size];
      const region = findRegionSpec(themeId, spec.size);
      sizes.push(spec.size);
      durations.push(spec.durationSeconds);
      variants.push({
        id: info.id,
        themeId: themeId,
        mapId: info.id,
        name: meta.name,
        subtitle: spec.subtitle,
        description: LEGACY_DESCRIPTION[themeId],
        size: spec.size,
        durationSeconds: spec.durationSeconds,
        durationLabel: durationLabel(spec.durationSeconds),
        territoryCount: spec.size,
        edgeCount: info.edgeCount,
        bridgeCount: info.bridgeCount,
        mountainCount: info.mountainCount,
        features: meta.features.slice(),
        selectable: true,
        geog: { regionLabel: region.regionLabel, sourceLabel: GEO_SOURCE_LABEL },
      });
    }
    themes.push({
      themeId: themeId,
      name: meta.name,
      subtitle: meta.subtitle,
      description: LEGACY_DESCRIPTION[themeId],
      features: meta.features.slice(),
      sizes: sizes,
      durations: durations,
    });
  }
  return {
    themes: themes,
    variants: variants,
    libraryCount: MAP_LIBRARY_SPECS.length,
  };
})();

function durationToSize(durationSeconds: number): number {
  if (durationSeconds <= 180) return 12;
  if (durationSeconds <= 300) return 18;
  return 24;
}

/**
 * Resolves (mapId|themeId|'random', duration, seed) without building a map.
 * `random`/omitted picks one compact library record from the seed. The same
 * (seed, duration) pair always resolves to the same concrete map id.
 */
export function resolveMapVariant(
  mapIdOrThemeId: string | undefined,
  durationSeconds: number,
  seed?: number
): MapResolution {
  const themeIds: string[] = ['plains_crossroads', 'mountain_pass', 'river_valley'];
  const requested = mapIdOrThemeId && mapIdOrThemeId.length ? mapIdOrThemeId : RANDOM_MAP_ID;

  // The tutorial battlefield is the only non-catalog id accepted here. It is
  // resolved by exact match and never enters the seeded random library or the
  // challenge-code map space.
  if (requested === TUTORIAL_MAP_ID) {
    if (durationSeconds !== TUTORIAL_DURATION_SECONDS) {
      throw new Error(
        'Tutorial map "' + TUTORIAL_MAP_ID + '" supports ' +
          TUTORIAL_DURATION_SECONDS + ' second matches, not ' + durationSeconds
      );
    }
    return {
      mapId: TUTORIAL_MAP_ID,
      variantId: TUTORIAL_MAP_ID,
      themeId: TUTORIAL_MAP_ID,
      durationSeconds: TUTORIAL_DURATION_SECONDS,
      size: tutorialFirstSteps.territories.length,
    };
  }

  if (requested === RANDOM_MAP_ID) {
    const spec = pickLibrarySpec(typeof seed === 'number' ? seed : 0, durationSeconds);
    return {
      mapId: spec.id as string,
      variantId: spec.id as string,
      themeId: spec.themeId,
      durationSeconds: durationSeconds,
      size: spec.size,
    };
  }

  if (themeIds.indexOf(requested) >= 0) {
    if (requested === 'plains_crossroads' && durationSeconds === 180) {
      return {
        mapId: plainsCrossroads12.id,
        variantId: plainsCrossroads12.id,
        themeId: 'plains_crossroads',
        durationSeconds: 180,
        size: 12,
      };
    }
    const size = durationToSize(durationSeconds);
    const id = requested + '_' + size;
    if (!LEGACY_BY_ID[id]) throw new Error('No legacy variant for "' + themeIds + '"');
    return {
      mapId: id,
      variantId: id,
      themeId: requested,
      durationSeconds: durationSeconds,
      size: size,
    };
  }

  const library = LIBRARY_BY_ID[requested];
  if (library) {
    const mapDuration = library.size === 12 ? 180 : library.size === 18 ? 300 : 480;
    if (mapDuration !== durationSeconds) {
      throw new Error(
        'Map "' + requested + '" supports ' + mapDuration + ' second matches, not ' + durationSeconds
      );
    }
    return {
      mapId: requested,
      variantId: requested,
      themeId: library.themeId,
      durationSeconds: mapDuration,
      size: library.size,
    };
  }

  // A concrete legacy variant id (e.g. mountain_pass_18) is accepted as-is.
  const direct = LEGACY_BY_ID[requested];
  if (direct) {
    return {
      mapId: direct.id,
      variantId: direct.id,
      themeId: direct.themeId,
      durationSeconds: durationSeconds,
      size: direct.size,
    };
  }

  throw new Error('Unknown mapId "' + requested + '"');
}

export function getMap(mapId: string): GameMapDefinition {
  if (mapId === TUTORIAL_MAP_ID) return tutorialFirstSteps;
  const legacy = legacyMap(mapId);
  if (legacy) return legacy;
  const library = LIBRARY_BY_ID[mapId];
  if (library) return buildLibraryMap(library);
  const ids = Object.keys(LEGACY_BY_ID).join(', ');
  throw new Error(
    'Unknown mapId "' + mapId + '". Legacy maps: ' + ids +
      '; atlas library: ' + MAP_LIBRARY_SPECS.length + ' generated maps'
  );
}

/**
 * Resolves and returns the actual map. The optional third seed only matters
 * for `random`/omitted ids; legacy theme and variant ids keep their old shape.
 * The optional fourth `factionCount` (2 default, 3 or 4) rebuilds the same
 * geometric map id with one more side's spawns; a request outside 2..4 throws
 * instead of silently downgrading.
 */
export function getMapForMatch(
  mapIdOrThemeId: string | undefined,
  durationSeconds: number,
  seed?: number,
  factionCount?: FactionCount
): { map: GameMapDefinition; resolution: MapResolution } {
  const factions = normalizeFactionCount(factionCount);
  const resolution = resolveMapVariant(mapIdOrThemeId, durationSeconds, seed);
  if (resolution.mapId === TUTORIAL_MAP_ID) {
    if (factions !== 2) {
      throw new Error('Tutorial map "' + TUTORIAL_MAP_ID + '" supports exactly 2 factions');
    }
    return { map: tutorialFirstSteps, resolution: resolution };
  }
  let map = legacyMap(resolution.mapId, factions);
  if (!map) {
    const library = LIBRARY_BY_ID[resolution.mapId];
    if (library) map = buildLibraryMap(library, factions);
  }
  if (!map) {
    const spec = findRegionSpec(resolution.themeId, resolution.size);
    const key = resolution.mapId + '#' + factions;
    map = cacheLibraryMap(buildGeographicMap(spec, durationSeconds, factions), key);
  }
  return { map: map, resolution: resolution };
}

export function hasMap(mapId: string): boolean {
  return mapId === TUTORIAL_MAP_ID || !!(LEGACY_BY_ID[mapId] || LIBRARY_BY_ID[mapId]);
}

export function listMaps(): GameMapDefinition[] {
  return Object.keys(LEGACY_BY_ID).map(function (id) {
    return getMap(id);
  });
}

export function validateMapById(mapId: string): MapValidationResult {
  return validateMap(getMap(mapId));
}

export { plainsCrossroads12, validateMap };
export { normalizeFactionCount } from './geographic-map/spawn-allocation';
export {
  TUTORIAL_DURATION_SECONDS,
  TUTORIAL_MAP_ID,
  TUTORIAL_SEED,
  TUTORIAL_TERRITORY,
  TUTORIAL_TERRITORY_IDS,
  isTutorialMapId,
  tutorialFirstSteps,
} from './tutorial-map';
export type { TutorialTerritoryId } from './tutorial-map';
export type { GameMapDefinition, MapValidationResult, MapThemeId };
export type {
  MapCatalog,
  MapResolution,
  MapThemeInfo,
  MapVariantInfo,
} from './catalog-types';
export type { MapLibraryRecord, MapLibrarySummary } from './library-types';
