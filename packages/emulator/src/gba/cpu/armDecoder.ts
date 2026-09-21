import type { Arm7 } from './Arm7.js';
import { FLAG_C, FLAG_T, MODE_USER, MODE_SYSTEM } from './registers.js';
import * as alu from './alu.js';

/**
 * The ARM-state (32-bit) decoder.
 *
 * Decoding goes by bit-pattern classes, checked in the order the architecture requires —
 * several encodings overlap, and the specific ones (BX, multiply, halfword transfer, PSR
 * transfer) must be recognised before the general data-processing pattern swallows them.
 */
export function executeArm(cpu: Arm7, opcode: number): void {
  opcode >>>= 0;
  if (!cpu.conditionPasses(opcode >>> 28)) return;

  // Branch and exchange: cond 0001 0010 1111 1111 1111 0001 Rn
  if ((opcode & 0x0ffffff0) === 0x012fff10) {
    cpu.branchExchange(cpu.regs.r[opcode & 0xf]!);
    return;
  }

  // Branch / branch with link: cond 101 L offset24
  if ((opcode & 0x0e000000) === 0x0a000000) {
    const offset = alu.signExtend(opcode & 0x00ffffff, 24) << 2;
    if ((opcode & 0x01000000) !== 0) cpu.regs.r[14] = (cpu.regs.r[15]! - 4) >>> 0;
    cpu.branchTo(cpu.regs.r[15]! + offset);
    return;
  }

  // Software interrupt: cond 1111 comment
  if ((opcode & 0x0f000000) === 0x0f000000) {
    // GBATEK, "How BIOS Processes SWIs": *"In ARM mode, only the upper 8bit of the 24bit
    // comment field are interpreted"*.
    cpu.softwareInterrupt((opcode >>> 16) & 0xff);
    return;
  }

  // Block data transfer: cond 100 P U S W L Rn reglist
  if ((opcode & 0x0e000000) === 0x08000000) {
    blockTransfer(cpu, opcode);
    return;
  }

  // Single data transfer: cond 01 I P U B W L Rn Rd offset
  if ((opcode & 0x0c000000) === 0x04000000) {
    singleTransfer(cpu, opcode);
    return;
  }

  // Multiply / multiply long: cond 0000 00.. .... .... .... 1001 ....
  if ((opcode & 0x0fc000f0) === 0x00000090) {
    multiply(cpu, opcode);
    return;
  }
  if ((opcode & 0x0f8000f0) === 0x00800090) {
    multiplyLong(cpu, opcode);
    return;
  }

  // Swap: cond 0001 0B00 Rn Rd 0000 1001 Rm
  if ((opcode & 0x0fb00ff0) === 0x01000090) {
    swap(cpu, opcode);
    return;
  }

  // Halfword / signed transfer: cond 000 P U I W L Rn Rd offsetH 1 S H 1 offsetL
  if ((opcode & 0x0e000090) === 0x00000090 && (opcode & 0x60) !== 0) {
    halfwordTransfer(cpu, opcode);
    return;
  }

  // PSR transfer: MRS / MSR sit inside the data-processing space with S clear on TST..CMN.
  if ((opcode & 0x0fbf0fff) === 0x010f0000) {
    // MRS
    const useSpsr = (opcode & 0x00400000) !== 0;
    cpu.regs.r[(opcode >>> 12) & 0xf] = useSpsr ? cpu.regs.spsr : cpu.regs.cpsr;
    return;
  }
  if ((opcode & 0x0db0f000) === 0x0120f000) {
    msr(cpu, opcode);
    return;
  }

  // Data processing: cond 00 I opcode S Rn Rd operand2
  if ((opcode & 0x0c000000) === 0x00000000) {
    dataProcessing(cpu, opcode);
    return;
  }

  cpu.undefinedInstruction();
}

/* ------------------------------ data processing ------------------------------ */

