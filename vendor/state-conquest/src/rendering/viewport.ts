export interface Viewport {
  width: number;
  height: number;
  mapWidth: number;
  mapHeight: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  padding: number;
  /** Applied camera; always 1/0 on the unzoomed fit viewport. */
  zoom?: number;
  panX?: number;
  panY?: number;
}

export interface CameraState {
  zoom: number;
  panX: number;
  panY: number;
}

export const DEFAULT_CAMERA: CameraState = { zoom: 1, panX: 0, panY: 0 };

export const MIN_CAMERA_ZOOM = 1;
export const MAX_CAMERA_ZOOM = 3.2;

/**
 * Fits the logical map into the CSS-pixel canvas area. Rendering and hit-testing
 * both consume this object so a resize can never leave them with different math.
 */
export function computeViewport(
  width: number,
  height: number,
  mapWidth: number,
  mapHeight: number,
  padding: number
): Viewport {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const safeMapWidth = Math.max(1, mapWidth);
  const safeMapHeight = Math.max(1, mapHeight);
  const pad = Math.max(0, padding);
  const availableWidth = Math.max(1, safeWidth - pad * 2);
  const availableHeight = Math.max(1, safeHeight - pad * 2);
  const scale = Math.min(availableWidth / safeMapWidth, availableHeight / safeMapHeight);

  return {
    width: safeWidth,
    height: safeHeight,
    mapWidth: safeMapWidth,
    mapHeight: safeMapHeight,
    scale: scale,
    offsetX: (safeWidth - safeMapWidth * scale) / 2,
    offsetY: (safeHeight - safeMapHeight * scale) / 2,
    padding: pad,
  };
}

export function mapToScreen(viewport: Viewport, x: number, y: number): [number, number] {
  return [viewport.offsetX + x * viewport.scale, viewport.offsetY + y * viewport.scale];
}

export function screenToMap(viewport: Viewport, x: number, y: number): [number, number] {
  return [(x - viewport.offsetX) / viewport.scale, (y - viewport.offsetY) / viewport.scale];
}

/**
 * Applies an optional camera to the fitted viewport. Zoom keeps map units
 * uniform (never stretches), and pan is clamped so the map cannot be dragged
 * completely out of the battlefield.
 */
export function applyCamera(base: Viewport, camera: CameraState): Viewport {
  const zoom = Math.max(MIN_CAMERA_ZOOM, Math.min(MAX_CAMERA_ZOOM, camera.zoom || 1));
  const scale = base.scale * zoom;
  const scaledWidth = base.mapWidth * scale;
  const scaledHeight = base.mapHeight * scale;
  const pad = base.padding;

  let offsetX = base.offsetX + (camera.panX || 0);
  let offsetY = base.offsetY + (camera.panY || 0);

  if (scaledWidth <= base.width - pad * 2) {
    offsetX = (base.width - scaledWidth) / 2;
  } else {
    offsetX = Math.max(base.width - scaledWidth - pad, Math.min(pad, offsetX));
  }
  if (scaledHeight <= base.height - pad * 2) {
    offsetY = (base.height - scaledHeight) / 2;
  } else {
    offsetY = Math.max(base.height - scaledHeight - pad, Math.min(pad, offsetY));
  }

  return {
    width: base.width,
    height: base.height,
    mapWidth: base.mapWidth,
    mapHeight: base.mapHeight,
    scale: scale,
    offsetX: offsetX,
    offsetY: offsetY,
    padding: base.padding,
    zoom: zoom,
    panX: offsetX - base.offsetX,
    panY: offsetY - base.offsetY,
  };
}

/** Zooms around a CSS-pixel focus while preserving the world point below it. */
export function zoomCameraAt(
  base: Viewport,
  camera: CameraState,
  factor: number,
  focusX: number,
  focusY: number
): CameraState {
  const current = applyCamera(base, camera);
  const world = screenToMap(current, focusX, focusY);
  const nextZoom = Math.max(
    MIN_CAMERA_ZOOM,
    Math.min(MAX_CAMERA_ZOOM, current.zoom ? current.zoom * factor : factor)
  );
  const nextScale = base.scale * nextZoom;
  const desiredOffsetX = focusX - world[0] * nextScale;
  const desiredOffsetY = focusY - world[1] * nextScale;
  return {
    zoom: nextZoom,
    panX: desiredOffsetX - base.offsetX,
    panY: desiredOffsetY - base.offsetY,
  };
}

export function panCamera(
  base: Viewport,
  camera: CameraState,
  dx: number,
  dy: number
): CameraState {
  if (camera.zoom <= 1.001) return DEFAULT_CAMERA;
  const applied = applyCamera(base, camera);
  return {
    zoom: camera.zoom,
    panX: (applied.panX || 0) + dx,
    panY: (applied.panY || 0) + dy,
  };
}

export function viewportSignature(viewport: Viewport): string {
  return (
    viewport.width.toFixed(1) +
    'x' +
    viewport.height.toFixed(1) +
    '@' +
    viewport.scale.toFixed(4) +
    ',' +
    viewport.offsetX.toFixed(2) +
    ',' +
    viewport.offsetY.toFixed(2) +
    '@' +
    (viewport.zoom || 1).toFixed(3) +
    ',' +
    (viewport.panX || 0).toFixed(2) +
    ',' +
    (viewport.panY || 0).toFixed(2)
  );
}

export function clampDpr(value: number): number {
  if (!isFinite(value) || value <= 0) return 1;
  return Math.min(2, Math.max(1, value));
}
