import type { StateReader, StateWriter } from '../../gb/state/StateBuffer.js';

/** Processor modes, as encoded in the low 5 bits of CPSR. */
export const MODE_USER = 0x10;
export const MODE_FIQ = 0x11;
export const MODE_IRQ = 0x12;
export const MODE_SUPERVISOR = 0x13;
export const MODE_ABORT = 0x17;
export const MODE_UNDEFINED = 0x1b;
export const MODE_SYSTEM = 0x1f;

/** CPSR flag bits. */
export const FLAG_N = 0x80000000;
export const FLAG_Z = 0x40000000;
export const FLAG_C = 0x20000000;
export const FLAG_V = 0x10000000;
export const FLAG_I = 0x00000080;
export const FLAG_F = 0x00000040;
export const FLAG_T = 0x00000020;
export const MODE_MASK = 0x1f;

/**
 * The ARM7TDMI register file.
 *
 * Sixteen general registers are visible at once, but seven modes bank some of them:
 * every privileged mode has its own R13 (SP) and R14 (LR), and FIQ additionally banks
 * R8-R12. Each mode also carries an SPSR to hold the CPSR it interrupted.
 *
 * Switching modes swaps the banked registers in and out of the visible `r` array, so the
 * hot path only ever indexes `r[n]` — no per-access mode check.
 */
export class ArmRegisters {
  /** The 16 currently-visible registers. R15 is PC. */
  readonly r = new Uint32Array(16);

  cpsr = MODE_SYSTEM | FLAG_I | FLAG_F;

  /* Banked copies, indexed by mode bank. */
  private readonly bankedSp = new Uint32Array(6);
  private readonly bankedLr = new Uint32Array(6);
  private readonly bankedSpsr = new Uint32Array(6);
  /** FIQ's private R8-R12, plus the user/system copies swapped out when FIQ is entered. */
  private readonly fiqR8to12 = new Uint32Array(5);
  private readonly userR8to12 = new Uint32Array(5);

  /**
   * Save-state.
   *
   * The banked registers matter as much as the visible ones: restoring a state taken in
   * IRQ mode without them puts the wrong SP back the moment the handler returns.
   */
  saveState(w: StateWriter): void {
    for (let i = 0; i < 16; i++) w.u32(this.r[i]!);
    w.u32(this.cpsr);
    for (let i = 0; i < 6; i++) w.u32(this.bankedSp[i]!);
    for (let i = 0; i < 6; i++) w.u32(this.bankedLr[i]!);
    for (let i = 0; i < 6; i++) w.u32(this.bankedSpsr[i]!);
    for (let i = 0; i < 5; i++) w.u32(this.fiqR8to12[i]!);
    for (let i = 0; i < 5; i++) w.u32(this.userR8to12[i]!);
  }

  loadState(r: StateReader): void {
    for (let i = 0; i < 16; i++) this.r[i] = r.u32();
    this.cpsr = r.u32();
    for (let i = 0; i < 6; i++) this.bankedSp[i] = r.u32();
    for (let i = 0; i < 6; i++) this.bankedLr[i] = r.u32();
    for (let i = 0; i < 6; i++) this.bankedSpsr[i] = r.u32();
    for (let i = 0; i < 5; i++) this.fiqR8to12[i] = r.u32();
    for (let i = 0; i < 5; i++) this.userR8to12[i] = r.u32();
  }

  reset(): void {
    this.r.fill(0);
    this.bankedSp.fill(0);
    this.bankedLr.fill(0);
    this.bankedSpsr.fill(0);
    this.fiqR8to12.fill(0);
    this.userR8to12.fill(0);
    this.cpsr = MODE_SYSTEM | FLAG_I | FLAG_F;

    // Values the BIOS would leave: SP for the three modes software actually uses.
    this.r[13] = 0x03007f00;
    this.bankedSp[bankIndex(MODE_IRQ)] = 0x03007fa0;
    this.bankedSp[bankIndex(MODE_SUPERVISOR)] = 0x03007fe0;
    this.r[15] = 0x08000000;
  }

  get mode(): number {
    return this.cpsr & MODE_MASK;
  }

  get thumb(): boolean {
    return (this.cpsr & FLAG_T) !== 0;
  }

