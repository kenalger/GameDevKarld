import type { ArmBus } from '../cpu/Arm7.js';
import { Waitstates } from './waitstates.js';
import { DmaController } from './Dma.js';
import { TimerController } from '../timer/Timers.js';
import type { GbaPpu } from '../video/GbaPpu.js';
import { GbaKeypad } from '../input/GbaKeypad.js';
import type { GbaApu } from '../audio/GbaApu.js';
import { GbaBackup, detectBackupType } from './backup.js';
import type { StateReader, StateWriter } from '../../gb/state/StateBuffer.js';

export const IRQ_VBLANK = 1 << 0;
export const IRQ_HBLANK = 1 << 1;
export const IRQ_VCOUNT = 1 << 2;
export const IRQ_TIMER0 = 1 << 3;
export const IRQ_DMA0 = 1 << 8;
export const IRQ_KEYPAD = 1 << 12;

/**
 * The GBA memory bus.
 *
 * Region layout and the quirks that matter:
 *
 *  - **BIOS is read-protected.** A read from outside BIOS code returns the last opcode the
 *    BIOS itself fetched, not the actual bytes — games use this to detect emulators.
 *  - **VRAM is 96KB in a 128KB window**, so the upper 32KB mirrors the block before it.
 *  - **Every region mirrors** across its window; EWRAM's 256KB repeats through 0x02FFFFFF.
 *  - **SRAM is an 8-bit bus**: a 16- or 32-bit read returns the single byte replicated.
 *  - **Unmapped reads return open bus**, which is the last value the bus carried — never
 *    zero. Software reads this deliberately.
 */
export class GbaMmu implements ArmBus {
  readonly bios = new Uint8Array(0x4000);
  readonly ewram = new Uint8Array(0x40000);
  readonly iwram = new Uint8Array(0x8000);
  readonly palette = new Uint8Array(0x400);
  readonly vram = new Uint8Array(0x18000);
  readonly oam = new Uint8Array(0x400);
  /** Cartridge backup: SRAM, Flash or EEPROM, detected from the ROM. */
  readonly backup = new GbaBackup();
  rom: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  readonly waits = new Waitstates();
  readonly dma: DmaController;
  readonly timers: TimerController;

  /** Raw I/O register storage for everything not handled specially. */
  private readonly io = new Uint8Array(0x400);

  /** Interrupt enable / request / master enable. */
  ie = 0;
  irqFlags = 0;
  ime = 0;

  /** The last value the bus carried, returned for unmapped reads. */
  private openBus = 0;
  /** The last opcode the BIOS fetched, returned for protected BIOS reads. */
  private lastBiosOpcode = 0;
  /** True while the CPU is executing inside the BIOS. */
  biosExecuting = false;

  /** KEYINPUT / KEYCNT. */
  readonly keypad = new GbaKeypad(() => this.requestInterrupt(IRQ_KEYPAD));

  /** Attached by the core. Video registers are routed here. */
  ppu: GbaPpu | null = null;

  /** Attached by the core. Sound registers (0x04000060-0x040000A7) are routed here. */
  apu: GbaApu | null = null;

  /** Raised when any enabled interrupt becomes pending. */
  onInterrupt: (() => void) | null = null;

  constructor() {
    this.dma = new DmaController(this, (channel) => this.requestInterrupt(IRQ_DMA0 << channel));
    this.timers = new TimerController((index) => this.requestInterrupt(IRQ_TIMER0 << index));
  }

  /**
   * Save-state for everything the bus owns.
   *
   * The BIOS and the ROM are deliberately absent: they are immutable inputs the host
   * already has, and writing 16 MB of ROM into every save state would be absurd.
   */
  saveState(w: StateWriter): void {
    w.bytesOf(this.ewram);
    w.bytesOf(this.iwram);
    w.bytesOf(this.palette);
    w.bytesOf(this.vram);
    w.bytesOf(this.oam);
    w.bytesOf(this.io);
    w.u16(this.ie);
    w.u16(this.irqFlags);
    w.u32(this.ime);
    w.u32(this.openBus);
    w.u32(this.lastBiosOpcode);
    w.bool(this.biosExecuting);
    w.u16(this.waits.waitcnt);
    this.dma.saveState(w);
    this.timers.saveState(w);
    this.keypad.saveState(w);
    this.backup.saveState(w);
  }

