import { el } from './dom';

export interface OverlayParts {
  root: HTMLElement;
  card: HTMLElement;
  body: HTMLElement;
}

export function createOverlay(className: string): OverlayParts {
  const root = el('div', 'overlay ' + className);
  const card = el('div', 'overlay-card');
  root.appendChild(card);
  return { root: root, card: card, body: card };
}
