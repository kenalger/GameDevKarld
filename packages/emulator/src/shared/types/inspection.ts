/**
 * Read-only window into a running core, for the developer debugger (Phase 10).
 *
 * Two rules, both load-bearing:
 *  1. The debugger NEVER mutates core internals through this interface.
 *  2. Inspection must cost the emulator nothing while the panel is closed — implementations
 *     read live state on demand and never snapshot per frame.
 *
 * Defined in Phase 00 on purpose: retrofitting it later means touching every subsystem.
 */
export interface CpuSnapshot {
  readonly a: number;
  readonly f: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly h: number;
  readonly l: number;
  readonly pc: number;
  readonly sp: number;
  readonly ime: boolean;
  readonly halted: boolean;
  readonly cycles: number;
}

export interface CoreInspector {
  getCpuSnapshot(): CpuSnapshot;
  readMemory(address: number): number;
  /** Copies `length` bytes into `out` without disturbing bus side effects where possible. */
  readMemoryRange(address: number, length: number, out: Uint8Array): void;
  getInstructionCount(): number;
  getFrameCount(): number;
}
