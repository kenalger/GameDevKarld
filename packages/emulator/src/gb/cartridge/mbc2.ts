import { BaseCartridge } from './BaseCartridge.js';

/** MBC2's RAM is 512 half-bytes, built into the mapper rather than a separate chip. */
const MBC2_RAM_CELLS = 512;

/**
 * MBC2.
 *
 * Two things make it unlike every other mapper:
 *
 *  1. **Its RAM is 512 x 4 bits, built in.** The upper nibble simply does not exist and
 *     reads back as 1s. The header declares a RAM size of 0, so the RAM must be created
 *     from the cartridge type rather than the header.
 *  2. **One address range, two registers.** Writes below 0x4000 select RAM-enable or
 *     ROM-bank depending on **bit 8 of the address**, not on the address range.
 */
export class Mbc2Cartridge extends BaseCartridge {
  private ramEnabled = false;
  private romBank = 1;
  private romBankMask = 0x0f;

  override load(data: Uint8Array): void {
    super.load(data);
    // Built into the mapper, so the header's RAM size says nothing about it.
    this.ram = new Uint8Array(MBC2_RAM_CELLS);
    const banks = Math.max(2, Math.floor(data.length / 0x4000));
    this.romBankMask = Math.min(banks - 1, 0x0f);
    this.ramEnabled = false;
    this.romBank = 1;
  }

  read(address: number): number {
    if (address < 0x4000) return this.rom[address] ?? 0xff;
    if (address < 0x8000) {
      // The zero-to-one correction already happened on write; masking to the cartridge's
      // real size afterwards may legitimately land on bank 0, and must be allowed to.
      const bank = this.romBank & this.romBankMask;
      return this.rom[bank * 0x4000 + (address - 0x4000)] ?? 0xff;
    }
    if (address >= 0xa000 && address < 0xc000) {
      if (!this.ramEnabled) return 0xff;
      // 512 cells mirror through the whole 0xA000-0xBFFF window, and only 4 bits exist.
      return 0xf0 | (this.ram[(address - 0xa000) % MBC2_RAM_CELLS]! & 0x0f);
    }
    return 0xff;
  }

  write(address: number, value: number): void {
    const byte = value & 0xff;

    if (address < 0x4000) {
      // Address bit 8 chooses the register. This is the MBC2 quirk.
      if ((address & 0x0100) === 0) {
        this.ramEnabled = (byte & 0x0f) === 0x0a;
      } else {
        const bank = byte & 0x0f;
        this.romBank = bank === 0 ? 1 : bank;
      }
      return;
    }

    if (address >= 0xa000 && address < 0xc000) {
      if (!this.ramEnabled) return;
      this.ram[(address - 0xa000) % MBC2_RAM_CELLS] = byte & 0x0f;
      this.dirty = true;
    }
  }
}
