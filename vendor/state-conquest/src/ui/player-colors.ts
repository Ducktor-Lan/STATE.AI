/**
 * Fixed player colour choices. Each swatch has a tested fill/edge/badge trio so
 * a custom choice cannot make armies, labels or borders unreadable.
 */
export type PlayerColorId = 'blue' | 'jade' | 'indigo' | 'rose' | 'cyan' | 'olive';

export interface PlayerColorOption {
  id: PlayerColorId;
  name: string;
  fill: string;
  edge: string;
  badge: string;
  ink: string;
  deep: string;
  soft: string;
}

export const DEFAULT_PLAYER_COLOR_ID: PlayerColorId = 'blue';

export const PLAYER_COLOR_OPTIONS: readonly PlayerColorOption[] = [
  {
    id: 'blue',
    name: '海蓝',
    fill: '#2F5F8B',
    edge: '#1B3B58',
    badge: '#245078',
    ink: '#4E86B8',
    deep: '#1B3B58',
    soft: '#DCE8F3',
  },
  {
    id: 'jade',
    name: '青玉',
    fill: '#2F8068',
    edge: '#1D5545',
    badge: '#266D58',
    ink: '#50A489',
    deep: '#1D5545',
    soft: '#D9EEE6',
  },
  {
    id: 'indigo',
    name: '靛青',
    fill: '#4D639B',
    edge: '#293B6A',
    badge: '#3D5082',
    ink: '#7B93D0',
    deep: '#293B6A',
    soft: '#E1E7F5',
  },
  {
    id: 'rose',
    name: '绛红',
    fill: '#B45A70',
    edge: '#733546',
    badge: '#98485E',
    ink: '#D17C92',
    deep: '#733546',
    soft: '#F2DDE3',
  },
  {
    id: 'cyan',
    name: '苍青',
    fill: '#2E7F91',
    edge: '#1F4E58',
    badge: '#286D7B',
    ink: '#58B4C1',
    deep: '#1F4E58',
    soft: '#D8EEF1',
  },
  {
    id: 'olive',
    name: '橄榄',
    fill: '#6D7F43',
    edge: '#47542A',
    badge: '#5D6C37',
    ink: '#9CAF67',
    deep: '#47542A',
    soft: '#E8EDD7',
  },
];

export function isPlayerColorId(value: unknown): value is PlayerColorId {
  for (let i = 0; i < PLAYER_COLOR_OPTIONS.length; i += 1) {
    if (PLAYER_COLOR_OPTIONS[i].id === value) return true;
  }
  return false;
}

export function normalizePlayerColorId(value: unknown): PlayerColorId {
  return isPlayerColorId(value) ? value : DEFAULT_PLAYER_COLOR_ID;
}

export function playerColorOption(value: unknown): PlayerColorOption {
  const id = normalizePlayerColorId(value);
  for (let i = 0; i < PLAYER_COLOR_OPTIONS.length; i += 1) {
    if (PLAYER_COLOR_OPTIONS[i].id === id) return PLAYER_COLOR_OPTIONS[i];
  }
  return PLAYER_COLOR_OPTIONS[0];
}
