import { el } from './dom';
import { DEFAULT_AVATAR_ID, avatarById } from './profile-store';

/**
 * Preset commander avatar: one CSS colour class + one glyph. No images, so the
 * whole set is CSP-safe and ships inside the bundle.
 */
export function avatarNode(avatarId: string, sizeClass: string): HTMLElement {
  const avatar = avatarById(avatarId) || avatarById(DEFAULT_AVATAR_ID) || {
    id: DEFAULT_AVATAR_ID,
    name: '',
    glyph: '',
  };
  const node = el('span', 'avatar avatar-' + avatar.id + ' ' + sizeClass);
  node.setAttribute('aria-hidden', 'true');
  node.appendChild(el('span', 'avatar-glyph', avatar.glyph));
  return node;
}
