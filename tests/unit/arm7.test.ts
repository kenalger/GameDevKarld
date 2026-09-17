import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Arm7, VECTOR_SWI } from '../../packages/emulator/src/gba/cpu/Arm7.js';
import {
  FLAG_C,
  MODE_FIQ,
  MODE_IRQ,
  MODE_SYSTEM,
} from '../../packages/emulator/src/gba/cpu/registers.js';
import * as alu from '../../packages/emulator/src/gba/cpu/alu.js';
import { FlatGbaBus } from '../harness/gbaBus.js';

const ROMS = new URL('../roms/gba-tests/', import.meta.url).pathname;
const romsAvailable = existsSync(`${ROMS}arm.gba`) && existsSync(`${ROMS}thumb.gba`);

/** Assembles 32-bit words at a ROM offset. */
function program(bus: FlatGbaBus, offset: number, ...words: number[]): void {
  words.forEach((w, i) => {
    const o = offset + i * 4;
    bus.rom[o] = w & 0xff;
    bus.rom[o + 1] = (w >>> 8) & 0xff;
    bus.rom[o + 2] = (w >>> 16) & 0xff;
    bus.rom[o + 3] = (w >>> 24) & 0xff;
  });
}

function boot(setup: (bus: FlatGbaBus) => void): Arm7 {
  const bus = new FlatGbaBus();
  setup(bus);
  const cpu = new Arm7(bus);
  cpu.reset();
  return cpu;
}

describe('barrel shifter edge cases', () => {
  it('LSL #0 leaves value and carry alone', () => {
    expect(alu.shift(0x12345678, alu.SHIFT_LSL, 0, true, false)).toBe(0x12345678);
    expect(alu.carryOut).toBe(true);
  });

  it('LSR #0 in immediate form means LSR #32: result 0, carry = bit 31', () => {
    expect(alu.shift(0x80000000, alu.SHIFT_LSR, 0, false, false)).toBe(0);
    expect(alu.carryOut).toBe(true);
  });

  it('ASR #0 in immediate form means ASR #32: all sign bits', () => {
    expect(alu.shift(0x80000000, alu.SHIFT_ASR, 0, false, false)).toBe(0xffffffff);
    expect(alu.shift(0x7fffffff, alu.SHIFT_ASR, 0, false, false)).toBe(0);
  });

  it('ROR #0 in immediate form is RRX: rotate through carry by one', () => {
    expect(alu.shift(0x00000001, alu.SHIFT_ROR, 0, true, false)).toBe(0x80000000);
    expect(alu.carryOut).toBe(true);
  });

  it('a register shift of 0 never applies the #0 special cases', () => {
    expect(alu.shift(0x80000000, alu.SHIFT_LSR, 0, false, true)).toBe(0x80000000);
    expect(alu.carryOut).toBe(false);
  });

  it('LSL by 32 via register: result 0, carry = bit 0', () => {
    expect(alu.shift(0x00000001, alu.SHIFT_LSL, 32, false, true)).toBe(0);
    expect(alu.carryOut).toBe(true);
  });

  it('LSL by more than 32 via register: result 0, carry clear', () => {
    expect(alu.shift(0xffffffff, alu.SHIFT_LSL, 33, true, true)).toBe(0);
    expect(alu.carryOut).toBe(false);
  });
});

describe('arithmetic flags', () => {
  it('ADD sets carry on unsigned overflow and V on signed overflow', () => {
    expect(alu.add(0xffffffff, 1, 0)).toBe(0);
    expect(alu.carryOut).toBe(true);
    expect(alu.overflowOut).toBe(false);

    expect(alu.add(0x7fffffff, 1, 0)).toBe(0x80000000);
    expect(alu.carryOut).toBe(false);
    expect(alu.overflowOut).toBe(true);
  });

  it('SUB carry means NO borrow, which is the ARM convention', () => {
    alu.sub(5, 3, 1);
    expect(alu.carryOut).toBe(true);
    alu.sub(3, 5, 1);
    expect(alu.carryOut).toBe(false);
  });
});

