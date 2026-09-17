import type { ArmBus } from '../../packages/emulator/src/gba/cpu/Arm7.js';

/**
 * A flat GBA address space for CPU testing: the real region layout with no waitstates,
 * no I/O side effects and no PPU. Enough to run the jsmolka CPU suites, which only need
 * IWRAM, EWRAM, ROM and a writable place to report results.
 */
export class FlatGbaBus implements ArmBus {
  readonly bios = new Uint8Array(0x4000);
  readonly ewram = new Uint8Array(0x40000);
  readonly iwram = new Uint8Array(0x8000);
  readonly io = new Uint8Array(0x400);
  readonly palette = new Uint8Array(0x400);
  readonly vram = new Uint8Array(0x18000);
  readonly oam = new Uint8Array(0x400);
  rom = new Uint8Array(0x2000000);
  readonly sram = new Uint8Array(0x10000);

  private region(address: number): { mem: Uint8Array; offset: number } | null {
    const top = address >>> 24;
    switch (top) {
      case 0x0:
        return { mem: this.bios, offset: address & 0x3fff };
      case 0x2:
        return { mem: this.ewram, offset: address & 0x3ffff };
      case 0x3:
        return { mem: this.iwram, offset: address & 0x7fff };
      case 0x4:
        return { mem: this.io, offset: address & 0x3ff };
      case 0x5:
        return { mem: this.palette, offset: address & 0x3ff };
      case 0x6: {
        // 96KB VRAM mirrors in a 128KB window: the upper 32KB repeats.
        let offset = address & 0x1ffff;
        if (offset >= 0x18000) offset -= 0x8000;
        return { mem: this.vram, offset };
      }
      case 0x7:
        return { mem: this.oam, offset: address & 0x3ff };
      case 0x8:
      case 0x9:
      case 0xa:
      case 0xb:
      case 0xc:
      case 0xd:
        return { mem: this.rom, offset: address & 0x1ffffff };
      case 0xe:
      case 0xf:
        return { mem: this.sram, offset: address & 0xffff };
      default:
        return null;
    }
  }

  read8(address: number): number {
    const r = this.region(address >>> 0);
    return r ? r.mem[r.offset]! : 0;
  }

  /**
   * The test framework's m_vsync spins on DISPSTAT's VBlank flag. With no PPU attached the
   * flag is toggled on every read, so the loop always terminates.
   */
  private vblankToggle = 0;

  read16(address: number): number {
    const r = this.region(address >>> 0);
    if (!r) return 0;
    if (address >>> 0 === 0x04000004) {
      this.vblankToggle ^= 1;
      return this.vblankToggle;
    }
    return r.mem[r.offset]! | (r.mem[r.offset + 1]! << 8);
  }

  read32(address: number): number {
    const r = this.region(address >>> 0);
    if (!r) return 0;
    if (address >>> 0 === 0x04000004) {
      this.vblankToggle ^= 1;
      return this.vblankToggle;
    }
    return (
      (r.mem[r.offset]! |
        (r.mem[r.offset + 1]! << 8) |
        (r.mem[r.offset + 2]! << 16) |
        (r.mem[r.offset + 3]! << 24)) >>>
      0
    );
  }

  write8(address: number, value: number): void {
    const r = this.region(address >>> 0);
    if (r && r.mem !== this.rom) r.mem[r.offset] = value & 0xff;
  }

  // The CPU drives the unaligned address; a 16- or 32-bit device ignores the low bits.
  // (The real bus does the same in GbaMmu — only SRAM, an 8-bit device, looks at them.)
  write16(address: number, value: number): void {
    const r = this.region((address & ~1) >>> 0);
    if (!r || r.mem === this.rom) return;
    r.mem[r.offset] = value & 0xff;
    r.mem[r.offset + 1] = (value >>> 8) & 0xff;
  }

  write32(address: number, value: number): void {
    const r = this.region((address & ~3) >>> 0);
    if (!r || r.mem === this.rom) return;
    r.mem[r.offset] = value & 0xff;
    r.mem[r.offset + 1] = (value >>> 8) & 0xff;
    r.mem[r.offset + 2] = (value >>> 16) & 0xff;
    r.mem[r.offset + 3] = (value >>> 24) & 0xff;
  }

  waitstates(): number {
    return 1;
  }
}
