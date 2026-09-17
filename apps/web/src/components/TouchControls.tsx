import { useCallback, useEffect, useRef } from 'react';
import type { GameBoyButton } from '@webboy/emulator';
import { session } from '../emulator/EmulatorSession.js';
import { TouchInput } from '../emulator/input/TouchInput.js';

/**
 * On-screen controls for touch devices.
 *
 * Hit-testing goes through `elementFromPoint` rather than stored rectangles, which is what
 * makes sliding a thumb across the d-pad work: the control under the finger is resolved
 * fresh on every move, so Left → Up happens without lifting.
 *
 * `touch-action: none` on the surface stops the browser scrolling, zooming or rubber-banding
 * the page mid-game. `preventDefault` is scoped to this surface ONLY — the rest of the page
 * still scrolls normally.
 */
export function TouchControls(): React.JSX.Element {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<TouchInput | null>(null);

  const hitTest = useCallback((x: number, y: number): GameBoyButton | null => {
    const element = document.elementFromPoint(x, y);
    const target = element?.closest<HTMLElement>('[data-touch-button]');
    return (target?.dataset['touchButton'] as GameBoyButton | undefined) ?? null;
  }, []);

  useEffect(() => {
    const touch = new TouchInput(session.input, hitTest);
    inputRef.current = touch;

    const surface = surfaceRef.current;
    if (!surface) return;

    const setPressed = (): void => {
      for (const el of surface.querySelectorAll<HTMLElement>('[data-touch-button]')) {
        const button = el.dataset['touchButton'] as GameBoyButton;
        el.dataset['pressed'] = String(session.input.isHeld(button));
      }
    };

    const onDown = (e: PointerEvent): void => {
      e.preventDefault();
      surface.setPointerCapture(e.pointerId);
      touch.down(e.pointerId, e.clientX, e.clientY);
      setPressed();
    };
    const onMove = (e: PointerEvent): void => {
      if (touch.activeCount === 0) return;
      e.preventDefault();
      touch.move(e.pointerId, e.clientX, e.clientY);
      setPressed();
    };
    const onUp = (e: PointerEvent): void => {
      touch.up(e.pointerId);
      setPressed();
    };
    const onCancel = (): void => {
      touch.releaseAll();
      setPressed();
    };

    surface.addEventListener('pointerdown', onDown);
    surface.addEventListener('pointermove', onMove);
    surface.addEventListener('pointerup', onUp);
    surface.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);

    return () => {
      surface.removeEventListener('pointerdown', onDown);
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', onUp);
      surface.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      touch.releaseAll();
    };
  }, [hitTest]);

  return (
    <div className="touch" ref={surfaceRef} aria-label="On-screen controls">
      <div className="dpad">
        <button type="button" className="dpad-up" data-touch-button="up" aria-label="Up" />
        <button type="button" className="dpad-left" data-touch-button="left" aria-label="Left" />
        <button type="button" className="dpad-centre" aria-hidden="true" tabIndex={-1} />
        <button type="button" className="dpad-right" data-touch-button="right" aria-label="Right" />
        <button type="button" className="dpad-down" data-touch-button="down" aria-label="Down" />
      </div>

      <div className="face">
        <button type="button" className="face-b" data-touch-button="b" aria-label="B">
          B
        </button>
        <button type="button" className="face-a" data-touch-button="a" aria-label="A">
          A
        </button>
      </div>

      <div className="menu">
        <button type="button" data-touch-button="select" aria-label="Select">
          Select
        </button>
        <button type="button" data-touch-button="start" aria-label="Start">
          Start
        </button>
      </div>
    </div>
  );
}
