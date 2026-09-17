import type { MemoryBus } from '../../shared/types/bus.js';
import { FLAG_C, FLAG_H, FLAG_N, FLAG_Z, Registers } from './registers.js';
import { InterruptController, INT_MASK, INT_VECTORS } from './interrupts.js';
import type { StateReader, StateWriter } from '../state/StateBuffer.js';
import {
  add8,
  adc8,
  sub8,
  sbc8,
  and8,
  or8,
  xor8,
  inc8,
  dec8,
  daa,
  rlc,
  rrc,
  rl,
  rr,
  sla,
  sra,
  srl,
  swap,
  bit,
  resultOf,
  flagsOf,
} from './alu.js';

export type CycleKind = 'read' | 'write' | 'internal';

/** Per-M-cycle bus observer. Used by the SingleStepTests harness and the future tracer. */
export type CycleObserver = (kind: CycleKind, address: number, value: number) => void;

/** One M-cycle is 4 T-cycles at 4194304 Hz. */
export const T_CYCLES_PER_M_CYCLE = 4;

/**
 * How many T-cycles of peripheral time elapse BEFORE the bus access within an M-cycle.
 *
 * A memory access does not happen at an M-cycle boundary, and the exact offset is
 * observable: Mooneye's instruction-timing tests read TIMA at precise cycles and compare
 * against hardware.
 *
 * CALIBRATED, NOT ASSUMED. Sweeping 0..4 against Mooneye acceptance scored 36/35/35/35/32,
 * so the access is placed before the cycle's peripheral time. Re-run the sweep before
 * changing this; it is worth 4 tests.
 */
export const ACCESS_T_OFFSET = 0;

/**
 * The Sharp SM83 (LR35902).
 *
 * Z80-like but not a Z80: no IX/IY, no shadow registers, no block instructions, no IN/OUT.
 *
 * Timing model — decided in Phase 01 and not retrofittable: every memory access and every
 * internal cycle ticks the rest of the machine through `onMachineCycle`. A core that runs
 * an instruction and then adds its cycle count cannot pass Phase 03.
 */
export class Cpu {
  readonly regs = new Registers();

  /**
   * IE/IF live here but are shared with the bus, which maps them at 0xFFFF and 0xFF0F.
   * The owning core MUST pass in its controller — a CPU dispatching from a private
   * instance the MMU never writes to will simply never take an interrupt.
   */
  readonly interrupts: InterruptController;

  /** Interrupt Master Enable. Not memory-mapped. */
  ime = false;

  /** EI sets IME after the FOLLOWING instruction, so `EI; DI` never services anything. */
  imePending = false;

  halted = false;

  /**
   * HALT with IME=0 and a pending interrupt does not halt, and PC fails to increment —
   * so the next byte executes twice. Real hardware; games depend on it.
   */
  haltBug = false;

  /** Elapsed T-cycles. */
  cycles = 0;

  /**
   * Called once per T-cycle so the timer, PPU and APU advance in lockstep with the CPU.
   *
   * Per-T rather than per-M because a memory access does not happen at an M-cycle
   * boundary: peripherals advance partway through the cycle, the access samples the bus,
   * and the rest of the cycle elapses. See ACCESS_T_OFFSET.
   */
  onTCycle: (() => void) | null = null;

  observer: CycleObserver | null = null;

  private lastAddress = 0;
  private lastValue = 0;

  constructor(
    private readonly bus: MemoryBus,
    interrupts: InterruptController = new InterruptController(),
  ) {
    this.interrupts = interrupts;
  }

  reset(): void {
    this.regs.reset();
    this.interrupts.reset();
    this.ime = false;
    this.imePending = false;
    this.halted = false;
    this.haltBug = false;
    this.cycles = 0;
  }

  /* ----------------------------- cycle-stepped bus ---------------------------- */

  /** Advances `count` T-cycles of peripheral time. */
  tickT(count: number): void {
    for (let i = 0; i < count; i++) {
      this.cycles++;
      this.onTCycle?.();
    }
  }

  /** A full M-cycle with no bus access. */
  tick(): void {
    this.tickT(T_CYCLES_PER_M_CYCLE);
  }

