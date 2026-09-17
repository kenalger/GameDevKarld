import type { MemoryBus } from '../../shared/types/bus.js';
import type { Cartridge } from '../../shared/types/cartridge.js';
import type { InterruptController } from '../cpu/interrupts.js';
import type { Timer } from '../timer/Timer.js';
import type { Serial } from '../serial/Serial.js';
import type { Ppu } from '../ppu/Ppu.js';
import type { Joypad } from '../input/Joypad.js';
import type { Apu } from '../apu/Apu.js';
import { IO_READ_MASK, POST_BOOT_IO } from './ioMasks.js';
import { OamDma } from './OamDma.js';
import { Hdma } from './Hdma.js';
import type { StateReader, StateWriter } from '../state/StateBuffer.js';

/**
 * The DMG memory bus.
 *
 * Reads and writes are BEHAVIOR, not storage. Unmapped I/O bits read as 1, echo RAM is an
 * address fold rather than a copy, and the prohibited region has its own rules. Getting
 * these right is what lets a test ROM boot at all.
 *
 * Hot path: no allocation in read/write, ever.
 */
export class Mmu implements MemoryBus {
  /**
   * VRAM and OAM are owned by the core and shared by reference with the PPU, which reads
   * them directly — the renderer is not subject to its own CPU-facing lockout.
   */
  private readonly vram: Uint8Array;
  private readonly oam: Uint8Array;

  /** 8 banks of 4KB on CGB; a DMG uses only the first two. */
  private readonly wram = new Uint8Array(0x8000);

  /** CGB mode enables VRAM/WRAM banking, HDMA and the colour palette registers. */
  cgb = false;

  /** FF70. Bank 0 aliases to 1 — selecting it does NOT give you a second copy of WRAM0. */
  private wramBank = 1;

  /** FF4D. Bit 0 requests a speed switch; bit 7 reports the current speed. */
  keyOne = 0;

  readonly hdma = new Hdma(
    { read: (a) => this.readDirect(a), write: () => undefined },
    (offset, value) => {
      // HDMA always targets the CURRENTLY selected VRAM bank.
      this.vram[this.vramBankOffset() + offset] = value;
    },
  );
  private readonly hram = new Uint8Array(0x7f);

  /** Unimplemented I/O still needs to hold written values for read-back. */
  private readonly io = new Uint8Array(0x80);

  private cartridge: Cartridge | null = null;

  /** Cycle-stepped, bus-locking OAM DMA. Ticked from the core's T-cycle hook. */
  readonly oamDma = new OamDma(
    (address) => this.readDirect(address),
    (index, value) => {
      this.oam[index] = value;
    },
  );

  constructor(
    private readonly interrupts: InterruptController,
    private readonly timer: Timer,
    private readonly serial: Serial,
    private readonly lcd: Ppu,
    private readonly joypad: Joypad,
    private readonly apu: Apu,
    vram: Uint8Array,
    oam: Uint8Array,
  ) {
    this.vram = vram;
    this.oam = oam;
  }

  setCartridge(cartridge: Cartridge): void {
    this.cartridge = cartridge;
  }

  reset(): void {
    this.vram.fill(0);
    this.wram.fill(0);
    this.oam.fill(0);
    this.hram.fill(0);
    this.io.fill(0);
    // There is no boot ROM, so restore the state one would have left behind.
    for (const [offset, value] of Object.entries(POST_BOOT_IO)) {
      this.io[Number(offset)] = value;
    }
  }

  tickT(): void {
    this.oamDma.tickT();
  }

  private vramBankOffset(): number {
    return this.cgb && this.lcd.vramBank === 1 ? 0x2000 : 0;
  }

  private wramBankOffset(): number {
    if (!this.cgb) return 0x1000;
    // Bank 0 aliases to 1.
    return Math.max(1, this.wramBank & 0x07) * 0x1000;
  }

