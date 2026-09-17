import type { CartridgeInfo } from '../../shared/types/cartridge.js';
import type { SystemKind } from '../../shared/types/system.js';

/**
 * Cartridge header offsets. Every one of these is from Pan Docs "The Cartridge Header" —
 * do not adjust them from memory.
 */
export const HEADER = {
  ENTRY: 0x0100,
  LOGO: 0x0104,
  TITLE: 0x0134,
  /** The title field shrank over time; these later bytes overlap it. */
  MANUFACTURER: 0x013f,
  CGB_FLAG: 0x0143,
  NEW_LICENSEE: 0x0144,
  SGB_FLAG: 0x0146,
  CARTRIDGE_TYPE: 0x0147,
  ROM_SIZE: 0x0148,
  RAM_SIZE: 0x0149,
  DESTINATION: 0x014a,
  OLD_LICENSEE: 0x014b,
  VERSION: 0x014c,
  HEADER_CHECKSUM: 0x014d,
  GLOBAL_CHECKSUM: 0x014e,
} as const;

/**
 * The 48-byte Nintendo logo the boot ROM checks, stored at 0x0104.
 *
 * Included as a hardware constant for header validation and MBC1 multicart detection. It
 * is a functional part of the cartridge format, not game content.
 */
export const NINTENDO_LOGO = Uint8Array.from([
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d,
  0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
  0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
]);

/** True when the 48 bytes at `offset` are the Nintendo logo. */
export function hasNintendoLogo(rom: Uint8Array, offset: number): boolean {
  for (let i = 0; i < NINTENDO_LOGO.length; i++) {
    if (rom[offset + i] !== NINTENDO_LOGO[i]) return false;
  }
  return true;
}

/** 0x80 = works on CGB and DMG; 0xC0 = CGB only. */
export const CGB_ENHANCED = 0x80;
export const CGB_ONLY = 0xc0;

export const MIN_ROM_BYTES = 0x0150;

/** RAM size codes. Code 1 is unused on real cartridges but appears in test ROMs. */
const RAM_SIZES = [0, 2048, 8192, 32768, 131072, 65536] as const;

export class CartridgeHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CartridgeHeaderError';
  }
}

/**
 * A GBA ROM is identified by ITS OWN header, never by filename:
 * an ARM branch at 0x00 (high byte 0xEA), the Nintendo logo at 0x04, and a fixed 0x96 at 0xB2.
 */
export function isGbaRom(rom: Uint8Array): boolean {
  return rom.length >= 0xc0 && rom[0x03] === 0xea && rom[0xb2] === 0x96;
}

/** Sum of 0x0134..0x014C as `x = x - byte - 1`. Compared against the byte at 0x014D. */
export function computeHeaderChecksum(rom: Uint8Array): number {
  let checksum = 0;
  for (let address = HEADER.TITLE; address <= HEADER.VERSION; address++) {
    checksum = (checksum - (rom[address] ?? 0) - 1) & 0xff;
  }
  return checksum;
}

/** Sum of every byte except the two checksum bytes themselves. Not verified by hardware. */
export function computeGlobalChecksum(rom: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < rom.length; i++) {
    if (i === HEADER.GLOBAL_CHECKSUM || i === HEADER.GLOBAL_CHECKSUM + 1) continue;
    sum = (sum + rom[i]!) & 0xffff;
  }
  return sum;
}

function readTitle(rom: Uint8Array): string {
  let title = '';
  for (let address = HEADER.TITLE; address < HEADER.CGB_FLAG; address++) {
    const byte = rom[address] ?? 0;
    if (byte === 0x00) break;
    // Later cartridges reuse the tail of this field, so stop at the first non-printable byte.
    if (byte < 0x20 || byte > 0x7e) break;
    title += String.fromCharCode(byte);
  }
  return title.trim();
}

export function parseHeader(rom: Uint8Array): CartridgeInfo {
  if (isGbaRom(rom)) {
    return {
      title: readGbaTitle(rom),
      cartridgeType: 0,
      romSize: rom.length,
      ramSize: 0,
      isColorCapable: false,
      system: 'GBA',
      saveKey: `gba:${readGbaTitle(rom)}:${rom.length}`,
      headerChecksumValid: true,
    };
  }

  if (rom.length < MIN_ROM_BYTES) {
    throw new CartridgeHeaderError(
      `ROM is ${rom.length} bytes — too short to contain a cartridge header (needs at least ${MIN_ROM_BYTES}).`,
    );
  }

  const cgbFlag = rom[HEADER.CGB_FLAG]!;
  const isColorCapable = cgbFlag === CGB_ENHANCED || cgbFlag === CGB_ONLY;
  const romSizeCode = rom[HEADER.ROM_SIZE]!;
  const ramSizeCode = rom[HEADER.RAM_SIZE]!;

  const declaredRomSize = 32768 << romSizeCode;
  const ramSize = RAM_SIZES[ramSizeCode] ?? 0;
  const title = readTitle(rom);
  const headerChecksumValid = computeHeaderChecksum(rom) === rom[HEADER.HEADER_CHECKSUM]!;

  return {
    title,
    cartridgeType: rom[HEADER.CARTRIDGE_TYPE]!,
    romSize: declaredRomSize,
    ramSize,
    isColorCapable,
    system: isColorCapable ? 'GBC' : 'GB',
    // Identity for save lookup: title + global checksum + size. NEVER the filename, so the
    // same game from a different dump resolves to the same save.
    saveKey: `${title || 'UNTITLED'}:${computeGlobalChecksum(rom).toString(16).padStart(4, '0')}:${rom.length}`,
    headerChecksumValid,
  };
}

function readGbaTitle(rom: Uint8Array): string {
  let title = '';
  for (let address = 0xa0; address < 0xac; address++) {
    const byte = rom[address] ?? 0;
    if (byte === 0x00 || byte < 0x20 || byte > 0x7e) break;
    title += String.fromCharCode(byte);
  }
  return title.trim();
}

export function detectSystem(rom: Uint8Array): SystemKind {
  return parseHeader(rom).system;
}
