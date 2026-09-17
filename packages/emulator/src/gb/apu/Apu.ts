import { PulseChannel } from './PulseChannel.js';
import { WaveChannel } from './WaveChannel.js';
import { NoiseChannel } from './NoiseChannel.js';

/** The system clock. */
export const CPU_CLOCK_HZ = 4194304;

/** Native sample rate of the emulated APU, before resampling for the browser. */
export const APU_NATIVE_RATE = CPU_CLOCK_HZ / 4; // 1048576 Hz

/**
 * The Game Boy APU.
 *
 * The single most important structural fact: **the frame sequencer is clocked by a falling
 * edge of a DIV bit, not by a free-running 512Hz timer.** Writing to DIV can therefore clock
 * it early, which software (and Blargg) can detect. Bit 4 in normal speed; bit 5 in CGB
 * double speed.
 *
 * Sequencer steps (512Hz):
 *   0,2,4,6 -> length (256Hz)   2,6 -> sweep (128Hz)   7 -> envelope (64Hz)
 */
export class Apu {
  readonly ch1 = new PulseChannel(true);
  readonly ch2 = new PulseChannel(false);
  readonly ch3 = new WaveChannel();
  readonly ch4 = new NoiseChannel();

  /** CGB clears the length counters on power-off; DMG preserves them. */
  cgb = false;

  private powered = false;
  private sequencerStep = 0;
  private lastDivBit = false;

  /** NR50 / NR51. */
  private leftVolume = 0;
  private rightVolume = 0;
  private vinLeft = false;
  private vinRight = false;
  private panning = 0;

  /**
   * Sample accumulation for the host's output rate.
   *
   * Counted in T-CYCLES, because `tickT` runs at the full 4194304 Hz system clock — not at
   * the APU's 1048576 Hz native sample rate.
   */
  private sampleCounter = 0;
  private tCyclesPerOutput = CPU_CLOCK_HZ / 48000;
  private onSample: ((left: number, right: number) => void) | null = null;

  reset(): void {
    this.ch1.reset();
    this.ch2.reset();
    this.ch3.reset();
    this.ch4.reset();
    this.powered = true;
    this.sequencerStep = 0;
    this.lastDivBit = false;
    // Post-boot: NR50 = 0x77, NR51 = 0xF3, NR52 = 0xF1.
    this.leftVolume = 7;
    this.rightVolume = 7;
    this.vinLeft = false;
    this.vinRight = false;
    this.panning = 0xf3;
    this.sampleCounter = 0;

    // The boot ROM plays the startup chime and leaves channel 1 still enabled, which is why
    // post-boot NR52 reads 0xF1 rather than 0xF0. WebBoy has no boot ROM, so that state is
    // restored directly — Mooneye's boot_hwio checks it.
    this.ch1.writeNrX1(0x80); // duty 2, as the chime left it
    this.ch1.envelope.write(0xf3);
    this.ch1.enabled = true;
  }

  /** Host output rate, so the APU can decimate to it. */
  setOutputRate(hz: number, sink: (left: number, right: number) => void): void {
    this.tCyclesPerOutput = CPU_CLOCK_HZ / hz;
    this.onSample = sink;
  }

  clearSink(): void {
    this.onSample = null;
  }

  /**
   * Advances one T-cycle.
   *
   * `divBit` is the APU-relevant bit of the timer's internal counter; the frame sequencer
   * advances on its falling edge.
   */
  tickT(divBit: boolean): void {
    if (this.lastDivBit && !divBit) this.stepSequencer();
    this.lastDivBit = divBit;

    if (!this.powered) return;

    this.ch1.tickT();
    this.ch2.tickT();
    this.ch3.tickT();
    this.ch4.tickT();

    if (this.onSample) {
      this.sampleCounter++;
      if (this.sampleCounter >= this.tCyclesPerOutput) {
        this.sampleCounter -= this.tCyclesPerOutput;
        const { left, right } = this.mix();
        this.onSample(left, right);
      }
    }
  }