  loadState(r: StateReader): void {
    r.intoArray(this.ewram);
    r.intoArray(this.iwram);
    r.intoArray(this.palette);
    r.intoArray(this.vram);
    r.intoArray(this.oam);
    r.intoArray(this.io);
    this.ie = r.u16();
    this.irqFlags = r.u16();
    this.ime = r.u32();
    this.openBus = r.u32();
    this.lastBiosOpcode = r.u32();
    this.biosExecuting = r.bool();
    this.waits.setControl(r.u16());
    this.dma.loadState(r);
    this.timers.loadState(r);
    this.keypad.loadState(r);
    this.backup.loadState(r);
  }

  reset(): void {
    this.ewram.fill(0);
    this.iwram.fill(0);
    this.palette.fill(0);
    this.vram.fill(0);
    this.oam.fill(0);
    this.io.fill(0);
    this.ie = 0;
    this.irqFlags = 0;
    this.ime = 0;
    this.openBus = 0;
    this.dma.reset();
    this.timers.reset();
    this.keypad.reset();
    this.apu?.reset();
    this.waits.setControl(0);
  }

  loadRom(data: Uint8Array): void {
    this.rom = data;
    // There is no header field for the save type, so the ROM is scanned for the SDK
    // save-library signature instead.
    this.backup.setType(detectBackupType(data));
  }

  requestInterrupt(mask: number): void {
    this.irqFlags |= mask & 0x3fff;
    if (this.ime !== 0 && (this.ie & this.irqFlags) !== 0) this.onInterrupt?.();
  }

  get irqPending(): boolean {
    return this.ime !== 0 && (this.ie & this.irqFlags & 0x3fff) !== 0;
  }

  waitstates(address: number, width: number, sequential: boolean): number {
    return this.waits.cycles(address, width, sequential);
  }

  /* --------------------------------- reads ----------------------------------- */

  read8(address: number): number {
    const addr = address >>> 0;
    const region = (addr >>> 24) & 0xf;

    switch (region) {
      case 0x0:
      case 0x1:
        // BIOS is readable only by code executing inside it.
        if (addr >= 0x4000) return this.openBusByte(addr);
        return this.biosExecuting
          ? this.bios[addr]!
          : (this.lastBiosOpcode >>> ((addr & 3) * 8)) & 0xff;
      case 0x2:
        return this.ewram[addr & 0x3ffff]!;
      case 0x3:
        return this.iwram[addr & 0x7fff]!;
      case 0x4:
        return this.readIo(addr);
      case 0x5:
        return this.palette[addr & 0x3ff]!;
      case 0x6:
        return this.vram[vramOffset(addr)]!;
      case 0x7:
        return this.oam[addr & 0x3ff]!;
      case 0xd:
        // The serial EEPROM shares region 0x0D with the top half of the third ROM mirror.
        if (this.isEeprom(addr)) return this.backup.eeprom.read();
        return this.romByte(addr);
      case 0x8:
      case 0x9:
      case 0xa:
      case 0xb:
      case 0xc:
        return this.romByte(addr);
      default:
        return this.backup.read(addr);
    }
  }

  read16(address: number): number {
    const addr = (address & ~1) >>> 0;
    const region = (addr >>> 24) & 0xf;
    // The EEPROM answers one bit per halfword, in bit 0 — this is the access DMA3 makes.
    if (region === 0xd && this.isEeprom(addr)) return this.backup.eeprom.read();
    // SRAM is an 8-bit bus: wider reads see the byte replicated.
    if (region >= 0xe) {
      const byte = this.backup.read(addr);
      return byte | (byte << 8);
    }
    if (region === 0x4) return this.readIo(addr) | (this.readIo(addr + 1) << 8);
    const value = this.read8(addr) | (this.read8(addr + 1) << 8);
    this.openBus = value | (value << 16);
    return value;
  }

