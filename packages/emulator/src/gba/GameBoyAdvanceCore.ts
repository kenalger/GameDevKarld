import type { EmulatorCore } from '../core/EmulatorCore.js';
import type { CartridgeInfo } from '../shared/types/cartridge.js';
import type { CoreInspector, CpuSnapshot } from '../shared/types/inspection.js';
import { Arm7 } from './cpu/Arm7.js';
import { GbaBios } from './bios/GbaBios.js';
import { GbaMmu } from './memory/GbaMmu.js';
import { GbaPpu, GBA_HEIGHT, GBA_WIDTH, DOTS_PER_LINE, LINES_PER_FRAME } from './video/GbaPpu.js';
import { parseHeader } from '../gb/cartridge/header.js';
import { fromGameBoyMask } from './input/GbaKeypad.js';
import { GbaApu } from './audio/GbaApu.js';
import {
  StateReader,
  StateWriter,
  StateFormatError,
  STATE_MAGIC,
  STATE_MAGIC_GBA,
  STATE_VERSION,
  cartridgeFingerprint,
} from '../gb/state/StateBuffer.js';

const DOTS_PER_FRAME = DOTS_PER_LINE * LINES_PER_FRAME;

/**
 * The Game Boy Advance.
 *
 * A separate core from the Game Boy, as the roadmap requires — it shares the EmulatorCore
 * contract and nothing else. The CPU, bus and PPU are all GBA-specific.
 */
export class GameBoyAdvanceCore implements EmulatorCore {
  readonly mmu = new GbaMmu();
  readonly ppu: GbaPpu;
  readonly apu = new GbaApu();
  readonly cpu: Arm7;
  /** The BIOS, emulated natively: WebBoy ships no BIOS image and cannot. */
  readonly bios: GbaBios;

  private info: CartridgeInfo | null = null;
  private running = true;
  private frameComplete = false;
  private frames = 0;
  private instructions = 0;

  constructor() {
    this.ppu = new GbaPpu({
      vram: this.mmu.vram,
      palette: this.mmu.palette,
      oam: this.mmu.oam,
      readIo16: (address) => this.mmu.read16(address),
      requestInterrupt: (mask) => this.mmu.requestInterrupt(mask),
      onHBlank: () => this.mmu.dma.notifyHBlank(),
      onVBlank: () => this.mmu.dma.notifyVBlank(),
    });
    this.mmu.ppu = this.ppu;
    this.mmu.apu = this.apu;

    // Direct Sound: a timer overflow pops one FIFO byte, and an empty-ish FIFO asks DMA
    // 1 or 2 to refill it. That loop spans three subsystems, and this is where it closes.
    this.mmu.timers.onFifoTick = (timerIndex: number) => this.apu.notifyTimerOverflow(timerIndex);
    this.apu.onFifoRefill = (fifo: 0 | 1) => this.mmu.dma.notifyFifo(fifo === 0 ? 1 : 2);
    this.cpu = new Arm7(this.mmu);
    this.bios = new GbaBios(this.cpu, this.mmu);
    this.cpu.bios = this.bios;
    this.mmu.onInterrupt = () => {
      this.cpu.irqPending = true;
    };
  }

  loadRom(data: Uint8Array): void {
    this.info = parseHeader(data);
    this.mmu.loadRom(data);
    this.reset();
  }

  reset(): void {
    this.mmu.reset();
    this.ppu.reset();
    this.apu.reset();
    this.cpu.reset();
    this.bios.reset();
    this.frames = 0;
    this.instructions = 0;
    this.frameComplete = false;
  }

  setInput(pressedMask: number): void {
    // The host speaks the shared 8-bit Game Boy layout; the GBA adds L and R and orders
    // its bits differently, so the mask is translated rather than passed through.
    this.mmu.keypad.setState(fromGameBoyMask(pressedMask));
  }

  hasBatterySave(): boolean {
    return this.mmu.backup.getType() !== 'none';
  }

  getSaveData(): Uint8Array | null {
    return this.mmu.backup.getSaveData();
  }

  loadSaveData(data: Uint8Array): void {
    this.mmu.backup.loadSaveData(data);
  }

  consumeSaveRamDirty(): boolean {
    if (!this.mmu.backup.isDirty) return false;
    this.mmu.backup.clearDirty();
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

    let dots = 0;
    while (!this.frameComplete && dots < DOTS_PER_FRAME * 2) {
      // DMA halts the CPU while it runs, so service it first.
      if (this.mmu.dma.busy) {
        const cycles = this.mmu.dma.run();
        this.advance(cycles);
        dots += cycles;
        continue;
      }

      this.cpu.irqPending = this.mmu.irqPending;
      const cycles = this.cpu.step();
      this.instructions++;
      this.advance(cycles);
      dots += cycles;
    }
    this.frames++;
  }

