import { describe, expect, it } from 'vitest';
import { buttonBit } from '@webboy/emulator';
import { KeyboardInput } from './KeyboardInput.js';
import { InputLatch } from './InputLatch.js';

/** A KeyboardEvent stand-in — the handler only reads these fields. */
function keyEvent(
  code: string,
  extra: {
    target?: { tagName?: string; isContentEditable?: boolean };
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    repeat?: boolean;
  } = {},
): KeyboardEvent & { defaultPrevented: boolean } {
  let prevented = false;
  return {
    code,
    ctrlKey: extra.ctrlKey ?? false,
    metaKey: extra.metaKey ?? false,
    altKey: extra.altKey ?? false,
    repeat: extra.repeat ?? false,
    target: extra.target ?? null,
    preventDefault: () => {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  } as unknown as KeyboardEvent & { defaultPrevented: boolean };
}

/** Reaches the private handlers, which is the whole behaviour worth testing. */
function handlers(keyboard: KeyboardInput): {
  down: (e: KeyboardEvent) => void;
  up: (e: KeyboardEvent) => void;
} {
  const k = keyboard as unknown as {
    onKeyDown: (e: KeyboardEvent) => void;
    onKeyUp: (e: KeyboardEvent) => void;
  };
  return { down: k.onKeyDown, up: k.onKeyUp };
}

describe('KeyboardInput', () => {
  it('presses and releases a bound key', () => {
    const latch = new InputLatch();
    const { down, up } = handlers(new KeyboardInput(latch));

    down(keyEvent('KeyZ'));
    expect(latch.sample() & buttonBit('a')).toBeTruthy();
    up(keyEvent('KeyZ'));
    expect(latch.sample() & buttonBit('a')).toBe(0);
  });

  /**
   * The listener is on the window, so without a guard every bound key is stolen from every
   * text field on the page — the debugger's address box could not take arrow keys or
   * Enter, and preventDefault() ate the character too.
   */
  describe('does not steal keystrokes from a field being typed in', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      it(`ignores a bound key inside <${tagName.toLowerCase()}>`, () => {
        const latch = new InputLatch();
        const { down } = handlers(new KeyboardInput(latch));

        const event = keyEvent('KeyZ', { target: { tagName } });
        down(event);

        expect(latch.sample() & buttonBit('a')).toBe(0);
        expect(event.defaultPrevented).toBe(false); // the character must reach the field
      });
    }

    it('ignores a bound key inside a contenteditable', () => {
      const latch = new InputLatch();
      const { down } = handlers(new KeyboardInput(latch));

      down(keyEvent('ArrowUp', { target: { tagName: 'DIV', isContentEditable: true } }));
      expect(latch.sample() & buttonBit('up')).toBe(0);
    });

    it('still plays when the event came from an ordinary element', () => {
      const latch = new InputLatch();
      const { down } = handlers(new KeyboardInput(latch));

      down(keyEvent('KeyZ', { target: { tagName: 'DIV' } }));
      expect(latch.sample() & buttonBit('a')).toBeTruthy();
    });
  });

  /**
   * macOS stops delivering keyup for other keys while Command is held — Chrome, Safari and
   * Firefox alike. Command's own keyup is the only chance to recover.
   */
  it('RELEASES EVERYTHING when Command comes up, which macOS needs', () => {
    const latch = new InputLatch();
    const { down, up } = handlers(new KeyboardInput(latch));

    down(keyEvent('KeyZ'));
    down(keyEvent('ArrowLeft'));
    latch.sample();

    // The player taps Command. macOS now swallows the keyups for Z and Left.
    up(keyEvent('MetaLeft'));

    expect(latch.sample()).toBe(0);
  });

  it('ignores a modified key so browser and OS shortcuts keep working', () => {
    const latch = new InputLatch();
    const { down } = handlers(new KeyboardInput(latch));

    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      down(keyEvent('KeyZ', { [modifier]: true }));
      expect(latch.sample() & buttonBit('a')).toBe(0);
    }
  });

  it('does not re-press on auto-repeat', () => {
    const latch = new InputLatch();
    const { down } = handlers(new KeyboardInput(latch));

    down(keyEvent('KeyZ'));
    latch.sample();
    latch.release('a');
    down(keyEvent('KeyZ', { repeat: true }));

    expect(latch.sample() & buttonBit('a')).toBe(0);
  });
});
