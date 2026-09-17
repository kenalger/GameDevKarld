import { beforeEach, describe, expect, it } from 'vitest';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import { Debugger } from '../../packages/emulator/src/gb/debug/Debugger.js';
import { disassembleRange } from '../../packages/emulator/src/gb/debug/disassembler.js';
import { buildRom } from '../harness/rom.js';

let core: GameBoyCore;
let dbg: Debugger;

beforeEach(() => {
  core = new GameBoyCore();
  core.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2 }));
  dbg = new Debugger(core);
});

describe('debugger cost', () => {
  it('IS DISABLED UNTIL SOMETHING IS WATCHED — a closed panel costs nothing', () => {
    expect(dbg.enabled).toBe(false);
    dbg.addBreakpoint(0x0150);
    expect(dbg.enabled).toBe(true);
    dbg.clear();
    expect(dbg.enabled).toBe(false);
  });
});

describe('breakpoints', () => {
  it('toggles on and off', () => {
    expect(dbg.toggleBreakpoint(0x0150)).toBe(true);
    expect(dbg.listBreakpoints()).toEqual([0x0150]);
    expect(dbg.toggleBreakpoint(0x0150)).toBe(false);
    expect(dbg.listBreakpoints()).toEqual([]);
  });

  it('lists breakpoints in address order', () => {
    dbg.addBreakpoint(0x0200);
    dbg.addBreakpoint(0x0100);
    dbg.addBreakpoint(0x0180);
    expect(dbg.listBreakpoints()).toEqual([0x0100, 0x0180, 0x0200]);
  });

  it('masks addresses to 16 bits', () => {
    dbg.addBreakpoint(0x1_0150);
    expect(dbg.listBreakpoints()).toEqual([0x0150]);
  });

  it('runs until a breakpoint is hit and reports where', () => {
    // NOP; NOP; NOP at the entry point so PC walks predictably.
    for (let i = 0; i < 8; i++) core.mmu.write(0xc000 + i, 0x00);
    core.cpu.regs.pc = 0xc000;

    dbg.addBreakpoint(0xc003);
    const event = dbg.runUntilBreak(100);

    expect(event).not.toBeNull();
    expect(event!.reason).toBe('breakpoint');
    expect(event!.address).toBe(0xc003);
    expect(core.cpu.regs.pc).toBe(0xc003);
  });

  it('returns null when the budget runs out without a hit', () => {
    dbg.addBreakpoint(0xffff);
    expect(dbg.runUntilBreak(50)).toBeNull();
  });

  it('does nothing when no breakpoint is set, rather than running forever', () => {
    expect(dbg.runUntilBreak()).toBeNull();
  });
});

describe('stepping', () => {
  it('advances exactly one instruction', () => {
    for (let i = 0; i < 4; i++) core.mmu.write(0xc000 + i, 0x00); // NOPs
    core.cpu.regs.pc = 0xc000;

    dbg.stepInstruction();
    expect(core.cpu.regs.pc).toBe(0xc001);
    dbg.stepInstruction();
    expect(core.cpu.regs.pc).toBe(0xc002);
  });

  it('advances a whole frame', () => {
    const before = core.getInspector().getFrameCount();
    dbg.stepFrame();
    expect(core.getInspector().getFrameCount()).toBe(before + 1);
  });

  it('records what it last did', () => {
    dbg.stepInstruction();
    expect(dbg.getLastBreak()?.reason).toBe('step');
  });
});

describe('watchpoints', () => {
  it('records a matching access', () => {
    dbg.addWatchpoint(0xc000, 'write');
    dbg.notifyAccess(0xc000, 'write', 0x42);
    const event = dbg.getLastBreak();
    expect(event?.reason).toBe('watchpoint');
    expect(event?.address).toBe(0xc000);
    expect(event?.detail).toContain('$42');
  });

  it('ignores the wrong access kind', () => {
    dbg.addWatchpoint(0xc000, 'write');
    dbg.notifyAccess(0xc000, 'read', 0x42);
    expect(dbg.getLastBreak()).toBeNull();
  });

  it('matches either kind when watching access', () => {
    dbg.addWatchpoint(0xc000, 'access');
    dbg.notifyAccess(0xc000, 'read', 0x01);
    expect(dbg.getLastBreak()?.reason).toBe('watchpoint');
  });

  it('ignores an unwatched address', () => {
    dbg.addWatchpoint(0xc000);
    dbg.notifyAccess(0xd000, 'write', 0x01);
    expect(dbg.getLastBreak()).toBeNull();
  });
});

describe('inspection is read-only', () => {
  it('disassembles around PC without changing machine state', () => {
    for (let f = 0; f < 10; f++) core.runFrame();
    const before = core.getInspector().getCpuSnapshot();

    const listing = disassembleRange(before.pc, 8, (a) => core.getInspector().readMemory(a));
    expect(listing).toHaveLength(8);
    expect(listing[0]!.address).toBe(before.pc);

    const after = core.getInspector().getCpuSnapshot();
    expect(after).toEqual(before);
  });

  it('reads a memory range without disturbing the CPU', () => {
    for (let f = 0; f < 5; f++) core.runFrame();
    const before = core.getInspector().getCpuSnapshot();

    const out = new Uint8Array(256);
    core.getInspector().readMemoryRange(0xc000, 256, out);

    expect(core.getInspector().getCpuSnapshot()).toEqual(before);
  });
});
