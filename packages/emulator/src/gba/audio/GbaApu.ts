import type { StateReader, StateWriter } from '../../gb/state/StateBuffer.js';
import { PulseChannel } from '../../gb/apu/PulseChannel.js';
import { WaveChannel } from '../../gb/apu/WaveChannel.js';
import { NoiseChannel } from '../../gb/apu/NoiseChannel.js';
import { SoundFifo } from './SoundFifo.js';

export const CPU_CLOCK_HZ = 16777216;

/** SOUNDCNT_H bits 0-1: the PSG block's share of the output range. */
const PSG_RATIO = [0.25, 0.5, 1, 0] as const;

/**
 * The GBA sound controller.
 *
 * Two independent systems share one mixer:
 *
 *  - **Four legacy PSG channels**, electrically the same hardware as the Game Boy's. The
 *    DMG channel classes are reused rather than copied, per the charter's "reuse where the
 *    hardware is shared" rule — only the register addresses and the mixer differ.
 *  - **Two Direct Sound FIFOs**, which is what games actually use for music. A timer
 *    overflow pops one byte; DMA refills the queue when it runs low.
 *
 * The frame sequencer here is a plain 512 Hz divider off the CPU clock. Unlike the DMG's,
 * it is not tied to a DIV bit, because the GBA's timers are separate hardware.
 */
export class GbaApu {
  readonly ch1 = new PulseChannel(true);
  readonly ch2 = new PulseChannel(false);
  readonly ch3 = new WaveChannel();
  readonly ch4 = new NoiseChannel();

  readonly fifoA = new SoundFifo();
  readonly fifoB = new SoundFifo();

  private soundcntL = 0;
  private soundcntH = 0;
  private powered = false;
  private soundbias = 0x0200;

  private sequencerStep = 0;
  private sequencerCounter = 0;

  private sampleCounter = 0;
  private tCyclesPerOutput = CPU_CLOCK_HZ / 48000;
  private onSample: ((left: number, right: number) => void) | null = null;

  /** Raised when a FIFO needs more data. The core forwards it to DMA 1 / 2. */
  onFifoRefill: ((fifo: 0 | 1) => void) | null = null;

  reset(): void {
    this.ch1.reset();
    this.ch2.reset();
    this.ch3.reset();
    this.ch4.reset();
    this.fifoA.reset();
    this.fifoB.reset();
    this.soundcntL = 0;
    this.soundcntH = 0;
    this.powered = false;
    this.soundbias = 0x0200;
    this.sequencerStep = 0;
    this.sequencerCounter = 0;
    this.sampleCounter = 0;
  }

  /**
   * Save-state.
   *
   * The output sink and sample rate are host wiring, not machine state, so they are left
   * alone — restoring must not disconnect the audio device the browser already opened.
   *
   * The four PSG channels ARE machine state and are written here. Their registers live in
   * dedicated fields on the channel objects, NOT in the bus's `io` array — sound register
   * writes are routed straight to the APU — so nothing else in the container carries them.
   * Channel 3's wave RAM is the clearest case: a game writes its waveform once at startup
   * and never again, so a state that omits it restores silence or noise.
   */
  saveState(w: StateWriter): void {
    w.u16(this.soundcntL);
    w.u16(this.soundcntH);
    w.bool(this.powered);
    w.u16(this.soundbias);
    w.u8(this.sequencerStep);
    w.f64(this.sequencerCounter);
    w.f64(this.sampleCounter);
    this.fifoA.saveState(w);
    this.fifoB.saveState(w);
    this.ch1.saveState(w);
    this.ch2.saveState(w);
    this.ch3.saveState(w);
    this.ch4.saveState(w);
  }

  loadState(r: StateReader): void {
    this.soundcntL = r.u16();
    this.soundcntH = r.u16();
    this.powered = r.bool();
    this.soundbias = r.u16();
    this.sequencerStep = r.u8();
    this.sequencerCounter = r.f64();
    this.sampleCounter = r.f64();
    this.fifoA.loadState(r);
    this.fifoB.loadState(r);
    this.ch1.loadState(r);
    this.ch2.loadState(r);
    this.ch3.loadState(r);
    this.ch4.loadState(r);
  }

  setOutputRate(hz: number, sink: (left: number, right: number) => void): void {
    this.tCyclesPerOutput = CPU_CLOCK_HZ / hz;
    this.onSample = sink;
  }

  clearSink(): void {
    this.onSample = null;
  }

