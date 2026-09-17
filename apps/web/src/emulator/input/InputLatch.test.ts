import { describe, expect, it } from 'vitest';
import { InputLatch } from './InputLatch.js';
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
