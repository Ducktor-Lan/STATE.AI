import type { GameMapDefinition } from '../game-api';
import type { MatchView, OwnerId } from '../ui/view-model';
import type { PlayerColorId } from '../ui/player-colors';
import { createOwnerPalette, ownerStyle } from './owner-palette';
import type { OwnerPalette } from './owner-palette';
import type { Point } from './geometry';

export interface ThumbnailOptions {
  /** Optional swatch id; invalid or absent values use the legacy blue default. */
  playerColorId?: PlayerColorId | string | null;
  /** Reuse the exact palette already owned by a match or poster renderer. */
  palette?: OwnerPalette;
}

type ThumbnailPaletteInput =
  | ThumbnailOptions
  | OwnerPalette
  | PlayerColorId
  | string
  | null
  | undefined;

function isOwnerPalette(value: unknown): value is OwnerPalette {
  return Boolean(value && typeof value === 'object' && 'style' in value && 'accent' in value);
}

function resolvePalette(input: ThumbnailPaletteInput): OwnerPalette {
  if (isOwnerPalette(input)) return input;
  if (input && typeof input === 'object') {
    return input.palette || createOwnerPalette(input.playerColorId);
  }
  return createOwnerPalette(input);
}

interface ThumbTerritory {
  id: string;
  owner: OwnerId;
  polygon: Array<[number, number]>;
  center: [number, number];
  shortName?: string;
  name?: string;
  labelAnchor?: [number, number];
  troops?: number;
}

interface ThumbBoundary {
  from: string;
  to: string;
  points: Array<[number, number]>;
  kind: 'open' | 'river' | 'ridge';
  passable: boolean;
}

function paintGeometry(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  mapWidth: number,
  mapHeight: number,
  territories: ThumbTerritory[],
  boundaries: ThumbBoundary[],
  palette: OwnerPalette
): void {
  const scale = Math.min(width / Math.max(1, mapWidth), height / Math.max(1, mapHeight));
  const offsetX = x + (width - mapWidth * scale) / 2;
  const offsetY = y + (height - mapHeight * scale) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();

  ctx.fillStyle = '#DCE7E4';
  ctx.fillRect(x, y, width, height);

  const land = new Path2D();
  const screenPolygons: Array<{ territory: ThumbTerritory; path: Path2D; points: Point[] }> = [];
  for (let i = 0; i < territories.length; i += 1) {
    const territory = territories[i];
    const path = new Path2D();
    const points: Point[] = [];
    for (let p = 0; p < territory.polygon.length; p += 1) {
      const px = offsetX + territory.polygon[p][0] * scale;
      const py = offsetY + territory.polygon[p][1] * scale;
      points.push([px, py]);
      if (p === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    }
    path.closePath();
    land.addPath(path);
    screenPolygons.push({ territory: territory, path: path, points: points });
  }

  ctx.fillStyle = '#EDE4D1';
  ctx.fill(land);

  for (let i = 0; i < screenPolygons.length; i += 1) {
    const item = screenPolygons[i];
    ctx.fillStyle = ownerStyle(item.territory.owner, palette).fill;
    ctx.fill(item.path);
  }

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < screenPolygons.length; i += 1) {
    const item = screenPolygons[i];
    ctx.strokeStyle = 'rgba(251, 245, 233, 0.72)';
    ctx.lineWidth = Math.max(0.6, scale * 2.4);
    ctx.stroke(item.path);
  }

  for (let i = 0; i < boundaries.length; i += 1) {
    const boundary = boundaries[i];
    if (boundary.points.length < 2) continue;
    ctx.beginPath();
    for (let p = 0; p < boundary.points.length; p += 1) {
      const px = offsetX + boundary.points[p][0] * scale;
      const py = offsetY + boundary.points[p][1] * scale;
      if (p === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    if (boundary.kind === 'river') {
      ctx.strokeStyle = 'rgba(63, 103, 123, 0.72)';
      ctx.lineWidth = Math.max(0.8, scale * 4.5);
    } else if (boundary.kind === 'ridge') {
      ctx.strokeStyle = 'rgba(75, 63, 48, 0.66)';
      ctx.lineWidth = Math.max(0.8, scale * 3.4);
    } else {
      ctx.strokeStyle = 'rgba(23, 43, 68, 0.5)';
      ctx.lineWidth = Math.max(0.5, scale * 1.4);
    }
    ctx.stroke();
  }

  // Thumbnails deliberately show ownership colours only. Battlefield labels
  // carry the mandatory current/capacity pair; squeezing digits here would
  // either drop the capacity or become unreadable.
  ctx.restore();
}

export function paintMapThumbnail(
  view: MatchView,
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  paletteInput?: ThumbnailPaletteInput
): void {
  const palette = resolvePalette(paletteInput);
  const territories: ThumbTerritory[] = [];
  for (let i = 0; i < view.territories.length; i += 1) {
    const territory = view.territories[i];
    territories.push({
      id: territory.id,
      owner: territory.owner,
      polygon: territory.polygon,
      center: territory.center,
      shortName: territory.shortName,
      name: territory.name,
      labelAnchor: territory.labelAnchor,
      troops: territory.troops,
    });
  }
  const boundaries: ThumbBoundary[] = [];
  if (view.boundaries) {
    for (let i = 0; i < view.boundaries.length; i += 1) {
      boundaries.push(view.boundaries[i]);
    }
  }
  paintGeometry(
    ctx,
    x,
    y,
    width,
    height,
    view.mapWidth,
    view.mapHeight,
    territories,
    boundaries,
    palette
  );
}

/** Selection-card preview: identical geometry path to the battlefield/poster. */
export function paintMapDefinitionThumbnail(
  map: GameMapDefinition,
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  paletteInput?: ThumbnailPaletteInput
): void {
  const palette = resolvePalette(paletteInput);
  const territories: ThumbTerritory[] = [];
  for (let i = 0; i < map.territories.length; i += 1) {
    const territory = map.territories[i];
    territories.push({
      id: territory.id,
      owner: territory.owner,
      polygon: territory.polygon,
      center: territory.center,
      shortName: territory.shortName,
      name: territory.name,
      labelAnchor: territory.labelAnchor,
    });
  }
  const boundaries: ThumbBoundary[] = [];
  if (map.layout && map.layout.boundaries) {
    for (let i = 0; i < map.layout.boundaries.length; i += 1) {
      boundaries.push(map.layout.boundaries[i]);
    }
  }
  paintGeometry(
    ctx,
    x,
    y,
    width,
    height,
    map.width,
    map.height,
    territories,
    boundaries,
    palette
  );
}
