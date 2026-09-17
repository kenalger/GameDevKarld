import type { EmulatorCore } from '../core/EmulatorCore.js';
import type { CartridgeInfo } from '../shared/types/cartridge.js';
import type { CoreInspector, CpuSnapshot } from '../shared/types/inspection.js';
import { Cpu } from './cpu/Cpu.js';
import { InterruptController } from './cpu/interrupts.js';
import { Mmu } from './memory/Mmu.js';
import { Timer } from './timer/Timer.js';
import { Serial } from './serial/Serial.js';
import { Ppu, DOTS_PER_FRAME } from './ppu/Ppu.js';
import { createCartridge } from './cartridge/cartridges.js';
import type { Cartridge } from '../shared/types/cartridge.js';
import { Joypad } from './input/Joypad.js';
import { Apu } from './apu/Apu.js';
import { Mbc3Cartridge } from './cartridge/mbc3.js';
import { hasBattery, packSave, unpackSave } from './cartridge/cartridges.js';
import { serializeRtc, deserializeRtc } from './cartridge/rtc.js';
import {
  StateReader,
  StateWriter,
  StateFormatError,
  STATE_MAGIC,
  STATE_MAGIC_GBA,
  STATE_VERSION,
  cartridgeFingerprint,
} from './state/StateBuffer.js';
import { savePpu, loadPpu, saveApu, loadApu, saveMemory, loadMemory } from './state/sections.js';
import { saveCpuState, loadCpuState } from './cpu/Cpu.js';

/** A frame is 70224 dots; the cap is generous slack against a runaway loop. */
const MAX_T_CYCLES_PER_FRAME = DOTS_PER_FRAME * 2;

/**
 * The original Game Boy (DMG).
 *
 * Wiring note: VRAM and OAM are allocated here and shared by reference with both the MMU
 * (which gates CPU access by PPU mode) and the PPU (which reads them directly, as the real
 * hardware does — the PPU is not subject to its own lockout).
 */
export class GameBoyCore implements EmulatorCore {
  readonly interrupts = new InterruptController();
  readonly timer = new Timer(this.interrupts);
  readonly serial = new Serial(this.interrupts);

  /** Two 8KB banks. A DMG uses only the first; CGB puts tile attributes in the second. */
  readonly vram = new Uint8Array(0x4000);
  readonly oam = new Uint8Array(0xa0);

  readonly joypad = new Joypad(this.interrupts);
  readonly apu = new Apu();
  readonly ppu: Ppu;
  readonly mmu: Mmu;
  readonly cpu: Cpu;

  /** True when running a CGB-capable cartridge. */
  cgb = false;

  private info: CartridgeInfo | null = null;
  private cartridge: Cartridge | null = null;
  private running = true;
  private frameComplete = false;
  private frames = 0;
  private instructions = 0;

  constructor() {
    this.ppu = new Ppu(this.interrupts, this.vram, this.oam);
    this.mmu = new Mmu(
      this.interrupts,
      this.timer,
      this.serial,
      this.ppu,
      this.joypad,
      this.apu,
      this.vram,
      this.oam,
    );
    this.cpu = new Cpu(this.mmu, this.interrupts);

    // Every T-cycle of CPU time advances the rest of the machine in lockstep. This is the
    // Phase 01 timing decision paying off: subsystems tick per access, not per instruction.
    this.cpu.onTCycle = () => {
      this.timer.tickT();
      // The APU's frame sequencer runs off a DIV bit, so the timer must advance first.
      this.apu.tickT(this.timer.apuClockBit);
      this.mmu.tickT();
      if (this.ppu.tickT()) this.frameComplete = true;
    };
  }

  loadRom(data: Uint8Array): void {
    const { cartridge, info } = createCartridge(data);
    this.info = info;
    this.cartridge = cartridge;

    // CGB mode comes from the cartridge header and switches the PPU, bus and timer
    // behaviour in place, rather than selecting a separate core. That is the plan's
    // "reuse where hardware behaviour is shared, do not duplicate" rule.
    const cgb = info.isColorCapable;
    this.cgb = cgb;
    this.ppu.cgb = cgb;
    this.mmu.cgb = cgb;
    this.apu.cgb = cgb;

    this.mmu.setCartridge(cartridge);
    this.reset();
  }

  reset(): void {
    this.mmu.reset();
    this.mmu.oamDma.reset();
    this.mmu.hdma.reset();
    this.interrupts.reset();
    this.timer.reset();
    this.serial.reset();
    this.ppu.reset();
    this.joypad.reset();
    this.apu.reset();
    this.cpu.reset();
    this.frames = 0;
    this.instructions = 0;
    this.frameComplete = false;

    // Post-boot state for a DMG. There is no boot ROM, so the values it would have left
    // behind are set directly — test ROMs depend on them.
    const r = this.cpu.regs;
    // A CGB boot ROM leaves A = 0x11; software reads it to detect the hardware.
    r.a = this.cgb ? 0x11 : 0x01;
    r.f = 0xb0;
    r.b = 0x00;
    r.c = 0x13;
    r.d = 0x00;
    r.e = 0xd8;
    r.h = 0x01;
    r.l = 0x4d;
    r.sp = 0xfffe;
    r.pc = 0x0100;
    this.interrupts.if = 0xe1;
  }

  setInput(pressedMask: number): void {
    this.joypad.setState(pressedMask);
  }

  /* ------------------------------ battery saves ------------------------------ */

  /** True only for cartridges with a battery — others have nothing worth persisting. */
  hasBatterySave(): boolean {
    return this.info !== null && hasBattery(this.info.cartridgeType);
  }

