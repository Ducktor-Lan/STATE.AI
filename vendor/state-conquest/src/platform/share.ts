/**
 * War-report poster and platform share/save wrapper.
 *
 * Hard rules:
 * - No automatic publishing. Every method below must be invoked by an explicit
 *   user click in the result screen.
 * - No SDK: renderPoster still works for an in-page browser preview; save/share
 *   capabilities are false and callers must hide or disable those buttons.
 * - Failures resolve false and never block "play again".
 */
import { getMiniTool } from './xhs';
import type { MiniToolApi } from './xhs';
import { VERSUS_BLUE_NAME, VERSUS_RED_NAME } from '../config/balance';
import type { PlayerColorId } from '../ui/player-colors';
import { createOwnerPalette } from '../rendering/owner-palette';
import type { OwnerPalette } from '../rendering/owner-palette';

export interface WarReportModel {
  resultLabel: string;
  resultKind: 'win' | 'lose' | 'draw';
  mapName: string;
  difficultyLabel: string;
  modeLabel: string;
  durationLabel: string;
  elapsedLabel: string;
  score: number;
  territoryCount: number;
  maxTerritories: number;
  captures: number;
  dateLabel: string;
  /** Player swatch for this report; absent/invalid values use legacy blue. */
  playerColorId?: PlayerColorId | string | null;
  /**
   * Local versus only. When both are present the stats grid prints two rows
   * (blue score/land, red score/land) instead of the solo leaderboard cells.
   */
  opponentScore?: number;
  opponentTerritories?: number;
  /** Optional async-challenge code printed in a high-contrast band. */
  challengeCode?: string;
  /**
   * Optional UI-provided map thumbnail renderer; must not load external images.
   * The sixth argument is the report's immutable owner palette.
   */
  thumbnail?:
    | ((
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        w: number,
        h: number,
        palette?: OwnerPalette
      ) => void)
    | null;
}

export interface PosterOptions {
  width?: number;
  height?: number;
  scale?: number;
}

export interface ShareCapabilities {
  platform: boolean;
  canSaveImage: boolean;
  canPostNote: boolean;
  canWriteTempFile: boolean;
}

