import { describe, expect, it } from 'vitest';
import { GameBoyAdvanceCore } from '../../packages/emulator/src/gba/GameBoyAdvanceCore.js';
import { Arm7, VECTOR_UNDEFINED, type ArmBus } from '../../packages/emulator/src/gba/cpu/Arm7.js';
import {
  FLAG_I,
  FLAG_T,
  MODE_SYSTEM,
  MODE_UNDEFINED,
} from '../../packages/emulator/src/gba/cpu/registers.js';

/**
 * The undefined instruction exception on ARM7TDMI.
 *
 * Nothing in the test-ROM corpus reaches this path — jsmolka's `arm.gba` and `thumb.gba`
 * only execute legal encodings — so these unit tests are the whole of the evidence. They
 * are written against two sources:
 *
 *  - GBATEK, "ARM CPU Exceptions": vector `BASE+04h`, mode *"Undefined (_und)"*,
 *    *"I=1, F=unchanged"*, and (from the ARM opcode timing table) *"The Undefined
 *    Instruction ... PC=4, ARM Und mode, LR=$+4"*.
 *  - ARM7TDMI Data Sheet (DDI 0029E) 4.17 and Figure 4-1 for the ARM encoding,
 *    5.16 for the THUMB one, and TRM (DDI 0029G) 4.6 for coprocessor-absent.
 *
 * The last block is the important one in the long run: it pins down what is NOT
 * undefined, so that a future widening of the decoder fails here rather than silently
 * breaking a game.
 */

/* ---------------------------------- fixtures ---------------------------------- */

/** Builds a core running `program` (ARM words) from the start of ROM. */
function coreRunning(program: number[]): GameBoyAdvanceCore {
  const rom = new Uint8Array(0x200);
  const view = new DataView(rom.buffer);
  for (let i = 0; i < program.length; i++) view.setUint32(i * 4, program[i]! >>> 0, true);
  const core = new GameBoyAdvanceCore();
  core.loadRom(rom);
  return core;
}

/**
 * Builds a core that switches to Thumb state and then runs `ops` (halfwords).
 *
 * `add r0, pc, #1` makes a Thumb-tagged pointer to 08000008h, and `bx r0` takes it.
 */
function coreRunningThumb(ops: number[]): GameBoyAdvanceCore {
  const rom = new Uint8Array(0x200);
  const view = new DataView(rom.buffer);
  view.setUint32(0, 0xe28f0001, true); // add r0, pc, #1
  view.setUint32(4, 0xe12fff10, true); // bx r0
  for (let i = 0; i < ops.length; i++) view.setUint16(8 + i * 2, ops[i]! & 0xffff, true);
  const core = new GameBoyAdvanceCore();
  core.loadRom(rom);
  return core;
}

const THUMB_BASE = 0x08000008;

/** `mov rd, #imm8`. */
function movImm(rd: number, imm: number): number {
  return 0xe3a00000 | (rd << 12) | (imm & 0xff);
}

const BRANCH_SELF = 0xeafffffe;

/**
 * A representative ARM undefined encoding.
 *
 * DDI 0029E Figure 4-1: `Cond 011 xxxxxxxxxxxxxxxxxxxx 1 xxxx`. GBATEK's binary opcode
 * table lists exactly the same row, and calls the sub-space with bits 24-20 and 7-4 all
 * set *"free for user"* — E7Fxxxfx is the encoding every toolchain uses for a trap.
 */
const ARM_UNDEFINED = 0xe7f000f0;

/* ------------------------------------ tests ----------------------------------- */

