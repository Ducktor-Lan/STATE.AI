/**
 * Real-geography region catalogue.
 *
 * State ids are USPS codes; `fips` is the Census state FIPS code used by the
 * generated `us-states` dataset. Every playable state is a single continental
 * state polygon (no AK/HI/DC, no MI: its largest ring would silently drop the
 * Upper Peninsula and the WI border, creating a false adjacency).
 *
 * The three themes reuse the same shared-border dataset but select different
 * contiguous regions:
 *   plains_crossroads — central Plains / Great Lakes interior, all open land
 *   mountain_pass     — Appalachian belt, split west/east with two land passes
 *   river_valley      — middle Mississippi both banks, split with two bridges
 *
 * River/mountain groups are strategic abstractions over real state borders,
 * not claims about the real terrain. Every crossing is a real shared border.
 */

import type { MapThemeId } from '../types';

export interface StateInfo {
  id: string;
  fips: string;
  /** Full Chinese state name (titles, reports). */
  name: string;
  /** 2-4 character map label. */
  shortName: string;
}

export const STATE_LIST: StateInfo[] = [
  { id: 'AL', fips: '01', name: '阿拉巴马州', shortName: '阿拉' },
  { id: 'AZ', fips: '04', name: '亚利桑那州', shortName: '亚利' },
  { id: 'AR', fips: '05', name: '阿肯色州', shortName: '阿肯' },
  { id: 'CA', fips: '06', name: '加利福尼亚州', shortName: '加州' },
  { id: 'CO', fips: '08', name: '科罗拉多州', shortName: '科州' },
  { id: 'CT', fips: '09', name: '康涅狄格州', shortName: '康州' },
  { id: 'DE', fips: '10', name: '特拉华州', shortName: '特拉' },
  { id: 'FL', fips: '12', name: '佛罗里达州', shortName: '佛州' },
  { id: 'GA', fips: '13', name: '佐治亚州', shortName: '佐州' },
  { id: 'ID', fips: '16', name: '爱达荷州', shortName: '爱达' },
  { id: 'IL', fips: '17', name: '伊利诺伊州', shortName: '伊州' },
  { id: 'IN', fips: '18', name: '印第安纳州', shortName: '印州' },
  { id: 'IA', fips: '19', name: '爱荷华州', shortName: '爱荷' },
  { id: 'KS', fips: '20', name: '堪萨斯州', shortName: '堪州' },
  { id: 'KY', fips: '21', name: '肯塔基州', shortName: '肯州' },
  { id: 'LA', fips: '22', name: '路易斯安那州', shortName: '路州' },
  { id: 'ME', fips: '23', name: '缅因州', shortName: '缅因' },
  { id: 'MD', fips: '24', name: '马里兰州', shortName: '马州' },
  { id: 'MA', fips: '25', name: '马萨诸塞州', shortName: '麻州' },
  { id: 'MI', fips: '26', name: '密歇根州', shortName: '密歇' },
  { id: 'MN', fips: '27', name: '明尼苏达州', shortName: '明州' },
  { id: 'MS', fips: '28', name: '密西西比州', shortName: '密西' },
  { id: 'MO', fips: '29', name: '密苏里州', shortName: '密苏' },
  { id: 'MT', fips: '30', name: '蒙大拿州', shortName: '蒙大' },
  { id: 'NE', fips: '31', name: '内布拉斯加州', shortName: '内布' },
  { id: 'NV', fips: '32', name: '内华达州', shortName: '内华' },
  { id: 'NH', fips: '33', name: '新罕布什尔州', shortName: '新罕' },
  { id: 'NJ', fips: '34', name: '新泽西州', shortName: '新泽' },
  { id: 'NM', fips: '35', name: '新墨西哥州', shortName: '新墨' },
  { id: 'NY', fips: '36', name: '纽约州', shortName: '纽约' },
  { id: 'NC', fips: '37', name: '北卡罗来纳州', shortName: '北卡' },
  { id: 'ND', fips: '38', name: '北达科他州', shortName: '北达' },
  { id: 'OH', fips: '39', name: '俄亥俄州', shortName: '俄州' },
  { id: 'OK', fips: '40', name: '俄克拉何马州', shortName: '俄克' },
  { id: 'OR', fips: '41', name: '俄勒冈州', shortName: '俄勒' },
  { id: 'PA', fips: '42', name: '宾夕法尼亚州', shortName: '宾州' },
  { id: 'RI', fips: '44', name: '罗得岛州', shortName: '罗得' },
  { id: 'SC', fips: '45', name: '南卡罗来纳州', shortName: '南卡' },
  { id: 'SD', fips: '46', name: '南达科他州', shortName: '南达' },
  { id: 'TN', fips: '47', name: '田纳西州', shortName: '田州' },
  { id: 'TX', fips: '48', name: '得克萨斯州', shortName: '得州' },
  { id: 'UT', fips: '49', name: '犹他州', shortName: '犹他' },
  { id: 'VT', fips: '50', name: '佛蒙特州', shortName: '佛蒙' },
  { id: 'VA', fips: '51', name: '弗吉尼亚州', shortName: '弗州' },
  { id: 'WA', fips: '53', name: '华盛顿州', shortName: '华州' },
  { id: 'WV', fips: '54', name: '西弗吉尼亚州', shortName: '西弗' },
  { id: 'WI', fips: '55', name: '威斯康星州', shortName: '威州' },
  { id: 'WY', fips: '56', name: '怀俄明州', shortName: '怀俄' },
];

