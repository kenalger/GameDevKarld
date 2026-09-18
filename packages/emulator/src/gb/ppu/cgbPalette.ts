/**
 * CGB colour RAM: 8 palettes x 4 colours, 15-bit BGR, accessed through an index/data
 * register pair with optional auto-increment.
 */
export class CgbPaletteRam {
  /** 64 bytes = 8 palettes x 4 colours x 2 bytes. */
  readonly bytes = new Uint8Array(64);
  private index = 0;
  private autoIncrement = false;

  reset(): void {
    // Undefined on hardware; white is a far friendlier default than black.
    this.bytes.fill(0xff);
    this.index = 0;
    this.autoIncrement = false;
  }

  readIndex(): number {
    return this.index | (this.autoIncrement ? 0x80 : 0) | 0x40;
  }

  writeIndex(value: number): void {
    this.index = value & 0x3f;
    this.autoIncrement = (value & 0x80) !== 0;
  }

  readData(): number {
    return this.bytes[this.index]!;
  }

  writeData(value: number): void {
    this.bytes[this.index] = value & 0xff;
    // Auto-increment happens on WRITE only, never on read.
    if (this.autoIncrement) this.index = (this.index + 1) & 0x3f;
  }

  /**
   * The state a save must carry.
   *
   * The index and the auto-increment flag are as much state as the colours are: a game
   * that saves between writing BCPS and writing BCPD would otherwise resume writing at
   * offset 0 and corrupt a palette it never touched.
   */
  serializableState(): { bytes: Uint8Array; index: number; autoIncrement: boolean } {
    return { bytes: this.bytes, index: this.index, autoIncrement: this.autoIncrement };
  }

  restoreState(s: { bytes: Uint8Array; index: number; autoIncrement: boolean }): void {
    this.bytes.set(s.bytes);
    this.index = s.index;
    this.autoIncrement = s.autoIncrement;
  }

  /** Returns a packed 0xRRGGBB for palette `palette`, colour `colour`. */
  colour(palette: number, colour: number): number {
    const offset = (palette & 7) * 8 + (colour & 3) * 2;
    const raw = this.bytes[offset]! | (this.bytes[offset + 1]! << 8);
    return expand(raw);
  }
}

/**
 * Expands a 15-bit BGR colour to 24-bit RGB.
 *
 * The correct expansion is `c << 3 | c >> 2`, NOT `c * 8`: the latter can never reach 255,
 * so white comes out as 0xF8F8F8 and the whole image is subtly dim.
 */
export function expand(raw: number): number {
  const r5 = raw & 0x1f;
  const g5 = (raw >> 5) & 0x1f;
  const b5 = (raw >> 10) & 0x1f;
  const r = (r5 << 3) | (r5 >> 2);
  const g = (g5 << 3) | (g5 >> 2);
  const b = (b5 << 3) | (b5 >> 2);
  return (r << 16) | (g << 8) | b;
}