describe('the ARM undefined instruction encoding', () => {
  it('enters Undefined mode with the documented SPSR, LR and vector', () => {
    const core = coreRunning([movImm(0, 1), ARM_UNDEFINED, movImm(2, 0x2a), BRANCH_SELF]);
    core.stepInstruction(); // mov r0, #1
    const cpsrBefore = core.cpu.regs.cpsr;
    expect(core.cpu.regs.mode).toBe(MODE_SYSTEM);

    core.stepInstruction(); // the undefined instruction

    // GBATEK: mode on entry Undefined (_und), I=1, ARM state.
    expect(core.cpu.regs.mode).toBe(MODE_UNDEFINED);
    expect(core.cpu.regs.cpsr & FLAG_I).toBe(FLAG_I);
    expect(core.cpu.regs.cpsr & FLAG_T).toBe(0);
    expect(core.cpu.regs.spsr >>> 0).toBe(cpsrBefore >>> 0);

    // LR=$+4: the instruction sits at 08000004h, so LR_und is 08000008h and the
    // documented `MOVS PC,R14` return lands on the instruction after it.
    expect(core.cpu.regs.r[14]).toBe(0x08000008);

    // PC is at the vector (reading R15 shows vector + 8 because of the pipeline).
    expect(core.cpu.regs.r[15]).toBe(VECTOR_UNDEFINED + 8);

    // And the instruction after the undefined one did NOT run.
    expect(core.cpu.regs.r[2]).toBe(0);
  });

  it('records the offending PC and opcode for diagnosis', () => {
    const core = coreRunning([movImm(0, 1), ARM_UNDEFINED, BRANCH_SELF]);
    expect(core.bios.undefinedPc).toBe(-1);
    expect(core.bios.undefinedOpcode).toBe(-1);

    core.stepInstruction();
    core.stepInstruction();

    expect(core.bios.undefinedPc).toBe(0x08000004);
    expect(core.bios.undefinedOpcode).toBe(ARM_UNDEFINED);
    expect(core.bios.undefinedThumb).toBe(false);
  });

  it('stays put instead of walking through an empty BIOS', () => {
    // The fault must stay localised: before this path existed, execution fell into the
    // BIOS region, reached the IRQ-return sentinel and popped garbage off SP_und.
    const core = coreRunning([ARM_UNDEFINED, BRANCH_SELF]);
    core.stepInstruction();
    const sp = core.cpu.regs.r[13]!;
    for (let i = 0; i < 64; i++) core.stepInstruction();
    expect(core.cpu.regs.mode).toBe(MODE_UNDEFINED);
    expect(core.cpu.regs.r[15]).toBe(VECTOR_UNDEFINED + 8);
    expect(core.cpu.regs.r[13]).toBe(sp);
    expect(core.cpu.regs.r[14]).toBe(0x08000004);
  });

  it('obeys its condition field', () => {
    // DDI 0029E 4.17: "The instruction is only executed if the condition is true."
    const neverUndefined = (ARM_UNDEFINED & 0x0fffffff) | 0x00000000; // cond = EQ, Z clear
    const core = coreRunning([movImm(0, 1), neverUndefined, movImm(2, 0x2a), BRANCH_SELF]);
    for (let i = 0; i < 3; i++) core.stepInstruction();
    expect(core.cpu.regs.mode).toBe(MODE_SYSTEM);
    expect(core.bios.undefinedOpcode).toBe(-1);
    expect(core.cpu.regs.r[2]).toBe(0x2a);
  });
});

describe('coprocessor instructions on a machine with no coprocessor', () => {
  // ARM7TDMI TRM (DDI 0029G) 4.6: "If any coprocessor instructions are received, they
  // take the undefined instruction trap." GBATEK: "irrelevant in GBA because no
  // coprocessor exists".
  const cases: [string, number][] = [
    ['CDP p0, 0, c0, c0, c0', 0xee000000],
    ['MRC p15, 0, r0, c0, c0', 0xee100f10],
    ['MCR p15, 0, r0, c0, c0', 0xee000f10],
    ['LDC p0, c0, [r0]', 0xed900000],
    ['STC p0, c0, [r0]', 0xed800000],
  ];

  for (const [name, opcode] of cases) {
    it(`${name} takes the undefined instruction trap`, () => {
      const core = coreRunning([opcode, BRANCH_SELF]);
      core.stepInstruction();
      expect(core.cpu.regs.mode).toBe(MODE_UNDEFINED);
      expect(core.bios.undefinedOpcode).toBe(opcode);
      expect(core.bios.undefinedPc).toBe(0x08000000);
    });
  }
});

