/**
 * Window / safe-area adapter.
 * Prefers getWindowInfo (client 9.49+). Falls back to container-injected CSS
 * variables (PC simulator) and env() values (real device), then zeros.
 */
import { getMiniTool, readBuildVersion, isClientVersionAtLeast, FILE_SYSTEM_MIN_CLIENT_VERSION } from './xhs';
import type { WindowInfo, WindowRect } from './xhs';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MenuButtons {
  back: WindowRect | null;
  me: WindowRect | null;
  share: WindowRect | null;
}

export interface WindowLayout {
  source: 'getWindowInfo' | 'css';
  windowWidth: number;
  windowHeight: number;
  safeArea: Insets;
  menuButtons: MenuButtons;
}

const ZERO_BUTTONS: MenuButtons = { back: null, me: null, share: null };

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readCssPx(name: string): number {
  if (typeof document === 'undefined' || typeof window === 'undefined') return 0;
  try {
    const raw = window.getComputedStyle(document.documentElement).getPropertyValue(name);
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function readCssInsets(): Insets {
  return {
    top: readCssPx('--safe-area-inset-top'),
    right: readCssPx('--safe-area-inset-right'),
    bottom: readCssPx('--safe-area-inset-bottom'),
    left: readCssPx('--safe-area-inset-left'),
  };
}

function normalizeButtons(info: WindowInfo): MenuButtons {
  const buttons = info && info.menuButtons;
  if (!buttons) return ZERO_BUTTONS;
  return {
    back: buttons.back || null,
    me: buttons.me || null,
    share: buttons.share || null,
  };
}

export async function readWindowLayout(): Promise<WindowLayout> {
  const miniTool = getMiniTool();
  const hasMethod = Boolean(miniTool && typeof miniTool.getWindowInfo === 'function');
  if (hasMethod && miniTool && typeof miniTool.getWindowInfo === 'function') {
    const buildVersion = await readBuildVersion();
    if (buildVersion > 0 && isClientVersionAtLeast(buildVersion, FILE_SYSTEM_MIN_CLIENT_VERSION)) {
      try {
        const info = await miniTool.getWindowInfo();
        if (info && finite(info.windowWidth) !== null && finite(info.windowHeight) !== null) {
          const width = Number(info.windowWidth);
          const height = Number(info.windowHeight);
          const rect = info.safeArea;
          const safeArea: Insets = rect
            ? {
              top: finite(rect.top) || 0,
              right: Math.max(0, width - (finite(rect.right) || width)),
              bottom: Math.max(0, height - (finite(rect.bottom) || height)),
              left: finite(rect.left) || 0,
            }
            : { top: 0, right: 0, bottom: 0, left: 0 };
          return {
            source: 'getWindowInfo',
            windowWidth: width,
            windowHeight: height,
            safeArea,
            menuButtons: normalizeButtons(info),
          };
        }
      } catch {
        // fall through to CSS values
      }
    }
  }

  let width = 0;
  let height = 0;
  if (typeof window !== 'undefined') {
    width = window.innerWidth || 0;
    height = window.innerHeight || 0;
  }
  return {
    source: 'css',
    windowWidth: width,
    windowHeight: height,
    safeArea: readCssInsets(),
    menuButtons: ZERO_BUTTONS,
  };
}

/** Writes --sc-safe-* and --sc-window-height so CSS can opt in to exact insets. */
export async function applySafeAreaCssVars(layout?: WindowLayout): Promise<WindowLayout> {
  const value = layout || await readWindowLayout();
  if (typeof document !== 'undefined') {
    const style = document.documentElement.style;
    style.setProperty('--sc-safe-top', `${value.safeArea.top}px`);
    style.setProperty('--sc-safe-right', `${value.safeArea.right}px`);
    style.setProperty('--sc-safe-bottom', `${value.safeArea.bottom}px`);
    style.setProperty('--sc-safe-left', `${value.safeArea.left}px`);
    style.setProperty('--sc-window-height', `${value.windowHeight}px`);
    style.setProperty('--sc-window-width', `${value.windowWidth}px`);
  }
  return value;
}
