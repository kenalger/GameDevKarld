import { afterEach, describe, expect, it } from 'vitest';
import { buttonBit } from '@webboy/emulator';
import { GamepadInput } from './GamepadInput.js';
import { InputLatch } from './InputLatch.js';
import { DEFAULT_STANDARD_MAPPING } from './gamepad.js';

/* -------------------------------- fake hardware -------------------------------- */

interface FakePad {
  index: number;
  id: string;
  mapping: string;
  buttons: { pressed: boolean }[];
  axes: number[];
}

function fakePad(overrides: Partial<FakePad> = {}): FakePad {
  return {
    index: 0,
    id: 'Fake Pad',
    mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => ({ pressed: false })),
    axes: [0, 0, 0, 0],
    ...overrides,
  };
}

/** Installs a fake `navigator.getGamepads`. Returns the slot array so tests can mutate it. */
function installPads(pads: (FakePad | null)[]): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => pads },
    configurable: true,
  });
}

/** A `window` stand-in that records the listeners the class attaches. */
function fakeWindow(): {
  window: Window;
  fire: (type: string, pad: FakePad) => void;
  listenerCount: () => number;
} {
  const listeners = new Map<string, (event: Event) => void>();
  const target = {
    addEventListener: (type: string, listener: (event: Event) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Window;
  return {
    window: target,
    fire: (type, pad) => listeners.get(type)?.({ gamepad: pad } as unknown as Event),
    listenerCount: () => listeners.size,
  };
}

const press = (pad: FakePad, index: number, down = true): void => {
  const button = pad.buttons[index];
  if (button) button.pressed = down;
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'navigator');
});

/* ------------------------------------ tests ------------------------------------ */