describe('the pipeline is visible to software', () => {
  it('reads PC as instruction + 8 in ARM state', () => {
    // 0x08000000: MOV R0, PC
    const cpu = boot((bus) => program(bus, 0, 0xe1a0000f));
    cpu.step();
    expect(cpu.regs.r[0]).toBe(0x08000008);
  });

  it('reads PC as instruction + 4 in Thumb state', () => {
    // ARM: BX to Thumb at 0x08000010. Thumb 0x10: MOV R0, PC via ADD R0, PC, #0 (A000)
    const cpu = boot((bus) => {
      program(bus, 0, 0xe3a00000 | 0x11); // MOV R0, #0x11 — wrong: use LDR from literal instead
      program(bus, 0, 0xe59f0000, 0xe12fff10, 0x08000011); // LDR R0,[PC]; BX R0; literal
      bus.rom[0x10] = 0x00;
      bus.rom[0x11] = 0xa0; // ADD R0, PC, #0
    });
    cpu.step(); // LDR
    cpu.step(); // BX -> Thumb
    expect(cpu.regs.thumb).toBe(true);
    cpu.step(); // ADD R0, PC
    expect(cpu.regs.r[0]).toBe(0x08000014);
  });

  it('BL stores the return address of the NEXT instruction', () => {
    const cpu = boot((bus) => program(bus, 0, 0xeb000010)); // BL +0x40
    cpu.step();
    expect(cpu.regs.r[14]).toBe(0x08000004);
    expect(cpu.regs.r[15]).toBe(0x08000048 + 8);
  });

  it('a BX whose target is the very next word must not skip an instruction', () => {
    // The regression that cost the first run: post-flush PC coincidentally equal to the
    // old PC made a PC-comparison "no branch happened" and advanced twice.
    const cpu = boot((bus) => {
      program(bus, 0x288, 0xe28f0001, 0xe12fff10); // ADD R0,PC,#1 ; BX R0 -> Thumb at 0x290
      bus.rom[0x290] = 0x33;
      bus.rom[0x291] = 0x20; // MOV R0, #0x33
      bus.rom[0x292] = 0x84;
      bus.rom[0x293] = 0x46; // MOV R12, R0
      bus.rom[0x294] = 0x00;
      bus.rom[0x295] = 0xa0; // ADD R0, PC, #0
    });
    cpu.regs.r[15] = 0x08000288;
    cpu.flushPipeline();
    for (let i = 0; i < 5; i++) cpu.step();
    expect(cpu.regs.r[12]).toBe(0x33); // MOV R12 ran
    expect(cpu.regs.r[0]).toBe(0x08000298); // and ADD R0,PC ran with the right PC
  });
});

describe('modes and banking', () => {
  it('banks SP and LR per mode', () => {
    const cpu = boot(() => undefined);
    cpu.regs.r[13] = 0x1111;
    cpu.regs.switchMode(MODE_IRQ);
    expect(cpu.regs.r[13]).toBe(0x03007fa0); // IRQ's own SP
    cpu.regs.r[13] = 0x2222;
    cpu.regs.switchMode(MODE_SYSTEM);
    expect(cpu.regs.r[13]).toBe(0x1111); // restored
    cpu.regs.switchMode(MODE_IRQ);
    expect(cpu.regs.r[13]).toBe(0x2222); // and IRQ's remembered
  });

  it('banks R8-R12 ONLY for FIQ', () => {
    const cpu = boot(() => undefined);
    cpu.regs.r[8] = 0xaa;
    cpu.regs.switchMode(MODE_FIQ);
    cpu.regs.r[8] = 0xbb;
    cpu.regs.switchMode(MODE_IRQ);
    expect(cpu.regs.r[8]).toBe(0xaa); // IRQ sees the user copy
    cpu.regs.switchMode(MODE_FIQ);
    expect(cpu.regs.r[8]).toBe(0xbb);
  });

  it('SWI enters supervisor mode, saves CPSR and returns via MOVS PC, LR', () => {
    const cpu = boot((bus) => {
      program(bus, 0, 0xef000000, 0xe3a00001); // SWI 0 ; MOV R0, #1
      new DataView(bus.bios.buffer).setUint32(VECTOR_SWI, 0xe1b0f00e, true); // MOVS PC, LR
    });
    cpu.regs.cpsr |= FLAG_C;
    cpu.step(); // SWI
    expect(cpu.regs.mode).toBe(0x13);
    expect(cpu.regs.spsr & FLAG_C).toBe(FLAG_C);
    cpu.step(); // MOVS PC, LR
    expect(cpu.regs.mode).toBe(MODE_SYSTEM);
    cpu.step(); // MOV R0, #1
    expect(cpu.regs.r[0]).toBe(1);
  });
});

/** THE PHASE 12 EXIT GATE. */
describe.skipIf(!romsAvailable)('jsmolka/gba-tests', () => {
  const run = (name: string): { passed: boolean; failedTest: number } => {
    const bus = new FlatGbaBus();
    bus.rom.set(new Uint8Array(readFileSync(`${ROMS}${name}.gba`)));
    const cpu = new Arm7(bus);
    cpu.reset();
    new DataView(bus.bios.buffer).setUint32(VECTOR_SWI, 0xe1b0f00e, true);
    cpu.softwareInterrupt = () => {
      const r = cpu.regs.r;
      const a = r[0]! | 0;
      const b = r[1]! | 0;
      r[0] = (b === 0 ? 0 : Math.trunc(a / b)) >>> 0;
      r[1] = (b === 0 ? 0 : a % b) >>> 0;
      r[3] = Math.abs(r[0]! | 0) >>> 0;
    };
    for (let steps = 0; steps < 20_000_000; steps++) {
      cpu.step();
      if (steps % 5000 === 0) {
        const pc = cpu.regs.r[15]!;
        for (let k = 0; k < 4; k++) cpu.step();
        if (cpu.regs.r[15] === pc) break;
      }
    }
    const digits = bus.iwram[0]! * 100 + bus.iwram[4]! * 10 + bus.iwram[8]!;
    return { passed: cpu.regs.r[12] === 0, failedTest: digits };
  };

  it('arm.gba — every ARM-state test passes', () => {
    const result = run('arm');
    expect(result.passed, `first failing test: ${result.failedTest}`).toBe(true);
  });

  it('thumb.gba — every Thumb-state test passes', () => {
    const result = run('thumb');
    expect(result.passed, `first failing test: ${result.failedTest}`).toBe(true);
  });
});
