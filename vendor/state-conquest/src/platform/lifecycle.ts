/**
 * Visibility lifecycle. Game time must not advance while the container is
 * hidden; the shell pauses the match and waits for an explicit resume.
 */
export interface LifecycleHandlers {
  onHidden?: () => void;
  onVisible?: () => void;
}

export function isDocumentHidden(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'hidden' || document.hidden === true;
}

export function bindVisibility(handlers: LifecycleHandlers): () => void {
  if (typeof document === 'undefined') return () => undefined;
  let lastHidden = isDocumentHidden();
  const handle = () => {
    const hidden = isDocumentHidden();
    if (hidden === lastHidden) return;
    lastHidden = hidden;
    if (hidden) {
      if (handlers.onHidden) handlers.onHidden();
    } else if (handlers.onVisible) {
      handlers.onVisible();
    }
  };
  document.addEventListener('visibilitychange', handle);
  return () => document.removeEventListener('visibilitychange', handle);
}
