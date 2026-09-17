import {
  ArmRegisters,
  FLAG_C,
  FLAG_F,
  FLAG_I,
  FLAG_T,
  FLAG_V,
  FLAG_Z,
  FLAG_N,
  MODE_IRQ,
  MODE_SUPERVISOR,
  MODE_UNDEFINED,
  MODE_USER,
  MODE_FIQ,
  MODE_MASK,
} from './registers.js';
import type { StateReader, StateWriter } from '../../gb/state/StateBuffer.js';
import { executeArm } from './armDecoder.js';
import { executeThumb } from './thumbDecoder.js';

/** Memory access width. */
export const ACCESS_BYTE = 1;
export const ACCESS_HALF = 2;
export const ACCESS_WORD = 4;

/**
 * The bus as the CPU sees it. Timing is the bus's business: sequential vs non-sequential
 * access classification originates here and is priced by the memory engineer.
 */
export interface ArmBus {
  read8(address: number): number;
  read16(address: number): number;
  read32(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
  /** Cycles this access costs. `sequential` is true when it follows the previous address. */
  waitstates(address: number, width: number, sequential: boolean): number;
}

export const VECTOR_RESET = 0x00000000;
export const VECTOR_UNDEFINED = 0x00000004;
export const VECTOR_SWI = 0x00000008;
export const VECTOR_IRQ = 0x00000018;
export const VECTOR_FIQ = 0x0000001c;

/**
 * The ARM7TDMI — a separate core from the SM83, sharing only the EmulatorCore contract.
 *
 * Two facts drive the design:
 *
 *  1. **The three-stage pipeline is visible to software.** Reading R15 returns the
 *     address of the current instruction PLUS 8 in ARM state, PLUS 4 in Thumb. Every
 *     PC-relative load, and every `MOV LR, PC`, depends on this. Get it wrong and the
 *     BIOS's first function return jumps into the weeds.
 *
 *  2. **ARM and Thumb are separate decoders** over the same register file and ALU, not
 *     one decoder with a mode flag threaded through it.
 */
export class Arm7 {
  readonly regs = new ArmRegisters();

  /** T-cycles elapsed. */
  cycles = 0;

  /** Pipeline: the instruction being executed, and the one after it. */
  private pipeline0 = 0;
  private pipeline1 = 0;
  private pipelineValid = false;

  /** Set by flushPipeline so step() knows a branch already positioned PC. */
  private branched = false;

  /** Next access is sequential when it immediately follows the last address. */
  private lastAddress = -1;

  /** Set by the memory engineer's interrupt controller; sampled between instructions. */
  irqPending = false;

  halted = false;

  /**
   * Save-state.
   *
   * The prefetch pipeline is part of the machine state, not a cache: PC already points two
   * instructions past the one executing, so dropping the pipeline on restore would run the
   * wrong instruction next.
   */
  saveState(w: StateWriter): void {
    this.regs.saveState(w);
    w.f64(this.cycles);
    w.u32(this.pipeline0);
    w.u32(this.pipeline1);
    w.bool(this.pipelineValid);
    w.bool(this.branched);
    w.u32(this.lastAddress >>> 0);
    w.bool(this.lastAddress < 0);
    w.bool(this.irqPending);
    w.bool(this.halted);
  }

  loadState(r: StateReader): void {
    this.regs.loadState(r);
    this.cycles = r.f64();
    this.pipeline0 = r.u32();
    this.pipeline1 = r.u32();
    this.pipelineValid = r.bool();
    this.branched = r.bool();
    const lastAddress = r.u32();
    this.lastAddress = r.bool() ? -1 : lastAddress;
    this.irqPending = r.bool();
    this.halted = r.bool();
  }

  constructor(readonly bus: ArmBus) {}

  reset(): void {
    this.regs.reset();
    this.cycles = 0;
    this.pipelineValid = false;
    this.lastAddress = -1;
    this.irqPending = false;
    this.halted = false;
  }

