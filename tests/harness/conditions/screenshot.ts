import type { EmulatorCore } from '@webboy/emulator';
import type { StopCondition } from '../types.js';

export interface PixelDiff {
  readonly differing: number;
  readonly total: number;
  /** Null when nothing differs. */
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

/**
 * Compares two RGBA buffers.
 *
 * Reports a differing-pixel COUNT and a BOUNDING BOX, never "looks wrong" — a 4-pixel diff
 * in the sprite row and a full-screen diff are completely different bugs, and the reviewer
 * needs to be able to tell them apart without opening an image.
 */
export function diffFrameBuffers(
  actual: Uint8ClampedArray,
  expected: Uint8ClampedArray,
  width: number,
  height: number,
): PixelDiff {
  const total = width * height;
  if (actual.length !== total * 4 || expected.length !== total * 4) {
    throw new RangeError(
      `Buffer size mismatch: expected ${total * 4} bytes, got actual=${actual.length} expected=${expected.length}`,
    );
  }

  let differing = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (
        actual[i] !== expected[i] ||
        actual[i + 1] !== expected[i + 1] ||
        actual[i + 2] !== expected[i + 2] ||
        actual[i + 3] !== expected[i + 3]
      ) {
        differing++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  return {
    differing,
    total,
    bounds: differing === 0 ? null : { minX, minY, maxX, maxY },
  };
}

/** Runs a fixed number of frames, then compares against a reference buffer. */
export function screenshotCondition(
  reference: Uint8ClampedArray,
  width: number,
  height: number,
  atFrame: number,
): StopCondition {
  return {
    name: 'screenshot',
    evaluate(core: EmulatorCore, frame: number) {
      if (frame < atFrame) return null;
      const diff = diffFrameBuffers(core.getFrameBuffer(), reference, width, height);
      if (diff.differing === 0) {
        return { outcome: 'pass' as const, detail: `Pixel-exact at frame ${frame}.` };
      }
      const b = diff.bounds!;
      return {
        outcome: 'fail' as const,
        detail:
          `${diff.differing}/${diff.total} pixels differ at frame ${frame}; ` +
          `bounds x=${b.minX}..${b.maxX} y=${b.minY}..${b.maxY}.`,
      };
    },
  };
}