export interface ShareService {
  capabilities(): ShareCapabilities;
  renderPoster(model: WarReportModel, options?: PosterOptions): string;
  saveImage(dataUrl: string): Promise<boolean>;
  postNote(dataUrl: string, title: string, text: string): Promise<boolean>;
}

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const RESULT_COLORS: Record<'win' | 'lose' | 'draw', string> = {
  win: '#ffcf4d',
  lose: '#ff7a7a',
  draw: '#9ad0ff',
};

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let value = text;
  while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}…`;
}

export function renderWarReport(model: WarReportModel, options?: PosterOptions): HTMLCanvasElement {
  const width = Math.max(320, Math.round((options && options.width) || 750));
  const height = Math.max(640, Math.round((options && options.height) || 1200));
  const scale = Math.max(1, options && options.scale ? options.scale : 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(scale, scale);
  const palette = createOwnerPalette(model.playerColorId);

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#0b1733');
  gradient.addColorStop(1, '#14294f');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // soft decorative bands
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  ctx.fillRect(0, height * 0.62, width, height * 0.38);
  ctx.fillStyle = 'rgba(255,207,77,0.10)';
  ctx.fillRect(0, 0, width, 8);

  const pad = 56;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e8eefc';
  ctx.font = `700 34px ${FONT_STACK}`;
  ctx.fillText('寸土必争', pad, pad + 26);

  ctx.fillStyle = 'rgba(232,238,252,0.55)';
  ctx.font = `400 20px ${FONT_STACK}`;
  ctx.fillText('离线领土策略 · 单局战报', pad, pad + 62);

  const resultColor = RESULT_COLORS[model.resultKind] || '#e8eefc';
  ctx.fillStyle = resultColor;
  ctx.font = `800 92px ${FONT_STACK}`;
  ctx.fillText(model.resultLabel, pad, pad + 190);

  ctx.fillStyle = 'rgba(232,238,252,0.72)';
  ctx.font = `500 26px ${FONT_STACK}`;
  ctx.fillText(`${model.modeLabel} · ${model.durationLabel} · ${model.difficultyLabel}`, pad, pad + 238);

  // map thumbnail panel
  const thumbX = pad;
  const thumbY = pad + 286;
  const thumbW = width - pad * 2;
  const thumbH = 280;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  roundRectPath(ctx, thumbX, thumbY, thumbW, thumbH, 24);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 2;
  ctx.stroke();
  if (model.thumbnail) {
    ctx.save();
    roundRectPath(ctx, thumbX + 12, thumbY + 12, thumbW - 24, thumbH - 24, 16);
    ctx.clip();
    try {
      model.thumbnail(ctx, thumbX + 12, thumbY + 12, thumbW - 24, thumbH - 24, palette);
    } catch {
      // thumbnail is optional decoration
    }
    ctx.restore();
  } else {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(232,238,252,0.5)';
    ctx.font = `600 30px ${FONT_STACK}`;
    ctx.fillText(model.mapName, thumbX + thumbW / 2, thumbY + thumbH / 2 + 4);
    ctx.textAlign = 'left';
  }
  // Map name badge: a dark strip keeps the label readable on the cream
  // thumbnail panel as well as on darker map art.
  ctx.font = `500 22px ${FONT_STACK}`;
  const mapLabel = fitText(ctx, model.mapName, thumbW - 44);
  const labelWidth = ctx.measureText(mapLabel).width;
  const badgeX = thumbX + 12;
  const badgeY = thumbY + thumbH - 50;
  const badgeW = Math.min(thumbW - 24, labelWidth + 28);
  const badgeH = 36;
  ctx.fillStyle = 'rgba(12, 23, 45, 0.84)';
  roundRectPath(ctx, badgeX, badgeY, badgeW, badgeH, 10);
  ctx.fill();
  ctx.fillStyle = '#e8eefc';
  ctx.fillText(mapLabel, badgeX + 14, badgeY + 25);

  // stats grid
  const statsTop = thumbY + thumbH + 84;
  const columnW = (width - pad * 2) / 2;
  // Versus has no single leaderboard: both sides are scored, so the same grid
  // prints one row per colour. Solo keeps the exact pre-versus rows.
  const versusScores =
    typeof model.opponentScore === 'number' &&
    typeof model.opponentTerritories === 'number';
  const rows: Array<[string, string]> = versusScores
    ? [
        [VERSUS_BLUE_NAME + '控地得分', String(model.score)],
        [VERSUS_BLUE_NAME + '领地', String(model.territoryCount)],
        [VERSUS_RED_NAME + '控地得分', String(model.opponentScore)],
        [VERSUS_RED_NAME + '领地', String(model.opponentTerritories)],
      ]
    : [
        ['控地得分', String(model.score)],
        ['占领数量', String(model.territoryCount)],
        ['最高控地', String(model.maxTerritories)],
        ['占领次数', String(model.captures)],
        ['实际用时', model.elapsedLabel],
        ['生成日期', model.dateLabel],
      ];
  const statsRows = Math.ceil(rows.length / 2);
  for (let i = 0; i < rows.length; i += 1) {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const x = pad + col * columnW;
    const y = statsTop + row * 108;
    ctx.fillStyle = 'rgba(232,238,252,0.5)';
    ctx.font = `400 20px ${FONT_STACK}`;
    ctx.fillText(rows[i][0], x, y);
    ctx.fillStyle = '#e8eefc';
    ctx.font = `700 38px ${FONT_STACK}`;
    ctx.fillText(fitText(ctx, rows[i][1], columnW - 24), x, y + 44);
  }

  const bandY = height - 196;
  // The last stats baseline is statsTop + (statsRows - 1)*108 + 44; keep 16px
  // clearance. A caller may request a shorter poster, in which case the band
  // is skipped rather than drawn over the stats grid (750x1200 always has room).
  if (model.challengeCode && bandY >= statsTop + (statsRows - 1) * 108 + 44 + 16) {
    // Deliberately oversized: players photograph this band or read it off the
    // screen, so the code is the most legible element of the poster.
    const bandX = pad;
    const bandW = width - pad * 2;
    const bandH = 104;
    ctx.fillStyle = 'rgba(237, 182, 78, 0.14)';
    roundRectPath(ctx, bandX, bandY, bandW, bandH, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(237, 182, 78, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = 'rgba(232,238,252,0.68)';
    ctx.font = `500 20px ${FONT_STACK}`;
    ctx.fillText('挑战码 · 同图同难度再战', bandX + 24, bandY + 32);
    ctx.fillStyle = '#ffcf4d';
    ctx.font = `800 44px ${FONT_STACK}`;
    ctx.fillText(fitText(ctx, model.challengeCode, bandW - 48), bandX + 24, bandY + 84);
  }

  ctx.fillStyle = 'rgba(232,238,252,0.38)';
  ctx.font = `400 18px ${FONT_STACK}`;
  ctx.fillText('小红书小工具 · 本地离线运行', pad, height - 42);

  return canvas;
}

function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  }
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value || '');
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

export function createShareService(miniTool?: MiniToolApi | null): ShareService {
  const api = miniTool === undefined ? getMiniTool() : miniTool;
  const canWriteTempFile = Boolean(api && typeof api.writeTempFile === 'function');

  const capabilities = (): ShareCapabilities => ({
    platform: Boolean(api),
    canSaveImage: Boolean(api && typeof api.saveImageToPhotosAlbum === 'function'),
    canPostNote: Boolean(api && typeof api.postNote === 'function'),
    canWriteTempFile,
  });

  async function toFilePath(dataUrl: string): Promise<string | null> {
    if (!api || !canWriteTempFile || typeof api.writeTempFile !== 'function') return null;
    try {
      const result = await api.writeTempFile({ data: dataUrl });
      return result && typeof result.filePath === 'string' ? result.filePath : null;
    } catch {
      return null;
    }
  }

  return {
    capabilities,

    renderPoster(model: WarReportModel, options?: PosterOptions): string {
      return canvasToDataUrl(renderWarReport(model, options));
    },

    async saveImage(dataUrl: string): Promise<boolean> {
      if (!dataUrl || !api || typeof api.saveImageToPhotosAlbum !== 'function') return false;
      const filePath = await toFilePath(dataUrl);
      try {
        await api.saveImageToPhotosAlbum({ filePath: filePath || dataUrl });
        return true;
      } catch {
        return false;
      }
    },

    async postNote(dataUrl: string, title: string, text: string): Promise<boolean> {
      if (!dataUrl || !api || typeof api.postNote !== 'function') return false;
      const filePath = await toFilePath(dataUrl);
      try {
        await api.postNote({
          title: truncate(title, 20),
          content: truncate(text, 1000),
          pageType: 'photo_publish',
          mediaInfo: { image_resources: [{ url: filePath || dataUrl }] },
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