  read8(address: number): number {
    this.tickT(ACCESS_T_OFFSET);
    const value = this.bus.read(address & 0xffff) & 0xff;
    this.tickT(T_CYCLES_PER_M_CYCLE - ACCESS_T_OFFSET);
    this.lastAddress = address & 0xffff;
    this.lastValue = value;
    this.observer?.('read', this.lastAddress, value);
    return value;
  }

  write8(address: number, value: number): void {
    const addr = address & 0xffff;
    const byte = value & 0xff;
    this.tickT(ACCESS_T_OFFSET);
    this.bus.write(addr, byte);
    this.tickT(T_CYCLES_PER_M_CYCLE - ACCESS_T_OFFSET);
    this.lastAddress = addr;
    this.lastValue = byte;
    this.observer?.('write', addr, byte);
  }

  /** An internal cycle: the CPU is busy but the bus is idle. */
  internal(): void {
    this.tick();
    this.observer?.('internal', this.lastAddress, this.lastValue);
  }

  fetch8(): number {
    const value = this.read8(this.regs.pc);
    // The HALT bug: PC does not advance past the byte, so it is executed twice.
    if (this.haltBug) this.haltBug = false;
    else this.regs.pc = (this.regs.pc + 1) & 0xffff;
    return value;
  }

  fetch16(): number {
    const lo = this.fetch8();
    const hi = this.fetch8();
    return (hi << 8) | lo;
  }

  push16(value: number): void {
    this.regs.sp = (this.regs.sp - 1) & 0xffff;
    this.write8(this.regs.sp, (value >>> 8) & 0xff);
    this.regs.sp = (this.regs.sp - 1) & 0xffff;
    this.write8(this.regs.sp, value & 0xff);
  }

  pop16(): number {
    const lo = this.read8(this.regs.sp);
    this.regs.sp = (this.regs.sp + 1) & 0xffff;
    const hi = this.read8(this.regs.sp);
    this.regs.sp = (this.regs.sp + 1) & 0xffff;
    return (hi << 8) | lo;
  }

  /* ------------------------------ operand access ------------------------------ */

  /** Operand encoding: 0=B 1=C 2=D 3=E 4=H 5=L 6=(HL) 7=A. Index 6 costs a read cycle. */
  getR(index: number): number {
    const r = this.regs;
    switch (index) {
      case 0:
        return r.b;
      case 1:
        return r.c;
      case 2:
        return r.d;
      case 3:
        return r.e;
      case 4:
        return r.h;
      case 5:
        return r.l;
      case 6:
        return this.read8(r.hl);
      default:
        return r.a;
    }
  }

  setR(index: number, value: number): void {
    const r = this.regs;
    const v = value & 0xff;
    switch (index) {
      case 0:
        r.b = v;
        break;
      case 1:
        r.c = v;
        break;
      case 2:
        r.d = v;
        break;
      case 3:
        r.e = v;
        break;
      case 4:
        r.h = v;
        break;
      case 5:
        r.l = v;
        break;
      case 6:
        this.write8(r.hl, v);
        break;
      default:
        r.a = v;
        break;
    }
  }

  /** Condition encoding: 0=NZ 1=Z 2=NC 3=C. */
  condition(index: number): boolean {
    const r = this.regs;
    switch (index) {
      case 0:
        return !r.flagZ;
      case 1:
        return r.flagZ;
      case 2:
        return !r.flagC;
      default:
        return r.flagC;
    }
  }

  /* --------------------------------- execution -------------------------------- */

  /**
   * Runs one instruction (or one interrupt dispatch), returning the T-cycles consumed.
   */
  step(): number {
    const before = this.cycles;

    if (this.serviceInterrupt()) return this.cycles - before;

    if (this.halted) {
      this.internal();
      return this.cycles - before;
    }

    // EI's effect lands after the next instruction completes, so latch it now.
    const enableAfter = this.imePending;

    const opcode = this.fetch8();
    const op = OPS[opcode];
    if (op === undefined) {
      throw new Error(
        `Illegal opcode 0x${opcode.toString(16).padStart(2, '0')} at 0x${((this.regs.pc - 1) & 0xffff).toString(16)} — the CPU locks on hardware.`,
      );
    }
    op(this);

    // IME lands only if the instruction that ran did not itself cancel the request.
    // `EI; DI` must never service an interrupt, so DI clearing `imePending` wins here.
    if (enableAfter && this.imePending) {
      this.ime = true;
      this.imePending = false;
    }

    return this.cycles - before;
  }

