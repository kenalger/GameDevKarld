import type { CoreInspector } from '../shared/types/inspection.js';
import type { CartridgeInfo } from '../shared/types/cartridge.js';
import type { Serializable } from '../shared/types/serialization.js';

/**
 * The contract between the application and any emulated system.
 * The frontend depends on this and on nothing below it — never on a CPU, PPU or cartridge.
 *
 * Shape fixed by GameDevKarld(1).md §7.
 */
export interface EmulatorCore extends Serializable {
  reset(): void;
  runFrame(): void;
  pause(): void;
  resume(): void;
  loadRom(data: Uint8Array): void;

  /**
   * Applies the complete button state, as a bitmask.
   *
   * Called once per frame from the host, at a defined point in emulated time. DOM events
   * must never poke emulator state directly — they arrive asynchronously relative to the
   * emulator, so a fast tap between frames would be lost or double-counted.
   */
  setInput(pressedMask: number): void;

  /* ------------------------------ battery saves ------------------------------ */

  /** True only for cartridges with a battery; others have nothing to persist. */
  hasBatterySave(): boolean;

  /** The complete save payload, in the `.sav` layout other emulators understand. */
  getSaveData(): Uint8Array | null;

  loadSaveData(data: Uint8Array): void;

  /** Whether save RAM changed since the last call. Clears the flag. */
  consumeSaveRamDirty(): boolean;

  /* ---------------------------------- audio ---------------------------------- */

  /**
   * Routes emulated audio to the host at its own sample rate.
   *
   * The DEVICE picks the rate (44100, 48000, sometimes 96000) — the core decimates to it.
   * Pass null to detach.
   */
  setAudioSink(sampleRate: number, sink: ((left: number, right: number) => void) | null): void;

  /**
   * RGBA framebuffer at the system's native resolution.
   *
   * Returns a STABLE reference — the same buffer every frame, never a copy, never a
   * fresh allocation. The display layer reads it; the core owns it. Must remain
   * transferable / SharedArrayBuffer-backed for the Web Worker move in Phase 10.
   */
  getFrameBuffer(): Uint8ClampedArray;

  getCartridgeInfo(): CartridgeInfo | null;
  getInspector(): CoreInspector;
}