  private stepSequencer(): void {
    if (!this.powered) return;

    const step = this.sequencerStep;
    if ((step & 1) === 0) {
      this.ch1.clockLength();
      this.ch2.clockLength();
      this.ch3.clockLength();
      this.ch4.clockLength();
    }
    if (step === 2 || step === 6) this.ch1.clockSweep();
    if (step === 7) {
      this.ch1.clockEnvelope();
      this.ch2.clockEnvelope();
      this.ch4.clockEnvelope();
    }
    this.sequencerStep = (step + 1) & 7;
  }

  /**
   * True when the NEXT sequencer step will clock the length counters.
   *
   * Channels need this to implement the extra-clocking quirk on an NRx4 write.
   */
  private get nextStepClocksLength(): boolean {
    return (this.sequencerStep & 1) === 0;
  }

  private mix(): { left: number; right: number } {
    const outputs = [this.ch1.output(), this.ch2.output(), this.ch3.output(), this.ch4.output()];
    let left = 0;
    let right = 0;
    for (let i = 0; i < 4; i++) {
      if ((this.panning & (0x10 << i)) !== 0) left += outputs[i]!;
      if ((this.panning & (1 << i)) !== 0) right += outputs[i]!;
    }
    // Four channels summed, then master volume (0-7 maps to 1-8 steps).
    left = (left / 4) * ((this.leftVolume + 1) / 8);
    right = (right / 4) * ((this.rightVolume + 1) / 8);
    return { left, right };
  }

  /* --------------------------------- registers -------------------------------- */

  read(address: number): number {
    if (address >= 0xff30 && address <= 0xff3f) return this.ch3.readRam(address - 0xff30);

    switch (address) {
      case 0xff10:
        return this.ch1.readNr10();
      case 0xff11:
        return this.ch1.readNrX1();
      case 0xff12:
        return this.ch1.readNrX2();
      case 0xff13:
        return 0xff; // write-only
      case 0xff14:
        return this.ch1.readNrX4();
      case 0xff16:
        return this.ch2.readNrX1();
      case 0xff17:
        return this.ch2.readNrX2();
      case 0xff18:
        return 0xff;
      case 0xff19:
        return this.ch2.readNrX4();
      case 0xff1a:
        return this.ch3.readNr30();
      case 0xff1b:
        return 0xff;
      case 0xff1c:
        return this.ch3.readNr32();
      case 0xff1d:
        return 0xff;
      case 0xff1e:
        return this.ch3.readNr34();
      case 0xff20:
        return 0xff;
      case 0xff21:
        return this.ch4.readNr42();
      case 0xff22:
        return this.ch4.readNr43();
      case 0xff23:
        return this.ch4.readNr44();
      case 0xff24:
        return (
          (this.vinLeft ? 0x80 : 0) |
          (this.leftVolume << 4) |
          (this.vinRight ? 0x08 : 0) |
          this.rightVolume
        );
      case 0xff25:
        return this.panning;
      case 0xff26:
        // Bits 0-3 are read-only channel status, driven by the length counters and DACs —
        // NOT by whether the channel is currently audible.
        return (
          0x70 |
          (this.powered ? 0x80 : 0) |
          (this.ch1.enabled ? 0x01 : 0) |
          (this.ch2.enabled ? 0x02 : 0) |
          (this.ch3.enabled ? 0x04 : 0) |
          (this.ch4.enabled ? 0x08 : 0)
        );
      default:
        return 0xff;
    }
  }

