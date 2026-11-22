/**
 * Fixed, deterministic teaching battlefield.
 *
 * This map exists only for the interactive tutorial and is deliberately NOT
 * part of the random atlas, the legacy map list or the challenge-codec map
 * space. `maps/index.ts` recognises exactly `TUTORIAL_MAP_ID` and nothing else;
 * every normal match keeps resolving through the seeded library.
 *
 * Layout (1200 x 800, four unequal organic shapes on a rough coastline):
 *
 *   ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
 *   ~                               /~~~~~~~~~~~~~~~~~~\ ~
 *   ~                              |  tut_enemy_rear    |~
 *   ~                              |  ai1, 12 troops    |~
 *   ~   /~~~~~~~~~~~~~~~~~~\ ~~~~~~+~~~~~~~~~~~~~~~~~~~~+~
 *   ~  |     tut_home        | tut_front |   tut_enemy    |~
 *   ~  |    player, 44       | neutral,3 |    ai1, 10     |~
 *   ~   \___________________/  \_______/  \_______________/~
 *   ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
 *
 * The shapes are drawn as wavy shared arcs (see ARC_* below) instead of four
 * equal rectangles: the village is the widest block (the middle one), the home
 * city is the deepest western block, the outpost is a narrower eastern strip
 * and the rear is a shallow shelf above the outpost, not the middle block.
 * Only the four centre points are used for march anchors, so the irregular
 * outline never changes travel timing (`travelFactor` stays 1).
 *
 * Real shared borders (layout.boundaries) make every declared edge passable
 * under validateMap's geographic mode, so the teaching routes below are the
 * same routes the army planner uses:
 *
 *   tut_home -- tut_front -- tut_enemy -- tut_enemy_rear
 *
 * Each shared border is the exact same polyline on both neighbouring rings, so
 * `boundaryOnPolygons` sees collinear, fully covered edges.
 *
 * Teaching force budget with the standard charge/dispatch rules:
 *   - home 44 -> reserve 7, available 37; a 60% drag sends 22.
 *   - 22 > requiredAttackCost(3, plain) = 3, so tut_front is captured with 19.
 *   - home keeps 22, enough to buy a production upgrade for 10 (needs > 10).
 *   - tut_front 19 -> available 16, which beats tut_enemy's cost 10.
 *   - tut_enemy_rear stays ai1, so the enemy can never be wiped out by this
 *     single teaching wave and evaluateEarlyEnd cannot finish the lesson.
 *
 * The outpost uses a deliberately smaller LOGICAL area (16000) than its drawn
 * shape. `capacityForArea(16000, 160000)` = 20 + 30 * sqrt(0.1) = 29.49,
 * rounded and clamped to 30. This matters for a long lesson: the real engine
 * keeps producing for both sides, and an outpost capped at 50 could not be
 * taken by a single village source (village available troops peak at 42).
 * With the 30 cap the fully produced village (50 -> available 42) can always
 * break it, while the opening garrison stays the same 10.
 *
 * The tutorial uses a fixed seed for reproducible events, but safety never
 * depends on it: MatchEngine clears the disaster schedule for this map id for
 * every seed, and the teaching advance never resolves a disaster at all.
 */

import type { GameMapDefinition, MapBoundaryMetadata } from './types';

export const TUTORIAL_MAP_ID = 'tutorial_first_steps';
export const TUTORIAL_DURATION_SECONDS = 180;
/** Fixed seed recommended to the shell; disaster safety does not rely on it. */
export const TUTORIAL_SEED = 20261031;

/** Stable ids used by the tutorial state machine and its tests. */
export const TUTORIAL_TERRITORY = {
  /** Player's starting city: drag source and the recommended upgrade target. */
  home: 'tut_home',
  /** Weak neutral village: the first capture target. */
  neutral: 'tut_front',
  /** Enemy outpost: reaches only through the captured village. */
  enemy: 'tut_enemy',
  /** Enemy rear: keeps the enemy faction alive during the lesson. */
  enemyReserve: 'tut_enemy_rear',
} as const;

export type TutorialTerritoryId =
  typeof TUTORIAL_TERRITORY[keyof typeof TUTORIAL_TERRITORY];

/** Every territory id, in map order (stable for UI/test iteration). */
export const TUTORIAL_TERRITORY_IDS: TutorialTerritoryId[] = [
  TUTORIAL_TERRITORY.home,
  TUTORIAL_TERRITORY.neutral,
  TUTORIAL_TERRITORY.enemy,
  TUTORIAL_TERRITORY.enemyReserve,
];

