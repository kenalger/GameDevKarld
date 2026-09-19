import { afterEach, describe, expect, it } from 'vitest';
import { buttonBit } from '@webboy/emulator';
import {
  DEADZONE,
  DEFAULT_STANDARD_MAPPING,
  bindPadInput,
  bindablePadInputs,
  clearPadInput,
  describePadInput,
  isPadInput,
  loadPadMappings,
  padInputsFor,
  padMask,
  readPadTokens,
  resolveMapping,
  savePadMappings,
} from './gamepad.js';

/** A localStorage stand-in. `null` for `store` makes every access throw, as a blocked
 *  storage does in a sandboxed iframe. */
function installStorage(store: Map<string, string> | null): void {
  const value =
    store === null
      ? {
          getItem: () => {
            throw new Error('blocked');
          },
          setItem: () => {
            throw new Error('blocked');
          },
        }
      : {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, item: string) => void store.set(key, item),
        };
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('input tokens', () => {
  it('accepts buttons and axes, and nothing else', () => {
    expect(isPadInput('b0')).toBe(true);
    expect(isPadInput('b15')).toBe(true);
    expect(isPadInput('a1-')).toBe(true);
    expect(isPadInput('a0+')).toBe(true);

    expect(isPadInput('b99')).toBe(false); // beyond the table
    expect(isPadInput('a9-')).toBe(false);
    expect(isPadInput('KeyZ')).toBe(false);
    expect(isPadInput('')).toBe(false);
    expect(isPadInput('b')).toBe(false);
  });

  /**
   * Only a pad the browser calls standard gets friendly names. On any other pad
   * "Button 3" is the honest label, because we genuinely do not know what it is.
   */
  it('names inputs only as confidently as the layout allows', () => {
    expect(describePadInput('b0', true)).toBe('Bottom face (0)');
    expect(describePadInput('b12', true)).toBe('D-pad up (12)');
    expect(describePadInput('b0', false)).toBe('Button 0');
    expect(describePadInput('a0-', true)).toBe('Left stick left');
    expect(describePadInput('a1+', true)).toBe('Left stick down');
    expect(describePadInput('a1+', false)).toBe('Axis 1 +');
  });
});

describe('binding', () => {
  it('binds, steals and clears with the keyboard panel’s semantics', () => {
    const first = bindPadInput(DEFAULT_STANDARD_MAPPING, 'start', 'b4');
    expect(first.stolenFrom).toBeNull();
    expect(padInputsFor(first.next, 'start')).toEqual(['b4']);

    // b4 now belongs to Start. Taking it for Select says whose it was.
    const second = bindPadInput(first.next, 'select', 'b4');
    expect(second.stolenFrom).toBe('start');
    expect(padInputsFor(second.next, 'start')).toEqual([]);

    expect(padInputsFor(clearPadInput(second.next, 'select'), 'select')).toEqual([]);
  });

  it('offers only the inputs the pad actually has', () => {
    const groups = bindablePadInputs({ buttons: { length: 4 }, axes: { length: 2 } });
    expect(groups.map((group) => group.group)).toEqual(['Buttons', 'Axes']);
    expect(groups[0]?.tokens).toEqual(['b0', 'b1', 'b2', 'b3']);
    expect(groups[1]?.tokens).toEqual(['a0-', 'a0+', 'a1-', 'a1+']);
  });
});

describe('persistence', () => {
  it('round-trips a mapping', () => {
    const store = new Map<string, string>();
    installStorage(store);

    savePadMappings({ 'My Pad': { b3: 'start', 'a0-': 'left' } });
    expect(loadPadMappings()).toEqual({ 'My Pad': { b3: 'start', 'a0-': 'left' } });
    expect(store.has('webboy.gamepad.v1')).toBe(true);
  });

  it('reads nothing when nothing is stored', () => {
    installStorage(new Map());
    expect(loadPadMappings()).toEqual({});
  });

  /**
   * FAILS CLOSED, the same way `settings.ts` does. Anything unrecognisable is dropped
   * rather than half-applied — a mapping built from a future version's keys, or from
   * garbage, would put buttons on the wrong actions, which is the exact failure this whole
   * change exists to remove.
   */
  describe('falls back to defaults on anything corrupt', () => {
    for (const [name, stored] of [
      ['not JSON at all', '{oh dear'],
      ['a JSON array', '[1,2,3]'],
      ['a JSON string', '"hello"'],
      ['null', 'null'],
      ['a pad whose mapping is not an object', '{"Pad":42}'],
      ['a pad whose mapping is an array', '{"Pad":["b0"]}'],
      ['tokens we do not understand', '{"Pad":{"KeyZ":"a","b99":"b"}}'],
      ['buttons that are not buttons', '{"Pad":{"b0":"turbo","b1":7}}'],
    ] as const) {
      it(name, () => {
        const store = new Map([['webboy.gamepad.v1', stored]]);
        installStorage(store);
        expect(loadPadMappings()).toEqual({});
      });
    }

    it('keeps the good entries and drops only the bad ones', () => {
      installStorage(new Map([['webboy.gamepad.v1', '{"Pad":{"b0":"start","b99":"a","x":"b"}}']]));
      expect(loadPadMappings()).toEqual({ Pad: { b0: 'start' } });
    });
  });

  it('survives storage that throws on every access', () => {
    installStorage(null);
    expect(loadPadMappings()).toEqual({});
    expect(() => savePadMappings({ Pad: { b0: 'a' } })).not.toThrow();
  });
});

describe('the compiled lookup', () => {
  const pad = (
    buttons: number[],
    axes: number[],
  ): { buttons: { pressed: boolean }[]; axes: number[] } => ({
    buttons: buttons.map((value) => ({ pressed: value === 1 })),
    axes,
  });

  it('turns tokens into the right bits', () => {
    const resolved = resolveMapping({ b2: 'a', 'a1-': 'up' });
    const down = pad([0, 0, 1], [0, -1]) as unknown as Gamepad;
    expect(padMask(down, resolved)).toBe(buttonBit('a') | buttonBit('up'));
  });

  it('respects the deadzone in both directions', () => {
    const resolved = resolveMapping(DEFAULT_STANDARD_MAPPING);
    const inside = pad([], [DEADZONE - 0.01, 0, 0, 0]) as unknown as Gamepad;
    const outside = pad([], [DEADZONE, 0, 0, 0]) as unknown as Gamepad;
    expect(padMask(inside, resolved)).toBe(0);
    expect(padMask(outside, resolved)).toBe(buttonBit('right'));
  });

  /** A pad with no sticks reports no axes. Indexing [0] and [1] blind is a phantom press. */
  it('reads a pad with no axes and no buttons without inventing input', () => {
    const resolved = resolveMapping(DEFAULT_STANDARD_MAPPING);
    expect(padMask(pad([], []) as unknown as Gamepad, resolved)).toBe(0);
  });

  it('collects the tokens a pad is holding, into a caller-owned array', () => {
    const out: string[] = [];
    readPadTokens(pad([1, 0, 0, 1], [0, -1]) as unknown as Gamepad, out);
    expect(out).toEqual(['b0', 'b3', 'a1-']);

    // Reused, not reallocated: the capture loop runs this every animation frame.
    const same = out;
    readPadTokens(pad([0, 0, 0, 0], []) as unknown as Gamepad, out);
    expect(out).toEqual([]);
    expect(out).toBe(same);
  });
});