function dataProcessing(cpu: Arm7, opcode: number): void {
  const r = cpu.regs.r;
  const op = (opcode >>> 21) & 0xf;
  const setFlags = (opcode & 0x00100000) !== 0;
  const rn = (opcode >>> 16) & 0xf;
  const rd = (opcode >>> 12) & 0xf;
  const carryIn = cpu.regs.flagC;

  let operand2: number;
  let rnValue = r[rn]!;

  if ((opcode & 0x02000000) !== 0) {
    // Immediate: 8-bit value rotated right by twice the 4-bit rotate field.
    operand2 = alu.rotateImmediate(opcode & 0xff, (opcode >>> 8) & 0xf, carryIn);
  } else {
    const rm = opcode & 0xf;
    const shiftType = (opcode >>> 5) & 3;
    let rmValue = r[rm]!;
    let amount: number;
    const byRegister = (opcode & 0x10) !== 0;

    if (byRegister) {
      // Register-specified shift: reading PC here sees +12 rather than +8, and the
      // shift costs an extra internal cycle.
      amount = r[(opcode >>> 8) & 0xf]! & 0xff;
      if (rm === 15) rmValue = (rmValue + 4) >>> 0;
      if (rn === 15) rnValue = (rnValue + 4) >>> 0;
      cpu.internal();
    } else {
      amount = (opcode >>> 7) & 0x1f;
    }
    operand2 = alu.shift(rmValue, shiftType, amount, carryIn, byRegister);
  }

  const shifterCarry = alu.carryOut;
  let result: number;
  let writeBack = true;
  let logical = false;

  switch (op) {
    case 0x0:
      result = (rnValue & operand2) >>> 0;
      logical = true;
      break; // AND
    case 0x1:
      result = (rnValue ^ operand2) >>> 0;
      logical = true;
      break; // EOR
    case 0x2:
      result = alu.sub(rnValue, operand2, 1);
      break; // SUB
    case 0x3:
      result = alu.sub(operand2, rnValue, 1);
      break; // RSB
    case 0x4:
      result = alu.add(rnValue, operand2, 0);
      break; // ADD
    case 0x5:
      result = alu.add(rnValue, operand2, carryIn ? 1 : 0);
      break; // ADC
    case 0x6:
      result = alu.sub(rnValue, operand2, carryIn ? 1 : 0);
      break; // SBC
    case 0x7:
      result = alu.sub(operand2, rnValue, carryIn ? 1 : 0);
      break; // RSC
    case 0x8:
      result = (rnValue & operand2) >>> 0;
      logical = true;
      writeBack = false;
      break; // TST
    case 0x9:
      result = (rnValue ^ operand2) >>> 0;
      logical = true;
      writeBack = false;
      break; // TEQ
    case 0xa:
      result = alu.sub(rnValue, operand2, 1);
      writeBack = false;
      break; // CMP
    case 0xb:
      result = alu.add(rnValue, operand2, 0);
      writeBack = false;
      break; // CMN
    case 0xc:
      result = (rnValue | operand2) >>> 0;
      logical = true;
      break; // ORR
    case 0xd:
      result = operand2;
      logical = true;
      break; // MOV
    case 0xe:
      result = (rnValue & ~operand2) >>> 0;
      logical = true;
      break; // BIC
    default:
      result = ~operand2 >>> 0;
      logical = true;
      break; // MVN
  }

  if (setFlags) {
    if (rd === 15) {
      // S with Rd=PC is the exception-return idiom: restore CPSR from SPSR.
      cpu.restoreCpsrFromSpsr();
    } else if (logical) {
      cpu.regs.setNZC(result, shifterCarry);
    } else {
      cpu.regs.setNZCV(result, alu.carryOut, alu.overflowOut);
    }
  }

  if (writeBack) {
    if (rd === 15) {
      // Writing PC branches. With S set the mode may have switched to Thumb.
      if ((cpu.regs.cpsr & FLAG_T) !== 0) cpu.branchTo(result & ~1);
      else cpu.branchTo(result & ~3);
    } else {
      r[rd] = result;
    }
  }
}

function msr(cpu: Arm7, opcode: number): void {
  const useSpsr = (opcode & 0x00400000) !== 0;
  let value: number;
  if ((opcode & 0x02000000) !== 0) {
    value = alu.rotateImmediate(opcode & 0xff, (opcode >>> 8) & 0xf, cpu.regs.flagC);
  } else {
    value = cpu.regs.r[opcode & 0xf]!;
  }

  // Field mask: bit 19 = flags, bit 16 = control. User mode may only touch the flags.
  let mask = 0;
  if ((opcode & 0x00080000) !== 0) mask |= 0xff000000;
  if ((opcode & 0x00040000) !== 0) mask |= 0x00ff0000;
  if ((opcode & 0x00020000) !== 0) mask |= 0x0000ff00;
  if ((opcode & 0x00010000) !== 0) mask |= 0x000000ff;

  if (useSpsr) {
    cpu.regs.spsr = ((cpu.regs.spsr & ~mask) | (value & mask)) >>> 0;
    return;
  }

  if (cpu.regs.mode === MODE_USER) mask &= 0xff000000;
  const next = ((cpu.regs.cpsr & ~mask) | (value & mask)) >>> 0;
  cpu.regs.writeCpsr(next);
}

/* --------------------------------- multiply ---------------------------------- */