const MAP_WIDTH = 1200;
const MAP_HEIGHT = 800;
/** One 400 x 400 tile's logical area; capacity becomes 50 at this reference. */
const TILE_AREA = 160000;
/**
 * Logical area of the enemy outpost. Its drawn shape is an ordinary organic
 * block, but the capacity formula only reads `areaUnits`:
 * 20 + 30 * sqrt(16000 / 160000) = 29.49 -> clamped to 30. This keeps the
 * outpost capturable after a very long teaching session.
 */
const ENEMY_OUTPOST_AREA = 16000;

/*
 * Shared borders. Each polyline is one continuous wavy arc, written once and
 * reused verbatim by both neighbouring polygons (one of them reversed). This
 * is the only way validateMap's collinear coverage test stays exact.
 */
const ARC_HOME_FRONT: Array<[number, number]> = [
  [392, 318],
  [352, 386],
  [398, 452],
  [366, 524],
  [410, 596],
  [382, 668],
  [420, 736],
  [402, 792],
];

const ARC_FRONT_ENEMY: Array<[number, number]> = [
  [816, 292],
  [778, 360],
  [828, 430],
  [796, 502],
  [844, 574],
  [812, 646],
  [850, 716],
  [826, 792],
];

const ARC_ENEMY_REAR: Array<[number, number]> = [
  [866, 316],
  [914, 282],
  [972, 322],
  [1032, 292],
  [1090, 336],
  [1138, 310],
  [1172, 356],
];

/*
 * Outer coastlines. Each list starts after the previous arc's last point and
 * ends before the next arc's first point; the ring closes itself. The ragged
 * points give every territory its own shoreline instead of a map-sized grid.
 */
const HOME_COAST: Array<[number, number]> = [
  [392, 318],
  [296, 248],
  [206, 278],
  [120, 236],
  [48, 286],
  [22, 376],
  [46, 470],
  [18, 560],
  [52, 648],
  [32, 720],
  [124, 756],
  [222, 780],
  [314, 748],
  [402, 792],
];

const FRONT_SOUTH_COAST: Array<[number, number]> = [
  [492, 774],
  [578, 794],
  [664, 768],
  [750, 788],
];

const FRONT_NORTH_COAST: Array<[number, number]> = [
  [724, 268],
  [640, 304],
  [552, 272],
  [468, 300],
];

const ENEMY_EAST_COAST: Array<[number, number]> = [
  [900, 762],
  [980, 738],
  [1058, 754],
  [1124, 738],
  [1106, 682],
  [1140, 610],
  [1118, 540],
  [1146, 456],
];

const REAR_NORTH_COAST: Array<[number, number]> = [
  [1186, 286],
  [1150, 212],
  [1172, 138],
  [1104, 74],
  [1022, 96],
  [948, 58],
  [872, 84],
  [798, 58],
  [748, 104],
  [770, 168],
  [820, 220],
  [852, 266],
];

/** Length and half-way point of a polyline, derived from its real vertices. */
function polylineMetrics(points: Array<[number, number]>): {
  length: number;
  midpoint: [number, number];
} {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
  }
  const half = total / 2;
  let walked = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const segment = Math.sqrt(dx * dx + dy * dy);
    if (segment <= 0) continue;
    if (walked + segment >= half || i === points.length - 1) {
      const t = (half - walked) / segment;
      return {
        length: Math.round(total * 1000) / 1000,
        midpoint: [
          Math.round((points[i - 1][0] + dx * t) * 10) / 10,
          Math.round((points[i - 1][1] + dy * t) * 10) / 10,
        ],
      };
    }
    walked += segment;
  }
  return { length: Math.round(total * 1000) / 1000, midpoint: points[0] };
}

function border(
  id: string,
  from: string,
  to: string,
  edgeId: string,
  points: Array<[number, number]>
): MapBoundaryMetadata {
  const metrics = polylineMetrics(points);
  return {
    id: id,
    from: from,
    to: to,
    points: points,
    kind: 'open',
    passable: true,
    edgeId: edgeId,
    length: metrics.length,
    midpoint: metrics.midpoint,
  };
}

const BOUNDARIES: MapBoundaryMetadata[] = [
  border(
    'tut_home-tut_front#border',
    TUTORIAL_TERRITORY.home,
    TUTORIAL_TERRITORY.neutral,
    'tut_home-tut_front',
    ARC_HOME_FRONT
  ),
  border(
    'tut_front-tut_enemy#border',
    TUTORIAL_TERRITORY.neutral,
    TUTORIAL_TERRITORY.enemy,
    'tut_front-tut_enemy',
    ARC_FRONT_ENEMY
  ),
  border(
    'tut_enemy-tut_enemy_rear#border',
    TUTORIAL_TERRITORY.enemy,
    TUTORIAL_TERRITORY.enemyReserve,
    'tut_enemy-tut_enemy_rear',
    ARC_ENEMY_REAR
  ),
];

