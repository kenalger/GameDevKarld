import type { EmulatorCore } from './EmulatorCore.js';
import { GameBoyCore } from '../gb/GameBoyCore.js';
import { GameBoyAdvanceCore } from '../gba/GameBoyAdvanceCore.js';
import { detectSystem } from '../gb/cartridge/header.js';
import type { SystemKind } from '../shared/types/system.js';

/**
 * Owns core selection and lifecycle. The frontend talks to this and never to a CPU, PPU or
 * cartridge — see GameDevKarld(1).md §19.
 */
export class EmulatorManager {
  private core: EmulatorCore | null = null;

  /**
   * Loads a cartridge, optionally forcing which core runs it.
   *
   * The header is the truth and `force` is a deliberate override — the one that matters is
   * running a CGB-compatible cartridge on the DMG core, which many games support and which
   * looks completely different. A mismatch is reported rather than silently honoured or
   * silently ignored, because either would look like a bug.
   */
  private detectedSystem: SystemKind | null = null;
  private activeSystem: SystemKind | null = null;

  /** What the cartridge header says, regardless of any override. */
  getDetectedSystem(): SystemKind | null {
    return this.detectedSystem;
  }

  /** Which core is actually running. */
  getActiveSystem(): SystemKind | null {
    return this.activeSystem;
  }

  loadRom(rom: Uint8Array, force?: SystemKind): void {
    const detected = detectSystem(rom);
    const system = force ?? detected;
    this.detectedSystem = detected;
    this.activeSystem = system;
    this.core = createCore(system);
    this.core.loadRom(rom);
  }

  getCore(): EmulatorCore | null {
    return this.core;
  }

  hasRom(): boolean {
    return this.core !== null;
  }

  reset(): void {
    this.core?.reset();
  }

  pause(): void {
    this.core?.pause();
  }

  resume(): void {
    this.core?.resume();
  }

  setInput(pressedMask: number): void {
    this.core?.setInput(pressedMask);
  }

  setAudioSink(sampleRate: number, sink: ((left: number, right: number) => void) | null): void {
    this.core?.setAudioSink(sampleRate, sink);
  }

  runFrame(): void {
    this.core?.runFrame();
  }

  /** One instruction, for the debugger. */
  stepInstruction(): void {
    const core = this.core;
    if (core && 'stepInstruction' in core)
      (core as { stepInstruction(): number }).stepInstruction();
  }
}

function createCore(system: SystemKind): EmulatorCore {
  switch (system) {
    case 'GB':
      return new GameBoyCore();
    case 'GBC':
      // CGB games run on the DMG core until Phase 11; CGB-only titles will misbehave.
      return new GameBoyCore();
    case 'GBA':
      return new GameBoyAdvanceCore();
  }
}
