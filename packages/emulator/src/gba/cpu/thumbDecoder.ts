import type { Arm7 } from './Arm7.js';
import * as alu from './alu.js';

/**
 * The Thumb-state (16-bit) decoder.
 *
 * Thumb is a compressed encoding of a subset of ARM: most instructions can only reach
 * R0-R7, most set flags unconditionally, and PC-relative operations round PC down to a
 * word boundary. Games spend the bulk of their time here, so this is the hotter path.
 */
export function executeThumb(cpu: Arm7, opcode: number): void {
  opcode &= 0xffff;
  const r = cpu.regs.r;

  switch (opcode >>> 13) {
    case 0:
      if ((opcode & 0x1800) === 0x1800) {
        // Format 2: ADD/SUB Rd, Rs, Rn/#imm3
        const rd = opcode & 7;
        const rs = (opcode >>> 3) & 7;
        const operand = (opcode & 0x0400) !== 0 ? (opcode >>> 6) & 7 : r[(opcode >>> 6) & 7]!;
        const result =
          (opcode & 0x0200) !== 0 ? alu.sub(r[rs]!, operand, 1) : alu.add(r[rs]!, operand, 0);
        r[rd] = result;
        cpu.regs.setNZCV(result, alu.carryOut, alu.overflowOut);
      } else {
        // Format 1: shift by immediate
        const rd = opcode & 7;
        const rs = (opcode >>> 3) & 7;
        const amount = (opcode >>> 6) & 0x1f;
        const type = (opcode >>> 11) & 3;
        const result = alu.shift(r[rs]!, type, amount, cpu.regs.flagC, false);
        r[rd] = result;
        cpu.regs.setNZC(result, alu.carryOut);
      }
      return;

    case 1: {
      // Format 3: MOV/CMP/ADD/SUB Rd, #imm8
      const rd = (opcode >>> 8) & 7;
      const imm = opcode & 0xff;
      switch ((opcode >>> 11) & 3) {
        case 0:
          r[rd] = imm;
          cpu.regs.setNZ(imm);
          break;
        case 1:
          cpu.regs.setNZCV(alu.sub(r[rd]!, imm, 1), alu.carryOut, alu.overflowOut);
          break;
        case 2:
          r[rd] = alu.add(r[rd]!, imm, 0);
          cpu.regs.setNZCV(r[rd]!, alu.carryOut, alu.overflowOut);
          break;
        default:
          r[rd] = alu.sub(r[rd]!, imm, 1);
          cpu.regs.setNZCV(r[rd]!, alu.carryOut, alu.overflowOut);
          break;
      }
      return;
    }

    case 2:
      if ((opcode & 0x1c00) === 0x0000) {
        aluOperation(cpu, opcode);
      } else if ((opcode & 0x1c00) === 0x0400) {
        hiRegisterOperation(cpu, opcode);
      } else if ((opcode & 0x1800) === 0x0800) {
        // Format 6: LDR Rd, [PC, #imm8*4] — PC is word-aligned for this one.
        const rd = (opcode >>> 8) & 7;
        const address = ((r[15]! & ~2) + ((opcode & 0xff) << 2)) >>> 0;
        r[rd] = cpu.read32(address);
        cpu.internal();
      } else if ((opcode & 0x0200) === 0) {
        // Format 7: LDR/STR/LDRB/STRB with register offset
        const rd = opcode & 7;
        const address = (r[(opcode >>> 3) & 7]! + r[(opcode >>> 6) & 7]!) >>> 0;
        switch ((opcode >>> 10) & 3) {
          case 0:
            cpu.write32(address, r[rd]!);
            break;
          case 1:
            cpu.write8(address, r[rd]!);
            break;
          case 2:
            r[rd] = cpu.read32Rotated(address);
            cpu.internal();
            break;
          default:
            r[rd] = cpu.read8(address);
            cpu.internal();
            break;
        }
      } else {
        // Format 8: halfword / sign-extended with register offset
        const rd = opcode & 7;
        const address = (r[(opcode >>> 3) & 7]! + r[(opcode >>> 6) & 7]!) >>> 0;
        switch ((opcode >>> 10) & 3) {
          case 0:
            cpu.write16(address, r[rd]!);
            break;
          case 1:
            r[rd] = alu.signExtend(cpu.read8(address), 8) >>> 0;
            cpu.internal();
            break;
          case 2: {
            let value = cpu.read16(address);
            if ((address & 1) !== 0) value = ((value >>> 8) | (value << 24)) >>> 0;
            r[rd] = value;
            cpu.internal();
            break;
          }
          default:
            r[rd] =
              (address & 1) !== 0
                ? alu.signExtend(cpu.read8(address), 8) >>> 0
                : alu.signExtend(cpu.read16(address), 16) >>> 0;
            cpu.internal();
            break;
        }
      }
      return;

    case 3: {
      // Format 9: LDR/STR/LDRB/STRB with 5-bit immediate offset
      const rd = opcode & 7;
      const rb = (opcode >>> 3) & 7;
      const imm = (opcode >>> 6) & 0x1f;
      switch ((opcode >>> 11) & 3) {
        case 0:
          cpu.write32((r[rb]! + imm * 4) >>> 0, r[rd]!);
          break;
        case 1:
          r[rd] = cpu.read32Rotated((r[rb]! + imm * 4) >>> 0);
          cpu.internal();
          break;
        case 2:
          cpu.write8((r[rb]! + imm) >>> 0, r[rd]!);
          break;
        default:
          r[rd] = cpu.read8((r[rb]! + imm) >>> 0);
          cpu.internal();
          break;
      }
      return;
    }

    case 4:
      if ((opcode & 0x1000) === 0) {
        // Format 10: LDRH/STRH with immediate offset
        const rd = opcode & 7;
        const address = (r[(opcode >>> 3) & 7]! + ((opcode >>> 6) & 0x1f) * 2) >>> 0;
        if ((opcode & 0x0800) !== 0) {
          // A misaligned halfword load rotates, exactly like the register-offset form.
          let value = cpu.read16(address);
          if ((address & 1) !== 0) value = ((value >>> 8) | (value << 24)) >>> 0;
          r[rd] = value;
          cpu.internal();
        } else {
          cpu.write16(address, r[rd]!);
        }
      } else {
        // Format 11: LDR/STR Rd, [SP, #imm8*4]
        const rd = (opcode >>> 8) & 7;
        const address = (r[13]! + (opcode & 0xff) * 4) >>> 0;
        if ((opcode & 0x0800) !== 0) {
          r[rd] = cpu.read32Rotated(address);
          cpu.internal();
        } else {
          cpu.write32(address, r[rd]!);
        }
      }
      return;

    case 5:
      if ((opcode & 0x1000) === 0) {
        // Format 12: ADD Rd, PC/SP, #imm8*4
        const rd = (opcode >>> 8) & 7;
        const imm = (opcode & 0xff) * 4;
        const base = (opcode & 0x0800) !== 0 ? r[13]! : (r[15]! & ~2) >>> 0;
        r[rd] = (base + imm) >>> 0;
      } else if ((opcode & 0x0f00) === 0x0000) {
        // Format 13: ADD SP, #±imm7*4
        const imm = (opcode & 0x7f) * 4;
        r[13] = ((opcode & 0x80) !== 0 ? r[13]! - imm : r[13]! + imm) >>> 0;
      } else if ((opcode & 0x0600) === 0x0400) {
        pushPop(cpu, opcode);
      } else {
        cpu.undefinedInstruction();
      }
      return;

    case 6:
      if ((opcode & 0x1000) === 0) {
        // Format 15: LDMIA/STMIA Rb!, {list}
        multipleTransfer(cpu, opcode);
      } else if ((opcode & 0x0f00) === 0x0f00) {
        // Format 17: SWI — the comment field is the low 8 bits.
        cpu.softwareInterrupt(opcode & 0xff);
      } else {
        // Format 16: conditional branch, 8-bit signed offset
        const cond = (opcode >>> 8) & 0xf;
        if (cpu.conditionPasses(cond)) {
          cpu.branchTo(r[15]! + (alu.signExtend(opcode & 0xff, 8) << 1));
        }
      }
      return;

    default:
      if ((opcode & 0x1800) === 0x0000) {
        // Format 18: unconditional branch, 11-bit signed offset
        cpu.branchTo(r[15]! + (alu.signExtend(opcode & 0x7ff, 11) << 1));
      } else if ((opcode & 0x1800) === 0x1000) {
        // Format 19a: BL prefix — stash the high part of the offset in LR.
        r[14] = (r[15]! + (alu.signExtend(opcode & 0x7ff, 11) << 12)) >>> 0;
      } else if ((opcode & 0x1800) === 0x1800) {
        // Format 19b: BL suffix — complete the jump and leave the return address.
        const target = (r[14]! + ((opcode & 0x7ff) << 1)) >>> 0;
        r[14] = ((r[15]! - 2) | 1) >>> 0;
        cpu.branchTo(target);
      } else {
        cpu.undefinedInstruction();
      }
      return;
  }
}

