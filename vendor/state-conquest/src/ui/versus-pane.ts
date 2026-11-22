import type { CameraState } from '../rendering/viewport';
import { VERSUS_BLUE_NAME, VERSUS_RED_NAME } from '../config/balance';
import { button, el, setText } from './dom';

export type VersusSide = 'player' | 'ai1';
export type VersusPaneOrientation = 'portrait' | 'landscape';
export type VersusPaneRotation = 0 | 180;

export interface VersusPaneInfo {
  score: number;
  land: number;
  force: number;
  selection: string;
  troops: string;
  charge: string;
}

export interface VersusPaneOptions {
  side: VersusSide;
  /** 180 mirrors the whole pane for the top/right red player. */
  rotation?: VersusPaneRotation;
  /** Extra canvas description; the side name is appended. */
  canvasLabel?: string;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
}

export interface VersusPaneSet {
  blue: VersusPane;
  red: VersusPane;
}

/**
 * Portrait keeps red on top and blue below; landscape puts blue left and red
 * right. The approved split therefore only flips the flex main axis.
 */
export function versusPaneOrientation(
  width: number,
  height: number
): VersusPaneOrientation {
  return width > height ? 'landscape' : 'portrait';
}

function noop(): void {
  // Zoom controls stay present before the App wires a camera.
}

function zoomText(zoom: number): string {
  const value = isFinite(zoom) && zoom > 0 ? zoom : 1;
  return '×' + value.toFixed(1);
}

/**
 * One half of a local-versus battlefield. It owns DOM only: both panes are fed
 * by the same engine/view, and the App keeps one renderer per canvas. Each
 * pane carries its own selection/troop/charge strip and camera controls, so
 * neither side depends on the old shared blue action panel.
 */
export class VersusPane {
  readonly el: HTMLElement;
  readonly frame: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly side: VersusSide;
  /** Live rotation; portrait red flips, landscape leaves both upright. */
  rotation: VersusPaneRotation;
  readonly zoomLabel: HTMLElement;
  readonly resetButton: HTMLButtonElement;
  private readonly name: string;
  private readonly score: HTMLElement;
  private readonly source: HTMLElement;
  private readonly troops: HTMLElement;
  private readonly charge: HTMLElement;
  private infoSignature = '';
  private cameraSignature = '';

  constructor(options: VersusPaneOptions) {
    const side = options.side;
    const rotation: VersusPaneRotation = options.rotation === 180 ? 180 : 0;
    const sideName = side === 'player' ? VERSUS_BLUE_NAME : VERSUS_RED_NAME;
    const tone = side === 'player' ? 'blue' : 'red';

    this.side = side;
    this.rotation = 0;

    const root = el('section', 'versus-pane versus-pane-' + tone);
    root.setAttribute('data-side', side);
    root.setAttribute('aria-label', sideName + '战场');

    const frame = el('div', 'versus-pane-frame');

    const canvas = el('canvas', 'battle-canvas versus-canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      (options.canvasLabel || '领土战场地图') + ' · ' + sideName
    );
    canvas.appendChild(
      document.createTextNode('当前浏览器不支持 Canvas，无法显示战场地图。')
    );

    const hud = el('div', 'versus-pane-hud');
    const head = el('div', 'versus-pane-head');
    const name = el('b', 'versus-pane-name', sideName);
    const score = el('span', 'versus-pane-score', '0 分 · 0 地 · 兵 0');
    const zoomLabel = el('span', 'versus-pane-zoom-level', zoomText(1));
    const controls = el('span', 'versus-pane-zoom');

    const zoomOut = button('−', 'versus-pane-zoom-btn', options.onZoomOut || noop);
    zoomOut.setAttribute('data-action', 'zoom-out');
    zoomOut.setAttribute('aria-label', sideName + '缩小地图');
    const zoomIn = button('+', 'versus-pane-zoom-btn', options.onZoomIn || noop);
    zoomIn.setAttribute('data-action', 'zoom-in');
    zoomIn.setAttribute('aria-label', sideName + '放大地图');
    const zoomReset = button(
      '复位',
      'versus-pane-zoom-btn versus-pane-zoom-reset',
      options.onZoomReset || noop
    );
    zoomReset.setAttribute('data-action', 'zoom-reset');
    zoomReset.setAttribute('aria-label', sideName + '地图恢复全图');
    zoomReset.disabled = true;
    controls.appendChild(zoomOut);
    controls.appendChild(zoomIn);
    controls.appendChild(zoomReset);

    head.appendChild(name);
    head.appendChild(score);
    head.appendChild(zoomLabel);
    head.appendChild(controls);

    const selection = el('div', 'versus-pane-selection');
    const source = el('b', 'versus-pane-source', '未选择领地');
    const troops = el('span', 'versus-pane-troops', '--/--');
    const charge = el('em', 'versus-pane-charge', '点按己方领地');
    selection.appendChild(source);
    selection.appendChild(troops);
    selection.appendChild(charge);

    hud.appendChild(head);
    hud.appendChild(selection);
    frame.appendChild(canvas);
    frame.appendChild(hud);
    root.appendChild(frame);

    this.el = root;
    this.frame = frame;
    this.canvas = canvas;
    this.name = sideName;
    this.score = score;
    this.zoomLabel = zoomLabel;
    this.source = source;
    this.troops = troops;
    this.charge = charge;
    this.resetButton = zoomReset;
    this.setRotation(rotation);
  }

  /**
   * Orientation-driven transform. Pointer mapping reads `rotation` live, so
   * the value and the painted frame can never disagree after a flip.
   */
  setRotation(rotation: VersusPaneRotation): void {
    const next: VersusPaneRotation = rotation === 180 ? 180 : 0;
    this.rotation = next;
    this.el.setAttribute('data-rotation', String(next));
    this.frame.style.transform = next === 180 ? 'rotate(180deg)' : '';
  }

  /** Signature-guarded per-pane score/land/force and selection/charge strip. */
  update(info: VersusPaneInfo): void {
    const signature = [
      info.score,
      info.land,
      info.force,
      info.selection,
      info.troops,
      info.charge,
    ].join('|');
    if (signature === this.infoSignature) return;
    this.infoSignature = signature;
    setText(
      this.score,
      info.score + ' 分 · ' + info.land + ' 地 · 兵 ' + info.force
    );
    setText(this.source, info.selection);
    setText(this.troops, info.troops);
    setText(this.charge, info.charge);
    this.el.setAttribute(
      'aria-label',
      this.name +
        '战场，' +
        info.score +
        ' 分，' +
        info.land +
        ' 块地，兵力 ' +
        info.force +
        '，' +
        info.selection +
        '，驻军 ' +
        info.troops +
        '，' +
        info.charge
    );
  }

  /** Camera is owned by the App; this only reflects zoom/reset affordance. */
  setCamera(camera: CameraState): void {
    const zoom = isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
    const panX = isFinite(camera.panX || 0) ? camera.panX || 0 : 0;
    const panY = isFinite(camera.panY || 0) ? camera.panY || 0 : 0;
    const signature = zoom.toFixed(3) + '|' + panX.toFixed(2) + '|' + panY.toFixed(2);
    if (signature === this.cameraSignature) return;
    this.cameraSignature = signature;
    setText(this.zoomLabel, zoomText(zoom));
    const reset = zoom <= 1.001 && Math.abs(panX) < 0.5 && Math.abs(panY) < 0.5;
    this.resetButton.disabled = reset;
    this.el.setAttribute('data-zoom', zoom.toFixed(2));
    this.el.setAttribute('data-pan', panX.toFixed(2) + ',' + panY.toFixed(2));
  }
}
