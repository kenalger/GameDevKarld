import { describe, expect, it } from 'vitest';
import { InputLatch, SOURCE } from './InputLatch.js';
import { buttonBit } from '@webboy/emulator';

describe('InputLatch', () => {
  it('reports a held button on every sample', () => {
    const latch = new InputLatch();
    latch.press('a');
    expect(latch.sample() & buttonBit('a')).toBeTruthy();
    expect(latch.sample() & buttonBit('a')).toBeTruthy();
  });

  it('stops reporting after release', () => {
    const latch = new InputLatch();
    latch.press('a');
    latch.sample();
    latch.release('a');
    expect(latch.sample() & buttonBit('a')).toBe(0);
  });

  it('NEVER DROPS A FAST TAP: press and release between two frames still registers', () => {
    const latch = new InputLatch();
    latch.press('start');
    latch.release('start'); // both happened before the emulator looked
    expect(latch.sample() & buttonBit('start')).toBeTruthy();
    // ...and only for that one frame.
    expect(latch.sample() & buttonBit('start')).toBe(0);
  });

  it('tracks several buttons at once', () => {
    const latch = new InputLatch();
    latch.press('left');
    latch.press('a');
    const state = latch.sample();
    expect(state & buttonBit('left')).toBeTruthy();
    expect(state & buttonBit('a')).toBeTruthy();
    expect(state & buttonBit('right')).toBe(0);
  });

  it('releaseAll clears held and sticky state alike', () => {
    const latch = new InputLatch();
    latch.press('up');
    latch.press('b');
    latch.releaseAll();
    expect(latch.sample()).toBe(0);
  });

  it('peek reports only what is physically held', () => {
    const latch = new InputLatch();
    latch.press('down');
    latch.release('down');
    expect(latch.peek()).toBe(0); // not held...
    expect(latch.sample() & buttonBit('down')).toBeTruthy(); // ...but not lost either
  });

  it('is idempotent on repeated presses', () => {
    const latch = new InputLatch();
    latch.press('a');
    latch.press('a');
    expect(latch.sample()).toBe(buttonBit('a'));
  });
});

/**
 * Sources must OR together, not overwrite each other.
 *
 * With one shared bitmask, any source's release cleared a button another source was still
 * holding. The reproduction is mundane: hold a key, tap the on-screen button for the same
 * action, lift your finger, and the game stops seeing the key you never let go of.
 */
describe('several input sources at once', () => {
  it('KEEPS A KEY HELD when a touch on the same button is released', () => {
    const latch = new InputLatch();
    latch.press('a', SOURCE.keyboard);
    latch.press('a', SOURCE.touch);
    latch.sample();

    latch.release('a', SOURCE.touch); // finger lifted; the key is still down
    expect(latch.sample() & buttonBit('a')).toBeTruthy();

    latch.release('a', SOURCE.keyboard); // now the key too
    expect(latch.sample() & buttonBit('a')).toBe(0);
  });

  it('lets a gamepad release without clearing the keyboard', () => {
    const latch = new InputLatch();
    latch.press('left', SOURCE.keyboard);
    latch.press('left', SOURCE.gamepad);
    latch.sample();

    latch.release('left', SOURCE.gamepad);
    expect(latch.sample() & buttonBit('left')).toBeTruthy();
  });

  it('CLEARS ONLY ONE SOURCE when releaseAll names one', () => {
    const latch = new InputLatch();
    latch.press('up', SOURCE.keyboard);
    latch.press('b', SOURCE.touch);
    latch.sample();

    // A window blur is the keyboard's business and must not drop the on-screen button.
    latch.releaseAll(SOURCE.keyboard);
    const state = latch.sample();
    expect(state & buttonBit('up')).toBe(0);
    expect(state & buttonBit('b')).toBeTruthy();
  });

  it('clears every source when releaseAll names none', () => {
    const latch = new InputLatch();
    latch.press('up', SOURCE.keyboard);
    latch.press('b', SOURCE.touch);
    latch.press('a', SOURCE.gamepad);
    latch.sample();

    latch.releaseAll();
    expect(latch.sample()).toBe(0);
  });
});