  read(address: number): number {
    const addr = address & 0xffff;

    // While DMA runs it owns ONE of the two buses — see OamDma.conflictsWith. An access
    // on that bus reads the byte the transfer is currently moving.
    if (this.oamDma.conflictsWith(addr)) return this.oamDma.conflictValue;
    // OAM itself is locked for the whole transfer, whichever bus the source is on.
    if (this.oamDma.isActive && addr >= 0xfe00 && addr < 0xfea0) return 0xff;

    // The PPU locks the CPU out of VRAM during mode 3 and OAM during modes 2 and 3.
    // The renderer reads its own copy directly and is unaffected.
    if (addr >= 0x8000 && addr < 0xa000 && this.lcd.vramBlocked) return 0xff;
    if (addr >= 0xfe00 && addr < 0xfea0 && this.lcd.oamBlocked) return 0xff;

    return this.readDirect(addr);
  }

  /** Bypasses the DMA bus conflict. Used by the DMA itself and by the debugger. */
  private readDirect(address: number): number {
    const addr = address & 0xffff;

    // 0x0000-0x7FFF ROM, 0xA000-0xBFFF cartridge RAM
    if (addr < 0x8000) return this.cartridge?.read(addr) ?? 0xff;
    if (addr < 0xa000) return this.vram[this.vramBankOffset() + addr - 0x8000]!;
    if (addr < 0xc000) return this.cartridge?.read(addr) ?? 0xff;
    if (addr < 0xd000) return this.wram[addr - 0xc000]!;
    if (addr < 0xe000) return this.wram[this.wramBankOffset() + (addr - 0xd000)]!;

    // Echo RAM: a fold of 0xC000-0xDDFF, not a copy. Real games do hit it.
    // This folds back into readDirect, NOT read: an OAM DMA sourced from echo RAM would
    // otherwise re-enter the bus-conflict path and copy its own output.
    if (addr < 0xfe00) return this.readDirect((addr - 0x2000) & 0xffff);

    if (addr < 0xfea0) return this.oam[addr - 0xfe00]!;

    // 0xFEA0-0xFEFF is prohibited; on a DMG it reads back 0x00.
    if (addr < 0xff00) return 0x00;

    if (addr < 0xff80) return this.readIo(addr);
    if (addr < 0xffff) return this.hram[addr - 0xff80]!;
    return this.interrupts.ie;
  }

  write(address: number, value: number): void {
    const addr = address & 0xffff;
    const byte = value & 0xff;

    // The transfer owns the bus it is using, and owns OAM outright: a CPU write into
    // either is lost. Mooneye's push_timing turns on exactly this — it pushes across the
    // end of a transfer and requires the high byte to vanish and the low byte to land.
    if (this.oamDma.conflictsWith(addr)) return;
    if (this.oamDma.isActive && addr >= 0xfe00 && addr < 0xfea0) return;

    if (addr < 0x8000) {
      this.cartridge?.write(addr, byte);
      return;
    }
    if (addr < 0xa000) {
      if (!this.lcd.vramBlocked) this.vram[this.vramBankOffset() + addr - 0x8000] = byte;
      return;
    }
    if (addr < 0xc000) {
      this.cartridge?.write(addr, byte);
      return;
    }
    if (addr < 0xd000) {
      this.wram[addr - 0xc000] = byte;
      return;
    }
    if (addr < 0xe000) {
      this.wram[this.wramBankOffset() + (addr - 0xd000)] = byte;
      return;
    }
    if (addr < 0xfe00) {
      this.write((addr - 0x2000) & 0xffff, byte);
      return;
    }
    if (addr < 0xfea0) {
      // OAM DMA writes go straight to storage; only the CPU is locked out.
      if (!this.lcd.oamBlocked) this.oam[addr - 0xfe00] = byte;
      return;
    }
    if (addr < 0xff00) return; // prohibited
    if (addr < 0xff80) {
      this.writeIo(addr, byte);
      return;
    }
    if (addr < 0xffff) {
      this.hram[addr - 0xff80] = byte;
      return;
    }
    this.interrupts.ie = byte;
  }

