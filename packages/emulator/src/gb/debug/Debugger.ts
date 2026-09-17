import type { GameBoyCore } from '../GameBoyCore.js';

export type WatchKind = 'read' | 'write' | 'access';

export interface Watchpoint {
  readonly address: number;
  readonly kind: WatchKind;
}

export interface BreakEvent {
  readonly reason: 'breakpoint' | 'watchpoint' | 'step';
  readonly address: number;
  readonly detail: string;
}

/**
 * Developer-mode debugging: breakpoints, memory watchpoints and stepping.
 *
 * COST WHEN CLOSED IS ZERO. `enabled` is false until something is actually being watched,
 * and the emulator's hot path checks a single boolean. Nothing is snapshotted per frame,
 * because a debugger that taxes the emulator while nobody is looking is a performance bug
 * wearing a useful hat.
 */
export class Debugger {
  private readonly breakpoints = new Set<number>();
  private readonly watchpoints = new Map<number, WatchKind>();
  private lastBreak: BreakEvent | null = null;

  constructor(private readonly core: GameBoyCore) {}

  /** True only when something is actually being watched. */
  get enabled(): boolean {
    return this.breakpoints.size > 0 || this.watchpoints.size > 0;
  }

  addBreakpoint(address: number): void {
    this.breakpoints.add(address & 0xffff);
  }

  removeBreakpoint(address: number): void {
    this.breakpoints.delete(address & 0xffff);
  }

  toggleBreakpoint(address: number): boolean {
    const addr = address & 0xffff;
    if (this.breakpoints.has(addr)) {
      this.breakpoints.delete(addr);
      return false;
    }
    this.breakpoints.add(addr);
    return true;
  }

  listBreakpoints(): number[] {
    return [...this.breakpoints].sort((a, b) => a - b);
  }

  addWatchpoint(address: number, kind: WatchKind = 'access'): void {
    this.watchpoints.set(address & 0xffff, kind);
  }

  removeWatchpoint(address: number): void {
    this.watchpoints.delete(address & 0xffff);
  }

  listWatchpoints(): Watchpoint[] {
    return [...this.watchpoints].map(([address, kind]) => ({ address, kind }));
  }

  clear(): void {
    this.breakpoints.clear();
    this.watchpoints.clear();
    this.lastBreak = null;
  }

  getLastBreak(): BreakEvent | null {
    return this.lastBreak;
  }

  /** Runs exactly one instruction. */
  stepInstruction(): BreakEvent {
    this.core.stepInstruction();
    const address = this.core.cpu.regs.pc;
    this.lastBreak = { reason: 'step', address, detail: 'Stepped one instruction' };
    return this.lastBreak;
  }

  /** Runs to the end of the current frame. */
  stepFrame(): BreakEvent {
    this.core.runFrame();
    const address = this.core.cpu.regs.pc;
    this.lastBreak = { reason: 'step', address, detail: 'Stepped one frame' };
    return this.lastBreak;
  }

  /**
   * Runs until a breakpoint hits or the budget is exhausted.
   *
   * Returns the break event, or null when the budget ran out without a hit.
   */
  runUntilBreak(maxInstructions = 5_000_000): BreakEvent | null {
    if (this.breakpoints.size === 0) return null;

    for (let i = 0; i < maxInstructions; i++) {
      this.core.stepInstruction();
      const pc = this.core.cpu.regs.pc;
      if (this.breakpoints.has(pc)) {
        this.lastBreak = {
          reason: 'breakpoint',
          address: pc,
          detail: `Breakpoint at $${pc.toString(16).padStart(4, '0').toUpperCase()}`,
        };
        return this.lastBreak;
      }
    }
    return null;
  }

  /** Called by the bus when a watched address is touched. */
  notifyAccess(address: number, kind: 'read' | 'write', value: number): void {
    const watched = this.watchpoints.get(address & 0xffff);
    if (!watched) return;
    if (watched !== 'access' && watched !== kind) return;

    this.lastBreak = {
      reason: 'watchpoint',
      address: address & 0xffff,
      detail: `${kind} $${value.toString(16).padStart(2, '0').toUpperCase()} at $${address.toString(16).padStart(4, '0').toUpperCase()}`,
    };
  }
}
