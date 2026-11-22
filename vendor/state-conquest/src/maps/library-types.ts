import type { MapThemeId } from './types';
import type { SpawnAxis } from './geographic-map/regions';

/**
 * Compact catalogue entry for the generated 144-map library.
 *
 * Only selection metadata is exported here. State polygons, borders and all
 * gameplay geometry stay in the shared generated dataset and are built lazily
 * for the one map a match actually uses.
 */
export interface MapLibraryRecord {
  id: string;
  name: string;
  themeId: MapThemeId;
  size: number;
  durationSeconds: number;
  regionLabel: string;
  states: string[];
  /** River/ridge side ids when the map has a strategic barrier. */
  groupIds?: string[];
  spawnAxis: SpawnAxis;
}

export interface MapLibrarySummary {
  count: number;
  bySize: Record<string, number>;
  byTheme: Record<string, number>;
}