describe('the THUMB undefined encodings', () => {
  // DDI 0029E 5.16: "Note Cond = 1110 is undefined, and should not be used." The rest of
  // the B000-BFFF block outside ADD SP and PUSH/POP is unallocated on ARMv4T, and
  // E800-EFFF is the ARMv5 BLX suffix this core does not have.
  const cases: [string, number][] = [
    ['B<cond=1110> (DExx)', 0xde00],
    ['the B000-BFFF hole (B100)', 0xb100],
    ['BKPT, an ARMv5 addition (BExx)', 0xbe00],
    ['the ARMv5 BLX suffix (E800)', 0xe800],
  ];

  for (const [name, opcode] of cases) {
    it(`${name} takes the undefined instruction trap`, () => {
      const core = coreRunningThumb([opcode, 0xe7fe /* b . */]);
      core.stepInstruction(); // add r0, pc, #1
      core.stepInstruction(); // bx r0 -> Thumb
      expect(core.cpu.regs.thumb).toBe(true);
      const cpsrBefore = core.cpu.regs.cpsr;

      core.stepInstruction(); // the undefined instruction

      expect(core.cpu.regs.mode).toBe(MODE_UNDEFINED);
      // GBATEK: every exception runs in ARM state, whatever state raised it.
      expect(core.cpu.regs.thumb).toBe(false);
      expect(core.cpu.regs.spsr >>> 0).toBe(cpsrBefore >>> 0);
      expect(core.cpu.regs.spsr & FLAG_T).toBe(FLAG_T);
      // LR is the ARM-style "$+4" seen from THUMB: the following halfword.
      expect(core.cpu.regs.r[14]).toBe(THUMB_BASE + 2);
      expect(core.cpu.regs.r[15]).toBe(VECTOR_UNDEFINED + 8);
      expect(core.bios.undefinedPc).toBe(THUMB_BASE);
      expect(core.bios.undefinedOpcode).toBe(opcode);
      expect(core.bios.undefinedThumb).toBe(true);
    });
  }

  it('leaves a real conditional branch alone', () => {
    // DDxx is cond=1101 (LE), not the undefined 1110. With Z and N==V clear it is taken.
    const core = coreRunningThumb([0xdd01 /* ble +2 */, 0x2001 /* mov r0,#1 */, 0xe7fe]);
    for (let i = 0; i < 4; i++) core.stepInstruction();
    expect(core.cpu.regs.mode).toBe(MODE_SYSTEM);
    expect(core.bios.undefinedOpcode).toBe(-1);
  });
});

describe('returning from the undefined instruction handler', () => {
  /**
   * A flat 64KB bus with no BIOS HLE attached, so the CPU takes the architectural path:
   * it branches to the vector and executes whatever is there. That is what lets this test
   * run a real handler and a real `MOVS PC,R14` return.
   */
  class FlatBus implements ArmBus {
    readonly memory = new Uint8Array(0x10000);
    private readonly view = new DataView(this.memory.buffer);

    read8(a: number): number {
      return this.memory[a & 0xffff]!;
    }
    read16(a: number): number {
      return this.view.getUint16(a & 0xfffe, true);
    }
    read32(a: number): number {
      return this.view.getUint32(a & 0xfffc, true);
    }
    write8(a: number, v: number): void {
      this.memory[a & 0xffff] = v & 0xff;
    }
    write16(a: number, v: number): void {
      this.view.setUint16(a & 0xfffe, v & 0xffff, true);
    }
    write32(a: number, v: number): void {
      this.view.setUint32(a & 0xfffc, v >>> 0, true);
    }
    waitstates(): number {
      return 1;
    }
    word(address: number, value: number): void {
      this.view.setUint32(address, value >>> 0, true);
    }
  }

  it('MOVS PC, R14 restores the caller’s mode, CPSR and PC', () => {
    // ARM7TDMI TRM 2.8.8: "the trap handler executes the following irrespective of the
    // processor operating state: MOVS PC,R14. This action restores the CPSR and returns
    // to the next instruction after the undefined instruction."
    const bus = new FlatBus();
    bus.word(VECTOR_UNDEFINED, 0xea00003d); // b 0x100
    bus.word(0x100, 0xe1b0f00e); // movs pc, lr
    bus.word(0x200, movImm(0, 1));
    bus.word(0x204, ARM_UNDEFINED);
    bus.word(0x208, movImm(2, 0x2a));
    bus.word(0x20c, BRANCH_SELF);

    const cpu = new Arm7(bus);
    cpu.reset();
    cpu.regs.r[15] = 0x200;
    cpu.regs.cpsr = MODE_SYSTEM;
    cpu.flushPipeline();

    cpu.step(); // mov r0, #1
    const cpsrBefore = cpu.regs.cpsr;
    cpu.step(); // the undefined instruction

    expect(cpu.regs.mode).toBe(MODE_UNDEFINED);
    expect(cpu.regs.r[15]).toBe(VECTOR_UNDEFINED + 8);

    cpu.step(); // b 0x100
    expect(cpu.regs.r[15]).toBe(0x108);

    cpu.step(); // movs pc, lr
    expect(cpu.regs.mode).toBe(MODE_SYSTEM);
    expect(cpu.regs.cpsr >>> 0).toBe(cpsrBefore >>> 0);
    expect(cpu.regs.r[15]).toBe(0x208 + 8);

    cpu.step(); // and execution really resumes after the undefined instruction
    expect(cpu.regs.r[2]).toBe(0x2a);
  });
});

