import { describe, expect, it, beforeEach } from 'vitest';
import { Cpu } from '../../packages/emulator/src/gb/cpu/Cpu.js';
import { FLAG_C, FLAG_H, FLAG_N, FLAG_Z } from '../../packages/emulator/src/gb/cpu/registers.js';
import {
  INT_JOYPAD,
  INT_SERIAL,
  INT_STAT,
  INT_TIMER,
  INT_VBLANK,
} from '../../packages/emulator/src/gb/cpu/interrupts.js';
import type { MemoryBus } from '../../packages/emulator/src/shared/types/bus.js';

class FlatMemory implements MemoryBus {
  readonly bytes = new Uint8Array(0x10000);
  read(address: number): number {
    return this.bytes[address & 0xffff]!;
  }
  write(address: number, value: number): void {
    this.bytes[address & 0xffff] = value & 0xff;
  }
}

let memory: FlatMemory;
let cpu: Cpu;

beforeEach(() => {
  memory = new FlatMemory();
  cpu = new Cpu(memory);
  cpu.reset();
});

/** Assemble bytes at an address and point PC at it. */
function program(address: number, ...bytes: number[]): void {
  bytes.forEach((byte, i) => (memory.bytes[address + i] = byte));
  cpu.regs.pc = address;
}

describe('registers', () => {
  it('hardwires the low nibble of F to zero', () => {
    cpu.regs.f = 0xff;
    expect(cpu.regs.f).toBe(0xf0);
    cpu.regs.af = 0x12ff;
    expect(cpu.regs.f).toBe(0xf0);
    expect(cpu.regs.af).toBe(0x12f0);
  });

  it('POP AF cannot resurrect the low nibble', () => {
    memory.bytes[0xc000] = 0xff;
    memory.bytes[0xc001] = 0x12;
    cpu.regs.sp = 0xc000;
    program(0x0100, 0xf1); // POP AF
    cpu.step();
    expect(cpu.regs.a).toBe(0x12);
    expect(cpu.regs.f).toBe(0xf0);
  });
});

describe('EI / DI', () => {
  it('delays EI by one instruction', () => {
    program(0x0100, 0xfb, 0x00, 0x00); // EI ; NOP ; NOP
    cpu.step(); // EI
    expect(cpu.ime).toBe(false);
    expect(cpu.imePending).toBe(true);
    cpu.step(); // NOP — IME takes effect at the END of this instruction
    expect(cpu.ime).toBe(true);
  });

  it('EI immediately followed by DI never enables interrupts', () => {
    program(0x0100, 0xfb, 0xf3, 0x00); // EI ; DI ; NOP
    cpu.step(); // EI
    cpu.step(); // DI — runs while IME is still clear, then clears the pending flag
    expect(cpu.ime).toBe(false);
    expect(cpu.imePending).toBe(false);
    cpu.step();
    expect(cpu.ime).toBe(false);
  });

  it('RETI enables IME immediately, unlike EI', () => {
    memory.bytes[0xc000] = 0x34;
    memory.bytes[0xc001] = 0x12;
    cpu.regs.sp = 0xc000;
    program(0x0100, 0xd9); // RETI
    cpu.step();
    expect(cpu.ime).toBe(true);
    expect(cpu.regs.pc).toBe(0x1234);
  });
});