  /**
   * Interrupt dispatch: 5 M-cycles, clears IME and the serviced IF bit, pushes PC.
   *
   * The IE read happens mid-push, so a stack that overlaps 0xFFFF can change which vector
   * is taken — Mooneye tests this in Phase 03.
   */
  private serviceInterrupt(): boolean {
    const pending = this.interrupts.pending;

    if (pending !== 0 && this.halted) {
      // With IME clear the CPU simply resumes with the next instruction — no vector, and
      // no extra cycle. Mooneye's halt_ime0_nointr_timing measures this exactly.
      this.halted = false;
      if (!this.ime) return false;
    }

    if (!this.ime || pending === 0) return false;

    this.ime = false;
    this.imePending = false;

    this.internal();
    this.internal();

    const pc = this.regs.pc;
    this.regs.sp = (this.regs.sp - 1) & 0xffff;
    this.write8(this.regs.sp, (pc >>> 8) & 0xff);

    // Re-read after the high byte: the push may have overwritten IE.
    const live = this.interrupts.pending;
    let index = -1;
    for (let i = 0; i < 5; i++) {
      if ((live & (1 << i)) !== 0) {
        index = i;
        break;
      }
    }

    this.regs.sp = (this.regs.sp - 1) & 0xffff;
    this.write8(this.regs.sp, pc & 0xff);

    if (index < 0) {
      // IE was clobbered mid-dispatch: vector to 0x0000.
      this.regs.pc = 0x0000;
    } else {
      this.interrupts.clear(1 << index);
      this.regs.pc = INT_VECTORS[index]!;
    }
    this.internal();
    return true;
  }
}

/* =============================== save state =============================== */

/** Serialises the CPU into a save state. Kept beside the class so the table block below
 *  stays module-level. */
export function saveCpuState(cpu: Cpu, w: StateWriter): void {
  const r = cpu.regs;
  w.u8(r.a);
  w.u8(r.f);
  w.u8(r.b);
  w.u8(r.c);
  w.u8(r.d);
  w.u8(r.e);
  w.u8(r.h);
  w.u8(r.l);
  w.u16(r.pc);
  w.u16(r.sp);
  w.bool(cpu.ime);
  w.bool(cpu.imePending);
  w.bool(cpu.halted);
  w.bool(cpu.haltBug);
  w.f64(cpu.cycles);
  w.u8(cpu.interrupts.ie);
  w.u8(cpu.interrupts.if & INT_MASK);
}

export function loadCpuState(cpu: Cpu, s: StateReader): void {
  const r = cpu.regs;
  r.a = s.u8();
  r.f = s.u8();
  r.b = s.u8();
  r.c = s.u8();
  r.d = s.u8();
  r.e = s.u8();
  r.h = s.u8();
  r.l = s.u8();
  r.pc = s.u16();
  r.sp = s.u16();
  cpu.ime = s.bool();
  cpu.imePending = s.bool();
  cpu.halted = s.bool();
  cpu.haltBug = s.bool();
  cpu.cycles = s.f64();
  cpu.interrupts.ie = s.u8();
  cpu.interrupts.if = s.u8();
}

/* ============================== opcode tables ============================== */

type Op = (cpu: Cpu) => void;

const OPS: (Op | undefined)[] = new Array<Op | undefined>(256).fill(undefined);
const CB_OPS: Op[] = new Array<Op>(256);

const apply = (cpu: Cpu, packed: number): number => {
  cpu.regs.f = flagsOf(packed);
  return resultOf(packed);
};

/* ---- 0x00-0x3F: mixed block ---- */

const PAIR_SET: ((cpu: Cpu, v: number) => void)[] = [
  (c, v) => {
    c.regs.bc = v;
  },
  (c, v) => {
    c.regs.de = v;
  },
  (c, v) => {
    c.regs.hl = v;
  },
  (c, v) => {
    c.regs.sp = v;
  },
];
const PAIR_GET: ((cpu: Cpu) => number)[] = [
  (c) => c.regs.bc,
  (c) => c.regs.de,
  (c) => c.regs.hl,
  (c) => c.regs.sp,
];

OPS[0x00] = () => {};

