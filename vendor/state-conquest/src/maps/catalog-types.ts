import type { MatchState } from '../core/types';
import type { MapGeographyBrief } from './types';

export interface MapVariantInfo {
  id: string;
  themeId: string;
  mapId: string;
  name: string;
  subtitle: string;
  description: string;
  size: number;
  durationSeconds: number;
  durationLabel: string;
  territoryCount: number;
  edgeCount: number;
  bridgeCount: number;
  mountainCount: number;
  features: string[];
  selectable: boolean;
  /** Readable geography summary for selection/report cards. */
  geog?: MapGeographyBrief;
}

export interface MapThemeInfo {
  themeId: string;
  name: string;
  subtitle: string;
  description: string;
  features: string[];
  sizes: number[];
  durations: number[];
}

export interface MapCatalog {
  themes: MapThemeInfo[];
  variants: MapVariantInfo[];
  /** Number of generated atlas maps selectable through the seeded library. */
  libraryCount?: number;
}

export interface MapResolution {
  mapId: string;
  variantId: string;
  themeId: string;
  durationSeconds: number;
  size: number;
}

export interface MatchMetadata {
  themeId: string;
  themeName: string;
  variantSize: number;
  durationSeconds: number;
  description: string;
  features: string[];
  layout?: MatchState['layout'];
}
