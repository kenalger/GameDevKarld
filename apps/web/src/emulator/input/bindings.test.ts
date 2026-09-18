import { describe, expect, it } from 'vitest';
import {
  BINDABLE_KEYS,
  DEFAULT_BINDINGS,
  RESERVED_CODES,
  bindKey,
  clearKey,
  describeKey,
  keysFor,
} from './bindings.js';

describe('describeKey', () => {
  it('names keys a player would recognise, not raw codes', () => {
    expect(describeKey('KeyZ')).toBe('Z');
    expect(describeKey('Digit3')).toBe('3');
    expect(describeKey('ArrowUp')).toBe('Up Arrow');
    expect(describeKey('ShiftRight')).toBe('Right Shift');
  });

  it('NAMES THE AWKWARD ONES, which used to fall through as codes', () => {
    expect(describeKey('Semicolon')).toBe(';');
    expect(describeKey('BracketLeft')).toBe('[');
    expect(describeKey('Space')).toBe('Space');
    expect(describeKey('Minus')).toBe('-');
  });
});

describe('bindKey', () => {
  it('binds a free key without disturbing anything else', () => {
    const { next, stolenFrom } = bindKey(DEFAULT_BINDINGS, 'a', 'KeyQ');
    expect(stolenFrom).toBeNull();
    expect(next['KeyQ']).toBe('a');
    expect(next['ArrowUp']).toBe('up');
  });

  it('REPLACES the old key for that button rather than accumulating', () => {
    const { next } = bindKey(DEFAULT_BINDINGS, 'a', 'KeyQ');
    expect(keysFor(next, 'a')).toEqual(['KeyQ']);
  });

  /**
   * Bindings are keyed by code, so one key maps to at most one button — a duplicate is
   * structurally impossible. Taking a key that is already in use is therefore a STEAL,
   * and the only failure mode is doing it silently.
   */
  it('STEALS A KEY IN USE and reports who lost it', () => {
    const { next, stolenFrom } = bindKey(DEFAULT_BINDINGS, 'a', 'Enter'); // Enter was Start
    expect(stolenFrom).toBe('start');
    expect(next['Enter']).toBe('a');
    expect(keysFor(next, 'start')).toEqual([]);
  });

  it('does not report a steal when the key already belonged to that button', () => {
    const { stolenFrom } = bindKey(DEFAULT_BINDINGS, 'a', 'KeyZ'); // already A
    expect(stolenFrom).toBeNull();
  });

  it('never mutates the bindings it was given', () => {
    const before = { ...DEFAULT_BINDINGS };
    bindKey(DEFAULT_BINDINGS, 'a', 'KeyQ');
    expect(DEFAULT_BINDINGS).toEqual(before);
  });
});

describe('clearKey', () => {
  it('leaves a button deliberately unbound', () => {
    const next = clearKey(DEFAULT_BINDINGS, 'select'); // has two keys by default
    expect(keysFor(next, 'select')).toEqual([]);
    expect(keysFor(next, 'start')).toEqual(['Enter']);
  });
});

describe('the bindable key list', () => {
  it('offers every default binding, or a player could not restore one by hand', () => {
    const offered = new Set(BINDABLE_KEYS.flatMap((group) => group.codes));
    for (const code of Object.keys(DEFAULT_BINDINGS)) {
      expect(offered.has(code), `${code} is a default but is not offered in the picker`).toBe(true);
    }
  });

  it('OFFERS NOTHING RESERVED — Escape and Tab must stay escape hatches', () => {
    const offered = BINDABLE_KEYS.flatMap((group) => group.codes);
    for (const code of offered) {
      expect(RESERVED_CODES.has(code), `${code} is offered but reserved`).toBe(false);
    }
  });

  it('reserves the modifiers, which are capturable but would never fire', () => {
    // The play handler discards any modified keydown, so a Control/Alt/Meta binding would
    // take and then never fire once.
    for (const code of ['ControlLeft', 'AltLeft', 'MetaLeft', 'Escape', 'Tab']) {
      expect(RESERVED_CODES.has(code)).toBe(true);
    }
  });
});
