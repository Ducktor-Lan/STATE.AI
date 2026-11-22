/**
 * The P0 map id `plains_crossroads_12` is preserved for saved settings and
 * tests, but it now holds real central-US state geometry, not the old 3x4
 * rectangle table.
 */

import { buildGeographicMap } from './geographic-map/build';
import type { GameMapDefinition } from './types';

export const plainsCrossroads12: GameMapDefinition = buildGeographicMap(
  'plains_crossroads',
  12,
  180
);
