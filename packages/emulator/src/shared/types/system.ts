/** The hardware families this project targets. Selected from the ROM header, never the filename. */
export type SystemKind = 'GB' | 'GBC' | 'GBA';

/** Native display dimensions, in pixels, per system. */
export const SCREEN_SIZE: Record<SystemKind, { width: number; height: number }> = {
  GB: { width: 160, height: 144 },
  GBC: { width: 160, height: 144 },
  GBA: { width: 240, height: 160 },
};

/**
 * DMG frame rate. Note this is NOT 60 — 4194304 / 70224 dots per frame.
 * The frame loop must accumulate against this value rather than assuming the display rate.
 */
export const DMG_FRAMES_PER_SECOND = 4194304 / 70224; // ≈59.7275
