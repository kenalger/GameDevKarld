import { BaseCartridge } from './BaseCartridge.js';

/**
 * MBC5.
 *
 * The mapper CGB games need. Two differences from MBC1 that matter:
 *
 *  1. **A 9-bit ROM bank number**, split across two registers — the low 8 bits at
 *     0x2000-0x2FFF and bit 8 at 0x3000-0x3FFF. That reaches 512 banks (8 MB).
 *  2. **Bank 0 is selectable** in the switchable slot. There is no zero-to-one correction,
 *     so MBC1's famous gaps do not exist here.
 */
export class Mbc5Cartridge extends BaseCartridge {
  private ramEnabled = false;
  private romBank = 1;
  private ramBank = 0;
  private romBankMask = 0x1ff;

  override load(data: Uint8Array): void {
    super.load(data);
    const banks = Math.max(2, Math.floor(data.length / 0x4000));
    this.romBankMask = banks - 1;
    this.ramEnabled = false;
    this.romBank = 1;
    this.ramBank = 0;
  }

  read(address: number): number {
    if (address < 0x4000) return this.rom[address] ?? 0xff;
    if (address < 0x8000) {
      return this.rom[(this.romBank & this.romBankMask) * 0x4000 + (address - 0x4000)] ?? 0xff;
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
    } else if (address < 0x3000) {
      // Low 8 bits. Writing 0 really does select bank 0.
      this.romBank = (this.romBank & 0x100) | byte;
    } else if (address < 0x4000) {
      this.romBank = (this.romBank & 0xff) | ((byte & 0x01) << 8);
    } else if (address < 0x6000) {
      this.ramBank = byte & 0x0f;
    } else if (address >= 0xa000 && address < 0xc000) {
      if (!this.ramEnabled || this.ram.length === 0) return;
      this.ram[this.ramOffset(address)] = byte;
      this.dirty = true;
    }
  }

  private ramOffset(address: number): number {
    return (this.ramBank * 0x2000 + (address - 0xa000)) % this.ram.length;
  }
}
