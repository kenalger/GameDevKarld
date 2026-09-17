import type { InputLatch } from './InputLatch.js';
import { DEFAULT_BINDINGS, type Bindings } from './bindings.js';

/**
 * Translates keyboard events into latch updates.
 *
 * Deliberately narrow: it maps a physical key to a button and writes to the latch. It never
 * touches the emulator, and it never reads emulator state.
 */
export class KeyboardInput {
  private bindings: Bindings = DEFAULT_BINDINGS;
  private attached = false;

  constructor(private readonly latch: InputLatch) {}

  setBindings(bindings: Bindings): void {
    this.bindings = bindings;
    // A rebind must not leave the old key stuck down.
    this.latch.releaseAll();
  }

  getBindings(): Bindings {
    return this.bindings;
  }

  attach(target: Window = window): () => void {
    if (this.attached) return () => undefined;
    this.attached = true;

    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    target.document.addEventListener('visibilitychange', this.onVisibilityChange);

    return () => {
      target.removeEventListener('keydown', this.onKeyDown);
      target.removeEventListener('keyup', this.onKeyUp);
      target.removeEventListener('blur', this.onBlur);
      target.document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.attached = false;
      this.latch.releaseAll();
    };
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Never swallow a shortcut: a modified key belongs to the browser or the OS.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const button = this.bindings[event.code];
    if (button === undefined) return;

    // preventDefault ONLY on mapped keys, so browser and assistive-technology shortcuts,
    // tabbing and scrolling all keep working everywhere else on the page.
    event.preventDefault();
    if (event.repeat) return;
    this.latch.press(button);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const button = this.bindings[event.code];
    if (button === undefined) return;
    event.preventDefault();
    this.latch.release(button);
  };

  /** Losing focus mid-press would otherwise leave the player holding a direction forever. */
  private readonly onBlur = (): void => {
    this.latch.releaseAll();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.latch.releaseAll();
  };
}
