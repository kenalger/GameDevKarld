import type { Cartridge, CartridgeInfo } from '../../shared/types/cartridge.js';
import { parseHeader, hasNintendoLogo } from './header.js';
import { BaseCartridge } from './BaseCartridge.js';
import { Mbc2Cartridge } from './mbc2.js';
import { Mbc3Cartridge } from './mbc3.js';
import { Mbc5Cartridge } from './mbc5.js';

export { Mbc2Cartridge, Mbc3Cartridge, Mbc5Cartridge };

/** Cartridge type codes from header byte 0x0147. */
export const CARTRIDGE_TYPES: Record<number, string> = {
  0x00: 'ROM ONLY',
  0x01: 'MBC1',
  0x02: 'MBC1+RAM',
  0x03: 'MBC1+RAM+BATTERY',
  0x05: 'MBC2',
  0x06: 'MBC2+BATTERY',
  0x08: 'ROM+RAM',
  0x09: 'ROM+RAM+BATTERY',
  0x0f: 'MBC3+TIMER+BATTERY',
  0x10: 'MBC3+TIMER+RAM+BATTERY',
  0x11: 'MBC3',
  0x12: 'MBC3+RAM',
  0x13: 'MBC3+RAM+BATTERY',
  0x19: 'MBC5',
  0x1a: 'MBC5+RAM',
  0x1b: 'MBC5+RAM+BATTERY',
  0x1c: 'MBC5+RUMBLE',
  0x1d: 'MBC5+RUMBLE+RAM',
  0x1e: 'MBC5+RUMBLE+RAM+BATTERY',
};

export class UnsupportedMapperError extends Error {
  constructor(
    readonly cartridgeType: number,
    readonly mapperName: string,
  ) {
    super(
      `Cartridge type 0x${cartridgeType.toString(16).padStart(2, '0')} (${mapperName}) is not supported yet.`,
    );
    this.name = 'UnsupportedMapperError';
  }
}

/** No banking: 32KB of ROM, optionally 8KB of RAM. */
export class RomOnlyCartridge extends BaseCartridge {
  read(address: number): number {
    if (address < 0x8000) return this.rom[address] ?? 0xff;
    if (address >= 0xa000 && address < 0xc000) {
      if (this.ram.length === 0) return 0xff;
      return this.ram[(address - 0xa000) % this.ram.length] ?? 0xff;
    }
    return 0xff;
  }

  write(address: number, value: number): void {
    if (address >= 0xa000 && address < 0xc000 && this.ram.length > 0) {
      this.ram[(address - 0xa000) % this.ram.length] = value & 0xff;
      this.dirty = true;
    }
    // Writes below 0x8000 have nowhere to go on a ROM-only cartridge.
  }
}

/**
 * MBC1 — the most commonly half-implemented mapper in existence.
 *
 * Three registers plus a mode bit:
 *   0x0000-0x1FFF  RAM enable (low nibble == 0x0A)
 *   0x2000-0x3FFF  ROM bank, low 5 bits. **Writing 0 selects bank 1.**
 *   0x4000-0x5FFF  2-bit register: upper ROM bank bits, or RAM bank
 *   0x6000-0x7FFF  mode: 0 = the 2-bit register applies to ROM only
 *                        1 = it also banks 0x0000-0x3FFF and cartridge RAM
 *
 * The "bank 0x20/0x40/0x60 quirk" falls out of applying the zero-to-one rule to the low 5
 * bits BEFORE combining with the upper bits: bank 0x20 becomes 0x21.
 */
export class Mbc1Cartridge extends BaseCartridge {
  private ramEnabled = false;
  /** Stored with the zero-to-one correction already applied, as hardware latches it. */
  private romBankLow = 1;
  private bankHigh = 0;
  private mode = 0;
  private romBankMask = 0x1f;
  private multicart = false;

  override load(data: Uint8Array): void {
    super.load(data);
    const banks = Math.max(2, Math.floor(data.length / 0x4000));
    // Bank numbers wrap within the cartridge's actual size.
    this.romBankMask = banks - 1;
    this.multicart = detectMbc1Multicart(data);
    this.ramEnabled = false;
    this.romBankLow = 1;
    this.bankHigh = 0;
    this.mode = 0;
  }

  /** A multicart wires only 4 bits of the low register, so bank2 shifts by 4 instead of 5. */
  private get highShift(): number {
    return this.multicart ? 4 : 5;
  }

  private get lowBits(): number {
    return this.multicart ? this.romBankLow & 0x0f : this.romBankLow;
  }

  private romOffset(bank: number): number {
    return (bank & this.romBankMask) * 0x4000;
  }

  private get lowerBank(): number {
    return this.mode === 0 ? 0 : (this.bankHigh << this.highShift) & this.romBankMask;
  }

  private get upperBank(): number {
    return ((this.bankHigh << this.highShift) | this.lowBits) & this.romBankMask;
  }

