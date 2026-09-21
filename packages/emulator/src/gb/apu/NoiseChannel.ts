import { LengthCounter, VolumeEnvelope } from './components.js';
import type { StateReader, StateWriter } from '../state/StateBuffer.js';

/** Divisors for the noise frequency, indexed by the low 3 bits of NR43. */
const DIVISOR = [8, 16, 32, 48, 64, 80, 96, 112] as const;

/**
 * Channel 4 — pseudo-random noise from a linear-feedback shift register.
 *
 * The LFSR is 15 bits, or 7 when the width bit is set, which produces the distinctly more
 * metallic tone games use for percussion.
 */
export class NoiseChannel {
  enabled = false;
  private lfsr = 0x7fff;
  private clockShift = 0;
  private widthMode = false;
  private divisorCode = 0;
  private timer = 0;

  readonly length = new LengthCounter(64);
  readonly envelope = new VolumeEnvelope();

  saveState(w: StateWriter): void {
    w.bool(this.enabled);
    w.u16(this.lfsr);
    w.u8(this.clockShift);
    w.bool(this.widthMode);
    w.u8(this.divisorCode);
    w.u32(this.timer);
    this.length.saveState(w);
    this.envelope.saveState(w);
  }

  loadState(r: StateReader): void {
    this.enabled = r.bool();
    this.lfsr = r.u16();
    this.clockShift = r.u8();
    this.widthMode = r.bool();
    this.divisorCode = r.u8();
    this.timer = r.u32();
    this.length.loadState(r);
    this.envelope.loadState(r);
  }

  reset(): void {
    this.enabled = false;
    this.lfsr = 0x7fff;
    this.clockShift = 0;
    this.widthMode = false;
    this.divisorCode = 0;
    this.timer = 0;
    this.length.reset();
    this.envelope.reset();
  }

  get dacEnabled(): boolean {
    return this.envelope.dacEnabled;
  }

  output(): number {
    if (!this.enabled || !this.dacEnabled) return 0;
    // Bit 0 inverted drives the output.
    const sample = (~this.lfsr & 1) * this.envelope.volume;
    return sample / 7.5 - 1;
  }

  private period(): number {
    return DIVISOR[this.divisorCode]! << this.clockShift;
  }

  tickT(): void {
    if (--this.timer > 0) return;
    this.timer = this.period();

    const xor = (this.lfsr & 1) ^ ((this.lfsr >> 1) & 1);
    this.lfsr = (this.lfsr >> 1) | (xor << 14);
    if (this.widthMode) {
      // 7-bit mode also feeds bit 6.
      this.lfsr = (this.lfsr & ~0x40) | (xor << 6);
    }
  }

  clockLength(): void {
    if (this.length.clock()) this.enabled = false;
  }

  clockEnvelope(): void {
    this.envelope.clock();
  }

  writeNr41(value: number): void {
    this.length.load(value & 0x3f);
  }

  readNr42(): number {
    return this.envelope.read();
  }

  writeNr42(value: number): void {
    this.envelope.write(value);
    if (!this.dacEnabled) this.enabled = false;
  }

  readNr43(): number {
    return (this.clockShift << 4) | (this.widthMode ? 0x08 : 0) | this.divisorCode;
  }

  writeNr43(value: number): void {
    this.clockShift = (value >> 4) & 0x0f;
    this.widthMode = (value & 0x08) !== 0;
    this.divisorCode = value & 0x07;
  }

  readNr44(): number {
    return 0xbf | (this.length.enabled ? 0x40 : 0);
  }

  writeNr44(value: number, nextStepClocksLength: boolean): void {
    const trigger = (value & 0x80) !== 0;
    if (this.length.writeControl((value & 0x40) !== 0, trigger, nextStepClocksLength)) {
      this.enabled = false;
    }
    if (!trigger) return;

    this.enabled = true;
    this.timer = this.period();
    this.lfsr = 0x7fff;
    this.envelope.trigger();
    if (!this.dacEnabled) this.enabled = false;
  }
}
