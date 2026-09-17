import { LengthCounter, VolumeEnvelope } from './components.js';

/** The four duty cycles, as 8-step waveforms. */
const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
] as const;

/**
 * A square-wave channel. Channel 1 adds the frequency sweep; channel 2 does not.
 */
export class PulseChannel {
  enabled = false;
  private duty = 0;
  private frequency = 0;
  private timer = 0;
  private step = 0;

  readonly length = new LengthCounter(64);
  readonly envelope = new VolumeEnvelope();

  /* -- sweep (channel 1 only) -- */
  private sweepPeriod = 0;
  private sweepNegate = false;
  private sweepShift = 0;
  private sweepTimer = 0;
  private sweepEnabled = false;
  private sweepShadow = 0;
  /** Set once a negate-mode calculation has happened; clearing negate then kills the channel. */
  private sweepNegateUsed = false;

  constructor(private readonly hasSweep: boolean) {}

  reset(): void {
    this.enabled = false;
    this.duty = 0;
    this.frequency = 0;
    this.timer = 0;
    this.step = 0;
    this.length.reset();
    this.envelope.reset();
    this.sweepPeriod = 0;
    this.sweepNegate = false;
    this.sweepShift = 0;
    this.sweepTimer = 0;
    this.sweepEnabled = false;
    this.sweepShadow = 0;
    this.sweepNegateUsed = false;
  }

  get dacEnabled(): boolean {
    return this.envelope.dacEnabled;
  }

  /** -1.0 .. 1.0, or 0 when the DAC is off. */
  output(): number {
    if (!this.enabled || !this.dacEnabled) return 0;
    const sample = DUTY[this.duty]![this.step]! * this.envelope.volume;
    // A DAC maps 0..15 onto roughly -1..1.
    return sample / 7.5 - 1;
  }

  tickT(): void {
    if (--this.timer > 0) return;
    this.timer = (2048 - this.frequency) * 4;
    this.step = (this.step + 1) & 7;
  }

  clockLength(): void {
    if (this.length.clock()) this.enabled = false;
  }

  clockEnvelope(): void {
    this.envelope.clock();
  }

  clockSweep(): void {
    if (!this.hasSweep || !this.sweepEnabled) return;
    if (--this.sweepTimer > 0) return;

    this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
    if (this.sweepPeriod === 0) return;

    const next = this.calculateSweep();
    if (next > 2047) {
      this.enabled = false;
      return;
    }
    if (this.sweepShift === 0) return;

    this.sweepShadow = next;
    this.frequency = next;
    // A second calculation runs immediately, for the overflow check only.
    if (this.calculateSweep() > 2047) this.enabled = false;
  }

  private calculateSweep(): number {
    const delta = this.sweepShadow >> this.sweepShift;
    if (this.sweepNegate) {
      this.sweepNegateUsed = true;
      return this.sweepShadow - delta;
    }
    return this.sweepShadow + delta;
  }

  /* --------------------------------- registers -------------------------------- */

  readNr10(): number {
    return 0x80 | (this.sweepPeriod << 4) | (this.sweepNegate ? 0x08 : 0) | this.sweepShift;
  }

  writeNr10(value: number): void {
    this.sweepPeriod = (value >> 4) & 0x07;
    const negate = (value & 0x08) !== 0;
    // Leaving negate mode after it has been used disables the channel — a real quirk that
    // Blargg's sweep test checks.
    if (this.sweepNegate && !negate && this.sweepNegateUsed) this.enabled = false;
    this.sweepNegate = negate;
    this.sweepShift = value & 0x07;
  }

  readNrX1(): number {
    return 0x3f | (this.duty << 6);
  }

  writeNrX1(value: number): void {
    this.duty = (value >> 6) & 0x03;
    this.length.load(value & 0x3f);
  }

  readNrX2(): number {
    return this.envelope.read();
  }

  writeNrX2(value: number): void {
    this.envelope.write(value);
    // Powering the DAC down disables the channel immediately.
    if (!this.dacEnabled) this.enabled = false;
  }

  writeNrX3(value: number): void {
    this.frequency = (this.frequency & 0x700) | value;
  }

  readNrX4(): number {
    return 0xbf | (this.length.enabled ? 0x40 : 0);
  }

  writeNrX4(value: number, nextStepClocksLength: boolean): void {
    this.frequency = (this.frequency & 0xff) | ((value & 0x07) << 8);

    const trigger = (value & 0x80) !== 0;
    if (this.length.writeControl((value & 0x40) !== 0, trigger, nextStepClocksLength)) {
      this.enabled = false;
    }
    if (trigger) this.trigger(nextStepClocksLength);
  }

  private trigger(nextStepClocksLength: boolean): void {
    void nextStepClocksLength;
    this.enabled = true;
    this.timer = (2048 - this.frequency) * 4;
    this.envelope.trigger();

    if (this.hasSweep) {
      this.sweepShadow = this.frequency;
      this.sweepTimer = this.sweepPeriod === 0 ? 8 : this.sweepPeriod;
      this.sweepEnabled = this.sweepPeriod !== 0 || this.sweepShift !== 0;
      this.sweepNegateUsed = false;
      // With a shift set, the overflow check runs at once and can kill the channel here.
      if (this.sweepShift !== 0 && this.calculateSweep() > 2047) this.enabled = false;
    }

    // Triggering with the DAC off leaves the channel disabled.
    if (!this.dacEnabled) this.enabled = false;
  }
}
