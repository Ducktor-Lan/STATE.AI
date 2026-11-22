/**
 * Backwards-compatible entry point.
 *
 * The former rectangular grid templates are gone: every built-in variant is
 * now built from real US state boundary geometry. `buildMapVariant` remains as
 * a thin alias for callers/tests that still import the old name.
 */

import { buildGeographicMap } from './geographic-map/build';
import type { GameMapDefinition, MapThemeId } from './types';

export type { MapThemeId } from './types';

export function buildMapVariant(
  themeId: MapThemeId,
  size: number,
  durationSeconds: number
): GameMapDefinition {
  return buildGeographicMap(themeId, size, durationSeconds);
}
