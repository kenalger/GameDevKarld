import { SOURCE, type InputLatch } from './InputLatch.js';
import { DEFAULT_BINDINGS, type Bindings } from './bindings.js';

/**
 * Whether the event landed in something the player is typing into.
 *
 * Duck-typed rather than `instanceof HTMLElement` so this stays testable without a DOM.
 */
function isTyping(target: EventTarget | null): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!element) return false;
  if (element.isContentEditable === true) return true;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

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
    // A rebind must not leave the old key stuck down. Only OUR keys — a rebind has no
    // business clearing a button the player is holding on a gamepad.
    this.latch.releaseAll(SOURCE.keyboard);
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

    // Nor steal a keystroke from a field the player is typing in. This listens on the
    // window, so without this guard the arrow keys could not move the caret in the
    // debugger's address box and Enter could not submit it — the key reached the game
    // instead and preventDefault() ate the character.
    if (isTyping(event.target)) return;

    const button = this.bindings[event.code];
    if (button === undefined) return;

    // preventDefault ONLY on mapped keys, so browser and assistive-technology shortcuts,
    // tabbing and scrolling all keep working everywhere else on the page.
    event.preventDefault();
    if (event.repeat) return;
    this.latch.press(button, SOURCE.keyboard);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    // macOS stops delivering keyup for every other key while Command is held, in Chrome,
    // Safari and Firefox alike. Press Z, tap Command, release Z — that keyup never
    // arrives and A stays held forever. Command's OWN keyup does arrive, so it is the
    // one chance to recover.
    if (event.code === 'MetaLeft' || event.code === 'MetaRight') {
      this.latch.releaseAll(SOURCE.keyboard);
      return;
    }

    const button = this.bindings[event.code];
    if (button === undefined) return;
    event.preventDefault();
    this.latch.release(button, SOURCE.keyboard);
  };

  /** Losing focus mid-press would otherwise leave the player holding a direction forever. */
  private readonly onBlur = (): void => {
    this.latch.releaseAll(SOURCE.keyboard);
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.latch.releaseAll(SOURCE.keyboard);
  };
}
