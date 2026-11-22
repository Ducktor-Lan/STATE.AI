import { button, el } from './dom';
import { createOverlay } from './overlay';

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function createConfirmOverlay(options: ConfirmOptions): HTMLElement {
  const parts = createOverlay('confirm-overlay');
  parts.card.className = 'overlay-card overlay-card-compact';
  parts.card.setAttribute('role', 'alertdialog');
  parts.card.setAttribute('aria-modal', 'true');
  parts.card.setAttribute('aria-labelledby', 'confirm-title');
  parts.card.setAttribute('aria-describedby', 'confirm-body');

  const title = el('h2', 'overlay-title confirm-title', options.title);
  title.id = 'confirm-title';
  const body = el('p', 'confirm-body', options.body);
  body.id = 'confirm-body';

  const actions = el('div', 'confirm-actions');
  const cancel = button(
    options.cancelLabel || '取消',
    'btn btn-secondary confirm-cancel',
    options.onCancel
  );
  const confirm = button(
    options.confirmLabel,
    'btn ' + (options.danger ? 'btn-danger' : 'btn-primary') + ' confirm-ok',
    options.onConfirm
  );
  actions.appendChild(cancel);
  actions.appendChild(confirm);

  // Long bodies (reset scope, quit copy) must scroll instead of pushing the
  // action row out of the 88%-height card on short viewports. The scroll
  // region is text-only; confirm-actions stays pinned below it. Author
  // overlay shares .overlay-card-compact but not this wrapper, so its layout
  // is untouched.
  const scroll = el('div', 'confirm-scroll');
  scroll.appendChild(el('p', 'overlay-kicker', 'PLEASE CONFIRM'));
  scroll.appendChild(title);
  scroll.appendChild(body);

  parts.card.appendChild(scroll);
  parts.card.appendChild(actions);
  return parts.root;
}