  /** Advances the PPU and timers by `cycles` of CPU time. */
  private advance(cycles: number): void {
    for (let i = 0; i < cycles; i++) {
      if (this.ppu.tick()) this.frameComplete = true;
      this.apu.tick();
    }
    this.mmu.timers.tick(cycles);
  }

  /**
   * One step of the machine: a DMA burst if one is pending, otherwise one instruction.
   *
   * The interrupt line is re-sampled here exactly as `runFrame` does. Leaving it out made
   * `stepInstruction` a subtly different machine from the one `runFrame` runs: a pending
   * IRQ latched by `onInterrupt` would never clear, so the CPU serviced it over and over.
   */
  stepInstruction(): number {
    if (this.mmu.dma.busy) {
      const dmaCycles = this.mmu.dma.run();
      this.advance(dmaCycles);
      return dmaCycles;
    }
    this.cpu.irqPending = this.mmu.irqPending;
    const cycles = this.cpu.step();
    this.instructions++;
    this.advance(cycles);
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
        const r = this.cpu.regs.r;
        // The GB-shaped snapshot cannot express 32-bit ARM state; the low registers are
        // surfaced so the debugger has something useful until it grows an ARM view.
        return {
          a: r[0]! & 0xff,
          f: r[1]! & 0xff,
          b: r[2]! & 0xff,
          c: r[3]! & 0xff,
          d: r[4]! & 0xff,
          e: r[5]! & 0xff,
          h: r[6]! & 0xff,
          l: r[7]! & 0xff,
          pc: r[15]! & 0xffff,
          sp: r[13]! & 0xffff,
          ime: this.mmu.ime !== 0,
          halted: this.cpu.halted,
          cycles: this.cpu.cycles,
        };
      },
      readMemory: (address: number) => this.mmu.read8(address),
      readMemoryRange: (address: number, length: number, out: Uint8Array) => {
        for (let i = 0; i < length; i++) out[i] = this.mmu.read8(address + i);
      },
      getInstructionCount: () => this.instructions,
      getFrameCount: () => this.frames,
    };
  }

  /**
   * Save-state.
   *
   * Same container as the Game Boy — magic, format version, cartridge fingerprint — but a
   * GBA-specific magic, because the sections that follow share nothing with a DMG state.
   * The BIOS and ROM are not written: the host supplies both, and a save state is machine
   * state, not a copy of the cartridge.
   */
  serialize(): ArrayBuffer {
    if (!this.info) throw new StateFormatError('No ROM is loaded, so there is no state to save.');

    const w = new StateWriter(512 * 1024);
    w.u32(STATE_MAGIC_GBA);
    w.u16(STATE_VERSION);
    w.u32(cartridgeFingerprint(this.info));

    this.cpu.saveState(w);
    this.mmu.saveState(w);
    this.ppu.saveState(w);
    this.apu.saveState(w);
    w.f64(this.frames);
    w.f64(this.instructions);
    w.bool(this.running);

    const bytes = w.finish();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  deserialize(data: ArrayBuffer): void {
    if (!this.info) throw new StateFormatError('Load a ROM before restoring a save state.');

    const r = new StateReader(new Uint8Array(data));

    const magic = r.u32();
    if (magic === STATE_MAGIC) {
      throw new StateFormatError('That is a Game Boy save state. Load it with a Game Boy game.');
    }
    if (magic !== STATE_MAGIC_GBA) {
      throw new StateFormatError('That file is not a WebBoy save state.');
    }

    const version = r.u16();
    if (version !== STATE_VERSION) {
      // Refuse rather than misparse: a state that loads wrong looks like it worked.
      throw new StateFormatError(
        `This save state was written by a different version of WebBoy (format ${version}, this build expects ${STATE_VERSION}) and cannot be loaded.`,
      );
    }

    if (r.u32() !== cartridgeFingerprint(this.info)) {
      throw new StateFormatError('This save state belongs to a different game.');
    }

    this.cpu.loadState(r);
    this.mmu.loadState(r);
    this.ppu.loadState(r);
    this.apu.loadState(r);
    this.frames = r.f64();
    this.instructions = r.f64();
    this.running = r.bool();
    this.frameComplete = false;
  }
}

export { GBA_WIDTH, GBA_HEIGHT };
