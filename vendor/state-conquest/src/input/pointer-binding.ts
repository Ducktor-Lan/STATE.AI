import { GestureController } from './gesture-controller';

/** CSS rotation a split pane may apply to its canvas (only 180 is meaningful). */
export type CanvasRotation = 0 | 180;
/** Rotation may be a live value so an orientation/layout change needs no rebind. */
export type RotationSource = CanvasRotation | (() => CanvasRotation);
/** Maps viewport client coordinates into the canvas CSS-pixel coordinate space. */
export type ClientPointMapper = (clientX: number, clientY: number) => [number, number];
/**
 * `cancel` keeps the solo contract: any second pointer anywhere aborts the
 * order. `isolate` scopes the binding to pointers that started on its own
 * canvas, so two split panes can run independently without cancelling.
 */
export type SecondPointerPolicy = 'cancel' | 'isolate';

export interface GestureBindingOptions {
  now?: () => number;
  /**
   * CSS rotation applied to this canvas by the split layout. 180 mirrors both
   * axes, so the lower/red pane still reports upright logical coordinates.
   * Unset (0) preserves the original rect-relative mapping.
   */
  rotation?: RotationSource;
  /**
   * Full client -> local mapping override. Takes precedence over `rotation`
   * when the App needs a layout-specific transform (for example a pane-wide
   * CSS scale with a non-standard transform origin).
   */
  mapClientPoint?: ClientPointMapper;
  /**
   * Second-pointer strategy. Defaults to `cancel` (unchanged solo semantics).
   * A split pane passes `isolate` so the other pane's pointers never cancel it.
   */
  secondPointerPolicy?: SecondPointerPolicy;
}

export interface GestureBinding {
  destroy(): void;
}

export interface CanvasRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CanvasGeometryLike {
  getBoundingClientRect(): CanvasRectLike;
  /** Untransformed CSS size; used to undo a CSS transform scale. */
  clientWidth?: number;
  clientHeight?: number;
}

function clockNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** Original solo mapping, kept byte-for-byte compatible when no options apply. */
function defaultLocalPoint(
  canvas: CanvasGeometryLike,
  clientX: number,
  clientY: number
): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [clientX - rect.left, clientY - rect.top];
}

function resolveRotation(source?: RotationSource): CanvasRotation {
  const value = typeof source === 'function' ? source() : source;
  return value === 180 ? 180 : 0;
}

/**
 * Converts viewport client coordinates to the canvas' logical CSS-pixel space.
 *
 * `getBoundingClientRect()` includes CSS transforms while `clientWidth/Height`
 * are the untransformed layout size the renderer and hit-testing use. The
 * ratio therefore undoes `transform: scale(...)`; a 180 degree rotation mirrors
 * both axes because the split layout mirrors the whole pane.
 */
export function clientPointToCanvas(
  canvas: CanvasGeometryLike,
  clientX: number,
  clientY: number,
  rotation: CanvasRotation = 0
): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const layoutWidth =
    typeof canvas.clientWidth === 'number' && canvas.clientWidth > 0
      ? canvas.clientWidth
      : rect.width;
  const layoutHeight =
    typeof canvas.clientHeight === 'number' && canvas.clientHeight > 0
      ? canvas.clientHeight
      : rect.height;
  const scaleX = rect.width > 0 && layoutWidth > 0 ? layoutWidth / rect.width : 1;
  const scaleY = rect.height > 0 && layoutHeight > 0 ? layoutHeight / rect.height : 1;
  if (rotation === 180) {
    return [(rect.width - x) * scaleX, (rect.height - y) * scaleY];
  }
  return [x * scaleX, y * scaleY];
}

/** Reusable mapper for App wiring; always reads the current element rect. */
export function createCanvasPointMapper(
  canvas: CanvasGeometryLike,
  rotation?: RotationSource
): ClientPointMapper {
  return function (clientX: number, clientY: number): [number, number] {
    return clientPointToCanvas(canvas, clientX, clientY, resolveRotation(rotation));
  };
}

/**
 * Pointer Events are preferred. If they are missing we bind touch + mouse and
 * suppress the synthesized mouse gesture that follows a touch sequence.
 */
