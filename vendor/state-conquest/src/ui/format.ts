import { TERRAIN_DEFENSE_PCT } from '../config/balance';
import type { Difficulty, OwnerId, ResultKind, Terrain } from './view-model';

export const TERRAIN_LABEL: Record<Terrain, string> = {
  plain: '平原',
  forest: '森林',
  hill: '丘陵',
  mountain: '山地',
};

export const OWNER_LABEL: Record<OwnerId, string> = {
  player: '我方',
  ai1: '敌方',
  ai2: '敌方',
  // v1.4 four-way faction; multi-faction surfaces use the unified 红方/金方/紫方
  // names from ui/factions.ts, this keeps solo legacy labels untouched.
  ai3: '紫方',
  neutral: '中立',
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  casual: '新手',
  easy: '休闲',
  normal: '标准',
  hard: '困难',
};

/**
 * Setup rows list every tier easiest-first. The order lives here (instead of
 * being implied by object key order) because the setup screen renders the DOM
 * in exactly this sequence and tests pin it.
 */
export const SETUP_DIFFICULTY_ORDER: Difficulty[] = ['casual', 'easy', 'normal', 'hard'];

/** One short line under each setup label; casual explicitly targets new players. */
export const SETUP_DIFFICULTY_SUB: Record<Difficulty, string> = {
  casual: '新手推荐',
  easy: '轻松',
  normal: '默认',
  hard: '硬仗',
};

export const RESULT_LABEL: Record<ResultKind, string> = {
  win: '胜利',
  lose: '失守',
  draw: '平局',
};

const REASON_TEXT: Record<string, string> = {
  not_own: '只能从己方领地派兵',
  not_adjacent: '未连接己方领地',
  self: '不能派往同一块领地',
  no_troops: '可调动兵力不足',
  not_playing: '当前不能行动',
  invalid: '目标不可用',
};

export function reasonText(reason: string | null | undefined): string {
  if (!reason) return '目标不可用';
  return REASON_TEXT[reason] || '目标不可用';
}

export function forecastText(forecast: string | null | undefined): string {
  if (forecast === 'capture') return '预计占领';
  if (forecast === 'repelled') return '预计失败';
  if (forecast === 'reinforce') return '己方增援';
  return '战斗预估';
}

export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}

export function formatPercent(ratio: number): string {
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
}

export function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

export function terrainDefenseLabel(terrain: Terrain): string {
  const pct = TERRAIN_DEFENSE_PCT[terrain];
  return pct === 0 ? '守备 ×1.00' : '守备 ×' + (1 + pct / 100).toFixed(2);
}

export function bridgeTravelText(travelFactor?: number): string {
  const factor = typeof travelFactor === 'number' && isFinite(travelFactor) && travelFactor > 0 ? travelFactor : 1;
  const seconds = 0.75 * factor * 1.35;
  const clamped = Math.max(0.35, Math.min(3.5, seconds));
  return clamped.toFixed(2) + ' 秒';
}

export function productionRate(level: 1 | 2 | 3): number {
  if (level === 2) return 1.15;
  if (level === 3) return 1.55;
  return 0.8;
}

export function productionText(level: 1 | 2 | 3): string {
  return '+' + productionRate(level).toFixed(2).replace(/0$/, '') + '/秒';
}

export function upgradeCost(level: 1 | 2 | 3): number | null {
  if (level === 1) return 10;
  if (level === 2) return 20;
  return null;
}

export function durationLabel(seconds: number): string {
  return Math.round(seconds / 60) + ' 分钟';
}

export function modeName(seconds: number): string {
  if (seconds === 180) return '速战';
  if (seconds === 480) return '持久';
  return '标准';
}
