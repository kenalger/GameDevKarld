import type { EmulatorCore } from './EmulatorCore.js';
import type { CartridgeInfo } from '../shared/types/cartridge.js';
import type { CoreInspector, CpuSnapshot } from '../shared/types/inspection.js';
import { SCREEN_SIZE, type SystemKind } from '../shared/types/system.js';

/**
 * Placeholder core for Phase 00. Renders an animated test pattern so the whole pipeline —
 * ROM bytes in, framebuffer out, canvas on screen — can be proven before any hardware exists.
 *
 * Replaced by GameBoyCore in Phase 01. Do not build features on it.
 */
export class StubCore implements EmulatorCore {
  private readonly width: number;
  private readonly height: number;
  private readonly frameBuffer: Uint8ClampedArray;
  private frame = 0;
  private running = true;
  private romLength = 0;

  constructor(private readonly system: SystemKind = 'GB') {
    const { width, height } = SCREEN_SIZE[system];
    this.width = width;
    this.height = height;
    this.frameBuffer = new Uint8ClampedArray(width * height * 4);
  }

  reset(): void {
    this.frame = 0;
    this.frameBuffer.fill(0);
  }

  pause(): void {
    this.running = false;
  }

  resume(): void {
    this.running = true;
  }

  loadRom(data: Uint8Array): void {
    this.romLength = data.length;
    this.reset();
  }

  setInput(_pressedMask: number): void {
    // The stub has no joypad.
  }

  hasBatterySave(): boolean {
    return false;
  }

  getSaveData(): Uint8Array | null {
    return null;
  }

  loadSaveData(_data: Uint8Array): void {
    // Nothing to load into.
  }

  consumeSaveRamDirty(): boolean {
    return false;
  }

  setAudioSink(_sampleRate: number, _sink: ((left: number, right: number) => void) | null): void {
    // The stub has no APU.
  }

  runFrame(): void {
    if (!this.running) return;
    const { width, height, frameBuffer, frame } = this;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        // Diagonal sweep over a checkerboard: verifies scaling is crisp and motion is smooth.
        const checker = ((x >> 3) + (y >> 3)) & 1;
        const sweep = (x + y + frame) % 160 < 8 ? 255 : 0;
        const shade = checker ? 0x9b : 0x0f;
        frameBuffer[i] = Math.max(shade, sweep);
        frameBuffer[i + 1] = Math.max(checker ? 0xbc : 0x38, sweep);
        frameBuffer[i + 2] = Math.max(checker ? 0x0f : 0x0f, sweep);
        frameBuffer[i + 3] = 0xff;
      }
    }
    this.frame++;
  }

  getFrameBuffer(): Uint8ClampedArray {
    return this.frameBuffer;
  }

  getCartridgeInfo(): CartridgeInfo | null {
    if (this.romLength === 0) return null;
    return {
      title: 'STUB',
      cartridgeType: 0,
      romSize: this.romLength,
      ramSize: 0,
      isColorCapable: false,
      system: this.system,
      saveKey: 'stub',
      headerChecksumValid: false,
    };
  }

  getInspector(): CoreInspector {
    const snapshot: CpuSnapshot = {
      a: 0,
      f: 0,
      b: 0,
      c: 0,
      d: 0,
      e: 0,
      h: 0,
      l: 0,
      pc: 0,
      sp: 0,
      ime: false,
      halted: false,
      cycles: 0,
    };
    return {
      getCpuSnapshot: () => snapshot,
      readMemory: () => 0xff,
      readMemoryRange: (_a, length, out) => out.fill(0xff, 0, length),
      getInstructionCount: () => 0,
      getFrameCount: () => this.frame,
    };
  }

  serialize(): ArrayBuffer {
    return new ArrayBuffer(0);
  }

  deserialize(_data: ArrayBuffer): void {
    // Stub holds no meaningful state.
  }
}