  private readIo(addr: number): number {
    const offset = addr - 0xff00;
    const mask = IO_READ_MASK[offset]!;

    // Entirely unmapped registers read as 0xFF and have no backing state.
    if (mask === 0xff) return 0xff;

    let value: number;
    switch (addr) {
      case 0xff00:
        value = this.joypad.read();
        break;
      case 0xff01:
      case 0xff02:
        value = this.serial.read(addr);
        break;
      case 0xff04:
      case 0xff05:
      case 0xff06:
      case 0xff07:
        value = this.timer.read(addr);
        break;
      case 0xff0f:
        value = this.interrupts.if;
        break;
      // DMA's source page register is plain storage, not an LCD register.
      case 0xff46:
        value = this.io[0x46]!;
        break;
      // ---- CGB registers. On a DMG every one of these reads back as 0xFF. ----
      case 0xff4d:
        value = this.cgb ? this.keyOne | 0x7e : 0xff;
        break;
      case 0xff4f:
        value = this.cgb ? this.lcd.vramBank | 0xfe : 0xff;
        break;
      case 0xff51:
      case 0xff52:
      case 0xff53:
      case 0xff54:
      case 0xff55:
        value = this.cgb ? this.hdma.read(addr) : 0xff;
        break;
      case 0xff68:
        value = this.cgb ? this.lcd.bgPalettes.readIndex() : 0xff;
        break;
      case 0xff69:
        value = this.cgb ? this.lcd.bgPalettes.readData() : 0xff;
        break;
      case 0xff6a:
        value = this.cgb ? this.lcd.objPalettes.readIndex() : 0xff;
        break;
      case 0xff6b:
        value = this.cgb ? this.lcd.objPalettes.readData() : 0xff;
        break;
      case 0xff70:
        value = this.cgb ? this.wramBank | 0xf8 : 0xff;
        break;
      default:
        if (addr >= 0xff10 && addr <= 0xff3f) value = this.apu.read(addr);
        else if (addr >= 0xff40 && addr <= 0xff4b) value = this.lcd.read(addr);
        else value = this.io[offset]!;
        break;
    }

    // Unimplemented bits of an implemented register always read as 1.
    return (value | mask) & 0xff;
  }

  private writeIo(addr: number, byte: number): void {
    switch (addr) {
      case 0xff00:
        this.joypad.write(byte);
        return;
      case 0xff01:
      case 0xff02:
        this.serial.write(addr, byte);
        return;
      case 0xff04:
      case 0xff05:
      case 0xff06:
      case 0xff07:
        this.timer.write(addr, byte);
        return;
      case 0xff0f:
        this.interrupts.if = byte;
        return;
      case 0xff46:
        this.io[0x46] = byte;
        this.oamDma.request(byte);
        return;
      case 0xff4d:
        // Bit 0 arms a speed switch; the actual swap happens on the next STOP.
        if (this.cgb) this.keyOne = (this.keyOne & 0x80) | (byte & 0x01);
        return;
      case 0xff4f:
        if (this.cgb) this.lcd.vramBank = byte & 0x01;
        return;
      case 0xff51:
      case 0xff52:
      case 0xff53:
      case 0xff54:
      case 0xff55:
        if (this.cgb) this.hdma.write(addr, byte);
        return;
      case 0xff68:
        if (this.cgb) this.lcd.bgPalettes.writeIndex(byte);
        return;
      case 0xff69:
        if (this.cgb) this.lcd.bgPalettes.writeData(byte);
        return;
      case 0xff6a:
        if (this.cgb) this.lcd.objPalettes.writeIndex(byte);
        return;
      case 0xff6b:
        if (this.cgb) this.lcd.objPalettes.writeData(byte);
        return;
      case 0xff70:
        if (this.cgb) this.wramBank = byte & 0x07;
        return;
      default:
        break;
    }

    if (addr >= 0xff10 && addr <= 0xff3f) {
      this.apu.write(addr, byte);
      return;
    }
    if (addr >= 0xff40 && addr <= 0xff4b) {
      this.lcd.write(addr, byte);
      return;
    }
    this.io[addr - 0xff00] = byte;
  }

  /* -------------------------------- save state -------------------------------- */

  saveState(w: StateWriter): void {
    w.bytesOf(this.wram);
    w.bytesOf(this.hram);
    w.bytesOf(this.io);
  }

  loadState(r: StateReader): void {
    r.intoArray(this.wram);
    r.intoArray(this.hram);
    r.intoArray(this.io);
  }

  /** Direct VRAM/OAM access for the renderer and the debugger. Bypasses mode locking. */
  getVram(): Uint8Array {
    return this.vram;
  }

  getOam(): Uint8Array {
    return this.oam;
  }
}