describe('interrupt dispatch', () => {
  beforeEach(() => {
    cpu.ime = true;
    cpu.regs.sp = 0xfffe;
    program(0x0150, 0x00);
  });

  it('takes 5 M-cycles (20 T-cycles)', () => {
    cpu.interrupts.ie = INT_VBLANK;
    cpu.interrupts.request(INT_VBLANK);
    expect(cpu.step()).toBe(20);
  });

  it('pushes PC, clears IME and the serviced IF bit, and vectors', () => {
    cpu.interrupts.ie = INT_TIMER;
    cpu.interrupts.request(INT_TIMER);
    cpu.step();

    expect(cpu.regs.pc).toBe(0x0050);
    expect(cpu.ime).toBe(false);
    expect(cpu.regs.sp).toBe(0xfffc);
    expect(memory.bytes[0xfffd]).toBe(0x01); // PC high
    expect(memory.bytes[0xfffc]).toBe(0x50); // PC low
    expect(cpu.interrupts.pending).toBe(0);
  });

  it.each([
    ['VBlank', INT_VBLANK, 0x0040],
    ['STAT', INT_STAT, 0x0048],
    ['Timer', INT_TIMER, 0x0050],
    ['Serial', INT_SERIAL, 0x0058],
    ['Joypad', INT_JOYPAD, 0x0060],
  ])('vectors %s to 0x%s', (_name, mask, vector) => {
    cpu.interrupts.ie = 0xff;
    cpu.interrupts.request(mask);
    cpu.step();
    expect(cpu.regs.pc).toBe(vector);
  });

  it('services the highest priority first when several are pending', () => {
    cpu.interrupts.ie = 0xff;
    cpu.interrupts.request(INT_JOYPAD | INT_TIMER | INT_VBLANK);
    cpu.step();
    expect(cpu.regs.pc).toBe(0x0040); // VBlank wins

    cpu.ime = true;
    cpu.step();
    expect(cpu.regs.pc).toBe(0x0050); // then Timer
  });

  it('does not dispatch while IME is clear', () => {
    cpu.ime = false;
    cpu.interrupts.ie = INT_VBLANK;
    cpu.interrupts.request(INT_VBLANK);
    cpu.step();
    expect(cpu.regs.pc).toBe(0x0151); // ran the NOP instead
  });

  it('does not dispatch an interrupt that is requested but not enabled', () => {
    cpu.interrupts.ie = 0;
    cpu.interrupts.request(INT_VBLANK);
    cpu.step();
    expect(cpu.regs.pc).toBe(0x0151);
  });
});

describe('HALT', () => {
  it('halts and burns cycles until an interrupt arrives', () => {
    program(0x0100, 0x76);
    cpu.step();
    expect(cpu.halted).toBe(true);
    const pc = cpu.regs.pc;
    cpu.step();
    expect(cpu.halted).toBe(true);
    expect(cpu.regs.pc).toBe(pc); // idling, not executing
  });

  it('wakes on a pending interrupt even with IME clear, without dispatching', () => {
    program(0x0100, 0x76, 0x00);
    cpu.ime = false;
    cpu.step();
    expect(cpu.halted).toBe(true);

    cpu.interrupts.ie = INT_VBLANK;
    cpu.interrupts.request(INT_VBLANK);
    cpu.step();
    expect(cpu.halted).toBe(false);
    // Waking with IME clear costs no extra cycle: the NOP at 0x0101 runs in the same step,
    // leaving PC at 0x0102. Crucially PC is NOT a vector — no interrupt was dispatched.
    expect(cpu.regs.pc).toBe(0x0102);
    expect(cpu.interrupts.pending).toBe(INT_VBLANK); // IF untouched
  });

  it('THE HALT BUG: with IME clear and an interrupt pending, PC fails to increment', () => {
    // HALT ; INC A — the INC A byte is fetched twice, so A increments twice.
    cpu.ime = false;
    cpu.interrupts.ie = INT_VBLANK;
    cpu.interrupts.request(INT_VBLANK);
    cpu.regs.a = 0x00;
    program(0x0100, 0x76, 0x3c, 0x00); // HALT ; INC A ; NOP

    cpu.step(); // HALT — does not halt
    expect(cpu.halted).toBe(false);
    expect(cpu.haltBug).toBe(true);

    cpu.step(); // INC A at 0x0101, PC does NOT advance
    expect(cpu.regs.a).toBe(0x01);
    expect(cpu.regs.pc).toBe(0x0101);

    cpu.step(); // the same byte executes again
    expect(cpu.regs.a).toBe(0x02);
    expect(cpu.regs.pc).toBe(0x0102);
  });
});