for (let p = 0; p < 4; p++) {
  OPS[0x01 + p * 0x10] = (c) => PAIR_SET[p]!(c, c.fetch16()); // LD rr,d16
  OPS[0x09 + p * 0x10] = (c) => {
    // ADD HL,rr
    const hl = c.regs.hl;
    const v = PAIR_GET[p]!(c);
    const sum = hl + v;
    let f = c.regs.f & FLAG_Z;
    if ((hl & 0x0fff) + (v & 0x0fff) > 0x0fff) f |= FLAG_H;
    if (sum > 0xffff) f |= FLAG_C;
    c.internal();
    c.regs.hl = sum & 0xffff;
    c.regs.f = f;
  };
  OPS[0x03 + p * 0x10] = (c) => {
    // INC rr
    c.internal();
    PAIR_SET[p]!(c, (PAIR_GET[p]!(c) + 1) & 0xffff);
  };
  OPS[0x0b + p * 0x10] = (c) => {
    // DEC rr
    c.internal();
    PAIR_SET[p]!(c, (PAIR_GET[p]!(c) - 1) & 0xffff);
  };
}

// INC r / DEC r / LD r,d8 across the 0x00-0x3F grid.
for (let r = 0; r < 8; r++) {
  const base = r * 0x08;
  OPS[0x04 + base] = (c) => c.setR(r, apply(c, inc8(c.getR(r), c.regs.f)));
  OPS[0x05 + base] = (c) => c.setR(r, apply(c, dec8(c.getR(r), c.regs.f)));
  OPS[0x06 + base] = (c) => c.setR(r, c.fetch8());
}

OPS[0x02] = (c) => c.write8(c.regs.bc, c.regs.a);
OPS[0x12] = (c) => c.write8(c.regs.de, c.regs.a);
OPS[0x22] = (c) => {
  c.write8(c.regs.hl, c.regs.a);
  c.regs.hl = (c.regs.hl + 1) & 0xffff;
};
OPS[0x32] = (c) => {
  c.write8(c.regs.hl, c.regs.a);
  c.regs.hl = (c.regs.hl - 1) & 0xffff;
};
OPS[0x0a] = (c) => {
  c.regs.a = c.read8(c.regs.bc);
};
OPS[0x1a] = (c) => {
  c.regs.a = c.read8(c.regs.de);
};
OPS[0x2a] = (c) => {
  c.regs.a = c.read8(c.regs.hl);
  c.regs.hl = (c.regs.hl + 1) & 0xffff;
};
OPS[0x3a] = (c) => {
  c.regs.a = c.read8(c.regs.hl);
  c.regs.hl = (c.regs.hl - 1) & 0xffff;
};

OPS[0x07] = (c) => {
  c.regs.a = apply(c, rlc(c.regs.a, false));
};
OPS[0x0f] = (c) => {
  c.regs.a = apply(c, rrc(c.regs.a, false));
};
OPS[0x17] = (c) => {
  c.regs.a = apply(c, rl(c.regs.a, c.regs.flagC ? 1 : 0, false));
};
OPS[0x1f] = (c) => {
  c.regs.a = apply(c, rr(c.regs.a, c.regs.flagC ? 1 : 0, false));
};

OPS[0x08] = (c) => {
  // LD (a16),SP
  const addr = c.fetch16();
  c.write8(addr, c.regs.sp & 0xff);
  c.write8((addr + 1) & 0xffff, (c.regs.sp >>> 8) & 0xff);
};

// STOP and HALT both consume two internal cycles after the fetch in the reference suite.
OPS[0x10] = (c) => {
  c.internal();
  c.internal();
};
OPS[0x76] = (c) => {
  c.internal();
  c.internal();
  if (!c.ime && c.interrupts.pending !== 0) c.haltBug = true;
  else c.halted = true;
};

OPS[0x18] = (c) => {
  // JR r8
  const offset = (c.fetch8() << 24) >> 24;
  c.internal();
  c.regs.pc = (c.regs.pc + offset) & 0xffff;
};
for (let cc = 0; cc < 4; cc++) {
  OPS[0x20 + cc * 0x08] = (c) => {
    // JR cc,r8
    const offset = (c.fetch8() << 24) >> 24;
    if (c.condition(cc)) {
      c.internal();
      c.regs.pc = (c.regs.pc + offset) & 0xffff;
    }
  };
}

