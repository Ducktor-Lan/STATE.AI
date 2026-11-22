import type { EdgeKind, OwnerId, PlayerId, Terrain } from '../core/types';

/** Fixed theme ids used by the catalog, saved settings and match metadata. */
export type MapThemeId = 'plains_crossroads' | 'mountain_pass' | 'river_valley';

export interface MapTerritoryDefinition {
  id: string;
  name?: string;
  /**
   * Short Chinese map label (2-4 characters, e.g. 加州 / 宾州). Renderers use
   * it for dense maps; `name` keeps the full name for panels and reports.
   */
  shortName?: string;
  polygon: Array<[number, number]>;
  center: [number, number];
  /** Preferred label point inside the polygon; falls back to center. */
  labelAnchor?: [number, number];
  /** Optional external badge point for very small/narrow territories. */
  labelLeader?: [number, number];
  areaUnits: number;
  terrain: Terrain;
  owner: OwnerId;
  initialTroops: number;
  scoreValue: number;
}

export interface MapEdgeDefinition {
  id?: string;
  from: string;
  to: string;
  kind: EdgeKind;
  travelFactor?: number;
}

/** How a drawn border behaves in the strategic layer. */
export type MapBoundaryKind = 'open' | 'river' | 'ridge';

/**
 * One contiguous shared-border arc in map coordinates.
 *
 * A pair of territories can share several disconnected arcs (e.g. a river
 * meander); emit one record per arc rather than joining unrelated points.
 * Every arc of the same logical edge carries the same `edgeId`; only the
 * longest arc carries `crossing` so the UI draws one bridge/pass marker.
 */
export interface MapBoundaryMetadata {
  /** Unique arc id, e.g. "MO-IL" or "MO-IL#2". */
  id: string;
  from: string;
  to: string;
  /** One continuous polyline; never spans disconnected parts. */
  points: Array<[number, number]>;
  kind: MapBoundaryKind;
  /** True only when this border is a playable edge in the simulation. */
  passable: boolean;
  /** Logical edge id (present on playable arcs). */
  edgeId?: string;
  /** Bridge/pass anchor on the longest playable arc. */
  crossing?: [number, number];
  /** Arc length in map pixels (positive for every shared border). */
  length: number;
  midpoint: [number, number];
}

export interface MapGeographyGroup {
  id: string;
  label: string;
  territoryIds: string[];
}

export interface MapGeographyBarrier {
  kind: 'river' | 'ridge';
  label: string;
  /** Number of real shared borders kept open as bridges/passes (normally 2). */
  crossingCount: number;
  /** Simulation edge kind used by the crossings. */
  crossKind: EdgeKind;
  /** Explicit note that the strategic barrier is an abstraction, not a claim of terrain. */
  note: string;
}

export interface MapGeographyMetadata {
  country: string;
  /** Human-readable data source (state boundary provenance). */
  sourceLabel: string;
  sourceLicense: string;
  projection: string;
  /** Human-readable playable region, e.g. "美国中部大平原". */
  regionLabel: string;
  regionNote?: string;
  /** USPS/ISO-like state ids included in this variant. */
  states: string[];
  /** Two bank/side groups for river/ridge maps. */
  groups?: MapGeographyGroup[];
  barrier?: MapGeographyBarrier;
}

/** Small top-level summary forwarded to selection/report UI. */
export interface MapGeographyBrief {
  regionLabel: string;
  sourceLabel: string;
}

export interface MapLayoutMetadata {
  /** Legacy grid fields; kept optional so old fixtures and snapshots still load. */
  boundaryRow?: number;
  passCols?: number[];
  bridgeCols?: number[];
  /** Formal, full geography metadata for the built-in real-boundary maps. */
  geography?: MapGeographyMetadata;
  /** Every shared border arc, playable or blocked. */
  boundaries?: MapBoundaryMetadata[];
}

export interface GameMapDefinition {
  id: string;
  name: string;
  width: number;
  height: number;
  referenceArea?: number;
  supportedDurations: number[];
  territories: MapTerritoryDefinition[];
  edges: MapEdgeDefinition[];
  spawnTerritories: Partial<Record<PlayerId, string[]>>;
  themeId?: string;
  variantSize?: number;
  durationSeconds?: number;
  description?: string;
  features?: string[];
  layout?: MapLayoutMetadata;
  /** Top-level readable geography summary (selection/report cards). */
  geog?: MapGeographyBrief;
}

export interface MapValidationResult {
  ok: boolean;
  errors: string[];
}
