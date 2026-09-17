import { HEADER, NINTENDO_LOGO } from '../../packages/emulator/src/gb/cartridge/header.js';

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
export function buildRom(options: RomOptions = {}): Uint8Array {
  const {
    title = 'TESTROM',
    cartridgeType = 0x00,
    romBanks = 2,
    ramSizeCode = 0x00,
    cgbFlag = 0x00,
    badChecksum = false,
  } = options;

  const rom = new Uint8Array(romBanks * 0x4000);

  // A recognisable per-bank byte, so banking tests can assert which bank is mapped.
  for (let bank = 0; bank < romBanks; bank++) rom[bank * 0x4000] = bank & 0xff;

  rom.set(NINTENDO_LOGO, HEADER.LOGO);

  rom[HEADER.ENTRY] = 0x00;
  rom[HEADER.ENTRY + 1] = 0xc3; // JP 0x0150

  for (let i = 0; i < title.length && i < 15; i++) {
    rom[HEADER.TITLE + i] = title.charCodeAt(i);
  }
  rom[HEADER.CGB_FLAG] = cgbFlag;
  rom[HEADER.CARTRIDGE_TYPE] = cartridgeType;
  rom[HEADER.ROM_SIZE] = Math.log2(romBanks / 2);
  rom[HEADER.RAM_SIZE] = ramSizeCode;

  let checksum = 0;
  for (let address = HEADER.TITLE; address <= HEADER.VERSION; address++) {
    checksum = (checksum - rom[address]! - 1) & 0xff;
  }
  rom[HEADER.HEADER_CHECKSUM] = badChecksum ? (checksum ^ 0xff) & 0xff : checksum;

  return rom;
}