  read32(address: number): number {
    const addr = (address & ~3) >>> 0;
    const region = (addr >>> 24) & 0xf;
    // A word read of the EEPROM is not a documented access; it consumes ONE bit rather
    // than two, so a stray LDR cannot silently eat half the reply stream.
    if (region === 0xd && this.isEeprom(addr)) return this.backup.eeprom.read();
    if (region >= 0xe) {
      const byte = this.backup.read(addr);
      return (byte | (byte << 8) | (byte << 16) | (byte << 24)) >>> 0;
    }
    const value = (this.read16(addr) | (this.read16(addr + 2) << 16)) >>> 0;
    this.openBus = value;
    return value;
  }

  private romByte(address: number): number {
    const offset = address & 0x01ffffff;
    return offset < this.rom.length ? this.rom[offset]! : this.openBusByte(address);
  }

  /**
   * Does this address decode to the serial EEPROM?
   *
   * GBATEK, "GBA Cart Backup EEPROM / Addressing and Waitstates": the chip answers at
   * 0x0DFFFF00-0x0DFFFFFF, *"On carts with 16MB or smaller ROM, eeprom can be alternately
   * accessed anywhere at D000000h-DFFFFFFh."* So the whole region decodes on a small cart,
   * and only the top 256 bytes on a large one — where the rest of 0x0D is real ROM.
   */
  private isEeprom(address: number): boolean {
    if (!this.backup.isEeprom) return false;
    return this.rom.length <= 0x01000000 || (address & 0x00ffff00) === 0x00ffff00;
  }

  /**
   * DMA3 has started a transfer INTO the EEPROM window.
   *
   * The length of that request stream is the only way to tell a 6-bit part from a 14-bit
   * one; see Eeprom.inferAddressBits.
   */
  notifyEepromDma(units: number): void {
    if (this.backup.isEeprom) this.backup.eeprom.inferAddressBits(units);
  }

  private openBusByte(address: number): number {
    return (this.openBus >>> ((address & 3) * 8)) & 0xff;
  }

  /**
   * Sets the value a protected BIOS read returns.
   *
   * WebBoy has no BIOS image to fetch opcodes from, so the native BIOS supplies the value
   * hardware would have left behind — GBATEK, "Reading from BIOS Memory": the opcode at
   * [00DCh+8] after startup, [0134h+8] during an IRQ, [013Ch+8] after one, [0188h+8] after
   * a SWI. See `gba/bios/GbaBios.ts`.
   */
  setBiosOpenBus(value: number): void {
    this.lastBiosOpcode = value >>> 0;
  }

  /** Records the opcode the CPU just fetched, for BIOS read protection and open bus. */
  noteFetch(address: number, opcode: number): void {
    this.biosExecuting = address >>> 24 === 0;
    if (this.biosExecuting) this.lastBiosOpcode = opcode >>> 0;
    this.openBus = opcode >>> 0;
  }

  /* --------------------------------- writes ---------------------------------- */

  write8(address: number, value: number): void {
    const addr = address >>> 0;
    const byte = value & 0xff;
    const region = (addr >>> 24) & 0xf;

    switch (region) {
      case 0x2:
        this.ewram[addr & 0x3ffff] = byte;
        return;
      case 0x3:
        this.iwram[addr & 0x7fff] = byte;
        return;
      case 0x4:
        this.writeIo(addr, byte);
        return;
      // Palette, VRAM and OAM have no 8-bit write path: the byte is duplicated across the
      // addressed halfword. OAM ignores byte writes entirely.
      case 0x5:
        this.write16(addr & ~1, byte | (byte << 8));
        return;
      case 0x6:
        this.write16(addr & ~1, byte | (byte << 8));
        return;
      case 0x7:
        return;
      case 0xd:
        // One command bit into the serial EEPROM, carried in bit 0.
        if (this.isEeprom(addr)) this.backup.eeprom.write(byte);
        return;
      case 0xe:
      case 0xf:
        this.backup.write(addr, byte);
        return;
      default:
        return; // ROM is not writable
    }
  }