/** Format 4: the register-to-register ALU operations, all on R0-R7. */
function aluOperation(cpu: Arm7, opcode: number): void {
  const r = cpu.regs.r;
  const rd = opcode & 7;
  const rs = (opcode >>> 3) & 7;
  const carry = cpu.regs.flagC;
  let result: number;

  switch ((opcode >>> 6) & 0xf) {
    case 0x0:
      result = (r[rd]! & r[rs]!) >>> 0;
      r[rd] = result;
      cpu.regs.setNZ(result);
      return;
    case 0x1:
      result = (r[rd]! ^ r[rs]!) >>> 0;
      r[rd] = result;
      cpu.regs.setNZ(result);
      return;
    case 0x2:
      result = alu.shift(r[rd]!, alu.SHIFT_LSL, r[rs]! & 0xff, carry, true);
      cpu.internal();
      break;
    case 0x3:
      result = alu.shift(r[rd]!, alu.SHIFT_LSR, r[rs]! & 0xff, carry, true);
      cpu.internal();
      break;
    case 0x4:
      result = alu.shift(r[rd]!, alu.SHIFT_ASR, r[rs]! & 0xff, carry, true);
      cpu.internal();
      break;
    case 0x5:
      result = alu.add(r[rd]!, r[rs]!, carry ? 1 : 0);
      r[rd] = result;
      cpu.regs.setNZCV(result, alu.carryOut, alu.overflowOut);
      return;
    case 0x6:
      result = alu.sub(r[rd]!, r[rs]!, carry ? 1 : 0);
      r[rd] = result;
      cpu.regs.setNZCV(result, alu.carryOut, alu.overflowOut);
      return;
    case 0x7:
      result = alu.shift(r[rd]!, alu.SHIFT_ROR, r[rs]! & 0xff, carry, true);
      cpu.internal();
      break;
    case 0x8:
      result = (r[rd]! & r[rs]!) >>> 0;
      cpu.regs.setNZ(result);
      return; // TST
    case 0x9:
      result = alu.sub(0, r[rs]!, 1);
      r[rd] = result;
      cpu.regs.setNZCV(result, alu.carryOut, alu.overflowOut);
      return;
    case 0xa:
      cpu.regs.setNZCV(alu.sub(r[rd]!, r[rs]!, 1), alu.carryOut, alu.overflowOut);
      return;
    case 0xb:
      cpu.regs.setNZCV(alu.add(r[rd]!, r[rs]!, 0), alu.carryOut, alu.overflowOut);
      return;
    case 0xc:
      result = (r[rd]! | r[rs]!) >>> 0;
      r[rd] = result;
      cpu.regs.setNZ(result);
      return;
    case 0xd: {
      result = Math.imul(r[rd]!, r[rs]!) >>> 0;
      r[rd] = result;
      cpu.regs.setNZ(result);
      cpu.internal();
      return;
    }
    case 0xe:
      result = (r[rd]! & ~r[rs]!) >>> 0;
      r[rd] = result;
      cpu.regs.setNZ(result);
      return;
    default:
      result = ~r[rs]! >>> 0;
      r[rd] = result;
      cpu.regs.setNZ(result);
      return;
  }

  // Shift-by-register results share this tail.
  r[rd] = result;
  cpu.regs.setNZC(result, alu.carryOut);
}