describe('GamepadInput', () => {
  describe('pad.mapping decides whether the standard table applies', () => {
    it('maps a STANDARD pad with no configuration at all', () => {
      const pad = fakePad();
      installPads([pad]);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);

      press(pad, 0); // south face
      press(pad, 12); // d-pad up
      gamepad.poll();

      expect(latch.peek() & buttonBit('a')).toBeTruthy();
      expect(latch.peek() & buttonBit('up')).toBeTruthy();
    });

    /**
     * The defect this file was written for. The standard index table is only guaranteed
     * when the browser reports `mapping === "standard"` — on anything else the indices are
     * whatever the driver felt like, and applying the table anyway is how a button lands
     * on the wrong action. So an unconfigured non-standard pad does NOTHING.
     */
    for (const mapping of ['', 'vendor']) {
      it(`does NOT apply the standard table to a pad reporting mapping "${mapping}"`, () => {
        const pad = fakePad({ mapping, id: 'Odd Pad' });
        installPads([pad]);
        const latch = new InputLatch();
        const gamepad = new GamepadInput(latch);

        for (let i = 0; i < pad.buttons.length; i++) press(pad, i);
        pad.axes = [-1, -1, 1, 1];
        gamepad.poll();

        expect(latch.peek()).toBe(0);
      });
    }

    it('plays a non-standard pad once the player has mapped it', () => {
      const pad = fakePad({ mapping: '', id: 'Odd Pad' });
      installPads([pad]);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);
      gamepad.setMappings({ 'Odd Pad': { b7: 'start', 'a3+': 'down' } });

      press(pad, 7);
      pad.axes = [0, 0, 0, 1];
      gamepad.poll();

      expect(latch.peek() & buttonBit('start')).toBeTruthy();
      expect(latch.peek() & buttonBit('down')).toBeTruthy();
    });

    it('prefers a stored mapping over the standard default', () => {
      const pad = fakePad({ id: 'Configured Pad' });
      installPads([pad]);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);
      gamepad.setMappings({ 'Configured Pad': { b0: 'start' } });

      press(pad, 0);
      gamepad.poll();

      expect(latch.peek() & buttonBit('start')).toBeTruthy();
      expect(latch.peek() & buttonBit('a')).toBe(0);
    });
  });

  describe('hot plug', () => {
    it('attaches and detaches both events', () => {
      installPads([]);
      const target = fakeWindow();
      const gamepad = new GamepadInput(new InputLatch());

      const detach = gamepad.attach(target.window);
      expect(target.listenerCount()).toBe(2);
      detach();
      expect(target.listenerCount()).toBe(0);
    });

    /**
     * Unplugging while a button is held used to leave that button down forever: the held
     * set is only reconciled by polling, and the frame loop is stopped whenever the game is
     * paused or the tab is hidden. Releasing on the event is the fix.
     */
    it('RELEASES A HELD BUTTON ON DISCONNECT, with no further polling', () => {
      const pad = fakePad();
      const slots: (FakePad | null)[] = [pad];
      installPads(slots);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);
      const target = fakeWindow();
      gamepad.attach(target.window);

      press(pad, 12);
      gamepad.poll();
      expect(latch.peek() & buttonBit('up')).toBeTruthy();

      // The pad is yanked out mid-press. Nothing polls again — the loop is stopped.
      slots[0] = null;
      target.fire('gamepaddisconnected', pad);

      expect(latch.peek()).toBe(0);
    });

    it('recompiles a slot when a different pad is plugged into it', () => {
      const first = fakePad({ id: 'First' });
      const slots: (FakePad | null)[] = [first];
      installPads(slots);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);
      gamepad.setMappings({ Second: { b1: 'start' } });
      const target = fakeWindow();
      gamepad.attach(target.window);

      gamepad.poll();

      const second = fakePad({ id: 'Second' });
      slots[0] = second;
      target.fire('gamepadconnected', second);
      press(second, 1);
      gamepad.poll();

      expect(latch.peek() & buttonBit('start')).toBeTruthy();
      expect(latch.peek() & buttonBit('b')).toBe(0);
    });

    it('notifies subscribers on connect and disconnect, and not per poll', () => {
      const pad = fakePad();
      installPads([pad]);
      const gamepad = new GamepadInput(new InputLatch());
      const target = fakeWindow();
      gamepad.attach(target.window);

      let notifications = 0;
      gamepad.subscribe(() => notifications++);

      target.fire('gamepadconnected', pad);
      target.fire('gamepaddisconnected', pad);
      for (let i = 0; i < 10; i++) gamepad.poll();

      expect(notifications).toBe(2);
    });
  });

  describe('axes', () => {
    it('reads the left stick as a d-pad on a standard pad', () => {
      const pad = fakePad();
      installPads([pad]);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);

      pad.axes = [-1, 1, 0, 0];
      gamepad.poll();

      expect(latch.peek() & buttonBit('left')).toBeTruthy();
      expect(latch.peek() & buttonBit('down')).toBeTruthy();
    });

    it('ignores drift inside the deadzone', () => {
      const pad = fakePad();
      installPads([pad]);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);

      pad.axes = [0.3, -0.4, 0, 0];
      gamepad.poll();

      expect(latch.peek()).toBe(0);
    });

    /** `pad.axes` used to be indexed [0] and [1] blind. A pad with no sticks has neither. */
    it('survives a pad that reports NO axes at all', () => {
      const pad = fakePad({ axes: [] });
      installPads([pad]);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);

      expect(() => gamepad.poll()).not.toThrow();
      expect(latch.peek()).toBe(0);
    });

    it('survives a pad that reports no buttons', () => {
      const pad = fakePad({ buttons: [] });
      installPads([pad]);
      const gamepad = new GamepadInput(new InputLatch());
      expect(() => gamepad.poll()).not.toThrow();
    });
  });

  describe('edges and release', () => {
    it('presses and releases on the edge only', () => {
      const pad = fakePad();
      installPads([pad]);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);

      press(pad, 9);
      gamepad.poll();
      gamepad.poll();
      expect(latch.peek() & buttonBit('start')).toBeTruthy();

      press(pad, 9, false);
      gamepad.poll();
      expect(latch.peek() & buttonBit('start')).toBe(0);
    });

    /** A button held across a pause must press again, not stay silently down. */
    it('re-presses a still-held button after releaseAll', () => {
      const pad = fakePad();
      installPads([pad]);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);

      press(pad, 0);
      gamepad.poll();
      gamepad.releaseAll();
      expect(latch.peek()).toBe(0);

      gamepad.poll();
      expect(latch.peek() & buttonBit('a')).toBeTruthy();
    });

    it('ORs two pads together rather than letting one clear the other', () => {
      const one = fakePad({ index: 0, id: 'One' });
      const two = fakePad({ index: 1, id: 'Two' });
      installPads([one, two]);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);

      press(one, 0);
      press(two, 9);
      gamepad.poll();

      expect(latch.peek() & buttonBit('a')).toBeTruthy();
      expect(latch.peek() & buttonBit('start')).toBeTruthy();

      press(two, 9, false);
      gamepad.poll();
      expect(latch.peek() & buttonBit('a')).toBeTruthy();
      expect(latch.peek() & buttonBit('start')).toBe(0);
    });

    it('tolerates empty slots between pads', () => {
      const pad = fakePad({ index: 2, id: 'Third' });
      installPads([null, null, pad, null]);
      const latch = new InputLatch();
      const gamepad = new GamepadInput(latch);

      press(pad, 0);
      expect(() => gamepad.poll()).not.toThrow();
      expect(latch.peek() & buttonBit('a')).toBeTruthy();
    });
  });

  /**
   * Charter law 7: no allocation in hot paths. `poll()` runs once per animation frame.
   *
   * This is asserted with counters rather than a timing threshold, the way
   * `GbCheatEngine.checksPerformed` is. Three of them, each aimed at one thing the old
   * implementation did every single frame:
   *
   *   1. a `Set` for the pressed buttons,
   *   2. a closure handed to `pad.buttons.forEach`,
   *   3. `const [x, y] = pad.axes`, which runs the array iterator.
   *
   * `navigator.getGamepads()` returning a fresh array is the API's allocation and cannot be
   * avoided by any caller; everything downstream of it can.
   */
  describe('the per-frame path allocates nothing of ours', () => {
    it('constructs no Set, calls no forEach, and runs no array iterator per frame', () => {
      let iterated = 0;
      let forEached = 0;

      const pad = fakePad();

      // `pad.buttons` and `pad.axes`, with their forEach and their iterator counted. The
      // old implementation called `buttons.forEach(closure)` and destructured `pad.axes`;
      // both show up here, and neither can be hidden by a fast machine.
      type Countable = { forEach: unknown; [Symbol.iterator]: unknown };
      const countIteration = (array: unknown[]): void => {
        const target = array as unknown as Countable;
        const real = (array as unknown as { [Symbol.iterator]: () => unknown })[
          Symbol.iterator
        ].bind(array);
        target.forEach = (): void => {
          forEached++;
        };
        target[Symbol.iterator] = (): unknown => {
          iterated++;
          return real();
        };
      };
      countIteration(pad.buttons);
      countIteration(pad.axes);

      installPads([pad]);
      const gamepad = new GamepadInput(new InputLatch());
      gamepad.poll(); // the first frame compiles the lookup table; that is the allocation
      const compiledAfterFirstFrame = gamepad.tablesCompiled;

      const RealSet = globalThis.Set;
      let setsConstructed = 0;
      globalThis.Set = new Proxy(RealSet, {
        construct(target, args: unknown[], newTarget: new (...a: never[]) => unknown): object {
          setsConstructed++;
          return Reflect.construct(target, args, newTarget);
        },
      });
      try {
        press(pad, 0);
        for (let i = 0; i < 200; i++) gamepad.poll();
      } finally {
        globalThis.Set = RealSet;
      }

      expect(setsConstructed).toBe(0);
      expect(forEached).toBe(0);
      expect(iterated).toBe(0);
      // Steady state: the compiled lookup tables are built once, not once per frame.
      expect(gamepad.tablesCompiled).toBe(compiledAfterFirstFrame);
      expect(gamepad.polls).toBe(201);
    });
  });

  it('exposes what the settings panel needs to describe a pad', () => {
    const pad = fakePad({ mapping: '', id: 'Odd Pad', axes: [0, 0] });
    installPads([pad]);
    const gamepad = new GamepadInput(new InputLatch());

    expect(gamepad.connected).toBe(true);
    const [info] = gamepad.pads();
    expect(info).toMatchObject({
      index: 0,
      id: 'Odd Pad',
      mapping: '',
      standard: false,
      customised: false,
      mapped: false,
      buttonCount: 17,
      axisCount: 2,
    });

    gamepad.setMappings({ 'Odd Pad': { b3: 'a' } });
    expect(gamepad.pads()[0]).toMatchObject({ customised: true, mapped: true });
    expect(gamepad.mappingFor('Odd Pad', false)).toEqual({ b3: 'a' });
    expect(gamepad.mappingFor('Unknown Pad', true)).toEqual(DEFAULT_STANDARD_MAPPING);
    expect(gamepad.mappingFor('Unknown Pad', false)).toEqual({});
  });

  it('reports nothing when the browser has no Gamepad API', () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const gamepad = new GamepadInput(new InputLatch());
    expect(gamepad.connected).toBe(false);
    expect(() => gamepad.poll()).not.toThrow();
  });
});