function multiply(cpu: Arm7, opcode: number): void {
  const r = cpu.regs.r;
  const rd = (opcode >>> 16) & 0xf;
  const rn = (opcode >>> 12) & 0xf;
  const rs = (opcode >>> 8) & 0xf;
  const rm = opcode & 0xf;
  const accumulate = (opcode & 0x00200000) !== 0;
  const setFlags = (opcode & 0x00100000) !== 0;

  let result = Math.imul(r[rm]!, r[rs]!) >>> 0;
  if (accumulate) result = (result + r[rn]!) >>> 0;
  r[rd] = result;

  // Cycle count depends on how many significant bytes the multiplier has.
  cpu.internal(multiplierCycles(r[rs]!) + (accumulate ? 1 : 0));
  if (setFlags) cpu.regs.setNZ(result);
}

function multiplyLong(cpu: Arm7, opcode: number): void {
  const r = cpu.regs.r;
  const rdHi = (opcode >>> 16) & 0xf;
  const rdLo = (opcode >>> 12) & 0xf;
  const rs = (opcode >>> 8) & 0xf;
  const rm = opcode & 0xf;
  const signed = (opcode & 0x00400000) !== 0;
  const accumulate = (opcode & 0x00200000) !== 0;
  const setFlags = (opcode & 0x00100000) !== 0;

  let product: bigint;
  if (signed) {
    product = BigInt(r[rm]! | 0) * BigInt(r[rs]! | 0);
  } else {
    product = BigInt(r[rm]!) * BigInt(r[rs]!);
  }
  if (accumulate) {
    product += (BigInt(r[rdHi]!) << 32n) | BigInt(r[rdLo]!);
  }
  product &= 0xffffffffffffffffn;

  r[rdLo] = Number(product & 0xffffffffn) >>> 0;
  r[rdHi] = Number((product >> 32n) & 0xffffffffn) >>> 0;

  cpu.internal(multiplierCycles(r[rs]!) + 1 + (accumulate ? 1 : 0));
  if (setFlags) {
    cpu.regs.setNZ(r[rdHi]! | (r[rdLo]! !== 0 ? 1 : 0));
    // Z reflects the whole 64-bit result.
    if (r[rdHi] === 0 && r[rdLo] === 0) cpu.regs.cpsr |= 0x40000000;
    else cpu.regs.cpsr &= ~0x40000000;
  }
}

function multiplierCycles(value: number): number {
  const v = value >>> 0;
  if ((v & 0xffffff00) === 0 || (v & 0xffffff00) === 0xffffff00) return 1;
  if ((v & 0xffff0000) === 0 || (v & 0xffff0000) === 0xffff0000) return 2;
  if ((v & 0xff000000) === 0 || (v & 0xff000000) === 0xff000000) return 3;
  return 4;
}

/* --------------------------------- transfers --------------------------------- */

function singleTransfer(cpu: Arm7, opcode: number): void {
  const r = cpu.regs.r;
  const immediate = (opcode & 0x02000000) === 0;
  const preIndex = (opcode & 0x01000000) !== 0;
  const up = (opcode & 0x00800000) !== 0;
  const byte = (opcode & 0x00400000) !== 0;
  const writeBack = (opcode & 0x00200000) !== 0;
  const load = (opcode & 0x00100000) !== 0;
  const rn = (opcode >>> 16) & 0xf;
  const rd = (opcode >>> 12) & 0xf;

  let offset: number;
  if (immediate) {
    offset = opcode & 0xfff;
  } else {
    offset = alu.shift(
      r[opcode & 0xf]!,
      (opcode >>> 5) & 3,
      (opcode >>> 7) & 0x1f,
      cpu.regs.flagC,
      false,
    );
  }

  const base = r[rn]!;
  const offsetAddress = (up ? base + offset : base - offset) >>> 0;
  const address = preIndex ? offsetAddress : base;

  if (load) {
    const value = byte ? cpu.read8(address) : cpu.read32Rotated(address);
    cpu.internal();
    // Writeback happens before the loaded value lands, so Rd == Rn keeps the loaded value.
    if (writeBack || !preIndex) r[rn] = offsetAddress;
    if (rd === 15) cpu.branchTo(value & ~3);
    else r[rd] = value;
  } else {
    // Storing PC stores PC + 12 relative to the instruction (i.e. current R15 + 4).
    const value = rd === 15 ? (r[15]! + 4) >>> 0 : r[rd]!;
    if (byte) cpu.write8(address, value);
    else cpu.write32(address, value);
    if (writeBack || !preIndex) r[rn] = offsetAddress;
  }
}

