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