  get flagN(): boolean {
    return (this.cpsr & FLAG_N) !== 0;
  }
  get flagZ(): boolean {
    return (this.cpsr & FLAG_Z) !== 0;
  }
  get flagC(): boolean {
    return (this.cpsr & FLAG_C) !== 0;
  }
  get flagV(): boolean {
    return (this.cpsr & FLAG_V) !== 0;
  }

  setNZ(value: number): void {
    let cpsr = this.cpsr & ~(FLAG_N | FLAG_Z);
    if ((value & 0x80000000) !== 0) cpsr |= FLAG_N;
    if (value >>> 0 === 0) cpsr |= FLAG_Z;
    this.cpsr = cpsr >>> 0;
  }

  setNZC(value: number, carry: boolean): void {
    let cpsr = this.cpsr & ~(FLAG_N | FLAG_Z | FLAG_C);
    if ((value & 0x80000000) !== 0) cpsr |= FLAG_N;
    if (value >>> 0 === 0) cpsr |= FLAG_Z;
    if (carry) cpsr |= FLAG_C;
    this.cpsr = cpsr >>> 0;
  }

  setNZCV(value: number, carry: boolean, overflow: boolean): void {
    let cpsr = this.cpsr & ~(FLAG_N | FLAG_Z | FLAG_C | FLAG_V);
    if ((value & 0x80000000) !== 0) cpsr |= FLAG_N;
    if (value >>> 0 === 0) cpsr |= FLAG_Z;
    if (carry) cpsr |= FLAG_C;
    if (overflow) cpsr |= FLAG_V;
    this.cpsr = cpsr >>> 0;
  }

  /** The SPSR of the current mode. User and System have none and read the CPSR instead. */
  get spsr(): number {
    const mode = this.mode;
    if (mode === MODE_USER || mode === MODE_SYSTEM) return this.cpsr;
    return this.bankedSpsr[bankIndex(mode)]!;
  }

  set spsr(value: number) {
    const mode = this.mode;
    if (mode === MODE_USER || mode === MODE_SYSTEM) return;
    this.bankedSpsr[bankIndex(mode)] = value >>> 0;
  }

  /**
   * Changes mode, swapping the banked registers so `r` always shows the right set.
   *
   * Called on every CPSR write that touches the mode bits and on exception entry.
   */
  switchMode(newMode: number): void {
    const oldMode = this.mode;
    if (oldMode === newMode) return;

    const oldBank = bankIndex(oldMode);
    const newBank = bankIndex(newMode);

    // Stash the current SP/LR into the old mode's slot, pull the new mode's out.
    this.bankedSp[oldBank] = this.r[13]!;
    this.bankedLr[oldBank] = this.r[14]!;
    this.r[13] = this.bankedSp[newBank]!;
    this.r[14] = this.bankedLr[newBank]!;

    // R8-R12 are banked ONLY for FIQ.
    if (oldMode === MODE_FIQ) {
      for (let i = 0; i < 5; i++) {
        this.fiqR8to12[i] = this.r[8 + i]!;
        this.r[8 + i] = this.userR8to12[i]!;
      }
    } else if (newMode === MODE_FIQ) {
      for (let i = 0; i < 5; i++) {
        this.userR8to12[i] = this.r[8 + i]!;
        this.r[8 + i] = this.fiqR8to12[i]!;
      }
    }

    this.cpsr = ((this.cpsr & ~MODE_MASK) | newMode) >>> 0;
  }

  /** Writes CPSR, handling a mode change if the low bits differ. */
  writeCpsr(value: number): void {
    const newMode = value & MODE_MASK;
    if (newMode !== this.mode) this.switchMode(newMode);
    this.cpsr = value >>> 0;
  }
}

/** Maps a mode number onto a compact bank slot. User and System share a bank. */
export function bankIndex(mode: number): number {
  switch (mode) {
    case MODE_FIQ:
      return 1;
    case MODE_IRQ:
      return 2;
    case MODE_SUPERVISOR:
      return 3;
    case MODE_ABORT:
      return 4;
    case MODE_UNDEFINED:
      return 5;
    default:
      return 0;
  }
}
