import { describe, expect, it } from 'vitest';
import { TouchInput } from './TouchInput.js';
import { InputLatch } from './InputLatch.js';
import { buttonBit, type GameBoyButton } from '@webboy/emulator';

/** A fake d-pad: x<10 is left, x>20 is right, otherwise up. x>100 is the A button. */
const hitTest = (x: number, _y: number): GameBoyButton | null => {
  if (x < 0) return null;
  if (x > 100) return 'a';
  if (x < 10) return 'left';
  if (x > 20) return 'right';
  return 'up';
};

const make = (): { latch: InputLatch; touch: TouchInput } => {
  const latch = new InputLatch();
  return { latch, touch: new TouchInput(latch, hitTest) };
};

describe('TouchInput', () => {
  it('presses the button under the pointer', () => {
    const { latch, touch } = make();
    touch.down(1, 5, 0);
    expect(latch.peek() & buttonBit('left')).toBeTruthy();
  });

  it('releases on pointer up', () => {
    const { latch, touch } = make();
    touch.down(1, 5, 0);
    touch.up(1);
    expect(latch.peek()).toBe(0);
  });

  it('SUPPORTS MULTITOUCH: a direction and a face button at once', () => {
    const { latch, touch } = make();
    touch.down(1, 5, 0); // left
    touch.down(2, 150, 0); // A
    const held = latch.peek();
    expect(held & buttonBit('left')).toBeTruthy();
    expect(held & buttonBit('a')).toBeTruthy();
  });

  it('SUPPORTS SLIDING: moving from Left to Up swaps without lifting', () => {
    const { latch, touch } = make();
    touch.down(1, 5, 0);
    expect(latch.peek() & buttonBit('left')).toBeTruthy();

    touch.move(1, 15, 0);
    expect(latch.peek() & buttonBit('left')).toBe(0);
    expect(latch.peek() & buttonBit('up')).toBeTruthy();
  });

  it('releases when a pointer slides off every control', () => {
    const { latch, touch } = make();
    touch.down(1, 5, 0);
    touch.move(1, -50, 0);
    expect(latch.peek()).toBe(0);
  });

  it('keeps a button held while a SECOND pointer is still on it', () => {
    const { latch, touch } = make();
    touch.down(1, 5, 0);
    touch.down(2, 6, 0); // same button, different finger
    touch.up(1);
    expect(latch.peek() & buttonBit('left')).toBeTruthy();
    touch.up(2);
    expect(latch.peek()).toBe(0);
  });

  it('ignores movement from a pointer that never went down here', () => {
    const { latch, touch } = make();
    touch.move(9, 5, 0);
    expect(latch.peek()).toBe(0);
  });

  it('releaseAll clears every pointer, for blur and pointercancel', () => {
    const { latch, touch } = make();
    touch.down(1, 5, 0);
    touch.down(2, 150, 0);
    touch.releaseAll();
    expect(latch.peek()).toBe(0);
    expect(touch.activeCount).toBe(0);
  });
});