  write16(address: number, value: number): void {
    const addr = (address & ~1) >>> 0;
    const half = value & 0xffff;
    const region = (addr >>> 24) & 0xf;

    // GBATEK, "Using DMA": "one halfword for each bit, bit1-15 of the halfwords are don't
    // care, only bit0 is used". This is the write DMA3 makes for a request stream.
    if (region === 0xd && this.isEeprom(addr)) {
      this.backup.eeprom.write(half);
      return;
    }

    // SRAM and Flash sit on an 8-bit bus, so a halfword write moves exactly ONE byte —
    // and it is the byte of `value` lined up with the *unaligned* address, not the low
    // byte. Handle it before the alignment above throws bit 0 away.
    if (region >= 0xe) {
      this.backup.write(address, half >>> (8 * (address & 1)));
      return;
    }

    switch (region) {
      case 0x2:
        this.ewram[addr & 0x3ffff] = half & 0xff;
        this.ewram[(addr & 0x3ffff) + 1] = half >>> 8;
        return;
      case 0x3:
        this.iwram[addr & 0x7fff] = half & 0xff;
        this.iwram[(addr & 0x7fff) + 1] = half >>> 8;
        return;
      case 0x4:
        this.writeIo16(addr, half);
        return;
      case 0x5:
        this.palette[addr & 0x3ff] = half & 0xff;
        this.palette[(addr & 0x3ff) + 1] = half >>> 8;
        return;
      case 0x6: {
        const offset = vramOffset(addr);
        this.vram[offset] = half & 0xff;
        this.vram[offset + 1] = half >>> 8;
        return;
      }
      case 0x7:
        this.oam[addr & 0x3ff] = half & 0xff;
        this.oam[(addr & 0x3ff) + 1] = half >>> 8;
        return;
      default:
        return;
    }
  }

  write32(address: number, value: number): void {
    const addr = (address & ~3) >>> 0;
    // A word write to the EEPROM clocks in one bit, matching the word read above.
    if (((addr >>> 24) & 0xf) === 0xd && this.isEeprom(addr)) {
      this.backup.eeprom.write(value);
      return;
    }
    // Same 8-bit-bus rule as write16: one byte, chosen by the low two address bits.
    if (((addr >>> 24) & 0xf) >= 0xe) {
      this.backup.write(address, value >>> (8 * (address & 3)));
      return;
    }
    this.write16(addr, value & 0xffff);
    this.write16(addr + 2, (value >>> 16) & 0xffff);
  }

  /* ----------------------------------- I/O ----------------------------------- */

