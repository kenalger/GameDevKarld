import { describe, expect, it } from 'vitest';
import { FramePacer } from './FramePacer.js';
import { DMG_FRAMES_PER_SECOND } from '@webboy/emulator';

const MS = 1000 / DMG_FRAMES_PER_SECOND; // ≈16.7427

describe('FramePacer', () => {
  it('runs no frame on the first tick, since there is no elapsed time yet', () => {
    expect(new FramePacer(DMG_FRAMES_PER_SECOND).advance(1000)).toBe(0);
  });

  it('runs one frame per interval at the native rate', () => {
    const pacer = new FramePacer(DMG_FRAMES_PER_SECOND);
    pacer.advance(0);
    expect(pacer.advance(MS)).toBe(1);
    expect(pacer.advance(MS * 2)).toBe(1);
    expect(pacer.advance(MS * 3)).toBe(1);
  });

  it('paces against 59.7275Hz, not 60 — a 60Hz display drops a frame periodically', () => {
    const pacer = new FramePacer(DMG_FRAMES_PER_SECOND);
    const displayMs = 1000 / 60; // slightly shorter than an emulated frame
    pacer.advance(0);
    let frames = 0;
    for (let tick = 1; tick <= 60; tick++) frames += pacer.advance(displayMs * tick);
    // One second of 60Hz ticks yields ~59 emulated frames, never 60.
    expect(frames).toBe(59);
  });

  it('catches up across a slow tick, up to the cap', () => {
    const pacer = new FramePacer(DMG_FRAMES_PER_SECOND);
    pacer.advance(0);
    expect(pacer.advance(MS * 3)).toBe(3);
  });

  it('never runs more than MAX_FRAMES_PER_TICK in one tick', () => {
    const pacer = new FramePacer(DMG_FRAMES_PER_SECOND);
    pacer.advance(0);
    expect(pacer.advance(200)).toBeLessThanOrEqual(FramePacer.MAX_FRAMES_PER_TICK);
  });

  it('treats a hidden-tab gap as one frame instead of a catch-up burst', () => {
    const pacer = new FramePacer(DMG_FRAMES_PER_SECOND);
    pacer.advance(0);
    // 30 seconds hidden. Without the guard this would try to run ~1800 frames.
    expect(pacer.advance(30_000)).toBe(1);
  });

  it('ignores a backwards clock', () => {
    const pacer = new FramePacer(DMG_FRAMES_PER_SECOND);
    pacer.advance(5000);
    expect(pacer.advance(1000)).toBe(1);
  });

  it('drops accumulated time on reset so resuming does not burst', () => {
    const pacer = new FramePacer(DMG_FRAMES_PER_SECOND);
    pacer.advance(0);
    pacer.advance(MS * 0.9); // partial frame banked
    pacer.reset();
    expect(pacer.advance(1000)).toBe(0); // first tick after reset re-seeds
    expect(pacer.advance(1000 + MS)).toBe(1);
  });

  it('rejects a nonsensical frame rate', () => {
    expect(() => new FramePacer(0)).toThrow(RangeError);
    expect(() => new FramePacer(-30)).toThrow(RangeError);
  });
});

/**
 * Speed is implemented by shrinking the per-frame budget, so everything downstream — the
 * sticky input latch, save states, determinism — behaves exactly as it does at 1x.
 */
describe('speed', () => {
  /** Frames produced over one second of 60Hz ticks. */
  function framesPerSecond(speed: number): number {
    const pacer = new FramePacer(59.7275);
    pacer.setSpeed(speed);
    let now = 0;
    let total = 0;
    pacer.advance(now); // first call only seeds the clock
    for (let tick = 0; tick < 60; tick++) {
      now += 1000 / 60;
      total += pacer.advance(now);
    }
    return total;
  }

  it('runs about 60 frames a second at 1x', () => {
    expect(framesPerSecond(1)).toBeGreaterThanOrEqual(58);
    expect(framesPerSecond(1)).toBeLessThanOrEqual(60);
  });

  it('DOUBLES the frames at 2x and halves them at 0.5x', () => {
    expect(framesPerSecond(2)).toBeGreaterThanOrEqual(115);
    expect(framesPerSecond(0.5)).toBeLessThanOrEqual(31);
    expect(framesPerSecond(0.5)).toBeGreaterThanOrEqual(28);
  });

  /**
   * The per-tick cap exists to stop a death spiral after a hitch. Left at a fixed 4 it
   * would silently hold 4x and above to real time on a 60Hz display, so the setting would
   * appear to do nothing at exactly the speeds people reach for.
   */
  it('SCALES THE PER-TICK CAP, or high speeds would silently do nothing', () => {
    expect(framesPerSecond(4)).toBeGreaterThanOrEqual(230);
    expect(framesPerSecond(8)).toBeGreaterThanOrEqual(460);
  });

  it('clamps out-of-range and nonsense values instead of breaking pacing', () => {
    const pacer = new FramePacer(59.7275);
    pacer.setSpeed(100);
    expect(pacer.speed).toBe(FramePacer.MAX_SPEED);
    pacer.setSpeed(0);
    expect(pacer.speed).toBe(FramePacer.MIN_SPEED);
    pacer.setSpeed(Number.NaN);
    expect(pacer.speed).toBe(1);
  });

  it('DROPS THE BACKLOG on a speed change, so old-rate time is not spent at the new one', () => {
    const pacer = new FramePacer(59.7275);
    pacer.advance(0);
    // 50ms is two frames at 1x and leaves ~16.5ms on the accumulator. It must be under the
    // per-tick cap, or the cap zeroes the accumulator itself and there is no backlog to test.
    expect(pacer.advance(50)).toBe(2);

    pacer.setSpeed(4);
    // One more millisecond. Carrying ~16.5ms of 1x debt into a 4.2ms-per-frame budget
    // would dump four frames the player never saw.
    expect(pacer.advance(51)).toBe(0);
  });
});