  private ramOffset(address: number): number {
    const bank = this.mode === 1 ? this.bankHigh : 0;
    return (bank * 0x2000 + (address - 0xa000)) % this.ram.length;
  }

  read(address: number): number {
    if (address < 0x4000) return this.rom[this.romOffset(this.lowerBank) + address] ?? 0xff;
    if (address < 0x8000) {
      return this.rom[this.romOffset(this.upperBank) + (address - 0x4000)] ?? 0xff;
    }
    if (address >= 0xa000 && address < 0xc000) {
      if (!this.ramEnabled || this.ram.length === 0) return 0xff;
      return this.ram[this.ramOffset(address)] ?? 0xff;
    }
    return 0xff;
  }

  write(address: number, value: number): void {
    const byte = value & 0xff;
    if (address < 0x2000) {
      this.ramEnabled = (byte & 0x0f) === 0x0a;
    } else if (address < 0x4000) {
      // Writing 0 selects bank 1. Applying this to the low 5 bits BEFORE they are combined
      // with bank2 is what produces the famous 0x20/0x40/0x60 gaps.
      const low = byte & 0x1f;
      this.romBankLow = low === 0 ? 1 : low;
    } else if (address < 0x6000) {
      this.bankHigh = byte & 0x03;
    } else if (address < 0x8000) {
      this.mode = byte & 0x01;
    } else if (address >= 0xa000 && address < 0xc000) {
      if (!this.ramEnabled || this.ram.length === 0) return;
      this.ram[this.ramOffset(address)] = byte;
      this.dirty = true;
    }
  }
}

/**
 * MBC1 multicart detection.
 *
 * There is no header bit for this; the accepted heuristic (used by mooneye-gb and others)
 * is that the ROM is exactly 1 MiB and carries the Nintendo logo at the start of several
 * 256 KiB quarters, because each quarter is a separate game.
 */
function detectMbc1Multicart(rom: Uint8Array): boolean {
  if (rom.length !== 0x100000) return false;

  // Compare against the real logo, not against the ROM's own bytes: a blank region would
  // otherwise "match" itself in every quarter and produce a false multicart.
  let logos = 0;
  for (let quarter = 0; quarter < 4; quarter++) {
    if (hasNintendoLogo(rom, quarter * 0x40000 + 0x0104)) logos++;
  }
  return logos >= 3;
}

/**
 * Builds the right mapper for a ROM. Mappers beyond ROM-ONLY and MBC1 arrive in Phase 06 and
 * throw a clear error until then rather than silently misbehaving.
 */
export function createCartridge(rom: Uint8Array): { cartridge: Cartridge; info: CartridgeInfo } {
  const info = parseHeader(rom);
  const type = info.cartridgeType;

  let cartridge: Cartridge;
  if (type === 0x00 || type === 0x08 || type === 0x09) {
    cartridge = new RomOnlyCartridge();
  } else if (type >= 0x01 && type <= 0x03) {
    cartridge = new Mbc1Cartridge();
  } else if (type === 0x05 || type === 0x06) {
    cartridge = new Mbc2Cartridge();
  } else if (type >= 0x0f && type <= 0x13) {
    cartridge = new Mbc3Cartridge();
  } else if (type >= 0x19 && type <= 0x1e) {
    cartridge = new Mbc5Cartridge();
  } else {
    throw new UnsupportedMapperError(type, CARTRIDGE_TYPES[type] ?? 'unknown');
  }

  cartridge.load(rom);
  return { cartridge, info };
}

/** True when the cartridge type has a battery, and so has a save worth persisting. */
export function hasBattery(cartridgeType: number): boolean {
  return [0x03, 0x06, 0x09, 0x0f, 0x10, 0x13, 0x1b, 0x1e].includes(cartridgeType);
}

/** True when the cartridge type carries a real-time clock. */
export function hasRtc(cartridgeType: number): boolean {
  return cartridgeType === 0x0f || cartridgeType === 0x10;
}

/**
 * Battery save payload.
 *
 * Layout matches the convention other emulators use for `.sav` files: raw SRAM, optionally
 * followed by a 48-byte RTC tail. Keeping to it is what makes a save exported here loadable
 * elsewhere, and vice versa.
 */
export interface SaveData {
  readonly sram: Uint8Array;
  readonly rtc: Uint8Array | null;
}

export function packSave(save: SaveData): Uint8Array {
  if (!save.rtc) return save.sram;
  const out = new Uint8Array(save.sram.length + save.rtc.length);
  out.set(save.sram, 0);
  out.set(save.rtc, save.sram.length);
  return out;
}

/** Splits a `.sav` back into SRAM and an optional RTC tail, given the expected SRAM size. */
export function unpackSave(data: Uint8Array, sramSize: number): SaveData {
  if (sramSize === 0) return { sram: new Uint8Array(0), rtc: data.length >= 44 ? data : null };
  return {
    sram: data.subarray(0, Math.min(sramSize, data.length)),
    rtc: data.length > sramSize ? data.subarray(sramSize) : null,
  };
}