  /**
   * A timer overflowed. Pops one sample from whichever FIFOs selected that timer, and
   * asks for a DMA refill if the queue has run low.
   */
  notifyTimerOverflow(timerIndex: number): void {
    if (!this.powered) return;

    if (((this.soundcntH >>> 10) & 1) === timerIndex) {
      this.fifoA.tickTimer();
      if (this.fifoA.needsRefill) this.onFifoRefill?.(0);
    }
    if (((this.soundcntH >>> 14) & 1) === timerIndex) {
      this.fifoB.tickTimer();
      if (this.fifoB.needsRefill) this.onFifoRefill?.(1);
    }
  }

  /** Advances by one CPU cycle. */
  tick(): void {
    if (!this.powered) {
      this.emitIfDue(0, 0);
      return;
    }

    // 512 Hz frame sequencer, driving length, sweep and envelope as on the DMG.
    if (++this.sequencerCounter >= CPU_CLOCK_HZ / 512) {
      this.sequencerCounter = 0;
      this.stepSequencer();
    }

    this.ch1.tickT();
    this.ch2.tickT();
    this.ch3.tickT();
    this.ch4.tickT();

    const { left, right } = this.mix();
    this.emitIfDue(left, right);
  }

  private emitIfDue(left: number, right: number): void {
    if (!this.onSample) return;
    this.sampleCounter++;
    if (this.sampleCounter < this.tCyclesPerOutput) return;
    this.sampleCounter -= this.tCyclesPerOutput;
    this.onSample(left, right);
  }