  /* ---------------------------------- memory ---------------------------------- */

  private charge(address: number, width: number): void {
    const sequential = address === this.lastAddress + width;
    this.cycles += this.bus.waitstates(address, width, sequential);
    this.lastAddress = address;
  }

  read8(address: number): number {
    this.charge(address, ACCESS_BYTE);
    return this.bus.read8(address >>> 0);
  }

  read16(address: number): number {
    this.charge(address, ACCESS_HALF);
    return this.bus.read16((address & ~1) >>> 0);
  }

  read32(address: number): number {
    this.charge(address, ACCESS_WORD);
    return this.bus.read32((address & ~3) >>> 0);
  }

  /** Misaligned word reads rotate the result — real hardware, and games rely on it. */
  read32Rotated(address: number): number {
    const value = this.read32(address);
    const misalign = (address & 3) * 8;
    return misalign === 0 ? value : ((value >>> misalign) | (value << (32 - misalign))) >>> 0;
  }

  write8(address: number, value: number): void {
    this.charge(address, ACCESS_BYTE);
    this.bus.write8(address >>> 0, value & 0xff);
  }

  // The low address bits are NOT stripped here. A 16-bit device ignores them, and each
  // bus region re-aligns for itself — but SRAM is an 8-bit device that uses A0/A1 to pick
  // which single byte of the value actually lands.
  write16(address: number, value: number): void {
    this.charge(address, ACCESS_HALF);
    this.bus.write16(address >>> 0, value & 0xffff);
  }

  write32(address: number, value: number): void {
    this.charge(address, ACCESS_WORD);
    this.bus.write32(address >>> 0, value >>> 0);
  }

  /** An internal cycle: the CPU is busy with no bus activity. */
  internal(count = 1): void {
    this.cycles += count;
    this.lastAddress = -1;
  }

  /* --------------------------------- pipeline --------------------------------- */

  /**
   * Refills the pipeline after a branch or mode change. Software sees PC = address + 8
   * (ARM) or + 4 (Thumb) precisely because two instructions are always fetched ahead.
   */
  flushPipeline(): void {
    const r = this.regs.r;
    if (this.regs.thumb) {
      r[15] = (r[15]! & ~1) >>> 0;
      this.pipeline0 = this.read16(r[15]!);
      this.pipeline1 = this.read16(r[15]! + 2);
      r[15] = (r[15]! + 4) >>> 0;
    } else {
      r[15] = (r[15]! & ~3) >>> 0;
      this.pipeline0 = this.read32(r[15]!);
      this.pipeline1 = this.read32(r[15]! + 4);
      r[15] = (r[15]! + 8) >>> 0;
    }
    this.pipelineValid = true;
    this.branched = true;
  }

  /** Runs one instruction. Returns cycles consumed. */
  step(): number {
    const before = this.cycles;

    if (!this.pipelineValid) this.flushPipeline();

    if (this.irqPending && (this.regs.cpsr & FLAG_I) === 0) {
      this.halted = false;
      this.raiseException(VECTOR_IRQ, MODE_IRQ);
      return this.cycles - before;
    }

    if (this.halted) {
      this.internal();
      return this.cycles - before;
    }

    const r = this.regs.r;
    const opcode = this.pipeline0;
    this.pipeline0 = this.pipeline1;

    // During execution R15 must read as instruction + 8 (ARM) / + 4 (Thumb) — which is
    // exactly where flushPipeline left it. Fetch the next word into the pipeline now, but
    // only advance PC AFTER the instruction runs, or every PC-relative operation and every
    // BL return address lands one instruction late.
    // A flag, not a PC comparison: a branch target's post-flush PC can coincidentally
    // equal the old PC (e.g. BX to the very next word), and a comparison would then
    // advance PC a second time and skip an instruction.
    this.branched = false;
    const pcBefore = r[15]!;
    if (this.regs.thumb) {
      this.pipeline1 = this.read16(pcBefore);
      executeThumb(this, opcode);
      if (!this.branched) r[15] = (pcBefore + 2) >>> 0;
    } else {
      this.pipeline1 = this.read32(pcBefore);
      executeArm(this, opcode);
      if (!this.branched) r[15] = (pcBefore + 4) >>> 0;
    }

    return this.cycles - before;
  }