OPS[0x27] = (c) => {
  c.regs.a = apply(c, daa(c.regs.a, c.regs.f));
};
OPS[0x2f] = (c) => {
  c.regs.a = ~c.regs.a & 0xff;
  c.regs.f = c.regs.f | FLAG_N | FLAG_H;
};
OPS[0x37] = (c) => {
  c.regs.f = (c.regs.f & FLAG_Z) | FLAG_C;
};
OPS[0x3f] = (c) => {
  c.regs.f = (c.regs.f & FLAG_Z) | (c.regs.flagC ? 0 : FLAG_C);
};

/* ---- 0x40-0x7F: LD r,r' (0x76 is HALT, set above) ---- */
for (let dst = 0; dst < 8; dst++) {
  for (let src = 0; src < 8; src++) {
    const opcode = 0x40 + dst * 8 + src;
    if (opcode === 0x76) continue;
    OPS[opcode] = (c) => c.setR(dst, c.getR(src));
  }
}

/* ---- 0x80-0xBF: ALU A,r ---- */
const ALU: ((cpu: Cpu, value: number) => void)[] = [
  (c, v) => {
    c.regs.a = apply(c, add8(c.regs.a, v));
  },
  (c, v) => {
    c.regs.a = apply(c, adc8(c.regs.a, v, c.regs.flagC ? 1 : 0));
  },
  (c, v) => {
    c.regs.a = apply(c, sub8(c.regs.a, v));
  },
  (c, v) => {
    c.regs.a = apply(c, sbc8(c.regs.a, v, c.regs.flagC ? 1 : 0));
  },
  (c, v) => {
    c.regs.a = apply(c, and8(c.regs.a, v));
  },
  (c, v) => {
    c.regs.a = apply(c, xor8(c.regs.a, v));
  },
  (c, v) => {
    c.regs.a = apply(c, or8(c.regs.a, v));
  },
  (c, v) => {
    apply(c, sub8(c.regs.a, v));
  }, // CP discards
];
for (let op = 0; op < 8; op++) {
  for (let r = 0; r < 8; r++) {
    OPS[0x80 + op * 8 + r] = (c) => ALU[op]!(c, c.getR(r));
  }
  OPS[0xc6 + op * 8] = (c) => ALU[op]!(c, c.fetch8()); // ALU A,d8
}

/* ---- 0xC0-0xFF ---- */
for (let cc = 0; cc < 4; cc++) {
  OPS[0xc0 + cc * 0x08] = (c) => {
    // RET cc
    c.internal();
    if (c.condition(cc)) {
      c.regs.pc = c.pop16();
      c.internal();
    }
  };
  OPS[0xc2 + cc * 0x08] = (c) => {
    // JP cc,a16
    const addr = c.fetch16();
    if (c.condition(cc)) {
      c.internal();
      c.regs.pc = addr;
    }
  };
  OPS[0xc4 + cc * 0x08] = (c) => {
    // CALL cc,a16
    const addr = c.fetch16();
    if (c.condition(cc)) {
      c.internal();
      c.push16(c.regs.pc);
      c.regs.pc = addr;
    }
  };
}

const PUSH_POP: [(c: Cpu) => number, (c: Cpu, v: number) => void][] = [
  [
    (c) => c.regs.bc,
    (c, v) => {
      c.regs.bc = v;
    },
  ],
  [
    (c) => c.regs.de,
    (c, v) => {
      c.regs.de = v;
    },
  ],
  [
    (c) => c.regs.hl,
    (c, v) => {
      c.regs.hl = v;
    },
  ],
  [
    (c) => c.regs.af,
    (c, v) => {
      c.regs.af = v;
    },
  ], // masks F's low nibble
];
for (let p = 0; p < 4; p++) {
  OPS[0xc1 + p * 0x10] = (c) => PUSH_POP[p]![1](c, c.pop16());
  OPS[0xc5 + p * 0x10] = (c) => {
    c.internal();
    c.push16(PUSH_POP[p]![0](c));
  };
  OPS[0xc7 + p * 0x10] = (c) => {
    c.internal();
    c.push16(c.regs.pc);
    c.regs.pc = p * 0x10;
  };
  OPS[0xcf + p * 0x10] = (c) => {
    c.internal();
    c.push16(c.regs.pc);
    c.regs.pc = p * 0x10 + 0x08;
  };
}