/** Format 5: ADD/CMP/MOV on high registers, and BX. */
function hiRegisterOperation(cpu: Arm7, opcode: number): void {
  const r = cpu.regs.r;
  const rd = (opcode & 7) | ((opcode >>> 4) & 8);
  const rs = (opcode >>> 3) & 0xf;
  const rsValue = r[rs]!;

  switch ((opcode >>> 8) & 3) {
    case 0: {
      const result = (r[rd]! + rsValue) >>> 0;
      if (rd === 15) cpu.branchTo(result & ~1);
      else r[rd] = result;
      return;
    }
    case 1:
      cpu.regs.setNZCV(alu.sub(r[rd]!, rsValue, 1), alu.carryOut, alu.overflowOut);
      return;
    case 2:
      if (rd === 15) cpu.branchTo(rsValue & ~1);
      else r[rd] = rsValue;
      return;
    default:
      cpu.branchExchange(rsValue);
      return;
  }
}

/** Format 14: PUSH {list, LR} / POP {list, PC}. */
function pushPop(cpu: Arm7, opcode: number): void {
  const r = cpu.regs.r;
  const list = opcode & 0xff;
  const extra = (opcode & 0x0100) !== 0;
  const load = (opcode & 0x0800) !== 0;

  if (load) {
    let address = r[13]!;
    for (let i = 0; i < 8; i++) {
      if ((list & (1 << i)) === 0) continue;
      r[i] = cpu.read32(address);
      address = (address + 4) >>> 0;
    }
    if (extra) {
      const pc = cpu.read32(address);
      address = (address + 4) >>> 0;
      r[13] = address;
      cpu.internal();
      cpu.branchTo(pc & ~1);
      return;
    }
    r[13] = address;
    cpu.internal();
  } else {
    const count = alu.popCount(list) + (extra ? 1 : 0);
    let address = (r[13]! - count * 4) >>> 0;
    r[13] = address;
    for (let i = 0; i < 8; i++) {
      if ((list & (1 << i)) === 0) continue;
      cpu.write32(address, r[i]!);
      address = (address + 4) >>> 0;
    }
    if (extra) cpu.write32(address, r[14]!);
  }
}