describe('illegal opcodes', () => {
  it.each([0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd])(
    'throws on 0x%s rather than silently continuing',
    (opcode) => {
      program(0x0100, opcode);
      expect(() => cpu.step()).toThrow(/Illegal opcode/);
    },
  );
});

describe('flag edge cases the reference suite also covers', () => {
  it('ADD SP,e8 takes H and C from the low byte and always clears Z and N', () => {
    cpu.regs.sp = 0x000f;
    program(0x0100, 0xe8, 0x01); // ADD SP,+1
    cpu.step();
    expect(cpu.regs.sp).toBe(0x0010);
    expect(cpu.regs.f & FLAG_H).toBe(FLAG_H);
    expect(cpu.regs.f & FLAG_Z).toBe(0);
    expect(cpu.regs.f & FLAG_N).toBe(0);
  });

  it('LD HL,SP+e8 handles a negative offset with unsigned low-byte carries', () => {
    cpu.regs.sp = 0x0100;
    program(0x0100, 0xf8, 0xff); // LD HL,SP-1
    cpu.step();
    expect(cpu.regs.hl).toBe(0x00ff);
    expect(cpu.regs.f & FLAG_C).toBe(0); // 0x00 + 0xFF = 0xFF, no carry out
  });

  it('INC r preserves the carry flag', () => {
    cpu.regs.f = FLAG_C;
    cpu.regs.b = 0x01;
    program(0x0100, 0x04); // INC B
    cpu.step();
    expect(cpu.regs.f & FLAG_C).toBe(FLAG_C);
  });

  it('CP does not modify A', () => {
    cpu.regs.a = 0x42;
    program(0x0100, 0xfe, 0x42); // CP 0x42
    cpu.step();
    expect(cpu.regs.a).toBe(0x42);
    expect(cpu.regs.f & FLAG_Z).toBe(FLAG_Z);
    expect(cpu.regs.f & FLAG_N).toBe(FLAG_N);
  });

  it('RLCA clears Z but CB RLC A sets it from the result', () => {
    cpu.regs.a = 0x00;
    program(0x0100, 0x07); // RLCA
    cpu.step();
    expect(cpu.regs.f & FLAG_Z).toBe(0);

    cpu.reset();
    cpu.regs.a = 0x00;
    program(0x0100, 0xcb, 0x07); // RLC A
    cpu.step();
    expect(cpu.regs.f & FLAG_Z).toBe(FLAG_Z);
  });

  it('BIT preserves the carry flag and sets H', () => {
    cpu.regs.f = FLAG_C;
    cpu.regs.b = 0x00;
    program(0x0100, 0xcb, 0x40); // BIT 0,B
    cpu.step();
    expect(cpu.regs.f & FLAG_C).toBe(FLAG_C);
    expect(cpu.regs.f & FLAG_H).toBe(FLAG_H);
    expect(cpu.regs.f & FLAG_Z).toBe(FLAG_Z);
  });
});

describe('cycle-stepped timing', () => {
  it('ticks peripherals once per T-cycle, in lockstep with the CPU', () => {
    let ticks = 0;
    cpu.onTCycle = () => ticks++;
    program(0x0100, 0x01, 0x34, 0x12); // LD BC,d16 — 3 M-cycles
    const tCycles = cpu.step();
    expect(ticks).toBe(12); // 3 M-cycles x 4 T
    expect(tCycles).toBe(12);
  });

  it('reports conditional branch timing correctly', () => {
    program(0x0100, 0x20, 0x05); // JR NZ,+5
    cpu.regs.f = FLAG_Z; // condition false
    expect(cpu.step()).toBe(8);

    cpu.reset();
    program(0x0100, 0x20, 0x05);
    cpu.regs.f = 0; // condition true
    expect(cpu.step()).toBe(12);
  });
});