function halfwordTransfer(cpu: Arm7, opcode: number): void {
  const r = cpu.regs.r;
  const preIndex = (opcode & 0x01000000) !== 0;
  const up = (opcode & 0x00800000) !== 0;
  const immediate = (opcode & 0x00400000) !== 0;
  const writeBack = (opcode & 0x00200000) !== 0;
  const load = (opcode & 0x00100000) !== 0;
  const rn = (opcode >>> 16) & 0xf;
  const rd = (opcode >>> 12) & 0xf;
  const sh = (opcode >>> 5) & 3;

  const offset = immediate ? ((opcode >>> 4) & 0xf0) | (opcode & 0xf) : r[opcode & 0xf]!;
  const base = r[rn]!;
  const offsetAddress = (up ? base + offset : base - offset) >>> 0;
  const address = preIndex ? offsetAddress : base;

  if (load) {
    let value: number;
    switch (sh) {
      case 1: // LDRH — a misaligned halfword read rotates like a word read does
        value = cpu.read16(address);
        if ((address & 1) !== 0) value = ((value >>> 8) | (value << 24)) >>> 0;
        break;
      case 2: // LDRSB
        value = alu.signExtend(cpu.read8(address), 8) >>> 0;
        break;
      default: // LDRSH — misaligned reads sign-extend the single byte instead
        if ((address & 1) !== 0) value = alu.signExtend(cpu.read8(address), 8) >>> 0;
        else value = alu.signExtend(cpu.read16(address), 16) >>> 0;
        break;
    }
    cpu.internal();
    if (writeBack || !preIndex) r[rn] = offsetAddress;
    if (rd === 15) cpu.branchTo(value & ~3);
    else r[rd] = value;
  } else {
    // Only STRH exists in this space.
    const value = rd === 15 ? (r[15]! + 4) >>> 0 : r[rd]!;
    cpu.write16(address, value);
    if (writeBack || !preIndex) r[rn] = offsetAddress;
  }
}

function blockTransfer(cpu: Arm7, opcode: number): void {
  const r = cpu.regs.r;
  const preIndex = (opcode & 0x01000000) !== 0;
  const up = (opcode & 0x00800000) !== 0;
  const psr = (opcode & 0x00400000) !== 0;
  let writeBack = (opcode & 0x00200000) !== 0;
  const load = (opcode & 0x00100000) !== 0;
  const rn = (opcode >>> 16) & 0xf;
  let list = opcode & 0xffff;

  // An empty list transfers PC alone and moves the base by 0x40.
  let count = alu.popCount(list);
  let emptyList = false;
  if (count === 0) {
    list = 0x8000;
    count = 16;
    emptyList = true;
  }

  const base = r[rn]!;
  const size = count * 4;
  let address = up ? base : (base - size) >>> 0;
  if (preIndex === up) address = (address + 4) >>> 0;
  const finalBase = (up ? base + size : base - size) >>> 0;
  if (emptyList) {
    const finalEmpty = (up ? base + 0x40 : base - 0x40) >>> 0;
    if (writeBack) r[rn] = finalEmpty;
    writeBack = false;
  }

  // The S bit with PC absent means "transfer the USER bank" — swap into it temporarily.
  const userBank = psr && !(load && (list & 0x8000) !== 0);
  const savedMode = cpu.regs.mode;
  if (userBank && savedMode !== MODE_USER && savedMode !== MODE_SYSTEM) {
    cpu.regs.switchMode(MODE_USER);
  }

  if (load) {
    // Writeback with Rn in the list: the loaded value wins, so write back first.
    if (writeBack) r[rn] = finalBase;
    for (let i = 0; i < 16; i++) {
      if ((list & (1 << i)) === 0) continue;
      const value = cpu.read32(address);
      address = (address + 4) >>> 0;
      if (i === 15) {
        if (psr) cpu.restoreCpsrFromSpsr();
        cpu.branchTo((cpu.regs.cpsr & FLAG_T) !== 0 ? value & ~1 : value & ~3);
      } else {
        r[i] = value;
      }
    }
    cpu.internal();
  } else {
    let first = true;
    for (let i = 0; i < 16; i++) {
      if ((list & (1 << i)) === 0) continue;
      let value = r[i]!;
      if (i === 15) value = (value + 4) >>> 0;
      // Storing the base register: the FIRST register in the list stores the ORIGINAL
      // base; a later one stores the written-back value.
      if (i === rn && !first && writeBack) value = finalBase;
      cpu.write32(address, value);
      address = (address + 4) >>> 0;
      first = false;
    }
    if (writeBack) r[rn] = finalBase;
  }

  if (userBank && savedMode !== MODE_USER && savedMode !== MODE_SYSTEM) {
    cpu.regs.switchMode(savedMode);
  }
}

function swap(cpu: Arm7, opcode: number): void {
  const r = cpu.regs.r;
  const byte = (opcode & 0x00400000) !== 0;
  const rn = (opcode >>> 16) & 0xf;
  const rd = (opcode >>> 12) & 0xf;
  const rm = opcode & 0xf;
  const address = r[rn]!;

  if (byte) {
    const value = cpu.read8(address);
    cpu.write8(address, r[rm]!);
    r[rd] = value;
  } else {
    const value = cpu.read32Rotated(address);
    cpu.write32(address, r[rm]!);
    r[rd] = value;
  }
  cpu.internal();
}

export { FLAG_C };