export const STATE_BY_ID: Record<string, StateInfo> = (function build(): Record<string, StateInfo> {
  const out: Record<string, StateInfo> = {};
  for (let i = 0; i < STATE_LIST.length; i += 1) out[STATE_LIST[i].id] = STATE_LIST[i];
  return out;
})();

export const STATE_ID_BY_FIPS: Record<string, string> = (function build(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < STATE_LIST.length; i += 1) {
    out[STATE_LIST[i].fips] = STATE_LIST[i].id;
  }
  return out;
})();

export interface RegionGroupSpec {
  id: string;
  label: string;
  states: string[];
}

export type SpawnAxis = 'sw-ne' | 's-n' | 'w-e';

export interface GeographicRegionSpec {
  /** Stable map id. Legacy specs omit it and use `${themeId}_${size}`. */
  id?: string;
  themeId: MapThemeId;
  size: number;
  regionLabel: string;
  regionNote: string;
  /** Every state included in this variant, in stable order. */
  states: string[];
  /** River/ridge side groups; absent for open-land maps. */
  groups?: RegionGroupSpec[];
  barrier?: {
    kind: 'river' | 'ridge';
    label: string;
    note: string;
  };
  /** Direction from the player side to the AI side. */
  spawnAxis: SpawnAxis;
}

const PLAINS_12 = [
  'ND', 'SD', 'NE', 'KS', 'OK', 'MN', 'IA', 'MO', 'AR', 'LA', 'WI', 'IL',
];
const PLAINS_18 = PLAINS_12.concat(['TX', 'CO', 'WY', 'MT', 'IN', 'OH']);
const PLAINS_24 = PLAINS_18.concat(['NM', 'UT', 'KY', 'TN', 'MS', 'AL']);

const MOUNTAIN_12_WEST = ['OH', 'KY', 'TN', 'IN', 'IL', 'AL'];
const MOUNTAIN_12_EAST = ['PA', 'WV', 'VA', 'MD', 'NC', 'SC'];
const MOUNTAIN_18_WEST = MOUNTAIN_12_WEST.concat(['MS', 'WI']);
const MOUNTAIN_18_EAST = MOUNTAIN_12_EAST.concat(['NY', 'NJ', 'CT', 'GA']);
const MOUNTAIN_24_WEST = MOUNTAIN_18_WEST.concat(['LA', 'AR']);
const MOUNTAIN_24_EAST = MOUNTAIN_18_EAST.concat(['MA', 'VT', 'NH', 'ME']);

const RIVER_12_WEST = ['MN', 'IA', 'MO', 'AR', 'LA', 'OK'];
const RIVER_12_EAST = ['IL', 'WI', 'KY', 'TN', 'MS', 'AL'];
const RIVER_18_WEST = RIVER_12_WEST.concat(['KS', 'NE', 'SD']);
const RIVER_18_EAST = RIVER_12_EAST.concat(['IN', 'OH', 'GA']);
const RIVER_24_WEST = RIVER_18_WEST.concat(['ND', 'TX', 'CO']);
const RIVER_24_EAST = RIVER_18_EAST.concat(['SC', 'NC', 'VA']);

function ordered(west: string[], east: string[]): string[] {
  return west.concat(east);
}