export function bindGestureInput(
  canvas: HTMLCanvasElement,
  controller: GestureController,
  options?: GestureBindingOptions
): GestureBinding {
  const now = (options && options.now) || clockNow;
  const removers: Array<() => void> = [];
  // No mapping options -> exact legacy behavior (no CSS-scale compensation).
  // Supplying rotation (even 0) or a custom mapper opts into transform-aware
  // mapping, which the split layout needs.
  const mapClient: ClientPointMapper =
    options && options.mapClientPoint
      ? options.mapClientPoint
      : options && options.rotation !== undefined
        ? createCanvasPointMapper(canvas, options.rotation)
        : function (clientX: number, clientY: number): [number, number] {
            return defaultLocalPoint(canvas, clientX, clientY);
          };

  function listen(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    opts?: boolean | AddEventListenerOptions
  ): void {
    target.addEventListener(type, handler, opts);
    removers.push(function () {
      target.removeEventListener(type, handler, opts);
    });
  }

  function prevent(event: Event): void {
    if (event.cancelable) event.preventDefault();
  }

  const multiPointer = controller.isMultiPointer();
  // Split panes opt out of the window-wide second-finger cancel. Every start
  // still enters through this canvas, so another pane cannot begin an order
  // here or abort the one this pane owns.
  const isolateSecondPointer =
    !!options && options.secondPointerPolicy === 'isolate';

  function activePointerId(): number | null {
    const state = controller.getState();
    return state.phase === 'idle' ? null : state.pointerId;
  }

  listen(canvas, 'contextmenu', function (event) {
    prevent(event);
  });

  const hasPointerEvents =
    typeof window !== 'undefined' &&
    typeof (window as unknown as { PointerEvent?: unknown }).PointerEvent !== 'undefined';

  if (hasPointerEvents) {
    listen(canvas, 'pointerdown', function (event) {
      const pointer = event as PointerEvent;
      if (pointer.pointerType === 'mouse' && pointer.button !== 0) return;
      const active = activePointerId();
      // Solo keeps the original contract: a second finger aborts the order.
      // Versus lets every pointer start its own independent state machine.
      if (!multiPointer && active !== null && active !== pointer.pointerId) {
        controller.cancel('multi-touch');
        return;
      }
      const point = mapClient(pointer.clientX, pointer.clientY);
      const began = controller.begin(
        point[0],
        point[1],
        pointer.pointerId,
        'pointer',
        now()
      );
      if (began) {
        try {
          if (typeof canvas.setPointerCapture === 'function') {
            canvas.setPointerCapture(pointer.pointerId);
          }
        } catch (error) {
          // Pointer capture is an enhancement; window listeners cover pointerup.
        }
      }
      // The battlefield never scrolls, including taps on empty pixels.
      prevent(event);
    });

    listen(
      window,
      'pointermove',
      function (event) {
        const pointer = event as PointerEvent;
        if (!controller.isPointerActive(pointer.pointerId)) return;
        const point = mapClient(pointer.clientX, pointer.clientY);
        controller.move(point[0], point[1], pointer.pointerId, now());
        prevent(event);
      },
      { passive: false }
    );

    listen(
      window,
      'pointerup',
      function (event) {
        const pointer = event as PointerEvent;
        if (!controller.isPointerActive(pointer.pointerId)) return;
        const point = mapClient(pointer.clientX, pointer.clientY);
        controller.end(point[0], point[1], pointer.pointerId, now());
        prevent(event);
      },
      { passive: false }
    );

    listen(window, 'pointercancel', function (event) {
      const pointer = event as PointerEvent;
      if (!controller.isPointerActive(pointer.pointerId)) return;
      controller.cancelPointer(pointer.pointerId, 'pointer-cancel');
    });

    // A second finger anywhere (including outside the canvas) aborts the order.
    // Versus opts out (independent slots) and a split pane opts out so the
    // sibling canvas cannot cancel it.
    if (!multiPointer && !isolateSecondPointer) {
      listen(window, 'pointerdown', function (event) {
        const pointer = event as PointerEvent;
        const active = activePointerId();
        if (active !== null && active !== pointer.pointerId) {
          controller.cancel('multi-touch');
        }
      });
    }

    return {
      destroy: function () {
        for (let i = 0; i < removers.length; i += 1) removers[i]();
        removers.length = 0;
      },
    };
  }

  let lastTouchAt = -99999;
  let mouseDown = false;

  function findTouch(touchList: TouchList | undefined, identifier: number): Touch | null {
    if (!touchList) return null;
    for (let i = 0; i < touchList.length; i += 1) {
      if (touchList[i].identifier === identifier) return touchList[i];
    }
    return null;
  }

  listen(
    canvas,
    'touchstart',
    function (event) {
      const touchEvent = event as TouchEvent;
      lastTouchAt = now();
      if (multiPointer) {
        for (let i = 0; i < touchEvent.changedTouches.length; i += 1) {
          const touch = touchEvent.changedTouches[i];
          const point = mapClient(touch.clientX, touch.clientY);
          controller.begin(point[0], point[1], touch.identifier, 'touch', now());
        }
        prevent(event);
        return;
      }
      if (isolateSecondPointer) {
        // `touches` also contains fingers owned by the sibling pane. Only a
        // new touch that lands on this canvas while it already owns one is a
        // conflict for this pane.
        if (activePointerId() !== null) {
          controller.cancel('multi-touch');
          return;
        }
      } else {
        if (touchEvent.touches.length > 1) {
          controller.cancel('multi-touch');
          return;
        }
        if (activePointerId() !== null) {
          controller.cancel('multi-touch');
          return;
        }
      }
      const touch = touchEvent.changedTouches[0] || touchEvent.touches[0];
      if (!touch) {
        prevent(event);
        return;
      }
      const point = mapClient(touch.clientX, touch.clientY);
      controller.begin(point[0], point[1], touch.identifier, 'touch', now());
      prevent(event);
    },
    { passive: false }
  );

  listen(
    window,
    'touchmove',
    function (event) {
      const touchEvent = event as TouchEvent;
      lastTouchAt = now();
      if (multiPointer) {
        let moved = false;
        for (let i = 0; i < touchEvent.changedTouches.length; i += 1) {
          const touch = touchEvent.changedTouches[i];
          if (!controller.isPointerActive(touch.identifier)) continue;
          const point = mapClient(touch.clientX, touch.clientY);
          controller.move(point[0], point[1], touch.identifier, now());
          moved = true;
        }
        if (moved || touchEvent.target === canvas) prevent(event);
        return;
      }
      const active = activePointerId();
      if (active === null) {
        // A touch that started on the canvas must not scroll the board.
        if (touchEvent.target === canvas) prevent(event);
        return;
      }
      // In isolate mode the extra touches may belong to the other pane, so
      // only this binding's active identifier is tracked here.
      if (!isolateSecondPointer && touchEvent.touches.length > 1) {
        controller.cancel('multi-touch');
        return;
      }
      const touch = findTouch(touchEvent.touches, active);
      if (!touch) return;
      const point = mapClient(touch.clientX, touch.clientY);
      controller.move(point[0], point[1], active, now());
      prevent(event);
    },
    { passive: false }
  );

  listen(
    window,
    'touchend',
    function (event) {
      const touchEvent = event as TouchEvent;
      lastTouchAt = now();
      if (multiPointer) {
        for (let i = 0; i < touchEvent.changedTouches.length; i += 1) {
          const touch = touchEvent.changedTouches[i];
          if (!controller.isPointerActive(touch.identifier)) continue;
          const point = mapClient(touch.clientX, touch.clientY);
          controller.end(point[0], point[1], touch.identifier, now());
        }
        prevent(event);
        return;
      }
      const active = activePointerId();
      if (active === null) return;
      const touch = findTouch(touchEvent.changedTouches, active);
      if (!touch) return;
      const point = mapClient(touch.clientX, touch.clientY);
      controller.end(point[0], point[1], active, now());
      prevent(event);
    },
    { passive: false }
  );

  listen(window, 'touchcancel', function (event) {
    lastTouchAt = now();
    const touchEvent = event as TouchEvent;
    if (multiPointer) {
      for (let i = 0; i < touchEvent.changedTouches.length; i += 1) {
        const touch = touchEvent.changedTouches[i];
        controller.cancelPointer(touch.identifier, 'pointer-cancel');
      }
      return;
    }
    const active = activePointerId();
    if (active === null) return;
    // A cancel for a touch owned by the sibling pane must not abort this one.
    if (isolateSecondPointer && !findTouch(touchEvent.changedTouches, active)) return;
    controller.cancel('pointer-cancel');
  });

  listen(canvas, 'mousedown', function (event) {
    const mouse = event as MouseEvent;
    if (mouse.button !== 0) return;
    if (now() - lastTouchAt < 800) return;
    if (activePointerId() !== null) return;
    const point = mapClient(mouse.clientX, mouse.clientY);
    mouseDown = controller.begin(point[0], point[1], -1, 'mouse', now());
    if (mouseDown) prevent(event);
  });

  listen(
    window,
    'mousemove',
    function (event) {
      if (!mouseDown) return;
      const mouse = event as MouseEvent;
      const point = mapClient(mouse.clientX, mouse.clientY);
      controller.move(point[0], point[1], -1, now());
      prevent(event);
    },
    { passive: false }
  );

  listen(window, 'mouseup', function (event) {
    if (!mouseDown) return;
    mouseDown = false;
    const mouse = event as MouseEvent;
    const point = mapClient(mouse.clientX, mouse.clientY);
    controller.end(point[0], point[1], -1, now());
    prevent(event);
  });

  return {
    destroy: function () {
      for (let i = 0; i < removers.length; i += 1) removers[i]();
      removers.length = 0;
    },
  };
}
