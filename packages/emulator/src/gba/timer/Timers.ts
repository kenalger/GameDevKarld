import type { StateReader, StateWriter } from '../../gb/state/StateBuffer.js';

/** Prescaler divisors, indexed by the 2-bit field in the control register. */
const PRESCALER = [1, 64, 256, 1024] as const;

/**
 * One of the four GBA timers.
 *
 * Reading the counter gives the live value; writing the same address sets the RELOAD
 * value instead, which only takes effect on overflow or on enable. That asymmetry catches
 * people out, so read and write are deliberately separate methods here.
 */
export class GbaTimer {
  /** The live 16-bit counter. */
  private counter = 0;
  /** Loaded into the counter on overflow and on the enable edge. */
  private reload = 0;
  private control = 0;
  /** Prescaler remainder, so a divisor of 1024 does not lose cycles between calls. */
  private remainder = 0;

  constructor(
    readonly index: number,
    private readonly onOverflow: (index: number) => void,
  ) {}

  reset(): void {
    this.counter = 0;
    this.reload = 0;
    this.control = 0;
    this.remainder = 0;
  }

  saveState(w: StateWriter): void {
    w.u16(this.counter);
    w.u16(this.reload);
    w.u16(this.control);
    w.f64(this.remainder);
  }

  loadState(r: StateReader): void {
    this.counter = r.u16();
    this.reload = r.u16();
    this.control = r.u16();
    this.remainder = r.f64();
  }

  get enabled(): boolean {
    return (this.control & 0x80) !== 0;
  }

  /** Cascade: this timer counts overflows of the one below it, not clock cycles. */
  get cascade(): boolean {
    return this.index > 0 && (this.control & 0x04) !== 0;
  }

  get irqEnabled(): boolean {
    return (this.control & 0x40) !== 0;
  }

  private get prescaler(): number {
    return PRESCALER[this.control & 3]!;
  }

  readCounter(): number {
    return this.counter & 0xffff;
  }

  readControl(): number {
    return this.control & 0xc7;
  }

  /** Writing the counter address sets the RELOAD value, not the counter. */
  writeReload(value: number): void {
    this.reload = value & 0xffff;
  }

  writeControl(value: number): void {
    const wasEnabled = this.enabled;
    this.control = value & 0xffff;
    // A disabled -> enabled edge loads the reload value; staying enabled does not.
    if (!wasEnabled && this.enabled) {
      this.counter = this.reload;
      this.remainder = 0;
    }
  }

  /** Advances by `cycles`. Returns the number of times it overflowed. */
  tick(cycles: number): number {
    if (!this.enabled || this.cascade) return 0;

    this.remainder += cycles;
    const divisor = this.prescaler;
    const ticks = Math.floor(this.remainder / divisor);
    if (ticks === 0) return 0;
    this.remainder -= ticks * divisor;

    return this.advance(ticks);
  }

  /** Cascaded timers are advanced one step per overflow of the timer below. */
  cascadeTick(count: number): number {
    if (!this.enabled || !this.cascade) return 0;
    return this.advance(count);
  }

  private advance(ticks: number): number {
    let overflows = 0;
    let counter = this.counter + ticks;

    while (counter > 0xffff) {
      counter -= 0x10000 - this.reload;
      overflows++;
      // Guard against a reload of 0xFFFF with a huge tick count spinning forever.
      if (overflows > 0x10000) break;
    }

    this.counter = counter & 0xffff;
    if (overflows > 0 && this.irqEnabled) this.onOverflow(this.index);
    return overflows;
  }
}

/**
 * The four-timer block.
 *
 * Timers 0 and 1 additionally pace the sound FIFOs, which is why Direct Sound spans the
 * CPU, DMA and audio subsystems — the timer overflow is what pops a sample.
 */
export class TimerController {
  readonly timers: readonly GbaTimer[];

  constructor(
    onInterrupt: (index: number) => void,
    /**
     * Called when timer 0 or 1 overflows, which is what paces the Direct Sound FIFOs.
     * Assignable so the core can close the timer -> APU -> DMA loop after construction.
     */
    public onFifoTick: (timerIndex: number) => void = () => undefined,
  ) {
    this.timers = [0, 1, 2, 3].map((i) => new GbaTimer(i, onInterrupt));
  }

  reset(): void {
    for (const timer of this.timers) timer.reset();
  }

  saveState(w: StateWriter): void {
    for (const timer of this.timers) timer.saveState(w);
  }

  loadState(r: StateReader): void {
    for (const timer of this.timers) timer.loadState(r);
  }

  /** Advances every timer, propagating cascades upward. */
  tick(cycles: number): void {
    let carry = 0;
    for (let i = 0; i < 4; i++) {
      const timer = this.timers[i]!;
      const overflows = timer.cascade ? timer.cascadeTick(carry) : timer.tick(cycles);
      if (overflows > 0 && (i === 0 || i === 1)) this.onFifoTick(i);
      carry = overflows;
    }
  }

  read(address: number): number {
    const index = (address - 0x04000100) >> 2;
    const timer = this.timers[index];
    if (!timer) return 0;
    return (address & 2) === 0 ? timer.readCounter() : timer.readControl();
  }

  write16(address: number, value: number): void {
    const index = (address - 0x04000100) >> 2;
    const timer = this.timers[index];
    if (!timer) return;
    if ((address & 2) === 0) timer.writeReload(value);
    else timer.writeControl(value);
  }
}
