/**
 * Single entry point for UI code. Everything is optional at runtime: without
 * window.xhs the game still runs, settings fall back to session memory, and
 * share/save capabilities are false so the UI can hide/disable those actions.
 */
import { getMiniTool, readBuildVersionSync } from './xhs';
import type { MiniToolApi, StorageInfo } from './xhs';
import { createStorage } from './storage';
import type { KeyValueStore } from './storage';
import { readWindowLayout, applySafeAreaCssVars } from './layout';
import type { WindowLayout } from './layout';
import { bindVisibility, isDocumentHidden } from './lifecycle';
import type { LifecycleHandlers } from './lifecycle';
import { createShareService } from './share';
import type { ShareService, WarReportModel, PosterOptions } from './share';
import { createAuthorService } from './author';
import type { AuthorService } from './author';

export interface PlatformAdapter {
  readonly isXhs: boolean;
  readonly ready: () => Promise<boolean>;
  readonly storage: KeyValueStore;
  readonly share: ShareService;
  readonly author: AuthorService;
  readonly layout: {
    read(): Promise<WindowLayout>;
    applyCssVars(layout?: WindowLayout): Promise<WindowLayout>;
  };
  readonly lifecycle: {
    bind(handlers: LifecycleHandlers): () => void;
    hidden(): boolean;
  };
}

export function createPlatformAdapter(miniTool?: MiniToolApi | null): PlatformAdapter {
  const api = miniTool === undefined ? getMiniTool() : miniTool;
  const storage = createStorage(api || null);
  const share = createShareService(api || null);
  // The sync launch option is the normal source; the service falls back to the
  // async getLaunchOptions call only when this value is missing.
  const author = createAuthorService(api || null, readBuildVersionSync());
  return {
    isXhs: Boolean(api),
    ready: () => storage.ready(),
    storage,
    share,
    author,
    layout: {
      read: readWindowLayout,
      applyCssVars: applySafeAreaCssVars,
    },
    lifecycle: {
      bind: bindVisibility,
      hidden: isDocumentHidden,
    },
  };
}

export { getMiniTool, readBuildVersion, isClientVersionAtLeast } from './xhs';
export { createAuthorService, authorAvailabilityMessage, AUTHOR_MIN_CLIENT_VERSION, FOLLOW_STATUS } from './author';
export type {
  AuthorService,
  AuthorAvailability,
  AuthorAvailabilityReason,
  AuthorFollowState,
  AuthorStatusResult,
  AuthorStatusFailure,
  AuthorFollowResult,
  AuthorFollowFailure,
} from './author';
export type { MiniToolApi, StorageInfo, WindowLayout, KeyValueStore, ShareService, WarReportModel, PosterOptions, LifecycleHandlers };