  write(address: number, value: number): void {
    const byte = value & 0xff;

    // Wave RAM stays accessible with the APU powered down.
    if (address >= 0xff30 && address <= 0xff3f) {
      this.ch3.writeRam(address - 0xff30, byte);
      return;
    }

    if (address === 0xff26) {
      this.writeNr52(byte);
      return;
    }

    // While powered off, most registers ignore writes — but on a DMG the LENGTH LOAD
    // fields stay writable. Only the length bits take effect; duty is ignored. On a CGB
    // even that is refused.
    if (!this.powered) {
      if (this.cgb) return;
      switch (address) {
        case 0xff11:
          this.ch1.length.load(byte & 0x3f);
          break;
        case 0xff16:
          this.ch2.length.load(byte & 0x3f);
          break;
        case 0xff1b:
          this.ch3.length.load(byte & 0xff);
          break;
        case 0xff20:
          this.ch4.length.load(byte & 0x3f);
          break;
        default:
          break;
      }
      return;
    }

    const clocks = this.nextStepClocksLength;
    switch (address) {
      case 0xff10:
        this.ch1.writeNr10(byte);
        break;
      case 0xff11:
        this.ch1.writeNrX1(byte);
        break;
      case 0xff12:
        this.ch1.writeNrX2(byte);
        break;
      case 0xff13:
        this.ch1.writeNrX3(byte);
        break;
      case 0xff14:
        this.ch1.writeNrX4(byte, clocks);
        break;
      case 0xff16:
        this.ch2.writeNrX1(byte);
        break;
      case 0xff17:
        this.ch2.writeNrX2(byte);
        break;
      case 0xff18:
        this.ch2.writeNrX3(byte);
        break;
      case 0xff19:
        this.ch2.writeNrX4(byte, clocks);
        break;
      case 0xff1a:
        this.ch3.writeNr30(byte);
        break;
      case 0xff1b:
        this.ch3.writeNr31(byte);
        break;
      case 0xff1c:
        this.ch3.writeNr32(byte);
        break;
      case 0xff1d:
        this.ch3.writeNr33(byte);
        break;
      case 0xff1e:
        this.ch3.writeNr34(byte, clocks);
        break;
      case 0xff20:
        this.ch4.writeNr41(byte);
        break;
      case 0xff21:
        this.ch4.writeNr42(byte);
        break;
      case 0xff22:
        this.ch4.writeNr43(byte);
        break;
      case 0xff23:
        this.ch4.writeNr44(byte, clocks);
        break;
      case 0xff24:
        this.vinLeft = (byte & 0x80) !== 0;
        this.leftVolume = (byte >> 4) & 0x07;
        this.vinRight = (byte & 0x08) !== 0;
        this.rightVolume = byte & 0x07;
        break;
      case 0xff25:
        this.panning = byte;
        break;
      default:
        break;
    }
  }

  /* -------------------------------- save state -------------------------------- */

  serializableState() {
    return {
      powered: this.powered,
      sequencerStep: this.sequencerStep,
      lastDivBit: this.lastDivBit,
      leftVolume: this.leftVolume,
      rightVolume: this.rightVolume,
      panning: this.panning,
      waveRam: this.ch3.ram,
    };
  }

  restoreState(s: ReturnType<Apu['serializableState']>): void {
    this.powered = s.powered;
    this.sequencerStep = s.sequencerStep;
    this.lastDivBit = s.lastDivBit;
    this.leftVolume = s.leftVolume;
    this.rightVolume = s.rightVolume;
    this.panning = s.panning;
    this.ch3.ram.set(s.waveRam.subarray(0, this.ch3.ram.length));
  }

  /** NR52 bit 7. Powering off zeroes every register and silences everything. */
  private writeNr52(byte: number): void {
    const powerOn = (byte & 0x80) !== 0;
    if (this.powered && !powerOn) {
      // Clear all channel state. On a DMG the LENGTH COUNTERS and wave RAM survive — the
      // counters keep counting and can still be written while the APU is off. On a CGB the
      // counters ARE cleared. Blargg's 08 and 11 tests check the opposite behaviour on each
      // machine, so this cannot be a single rule.
      const lengths = [
        this.ch1.length.value,
        this.ch2.length.value,
        this.ch3.length.value,
        this.ch4.length.value,
      ];

      this.ch1.reset();
      this.ch2.reset();
      this.ch3.reset();
      this.ch4.reset();

      if (!this.cgb) {
        this.ch1.length.value = lengths[0]!;
        this.ch2.length.value = lengths[1]!;
        this.ch3.length.value = lengths[2]!;
        this.ch4.length.value = lengths[3]!;
      }
      this.leftVolume = 0;
      this.rightVolume = 0;
      this.vinLeft = false;
      this.vinRight = false;
      this.panning = 0;
      this.powered = false;
      return;
    }
    if (!this.powered && powerOn) {
      this.powered = true;
      // The sequencer restarts, so the first step after power-up clocks length.
      this.sequencerStep = 0;
    }
  }
}
