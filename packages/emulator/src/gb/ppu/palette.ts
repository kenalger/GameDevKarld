/**
 * DMG output colours.
 *
 * The Game Boy's four shades are not greys — the LCD is green. A greyscale default is the
 * most common way an otherwise-correct emulator looks wrong, so the classic panel is the
 * default and alternatives are selectable.
 */
export type ShadePalette = readonly [number, number, number, number];

const rgb = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;

export const PALETTE_DMG_GREEN: ShadePalette = [
  rgb(0x9b, 0xbc, 0x0f),
  rgb(0x8b, 0xac, 0x0f),
  rgb(0x30, 0x62, 0x30),
  rgb(0x0f, 0x38, 0x0f),
];

export const PALETTE_GREY: ShadePalette = [
  rgb(0xff, 0xff, 0xff),
  rgb(0xaa, 0xaa, 0xaa),
  rgb(0x55, 0x55, 0x55),
  rgb(0x00, 0x00, 0x00),
];

/** Pocket Game Boy — a true greyscale panel. */
export const PALETTE_POCKET: ShadePalette = [
  rgb(0xe3, 0xe6, 0xc9),
  rgb(0xc3, 0xc4, 0xa5),
  rgb(0x8e, 0x8b, 0x61),
  rgb(0x1f, 0x1f, 0x1f),
];
