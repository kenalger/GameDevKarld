import { readFileSync } from 'node:fs';
import type { MemoryBus } from '../../packages/emulator/src/shared/types/bus.js';
import { Cpu } from '../../packages/emulator/src/gb/cpu/Cpu.js';
import type { CycleKind } from '../../packages/emulator/src/gb/cpu/Cpu.js';

interface State {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  h: number;
  l: number;
  pc: number;
  sp: number;
  ime: number;
  ie?: number;
  ei?: number;
  ram: [number, number][];
}

interface Case {
  name: string;
  initial: State;
  final: State;
  cycles: ([number, number, string] | null)[];
}

/** Flat 64KB memory. The CPU is unit-testable with no bus, cartridge, PPU or timer. */
class FlatMemory implements MemoryBus {
  readonly bytes = new Uint8Array(0x10000);
  read(address: number): number {
    return this.bytes[address & 0xffff]!;
  }
  write(address: number, value: number): void {
    this.bytes[address & 0xffff] = value & 0xff;
  }
}

export interface OpcodeReport {
  readonly opcode: string;
  readonly total: number;
  readonly passed: number;
  readonly failures: string[];
}

const kindOf = (flags: string): CycleKind =>
  flags.includes('r') ? 'read' : flags.includes('w') ? 'write' : 'internal';

export function runOpcodeFile(path: string, opcode: string, maxFailures = 3): OpcodeReport {
  const cases = JSON.parse(readFileSync(path, 'utf8')) as Case[];
  const memory = new FlatMemory();
  const cpu = new Cpu(memory);

  const observed: { kind: CycleKind; address: number; value: number }[] = [];
  cpu.observer = (kind, address, value) => observed.push({ kind, address, value });

  let passed = 0;
  const failures: string[] = [];

  for (const testCase of cases) {
    const { initial, final } = testCase;

    memory.bytes.fill(0);
    for (const [address, value] of initial.ram) memory.bytes[address] = value;

    cpu.reset();
    const r = cpu.regs;
    r.a = initial.a;
    r.b = initial.b;
    r.c = initial.c;
    r.d = initial.d;
    r.e = initial.e;
    r.f = initial.f;
    r.h = initial.h;
    r.l = initial.l;
    r.pc = initial.pc;
    r.sp = initial.sp;
    cpu.ime = initial.ime === 1;
    cpu.imePending = initial.ei === 1;
    cpu.interrupts.ie = initial.ie ?? 0;

    observed.length = 0;
    cpu.step();

    const problems: string[] = [];
    const check = (label: string, actual: number, expected: number): void => {
      if (actual !== expected) {
        problems.push(`${label}=${hex(actual)} expected ${hex(expected)}`);
      }
    };

    check('a', r.a, final.a);
    check('b', r.b, final.b);
    check('c', r.c, final.c);
    check('d', r.d, final.d);
    check('e', r.e, final.e);
    check('f', r.f, final.f);
    check('h', r.h, final.h);
    check('l', r.l, final.l);
    check('pc', r.pc, final.pc);
    check('sp', r.sp, final.sp);
    check('ime', cpu.ime ? 1 : 0, final.ime);
    if (final.ei !== undefined) check('ei', cpu.imePending ? 1 : 0, final.ei);

    for (const [address, value] of final.ram) {
      if (memory.bytes[address] !== value) {
        problems.push(`ram[${hex(address)}]=${hex(memory.bytes[address]!)} expected ${hex(value)}`);
      }
    }

    const expectedCycles = testCase.cycles.filter((entry) => entry !== null);
    if (observed.length !== expectedCycles.length) {
      problems.push(
        `cycles=${observed.length} expected ${expectedCycles.length} ` +
          `[got ${observed.map((o) => o.kind[0]).join('')} want ${expectedCycles.map((e) => kindOf(e![2])[0]).join('')}]`,
      );
    } else {
      for (let i = 0; i < expectedCycles.length; i++) {
        const want = expectedCycles[i]!;
        const got = observed[i]!;
        const wantKind = kindOf(want[2]);
        if (got.kind !== wantKind || got.address !== want[0] || got.value !== want[1]) {
          problems.push(
            `cycle ${i}: ${got.kind}@${hex(got.address)}=${hex(got.value)} ` +
              `expected ${wantKind}@${hex(want[0])}=${hex(want[1])}`,
          );
          break;
        }
      }
    }

    if (problems.length === 0) {
      passed++;
    } else if (failures.length < maxFailures) {
      failures.push(`${testCase.name}: ${problems.join('; ')}`);
    }
  }

  return { opcode, total: cases.length, passed, failures };
}

const hex = (value: number): string => `0x${value.toString(16)}`;