export const GEOGRAPHIC_REGIONS: GeographicRegionSpec[] = [
  {
    themeId: 'plains_crossroads',
    size: 12,
    regionLabel: '美国中西部平原',
    regionNote: '大平原东缘与五大湖内陆，开阔多路，无战略隔断。',
    states: PLAINS_12.slice(),
    spawnAxis: 'sw-ne',
  },
  {
    themeId: 'plains_crossroads',
    size: 18,
    regionLabel: '大平原—五大湖',
    regionNote: '从落基山东麓到五大湖的开阔走廊，州界即通路。',
    states: PLAINS_18.slice(),
    spawnAxis: 'sw-ne',
  },
  {
    themeId: 'plains_crossroads',
    size: 24,
    regionLabel: '大平原—密西西比腹地',
    regionNote: '横跨大平原与密西西比腹地，南方大州容量显著。',
    states: PLAINS_24.slice(),
    spawnAxis: 'sw-ne',
  },
  {
    themeId: 'mountain_pass',
    size: 12,
    regionLabel: '阿巴拉契亚山地',
    regionNote: '阿巴拉契亚山脉两侧；仅两处真实州界作为战略山口，其余山脊不可通行。',
    states: ordered(MOUNTAIN_12_WEST, MOUNTAIN_12_EAST),
    groups: [
      { id: 'west', label: '山脊西侧', states: MOUNTAIN_12_WEST.slice() },
      { id: 'east', label: '山脊东侧', states: MOUNTAIN_12_EAST.slice() },
    ],
    barrier: {
      kind: 'ridge',
      label: '阿巴拉契亚山脊（战略抽象）',
      note: '山口为真实相邻州界，山脊线与不可通行标记为架空战略地形。',
    },
    spawnAxis: 'sw-ne',
  },
  {
    themeId: 'mountain_pass',
    size: 18,
    regionLabel: '阿巴拉契亚山地',
    regionNote: '山脉两侧向北延伸至纽约、新英格兰，向南至佐治亚。',
    states: ordered(MOUNTAIN_18_WEST, MOUNTAIN_18_EAST),
    groups: [
      { id: 'west', label: '山脊西侧', states: MOUNTAIN_18_WEST.slice() },
      { id: 'east', label: '山脊东侧', states: MOUNTAIN_18_EAST.slice() },
    ],
    barrier: {
      kind: 'ridge',
      label: '阿巴拉契亚山脊（战略抽象）',
      note: '山口为真实相邻州界，山脊线与不可通行标记为架空战略地形。',
    },
    spawnAxis: 'sw-ne',
  },
  {
    themeId: 'mountain_pass',
    size: 24,
    regionLabel: '阿巴拉契亚山地',
    regionNote: '完整阿巴拉契亚走廊：西部腹地、山脉本体与新英格兰。',
    states: ordered(MOUNTAIN_24_WEST, MOUNTAIN_24_EAST),
    groups: [
      { id: 'west', label: '山脊西侧', states: MOUNTAIN_24_WEST.slice() },
      { id: 'east', label: '山脊东侧', states: MOUNTAIN_24_EAST.slice() },
    ],
    barrier: {
      kind: 'ridge',
      label: '阿巴拉契亚山脊（战略抽象）',
      note: '山口为真实相邻州界，山脊线与不可通行标记为架空战略地形。',
    },
    spawnAxis: 'sw-ne',
  },
  {
    themeId: 'river_valley',
    size: 12,
    regionLabel: '密西西比中游两岸',
    regionNote: '密西西比河两岸；仅两处真实跨河州界作为桥头，其余河段不可通行。',
    states: ordered(RIVER_12_WEST, RIVER_12_EAST),
    groups: [
      { id: 'west', label: '密西西比河西岸', states: RIVER_12_WEST.slice() },
      { id: 'east', label: '密西西比河东岸', states: RIVER_12_EAST.slice() },
    ],
    barrier: {
      kind: 'river',
      label: '密西西比河（战略抽象）',
      note: '桥头为真实相邻州界，河线与不可通行标记为架空战略地形。',
    },
    spawnAxis: 's-n',
  },
  {
    themeId: 'river_valley',
    size: 18,
    regionLabel: '密西西比中游两岸',
    regionNote: '上中游至墨西哥湾，两岸腹地加深，桥头价值更高。',
    states: ordered(RIVER_18_WEST, RIVER_18_EAST),
    groups: [
      { id: 'west', label: '密西西比河西岸', states: RIVER_18_WEST.slice() },
      { id: 'east', label: '密西西比河东岸', states: RIVER_18_EAST.slice() },
    ],
    barrier: {
      kind: 'river',
      label: '密西西比河（战略抽象）',
      note: '桥头为真实相邻州界，河线与不可通行标记为架空战略地形。',
    },
    spawnAxis: 's-n',
  },
  {
    themeId: 'river_valley',
    size: 24,
    regionLabel: '密西西比中游两岸',
    regionNote: '从北部源头到三角洲的完整密西西比走廊，两岸各有纵深。',
    states: ordered(RIVER_24_WEST, RIVER_24_EAST),
    groups: [
      { id: 'west', label: '密西西比河西岸', states: RIVER_24_WEST.slice() },
      { id: 'east', label: '密西西比河东岸', states: RIVER_24_EAST.slice() },
    ],
    barrier: {
      kind: 'river',
      label: '密西西比河（战略抽象）',
      note: '桥头为真实相邻州界，河线与不可通行标记为架空战略地形。',
    },
    spawnAxis: 's-n',
  },
];

export function findRegionSpec(themeId: string, size: number): GeographicRegionSpec {
  for (let i = 0; i < GEOGRAPHIC_REGIONS.length; i += 1) {
    const spec = GEOGRAPHIC_REGIONS[i];
    if (spec.themeId === themeId && spec.size === size) return spec;
  }
  throw new Error('Unknown geographic region ' + themeId + '/' + size);
}