describe('what is NOT an undefined instruction', () => {
  /**
   * The guard against widening "undefined" too far.
   *
   * `arm.gba` and `thumb.gba` are the real proof that the instruction set still decodes,
   * but a ROM failure is a poor signal — it says "something broke", not "you widened the
   * undefined space". These run one encoding at a time and assert the CPU stayed out of
   * Undefined mode.
   */
  const armEncodings: [string, number][] = [
    ['MOV r0, #1', 0xe3a00001],
    ['ADD r0, r1, r2, lsl #3', 0xe0810182],
    ['ADD r0, r1, r2, lsl r3', 0xe0810312], // register-specified shift: bit 4 set, legal
    ['MRS r0, cpsr', 0xe10f0000],
    ['MSR cpsr_f, r0', 0xe128f000],
    ['MUL r0, r1, r2', 0xe0000291],
    ['MLA r0, r1, r2, r3', 0xe0203291],
    ['UMULL r0, r1, r2, r3', 0xe0810392],
    ['SMULL r0, r1, r2, r3', 0xe0c10392],
    ['SWP r0, r1, [r2]', 0xe1020091],
    ['SWPB r0, r1, [r2]', 0xe1420091],
    ['BX r0', 0xe12fff10],
    ['LDR r0, [r1, #4]', 0xe5910004],
    ['STR r0, [r1, #4]', 0xe5810004],
    ['LDR r0, [r1, r2]', 0xe7910002], // the register-offset form, bit 4 clear
    ['STR r0, [r1, r2, lsl #2]', 0xe7810102],
    ['LDRB r0, [r1, r2, ror #1]', 0xe7d100e2],
    ['LDRH r0, [r1, #4]', 0xe1d100b4],
    ['STRH r0, [r1, #4]', 0xe1c100b4],
    ['LDRSB r0, [r1, #4]', 0xe1d100d4],
    ['LDRSH r0, [r1, #4]', 0xe1d100f4],
    ['LDRH r0, [r1, r2]', 0xe19100b2],
    ['LDMIA r1!, {r0}', 0xe8b10001],
    ['STMDB r1!, {r0}', 0xe9210001],
    // DDI 0029E 4.1.1: "Some instruction codes are not defined but do not cause the
    // Undefined instruction trap to be taken, for instance a Multiply instruction with
    // bit 6 changed to a 1." This core must keep executing it as a multiply.
    ['MUL with bit 6 set', 0xe00002d1],
  ];

  for (const [name, opcode] of armEncodings) {
    it(`ARM ${name} still decodes`, () => {
      const core = coreRunning([opcode, BRANCH_SELF]);
      core.stepInstruction();
      expect(core.bios.undefinedOpcode).toBe(-1);
      expect(core.cpu.regs.mode).toBe(MODE_SYSTEM);
    });
  }

  const thumbEncodings: [string, number][] = [
    ['LSL r0, r1, #2', 0x0088],
    ['ADD r0, r1, r2', 0x1888],
    ['MOV r0, #1', 0x2001],
    ['AND r0, r1', 0x4008],
    ['ADD r0, r8', 0x4440],
    ['LDR r0, [pc, #0]', 0x4800],
    ['STR r0, [r1, r2]', 0x5088],
    ['LDRSH r0, [r1, r2]', 0x5e88],
    ['LDR r0, [r1, #4]', 0x6848],
    ['STRH r0, [r1, #0]', 0x8008],
    ['LDR r0, [sp, #0]', 0x9800],
    ['ADD r0, sp, #0', 0xa800],
    ['ADD sp, #4', 0xb001],
    ['SUB sp, #4', 0xb081],
    ['PUSH {r0}', 0xb401],
    ['PUSH {r0, lr}', 0xb501],
    ['POP {r0}', 0xbc01],
    ['STMIA r1!, {r0}', 0xc101],
    ['LDMIA r1!, {r0}', 0xc901],
    ['BEQ +0', 0xd000],
    ['BLE +0', 0xdd00],
    ['B +0', 0xe000],
    ['BL prefix', 0xf000],
  ];

  for (const [name, opcode] of thumbEncodings) {
    it(`THUMB ${name} still decodes`, () => {
      const core = coreRunningThumb([opcode, 0xe7fe]);
      core.stepInstruction(); // add r0, pc, #1
      core.stepInstruction(); // bx r0
      core.stepInstruction(); // the encoding under test
      expect(core.bios.undefinedOpcode).toBe(-1);
      expect(core.cpu.regs.mode).toBe(MODE_SYSTEM);
    });
  }

  it('SWI is not swallowed by the undefined path', () => {
    const core = coreRunning([movImm(0, 81), 0xef080000 /* swi 08h */, BRANCH_SELF]);
    for (let i = 0; i < 4; i++) core.stepInstruction();
    expect(core.bios.undefinedOpcode).toBe(-1);
    expect(core.cpu.regs.r[0]).toBe(9); // sqrt(81): the BIOS routine really ran
  });
});
