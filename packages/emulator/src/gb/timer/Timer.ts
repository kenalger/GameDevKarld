import type { InterruptController } from '../cpu/interrupts.js';
import { INT_TIMER } from '../cpu/interrupts.js';
import type { StateReader, StateWriter } from '../state/StateBuffer.js';

/** Which bit of the internal counter TAC selects, indexed by TAC bits 0-1. */
const TAC_BIT = [9, 3, 5, 7] as const;

/**
 * DIV / TIMA / TMA / TAC.
 *
 * The critical design point: DIV is the top 8 bits of a free-running 16-bit counter, and
 * TIMA increments on the **falling edge** of (selected counter bit AND TAC enable). Writing
 * DIV resets the whole counter, which can itself produce a spurious TIMA increment.
 *
 * Modelling this as "increment TIMA every N cycles" cannot pass Mooneye. The edge detector
 * is the implementation.
 */
export class Timer {
  /** The full 16-bit internal counter. DIV (0xFF04) is its high byte. */
  private counter = 0;
  private tima = 0;
  private tma = 0;
  private tac = 0;

  /**
   * TIMA overflow reloads TMA 4 T-cycles LATE. During that window TIMA reads 0x00, writing
   * TIMA cancels the reload, and writing TMA loads the new value.
   */
  private overflowCountdown = -1;

  constructor(private readonly interrupts: InterruptController) {}

  reset(): void {
    // Post-boot DIV on a DMG is 0xAB.
    this.counter = 0xabcc;
    this.tima = 0;
    this.tma = 0;
    this.tac = 0xf8;
    this.overflowCountdown = -1;
  }

  /**
   * The bit of the internal counter that clocks the APU's frame sequencer.
   *
   * Bit 4 at normal speed (bit 5 in CGB double speed, which arrives in Phase 11). The APU
   * steps on this signal's FALLING edge, which is why a DIV write can clock it early.
   */
  get apuClockBit(): boolean {
    return (this.counter & 0x1000) !== 0;
  }

  get div(): number {
    return (this.counter >>> 8) & 0xff;
  }

  /** Advances by one T-cycle. Called four times per M-cycle so no edge is skipped. */
  tickT(): void {
    // A countdown of exactly 0 marks the single cycle on which TMA was loaded; that cycle
    // is over by the time the next one starts.
    if (this.overflowCountdown === 0) this.overflowCountdown = -1;

    if (this.overflowCountdown > 0) {
      this.overflowCountdown--;
      if (this.overflowCountdown === 0) {
        this.tima = this.tma;
        this.interrupts.request(INT_TIMER);
      }
    }
    this.setCounter((this.counter + 1) & 0xffff);
  }

  private setCounter(value: number): void {
    const before = this.edgeSignal(this.counter, this.tac);
    this.counter = value;
    const after = this.edgeSignal(this.counter, this.tac);
    if (before && !after) this.incrementTima();
  }

  private edgeSignal(counter: number, tac: number): boolean {
    if ((tac & 0x04) === 0) return false;
    return (counter & (1 << TAC_BIT[tac & 0x03]!)) !== 0;
  }

  private incrementTima(): void {
    this.tima = (this.tima + 1) & 0xff;
    if (this.tima === 0) {
      // Overflow: TIMA reads 0 for 4 T-cycles before TMA loads and the interrupt fires.
      this.overflowCountdown = 4;
    }
  }

  read(address: number): number {
    switch (address) {
      case 0xff04:
        return this.div;
      case 0xff05:
        return this.tima;
      case 0xff06:
        return this.tma;
      case 0xff07:
        return this.tac | 0xf8;
      default:
        return 0xff;
    }
  }

  write(address: number, value: number): void {
    const byte = value & 0xff;
    switch (address) {
      case 0xff04:
        // Any write resets the whole 16-bit counter, which may drop the selected bit
        // from 1 to 0 and clock TIMA.
        this.setCounter(0);
        break;
      case 0xff05:
        // On the exact cycle TMA is loaded, a write to TIMA is IGNORED — TMA wins.
        if (this.overflowCountdown === 0) break;
        // Anywhere else in the window, the write cancels the pending reload.
        if (this.overflowCountdown > 0) this.overflowCountdown = -1;
        this.tima = byte;
        break;
      case 0xff06:
        this.tma = byte;
        // Writing TMA during the window loads the NEW value.
        if (this.overflowCountdown === 0) this.tima = byte;
        break;
      case 0xff07: {
        const before = this.edgeSignal(this.counter, this.tac);
        this.tac = byte & 0x07;
        const after = this.edgeSignal(this.counter, this.tac);
        if (before && !after) this.incrementTima();
        break;
      }
      default:
        break;
    }
  }

  saveState(w: StateWriter): void {
    w.u16(this.counter);
    w.u8(this.tima);
    w.u8(this.tma);
    w.u8(this.tac);
    w.u8(this.overflowCountdown + 1); // shift so -1 encodes as 0
  }

  loadState(s: StateReader): void {
    this.counter = s.u16();
    this.tima = s.u8();
    this.tma = s.u8();
    this.tac = s.u8();
    this.overflowCountdown = s.u8() - 1;
  }
}