  private stepSequencer(): void {
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
   * Mixes the PSG block and the two FIFOs.
   *
   * Each PSG channel spans a quarter of the output range and the block is then scaled by
   * SOUNDCNT_H's ratio; each FIFO spans the full range at 50% or 100%.
   */
  private mix(): { left: number; right: number } {
    const outputs = [this.ch1.output(), this.ch2.output(), this.ch3.output(), this.ch4.output()];

    let psgLeft = 0;
    let psgRight = 0;
    for (let i = 0; i < 4; i++) {
      if ((this.soundcntL & (0x1000 << i)) !== 0) psgLeft += outputs[i]!;
      if ((this.soundcntL & (0x0100 << i)) !== 0) psgRight += outputs[i]!;
    }

    // SOUNDCNT_L master volume is 0-7, which maps to 1/8 .. 8/8.
    const leftVolume = (((this.soundcntL >>> 4) & 7) + 1) / 8;
    const rightVolume = ((this.soundcntL & 7) + 1) / 8;
    const ratio = PSG_RATIO[this.soundcntH & 3]!;

    let left = (psgLeft / 4) * leftVolume * ratio;
    let right = (psgRight / 4) * rightVolume * ratio;

    // Direct Sound: signed bytes scaled to -1..1, at half or full volume.
    const aVolume = (this.soundcntH & 0x0004) !== 0 ? 1 : 0.5;
    const bVolume = (this.soundcntH & 0x0008) !== 0 ? 1 : 0.5;
    const a = (this.fifoA.sample / 128) * aVolume;
    const b = (this.fifoB.sample / 128) * bVolume;

    if ((this.soundcntH & 0x0200) !== 0) left += a;
    if ((this.soundcntH & 0x0100) !== 0) right += a;
    if ((this.soundcntH & 0x2000) !== 0) left += b;
    if ((this.soundcntH & 0x1000) !== 0) right += b;

    return { left: clamp(left), right: clamp(right) };
  }

  /* --------------------------------- registers -------------------------------- */

  read(address: number): number {
    // The PSG channel registers mirror the DMG's, offset from 0x04000060.
    if (address >= 0x04000060 && address <= 0x0400007f) {
      return this.readPsg(address);
    }
    switch (address) {
      case 0x04000080:
        return this.soundcntL;
      case 0x04000082:
        return this.soundcntH & 0x770f;
      case 0x04000084:
        return (
          (this.powered ? 0x80 : 0) |
          (this.ch1.enabled ? 1 : 0) |
          (this.ch2.enabled ? 2 : 0) |
          (this.ch3.enabled ? 4 : 0) |
          (this.ch4.enabled ? 8 : 0)
        );
      case 0x04000088:
        return this.soundbias;
      default:
        return 0;
    }
  }

  write(address: number, value: number): void {
    const half = value & 0xffff;

    if (address >= 0x04000060 && address <= 0x0400007f) {
      if (this.powered) this.writePsg(address, half);
      return;
    }

    switch (address) {
      case 0x04000080:
        if (this.powered) this.soundcntL = half;
        return;
      case 0x04000082:
        this.soundcntH = half;
        // Bits 11 and 15 clear a FIFO rather than being stored.
        if ((half & 0x0800) !== 0) this.fifoA.reset();
        if ((half & 0x8000) !== 0) this.fifoB.reset();
        return;
      case 0x04000084: {
        const powerOn = (half & 0x80) !== 0;
        if (this.powered && !powerOn) {
          // Powering down resets every PSG register, as on the DMG.
          this.ch1.reset();
          this.ch2.reset();
          this.ch3.reset();
          this.ch4.reset();
          this.soundcntL = 0;
        }
        this.powered = powerOn;
        return;
      }
      case 0x04000088:
        this.soundbias = half;
        return;
      // FIFO writes are 32-bit in practice but arrive here as halves.
      case 0x040000a0:
      case 0x040000a2:
        this.fifoA.push(half & 0xff);
        this.fifoA.push((half >>> 8) & 0xff);
        return;
      case 0x040000a4:
      case 0x040000a6:
        this.fifoB.push(half & 0xff);
        this.fifoB.push((half >>> 8) & 0xff);
        return;
      default:
        return;
    }
  }

  /** A 32-bit FIFO write, which is how DMA delivers samples. */
  writeFifoWord(fifo: 0 | 1, value: number): void {
    (fifo === 0 ? this.fifoA : this.fifoB).pushWord(value);
  }

  /**
   * Maps a GBA PSG address onto the DMG channel registers.
   *
   * 0x04000060 is NR10, and the layout matches the DMG from there — except the GBA leaves
   * a gap where the DMG had unused bytes, so channel 2 starts at 0x68 rather than 0x66.
   */
  private psgTarget(address: number): { channel: 1 | 2 | 3 | 4; register: number } | null {
    if (address >= 0x04000060 && address <= 0x04000067) {
      return { channel: 1, register: address - 0x04000060 };
    }
    if (address >= 0x04000068 && address <= 0x0400006f) {
      return { channel: 2, register: address - 0x04000068 };
    }
    if (address >= 0x04000070 && address <= 0x04000077) {
      return { channel: 3, register: address - 0x04000070 };
    }
    return { channel: 4, register: address - 0x04000078 };
  }

  private readPsg(address: number): number {
    const target = this.psgTarget(address);
    if (!target) return 0;
    const { channel, register } = target;
    if (channel === 1) {
      if (register === 0) return this.ch1.readNr10();
      if (register === 2) return this.ch1.readNrX1();
      if (register === 3) return this.ch1.readNrX2();
      if (register === 4) return this.ch1.readNrX4();
    }
    if (channel === 2) {
      if (register === 0) return this.ch2.readNrX1();
      if (register === 1) return this.ch2.readNrX2();
      if (register === 4) return this.ch2.readNrX4();
    }
    if (channel === 3) {
      if (register === 0) return this.ch3.readNr30();
      if (register === 2) return this.ch3.readNr32();
      if (register === 4) return this.ch3.readNr34();
    }
    if (register === 1) return this.ch4.readNr42();
    if (register === 4) return this.ch4.readNr43();
    if (register === 5) return this.ch4.readNr44();
    return 0;
  }

  private writePsg(address: number, value: number): void {
    const target = this.psgTarget(address);
    if (!target) return;
    const { channel, register } = target;
    // The GBA writes these 16 bits at a time; each half carries two DMG registers.
    const low = value & 0xff;
    const high = (value >>> 8) & 0xff;

    if (channel === 1) {
      if (register === 0) this.ch1.writeNr10(low);
      else if (register === 2) {
        this.ch1.writeNrX1(low);
        this.ch1.writeNrX2(high);
      } else if (register === 4) {
        this.ch1.writeNrX3(low);
        this.ch1.writeNrX4(high, (this.sequencerStep & 1) === 0);
      }
      return;
    }
    if (channel === 2) {
      if (register === 0) {
        this.ch2.writeNrX1(low);
        this.ch2.writeNrX2(high);
      } else if (register === 4) {
        this.ch2.writeNrX3(low);
        this.ch2.writeNrX4(high, (this.sequencerStep & 1) === 0);
      }
      return;
    }
    if (channel === 3) {
      if (register === 0) this.ch3.writeNr30(low);
      else if (register === 2) {
        this.ch3.writeNr31(low);
        this.ch3.writeNr32(high);
      } else if (register === 4) {
        this.ch3.writeNr33(low);
        this.ch3.writeNr34(high, (this.sequencerStep & 1) === 0);
      }
      return;
    }
    if (register === 0) {
      this.ch4.writeNr41(low);
      this.ch4.writeNr42(high);
    } else if (register === 4) {
      this.ch4.writeNr43(low);
      this.ch4.writeNr44(high, (this.sequencerStep & 1) === 0);
    }
  }
}

function clamp(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}