  /** Called by any instruction that writes PC. */
  branchTo(address: number): void {
    this.regs.r[15] = address >>> 0;
    this.flushPipeline();
  }

  /** BX: bit 0 of the target selects Thumb state. */
  branchExchange(address: number): void {
    if ((address & 1) !== 0) this.regs.cpsr |= FLAG_T;
    else this.regs.cpsr &= ~FLAG_T;
    this.branchTo(address & ~1);
  }

  /* -------------------------------- exceptions -------------------------------- */

  /**
   * Exception entry: save CPSR into the new mode's SPSR, save the return address in its
   * LR, disable IRQ, switch to ARM state, and jump to the vector.
   */
  raiseException(vector: number, mode: number): void {
    const oldCpsr = this.regs.cpsr;
    const thumb = this.regs.thumb;
    const r = this.regs.r;

    // The return address depends on the exception. For IRQ and SWI the pipeline offset
    // means the "next instruction" is PC - 4 (ARM) or PC - 2 (Thumb).
    let returnAddress: number;
    if (vector === VECTOR_IRQ || vector === VECTOR_FIQ) {
      returnAddress = thumb ? r[15]! : r[15]! - 4;
    } else {
      returnAddress = thumb ? r[15]! - 2 : r[15]! - 4;
    }

    this.regs.switchMode(mode);
    this.regs.spsr = oldCpsr;
    r[14] = returnAddress >>> 0;

    let cpsr = (this.regs.cpsr & ~FLAG_T) | FLAG_I;
    if (vector === VECTOR_FIQ) cpsr |= FLAG_F;
    this.regs.cpsr = cpsr >>> 0;

    this.branchTo(vector);
  }

  softwareInterrupt(): void {
    this.raiseException(VECTOR_SWI, MODE_SUPERVISOR);
  }

  undefinedInstruction(): void {
    this.raiseException(VECTOR_UNDEFINED, MODE_UNDEFINED);
  }

  /* --------------------------------- helpers ---------------------------------- */

  /**
   * Restores CPSR from SPSR — the tail of every exception return (`MOVS PC, LR`,
   * `SUBS PC, LR, #4`, `LDM ... {PC}^`).
   */
  restoreCpsrFromSpsr(): void {
    const mode = this.regs.mode;
    if (mode === MODE_USER || mode === 0x1f) return;
    this.regs.writeCpsr(this.regs.spsr);
  }

  /** Evaluates an ARM condition code against the current flags. */
  conditionPasses(cond: number): boolean {
    const cpsr = this.regs.cpsr;
    const n = (cpsr & FLAG_N) !== 0;
    const z = (cpsr & FLAG_Z) !== 0;
    const c = (cpsr & FLAG_C) !== 0;
    const v = (cpsr & FLAG_V) !== 0;
    switch (cond) {
      case 0x0:
        return z;
      case 0x1:
        return !z;
      case 0x2:
        return c;
      case 0x3:
        return !c;
      case 0x4:
        return n;
      case 0x5:
        return !n;
      case 0x6:
        return v;
      case 0x7:
        return !v;
      case 0x8:
        return c && !z;
      case 0x9:
        return !c || z;
      case 0xa:
        return n === v;
      case 0xb:
        return n !== v;
      case 0xc:
        return !z && n === v;
      case 0xd:
        return z || n !== v;
      case 0xe:
        return true;
      default:
        return false; // 0b1111 is "never" on this core
    }
  }

  get isFiqMode(): boolean {
    return (this.regs.cpsr & MODE_MASK) === MODE_FIQ;
  }
}