  private readIo(address: number): number {
    const offset = address & 0x3ff;

    if (address >= 0x04000100 && address <= 0x0400010f) {
      const value = this.timers.read(address & ~1);
      return (address & 1) === 0 ? value & 0xff : (value >>> 8) & 0xff;
    }
    if (address >= 0x040000b0 && address <= 0x040000df) {
      const value = this.dma.read(address & ~1);
      return (address & 1) === 0 ? value & 0xff : (value >>> 8) & 0xff;
    }
    // 0x04000000-0x04000056 is the LCD block, owned by the PPU.
    if (this.ppu && address >= 0x04000000 && address <= 0x04000056) {
      const value = this.ppu.readRegister(address & ~1);
      return (address & 1) === 0 ? value & 0xff : (value >>> 8) & 0xff;
    }
    // 0x04000060-0x040000A7 is the sound block, owned by the APU.
    if (this.apu && address >= 0x04000060 && address <= 0x040000a7) {
      const value = this.apu.read(address & ~1);
      return (address & 1) === 0 ? value & 0xff : (value >>> 8) & 0xff;
    }

    switch (address) {
      // KEYINPUT is inverted: a bit reads 0 while its button is held.
      case 0x04000130:
        return this.keypad.readKeyInput() & 0xff;
      case 0x04000131:
        return (this.keypad.readKeyInput() >>> 8) & 0xff;
      case 0x04000132:
        return this.keypad.readKeyControl() & 0xff;
      case 0x04000133:
        return (this.keypad.readKeyControl() >>> 8) & 0xff;
      case 0x04000200:
        return this.ie & 0xff;
      case 0x04000201:
        return (this.ie >>> 8) & 0xff;
      case 0x04000202:
        return this.irqFlags & 0xff;
      case 0x04000203:
        return (this.irqFlags >>> 8) & 0xff;
      case 0x04000204:
        return this.waits.waitcnt & 0xff;
      case 0x04000205:
        return (this.waits.waitcnt >>> 8) & 0xff;
      case 0x04000208:
        return this.ime & 0xff;
      case 0x04000209:
        return 0;
      default:
        return this.io[offset]!;
    }
  }

  private writeIo(address: number, byte: number): void {
    const offset = address & 0x3ff;

    // 0x04000060-0x040000A7 is the sound block. Sound registers do not live in `io` — the
    // APU owns them — so without this a byte store (STRB to one envelope byte, or a byte
    // fed to a FIFO) landed in the io array and never reached the APU.
    if (this.apu && address >= 0x04000060 && address <= 0x040000a7) {
      this.apu.write8(address, byte);
      return;
    }

    switch (address) {
      // KEYINPUT is read-only; only KEYCNT accepts writes.
      case 0x04000130:
      case 0x04000131:
        return;
      case 0x04000132:
        this.keypad.writeKeyControl((this.keypad.readKeyControl() & 0xff00) | byte);
        return;
      case 0x04000133:
        this.keypad.writeKeyControl((this.keypad.readKeyControl() & 0x00ff) | (byte << 8));
        return;
      case 0x04000200:
        this.ie = (this.ie & 0xff00) | byte;
        return;
      case 0x04000201:
        this.ie = (this.ie & 0x00ff) | (byte << 8);
        return;
      // Writing IF ACKNOWLEDGES: a 1 bit CLEARS the corresponding flag.
      case 0x04000202:
        this.irqFlags &= ~byte;
        return;
      case 0x04000203:
        this.irqFlags &= ~(byte << 8);
        return;
      case 0x04000204:
        this.waits.setControl((this.waits.waitcnt & 0xff00) | byte);
        return;
      case 0x04000205:
        this.waits.setControl((this.waits.waitcnt & 0x00ff) | (byte << 8));
        return;
      case 0x04000208:
        this.ime = byte & 1;
        return;
      default:
        break;
    }

    this.io[offset] = byte;
  }

  private writeIo16(address: number, value: number): void {
    if (this.ppu && address >= 0x04000000 && address <= 0x04000056) {
      this.ppu.writeRegister(address, value);
      return;
    }
    if (this.apu && address >= 0x04000060 && address <= 0x040000a7) {
      this.apu.write(address, value);
      return;
    }
    if (address >= 0x040000b0 && address <= 0x040000df) {
      this.dma.write16(address, value);
      return;
    }
    if (address >= 0x04000100 && address <= 0x0400010f) {
      this.timers.write16(address, value);
      return;
    }
    this.writeIo(address, value & 0xff);
    this.writeIo(address + 1, (value >>> 8) & 0xff);
  }
}

/** VRAM is 96KB in a 128KB window: the last 32KB block repeats. */
function vramOffset(address: number): number {
  let offset = address & 0x1ffff;
  if (offset >= 0x18000) offset -= 0x8000;
  return offset;
}