export const tutorialFirstSteps: GameMapDefinition = {
  id: TUTORIAL_MAP_ID,
  name: '新手战场',
  width: MAP_WIDTH,
  height: MAP_HEIGHT,
  referenceArea: TILE_AREA,
  // The fixed scene is a 180-second short lesson; the teaching advance itself
  // is not bound by this clock (see MatchEngine.tickWithoutAi).
  supportedDurations: [TUTORIAL_DURATION_SECONDS],
  description:
    '教学专用固定战场：主城—村庄—敌哨—敌方后备四点一线，无天灾、可无限等待，仅供教程调用。',
  features: ['教学专用', '固定场景', '无天灾', '无限等待'],
  variantSize: TUTORIAL_TERRITORY_IDS.length,
  durationSeconds: TUTORIAL_DURATION_SECONDS,
  geog: {
    regionLabel: '教学战场',
    sourceLabel: '固定教学地图（非真实地理数据）',
  },
  territories: [
    {
      id: TUTORIAL_TERRITORY.home,
      name: '新手主城',
      shortName: '主城',
      // West block: the deepest shape, with a ragged west coast.
      polygon: [
        ...HOME_COAST,
        ...ARC_HOME_FRONT.slice(1, -1).reverse(),
      ],
      center: [196, 556],
      labelAnchor: [196, 556],
      areaUnits: TILE_AREA,
      terrain: 'plain',
      owner: 'player',
      initialTroops: 44,
      scoreValue: 10,
    },
    {
      id: TUTORIAL_TERRITORY.neutral,
      name: '前沿村庄',
      shortName: '村庄',
      // Middle block: shares its whole west side with home and its east side
      // with the outpost, with organic north/south coasts.
      polygon: [
        ...ARC_HOME_FRONT,
        ...FRONT_SOUTH_COAST,
        ...ARC_FRONT_ENEMY.slice().reverse(),
        ...FRONT_NORTH_COAST,
      ],
      center: [600, 552],
      labelAnchor: [600, 552],
      areaUnits: TILE_AREA,
      terrain: 'plain',
      owner: 'neutral',
      initialTroops: 3,
      scoreValue: 10,
    },
    {
      id: TUTORIAL_TERRITORY.enemy,
      name: '敌方前哨',
      shortName: '敌哨',
      // Eastern strip below the rear shelf; its top-left corner meets rear only
      // at a single point, so the lesson route stays home -> front -> outpost.
      polygon: [
        ...ARC_FRONT_ENEMY,
        ...ENEMY_EAST_COAST,
        ...ARC_ENEMY_REAR.slice().reverse(),
      ],
      center: [986, 566],
      labelAnchor: [986, 566],
      areaUnits: ENEMY_OUTPOST_AREA,
      terrain: 'plain',
      owner: 'ai1',
      initialTroops: 10,
      scoreValue: 10,
    },
    {
      id: TUTORIAL_TERRITORY.enemyReserve,
      name: '敌方后备',
      shortName: '后备',
      // Shallow northern shelf above the outpost, wider than it is tall.
      polygon: [
        ...ARC_ENEMY_REAR,
        ...REAR_NORTH_COAST,
      ],
      center: [982, 192],
      labelAnchor: [982, 192],
      areaUnits: TILE_AREA,
      terrain: 'plain',
      owner: 'ai1',
      initialTroops: 12,
      scoreValue: 10,
    },
  ],
  edges: [
    {
      id: 'tut_home-tut_front',
      from: TUTORIAL_TERRITORY.home,
      to: TUTORIAL_TERRITORY.neutral,
      kind: 'land',
      travelFactor: 1,
    },
    {
      id: 'tut_front-tut_enemy',
      from: TUTORIAL_TERRITORY.neutral,
      to: TUTORIAL_TERRITORY.enemy,
      kind: 'land',
      travelFactor: 1,
    },
    {
      id: 'tut_enemy-tut_enemy_rear',
      from: TUTORIAL_TERRITORY.enemy,
      to: TUTORIAL_TERRITORY.enemyReserve,
      kind: 'land',
      travelFactor: 1,
    },
  ],
  spawnTerritories: {
    player: [TUTORIAL_TERRITORY.home],
    ai1: [TUTORIAL_TERRITORY.enemy, TUTORIAL_TERRITORY.enemyReserve],
  },
  layout: {
    boundaries: BOUNDARIES,
  },
};

export function isTutorialMapId(mapId: string | undefined | null): boolean {
  return mapId === TUTORIAL_MAP_ID;
}