/** Format 15: LDMIA / STMIA with writeback. */
function multipleTransfer(cpu: Arm7, opcode: number): void {
  const r = cpu.regs.r;
  const rb = (opcode >>> 8) & 7;
  const list = opcode & 0xff;
  const load = (opcode & 0x0800) !== 0;
  let address = r[rb]!;

  if (list === 0) {
    // Empty list: transfer PC and step the base by 0x40.
    if (load) cpu.branchTo(cpu.read32(address) & ~1);
    else cpu.write32(address, (r[15]! + 2) >>> 0);
    r[rb] = (r[rb]! + 0x40) >>> 0;
    return;
  }

  if (load) {
    for (let i = 0; i < 8; i++) {
      if ((list & (1 << i)) === 0) continue;
      r[i] = cpu.read32(address);
      address = (address + 4) >>> 0;
    }
    // Writeback is suppressed when the base register was itself loaded.
    if ((list & (1 << rb)) === 0) r[rb] = address;
    cpu.internal();
  } else {
    const finalAddress = (address + alu.popCount(list) * 4) >>> 0;
    let first = true;
    for (let i = 0; i < 8; i++) {
      if ((list & (1 << i)) === 0) continue;
      // Storing the base: first in the list stores the original, later ones the final.
      const value = i === rb && !first ? finalAddress : r[i]!;
      cpu.write32(address, value);
      address = (address + 4) >>> 0;
      first = false;
    }
    r[rb] = finalAddress;
  }
}
