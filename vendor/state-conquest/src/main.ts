import './styles/main.css';
import { App } from './ui/app-shell';

declare const __DEV__: boolean;

function boot(): void {
  const root = document.getElementById('app');
  if (!root) return;

  let devSeed: number | undefined;
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // Dev build only: a deterministic seed lets the assembly smoke test drive
    // real matches to win/lose/timeout. Stripped from production bundles.
    const raw = (window as unknown as { __CONQUEST_DEV_SEED__?: unknown })
      .__CONQUEST_DEV_SEED__;
    const parsed = Number(raw);
    if (isFinite(parsed) && parsed > 0) devSeed = parsed;
  }

  const app = new App(root, devSeed);
  app.init();

  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    (window as unknown as { __CONQUEST__?: unknown }).__CONQUEST__ = app.devApi();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