OPS[0xc3] = (c) => {
  const a = c.fetch16();
  c.internal();
  c.regs.pc = a;
};
OPS[0xc9] = (c) => {
  c.regs.pc = c.pop16();
  c.internal();
};
OPS[0xcd] = (c) => {
  const a = c.fetch16();
  c.internal();
  c.push16(c.regs.pc);
  c.regs.pc = a;
};
OPS[0xd9] = (c) => {
  c.regs.pc = c.pop16();
  c.internal();
  c.ime = true;
  c.imePending = false;
};

OPS[0xe0] = (c) => c.write8(0xff00 + c.fetch8(), c.regs.a);
OPS[0xf0] = (c) => {
  c.regs.a = c.read8(0xff00 + c.fetch8());
};
OPS[0xe2] = (c) => c.write8(0xff00 + c.regs.c, c.regs.a);
OPS[0xf2] = (c) => {
  c.regs.a = c.read8(0xff00 + c.regs.c);
};
OPS[0xea] = (c) => c.write8(c.fetch16(), c.regs.a);
OPS[0xfa] = (c) => {
  c.regs.a = c.read8(c.fetch16());
};

OPS[0xe9] = (c) => {
  c.regs.pc = c.regs.hl;
};
OPS[0xf9] = (c) => {
  c.internal();
  c.regs.sp = c.regs.hl;
};

OPS[0xe8] = (c) => {
  // ADD SP,e8
  const offset = (c.fetch8() << 24) >> 24;
  const sp = c.regs.sp;
  c.internal();
  c.internal();
  c.regs.sp = (sp + offset) & 0xffff;
  c.regs.f = halfCarryFlags(sp, offset);
};
OPS[0xf8] = (c) => {
  // LD HL,SP+e8
  const offset = (c.fetch8() << 24) >> 24;
  const sp = c.regs.sp;
  c.internal();
  c.regs.hl = (sp + offset) & 0xffff;
  c.regs.f = halfCarryFlags(sp, offset);
};

/**
 * ADD SP,e8 and LD HL,SP+e8 derive H and C from the LOW BYTE unsigned addition (bit 3 and
 * bit 7 carries) and always clear Z and N. Nearly every implementation gets this wrong first.
 */
function halfCarryFlags(sp: number, offset: number): number {
  let f = 0;
  if ((sp & 0x0f) + (offset & 0x0f) > 0x0f) f |= FLAG_H;
  if ((sp & 0xff) + (offset & 0xff) > 0xff) f |= FLAG_C;
  return f;
}

OPS[0xf3] = (c) => {
  c.ime = false;
  c.imePending = false;
};
OPS[0xfb] = (c) => {
  c.imePending = true;
};
OPS[0xcb] = (c) => CB_OPS[c.fetch8()]!(c);

/* ---- CB page: fully regular ---- */
const CB_SHIFTS: ((cpu: Cpu, v: number) => number)[] = [
  (_c, v) => rlc(v, true),
  (_c, v) => rrc(v, true),
  (c, v) => rl(v, c.regs.flagC ? 1 : 0, true),
  (c, v) => rr(v, c.regs.flagC ? 1 : 0, true),
  (_c, v) => sla(v),
  (_c, v) => sra(v),
  (_c, v) => swap(v),
  (_c, v) => srl(v),
];
for (let op = 0; op < 8; op++) {
  for (let r = 0; r < 8; r++) {
    CB_OPS[op * 8 + r] = (c) => c.setR(r, apply(c, CB_SHIFTS[op]!(c, c.getR(r))));
  }
}
for (let b = 0; b < 8; b++) {
  for (let r = 0; r < 8; r++) {
    // BIT reads but never writes back, so BIT n,(HL) is 3 M-cycles, not 4.
    CB_OPS[0x40 + b * 8 + r] = (c) => {
      c.regs.f = bit(c.getR(r), b, c.regs.f);
    };
    CB_OPS[0x80 + b * 8 + r] = (c) => c.setR(r, c.getR(r) & ~(1 << b));
    CB_OPS[0xc0 + b * 8 + r] = (c) => c.setR(r, c.getR(r) | (1 << b));
  }
}

/** Opcodes with no hardware behavior — the CPU locks up. */
export const ILLEGAL_OPCODES = [
  0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd,
] as const;

export { OPS, CB_OPS, INT_MASK, FLAG_Z, FLAG_N, FLAG_H, FLAG_C };