  /**
   * The complete battery save: SRAM, plus a 48-byte RTC tail for clock cartridges.
   *
   * The RTC tail carries a real-world timestamp, which is what lets an MBC3 clock keep
   * running while the game is closed. Without it, a game with a day/night cycle would
   * freeze in time between sessions.
   */
  getSaveData(): Uint8Array | null {
    const cartridge = this.cartridge;
    if (!cartridge || !this.hasBatterySave()) return null;

    const sram = cartridge.getSaveRam() ?? new Uint8Array(0);
    const rtc =
      cartridge instanceof Mbc3Cartridge
        ? (cartridge.tickRtc(), serializeRtc(cartridge.getRtcState()))
        : null;

    if (sram.length === 0 && !rtc) return null;
    return packSave({ sram, rtc });
  }

  loadSaveData(data: Uint8Array): void {
    const cartridge = this.cartridge;
    if (!cartridge) return;

    const sramSize = cartridge.getSaveRam()?.length ?? 0;
    const { sram, rtc } = unpackSave(data, sramSize);
    if (sram.length > 0) cartridge.loadSaveRam(sram);
    if (rtc && cartridge instanceof Mbc3Cartridge) {
      const state = deserializeRtc(rtc);
      if (state) cartridge.loadRtcState(state);
    }
  }

  /** Returns whether SRAM changed since the last call, and clears the flag. */
  consumeSaveRamDirty(): boolean {
    const cartridge = this.cartridge;
    if (!cartridge?.saveRamDirty) return false;
    cartridge.clearSaveRamDirty();
    return true;
  }

  setAudioSink(sampleRate: number, sink: ((left: number, right: number) => void) | null): void {
    if (sink) this.apu.setOutputRate(sampleRate, sink);
    else this.apu.clearSink();
  }

  pause(): void {
    this.running = false;
  }

  resume(): void {
    this.running = true;
  }

  runFrame(): void {
    if (!this.running) return;
    this.frameComplete = false;
    let elapsed = 0;
    while (!this.frameComplete && elapsed < MAX_T_CYCLES_PER_FRAME) {
      elapsed += this.cpu.step();
      this.instructions++;
    }
    this.frames++;
  }

  /** Runs a single instruction. Used by the headless harness and the debugger. */
  stepInstruction(): number {
    const cycles = this.cpu.step();
    this.instructions++;
    return cycles;
  }

  getFrameBuffer(): Uint8ClampedArray {
    return this.ppu.frameBuffer;
  }

  getCartridgeInfo(): CartridgeInfo | null {
    return this.info;
  }

  getInspector(): CoreInspector {
    return {
      getCpuSnapshot: (): CpuSnapshot => {
        const r = this.cpu.regs;
        return {
          a: r.a,
          f: r.f,
          b: r.b,
          c: r.c,
          d: r.d,
          e: r.e,
          h: r.h,
          l: r.l,
          pc: r.pc,
          sp: r.sp,
          ime: this.cpu.ime,
          halted: this.cpu.halted,
          cycles: this.cpu.cycles,
        };
      },
      readMemory: (address: number) => this.mmu.read(address),
      readMemoryRange: (address: number, length: number, out: Uint8Array) => {
        for (let i = 0; i < length; i++) out[i] = this.mmu.read(address + i);
      },
      getInstructionCount: () => this.instructions,
      getFrameCount: () => this.frames,
    };
  }

  /* -------------------------------- save states ------------------------------- */

  /**
   * The complete machine state, as a versioned binary blob.
   *
   * Layout: magic, format version, a hash of the cartridge identity, then one section per
   * subsystem in a fixed order. The cartridge hash is what lets a load refuse a state
   * belonging to a different game instead of resuming into nonsense.
   */
  serialize(): ArrayBuffer {
    if (!this.cartridge)
      throw new StateFormatError('No ROM is loaded, so there is no state to save.');

    const w = new StateWriter();
    w.u32(STATE_MAGIC);
    w.u16(STATE_VERSION);
    w.u32(cartridgeFingerprint(this.info));

    saveCpuState(this.cpu, w);
    this.timer.saveState(w);
    this.joypad.saveState(w);
    savePpu(this.ppu, w);
    saveApu(this.apu, w);
    saveMemory(this.mmu, this.vram, this.oam, this.cartridge, w);

    const bytes = w.finish();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  deserialize(data: ArrayBuffer): void {
    if (!this.cartridge) throw new StateFormatError('Load a ROM before restoring a save state.');

    const r = new StateReader(new Uint8Array(data));

    const magic = r.u32();
    if (magic === STATE_MAGIC_GBA) {
      throw new StateFormatError('That is a Game Boy Advance save state. Load it with a GBA game.');
    }
    if (magic !== STATE_MAGIC) {
      throw new StateFormatError('That file is not a WebBoy save state.');
    }

    const version = r.u16();
    if (version !== STATE_VERSION) {
      // Refuse rather than misparse. A state that loads wrong looks like it worked and
      // then corrupts the save.
      throw new StateFormatError(
        `This save state was written by a different version of WebBoy (format ${version}, this build expects ${STATE_VERSION}) and cannot be loaded.`,
      );
    }

    const fingerprint = r.u32();
    if (fingerprint !== cartridgeFingerprint(this.info)) {
      throw new StateFormatError('This save state belongs to a different game.');
    }

    loadCpuState(this.cpu, r);
    this.timer.loadState(r);
    this.joypad.loadState(r);
    loadPpu(this.ppu, r);
    loadApu(this.apu, r);
    loadMemory(this.mmu, this.vram, this.oam, this.cartridge, r);

    this.mmu.oamDma.reset();
    this.frameComplete = false;
  }
}
