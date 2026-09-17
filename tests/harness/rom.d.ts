export interface RomOptions {
  title?: string;
  cartridgeType?: number;
  /** 16KB banks. Must be a power of two and at least 2. */
  romBanks?: number;
  ramSizeCode?: number;
  cgbFlag?: number;
  /** Deliberately corrupt the header checksum. */
  badChecksum?: boolean;
}
/**
 * Builds a synthetic cartridge with a valid header.
 *
 * Synthetic ROMs, never commercial ones — no game data is committed to this repository in
 * any form. See docs/legal.md.
 */
export declare function buildRom(options?: RomOptions): Uint8Array;
//# sourceMappingURL=rom.d.ts.map
