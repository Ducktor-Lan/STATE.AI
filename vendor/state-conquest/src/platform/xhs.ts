/**
 * Minimal, accurate typings for the container-injected `window.xhs` SDK.
 * The SDK is never bundled; it is injected by the Xiaohongshu container.
 */

export interface LaunchOptions {
  miniToolEnv?: {
    userDataPath?: string;
    buildVersion?: number | string;
  };
}

export interface WindowRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  pixelRatio: number;
  screenWidth: number;
  screenHeight: number;
  windowWidth: number;
  windowHeight: number;
  statusBarHeight: number;
  screenTop: number;
  safeArea: WindowRect;
  menuButtons: {
    back: WindowRect | null;
    me: WindowRect | null;
    share: WindowRect | null;
  };
}

export interface StorageInfo {
  keys: string[];
  usedBytes: number;
  limitBytes: number;
}

/**
 * 9.51+ author follow APIs. Neither takes business parameters: the author is
 * always the publisher of the current minitool. Called without callbacks they
 * return a Promise; a failed follow may reject with errCode 20002/15404/10003,
 * while a failed status query resolves with follow_status -1.
 */
export type FollowStatusValue = -1 | 0 | 1 | 2;

export interface FollowApiResult {
  errMsg: string;
  follow_status: FollowStatusValue;
}

export interface PostNoteOptions {
  title?: string;
  content?: string;
  pageType?: 'video_publish' | 'photo_publish' | 'slides_edit';
  mediaInfo: {
    image_resources?: Array<{ url: string }>;
    video_resources?: { video_url: string; cover_url?: string };
    live_photo_sources?: Array<{ url: string; video_url: string }>;
  };
}

/** Only the methods this project uses are typed; all are optional. */
export interface MiniToolApi {
  getLaunchOptions?: () => Promise<LaunchOptions>;
  getWindowInfo?: () => Promise<WindowInfo>;
  writeTempFile?: (options: { data: string }) => Promise<{ filePath: string }>;
  saveImageToPhotosAlbum?: (options: { filePath: string }) => Promise<unknown>;
  postNote?: (options: PostNoteOptions) => Promise<unknown>;
  setStorage?: (options: { key: string; data: string; encrypt?: boolean }) => Promise<unknown>;
  getStorage?: (options: { key: string; encrypt?: boolean }) => Promise<{ data: string | null }>;
  getStorageInfo?: () => Promise<StorageInfo>;
  removeStorage?: (options: { key: string }) => Promise<unknown>;
  clearStorage?: () => Promise<unknown>;
  getFollowStatus?: () => Promise<FollowApiResult>;
  followAuthor?: () => Promise<FollowApiResult>;
}

export interface XhsRoot {
  miniTool?: MiniToolApi;
  launchOptions?: LaunchOptions;
}

function readRoot(): XhsRoot | null {
  if (typeof window === 'undefined') return null;
  const host = window as unknown as { xhs?: XhsRoot };
  const xhs = host.xhs;
  return xhs && typeof xhs === 'object' ? xhs : null;
}

export function getXhs(): XhsRoot | null {
  return readRoot();
}

export function getMiniTool(): MiniToolApi | null {
  const xhs = readRoot();
  const miniTool = xhs && xhs.miniTool;
  return miniTool && typeof miniTool === 'object' ? miniTool : null;
}

export function readBuildVersionFrom(launchOptions: LaunchOptions | null | undefined): number {
  const env = launchOptions && launchOptions.miniToolEnv;
  const value = Number(env && env.buildVersion);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function readBuildVersionSync(): number {
  const xhs = readRoot();
  return readBuildVersionFrom(xhs && xhs.launchOptions);
}

export async function readBuildVersion(): Promise<number> {
  const syncValue = readBuildVersionSync();
  if (syncValue) return syncValue;
  const miniTool = getMiniTool();
  if (!miniTool || typeof miniTool.getLaunchOptions !== 'function') return 0;
  try {
    return readBuildVersionFrom(await miniTool.getLaunchOptions());
  } catch {
    return 0;
  }
}

/** buildVersion's last three digits are a build sequence; 9462004 -> 9462. */
export function clientVersion(buildVersion: number): number {
  return Math.floor((Number(buildVersion) || 0) / 1000);
}

export function isClientVersionAtLeast(buildVersion: number, minimumClientVersion: number): boolean {
  return clientVersion(buildVersion) >= minimumClientVersion;
}

export const STORAGE_MIN_CLIENT_VERSION = 9460;
export const FILE_SYSTEM_MIN_CLIENT_VERSION = 9490;
export const FOLLOW_AUTHOR_MIN_CLIENT_VERSION = 9510;
