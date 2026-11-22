/**
 * The owner palette shared by every canvas based rendering pass.
 *
 * A palette is created per match/render owner and is immutable after creation.
 * The exported defaults remain the legacy blue mapping for callers that do not
 * yet provide a palette, but no rendering code mutates those defaults.
 */
import type { OwnerId } from '../ui/view-model';
import { playerColorOption } from '../ui/player-colors';
import type { PlayerColorId } from '../ui/player-colors';

export interface OwnerStyle {
  readonly fill: string;
  readonly edge: string;
  readonly badge: string;
}

/**
 * A muted version of each owner colour, used where a mark must sit on top of
 * an opaque owner fill and stay readable in both zoom levels.
 */
export interface OwnerAccent {
  /** Bright line/dot colour for a lane or impact marker. */
  readonly ink: string;
  /** Darker companion for outlines/shadow. */
  readonly deep: string;
  /** Cream-free light fill for chips on dark backgrounds. */
  readonly soft: string;
}

export interface OwnerPalette {
  readonly style: Readonly<Record<OwnerId, OwnerStyle>>;
  readonly accent: Readonly<Record<OwnerId, OwnerAccent>>;
}

const DEFAULT_PLAYER = playerColorOption('blue');

function freezeStyle(style: OwnerStyle): OwnerStyle {
  return Object.freeze(style);
}

function freezeAccent(accent: OwnerAccent): OwnerAccent {
  return Object.freeze(accent);
}

export const OWNER_STYLE: Readonly<Record<OwnerId, OwnerStyle>> = Object.freeze({
  player: freezeStyle({
    fill: DEFAULT_PLAYER.fill,
    edge: DEFAULT_PLAYER.edge,
    badge: DEFAULT_PLAYER.badge,
  }),
  ai1: freezeStyle({ fill: '#C95843', edge: '#7C3024', badge: '#B14834' }),
  ai2: freezeStyle({ fill: '#C5833E', edge: '#7F5224', badge: '#AF7132' }),
  // v1.4 four-way purple faction; muted to sit next to the existing three.
  ai3: freezeStyle({ fill: '#7A5FA0', edge: '#4A3A66', badge: '#68518A' }),
  neutral: freezeStyle({ fill: '#D9D0BE', edge: '#8B7F6B', badge: '#B8AD98' }),
});

export const OWNER_ACCENT: Readonly<Record<OwnerId, OwnerAccent>> = Object.freeze({
  player: freezeAccent({
    ink: DEFAULT_PLAYER.ink,
    deep: DEFAULT_PLAYER.deep,
    soft: DEFAULT_PLAYER.soft,
  }),
  ai1: freezeAccent({ ink: '#D9755F', deep: '#7C3024', soft: '#F5DED8' }),
  ai2: freezeAccent({ ink: '#D9A05B', deep: '#7F5224', soft: '#F6E8D3' }),
  ai3: freezeAccent({ ink: '#9B7FC4', deep: '#4A3A66', soft: '#E9E0F2' }),
  neutral: freezeAccent({ ink: '#9A8E7C', deep: '#6B6154', soft: '#EFE9DD' }),
});

/** Creates a frozen full palette for one match/render pass. */
export function createOwnerPalette(
  colorId?: PlayerColorId | string | null
): OwnerPalette {
  const option = playerColorOption(colorId);
  const style: Record<OwnerId, OwnerStyle> = {
    player: freezeStyle({ fill: option.fill, edge: option.edge, badge: option.badge }),
    ai1: freezeStyle({ ...OWNER_STYLE.ai1 }),
    ai2: freezeStyle({ ...OWNER_STYLE.ai2 }),
    ai3: freezeStyle({ ...OWNER_STYLE.ai3 }),
    neutral: freezeStyle({ ...OWNER_STYLE.neutral }),
  };
  const accent: Record<OwnerId, OwnerAccent> = {
    player: freezeAccent({ ink: option.ink, deep: option.deep, soft: option.soft }),
    ai1: freezeAccent({ ...OWNER_ACCENT.ai1 }),
    ai2: freezeAccent({ ...OWNER_ACCENT.ai2 }),
    ai3: freezeAccent({ ...OWNER_ACCENT.ai3 }),
    neutral: freezeAccent({ ...OWNER_ACCENT.neutral }),
  };
  return Object.freeze({
    style: Object.freeze(style),
    accent: Object.freeze(accent),
  });
}

/** Owner-safe lookup: an unknown/absent id falls back to the neutral accent. */
export function ownerAccent(
  owner: string | null | undefined,
  palette?: OwnerPalette
): OwnerAccent {
  if (
    owner === 'player' ||
    owner === 'ai1' ||
    owner === 'ai2' ||
    owner === 'ai3' ||
    owner === 'neutral'
  ) {
    return palette ? palette.accent[owner] : OWNER_ACCENT[owner];
  }
  return palette ? palette.accent.neutral : OWNER_ACCENT.neutral;
}

/** Owner-safe badge lookup used by army chips and front end caps. */
export function ownerStyle(
  owner: string | null | undefined,
  palette?: OwnerPalette
): OwnerStyle {
  if (
    owner === 'player' ||
    owner === 'ai1' ||
    owner === 'ai2' ||
    owner === 'ai3' ||
    owner === 'neutral'
  ) {
    return palette ? palette.style[owner] : OWNER_STYLE[owner];
  }
  return palette ? palette.style.neutral : OWNER_STYLE.neutral;
}
