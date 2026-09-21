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
  /** Two banks of wave RAM here, not the Game Boy's one. */
  readonly ch3 = new WaveChannel(true);
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
    // Wave RAM, 0x04000090-0x0400009F, as a halfword: low byte first.
    if (address >= 0x04000090 && address <= 0x0400009f) {
      const offset = address - 0x04000090;
      return this.ch3.readGbaRam(offset) | (this.ch3.readGbaRam(offset + 1) << 8);
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
    // Wave RAM. Like the DMG's it is storage rather than a register, so it stays writable
    // with the APU powered down (Pan Docs, Audio Registers: wave RAM "can always be
    // read/written"). Writes address the bank that is NOT playing (GBATEK).
    if (address >= 0x04000090 && address <= 0x0400009f) {
      const offset = address - 0x04000090;
      this.ch3.writeGbaRam(offset, half & 0xff);
      this.ch3.writeGbaRam(offset + 1, (half >>> 8) & 0xff);
      return;
    }

    switch (address) {
      case 0x04000080:
        if (this.powered) this.soundcntL = half;
        return;
      case 0x04000082:
        // Bits 11 and 15 clear a FIFO rather than being stored.
        this.soundcntH = half & ~0x8800;
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

  /**
   * An 8-bit write to a sound register.
   *
   * These are ordinary code: `STRB` to a single envelope or length byte is how a lot of
   * GBA sound drivers poke one field without disturbing its neighbour. The PSG block is
   * literally the Game Boy's registers — "in some cases two of the old 8bit registers are
   * packed into a 16bit register and may be accessed as such" (GBATEK, GBA Sound
   * Controller) — so a byte write addresses ONE of the two packed DMG registers. It must
   * not be widened into a halfword write, or writing NR13 would re-run NR14's trigger.
   *
   * The registers that are natively 16 bits (SOUNDCNT_L/H, SOUNDBIAS) are instead
   * read-modify-written, which is what the CPU's byte lane does on hardware.
   */
  write8(address: number, byte: number): void {
    const value = byte & 0xff;

    if (address >= 0x04000060 && address <= 0x0400007f) {
      if (this.powered) this.writePsgByte(address, value);
      return;
    }
    if (address >= 0x04000090 && address <= 0x0400009f) {
      this.ch3.writeGbaRam(address - 0x04000090, value);
      return;
    }
    // A FIFO sample IS a byte, so a byte write queues exactly one.
    if (address >= 0x040000a0 && address <= 0x040000a3) {
      this.fifoA.push(value);
      return;
    }
    if (address >= 0x040000a4 && address <= 0x040000a7) {
      this.fifoB.push(value);
      return;
    }

    switch (address) {
      case 0x04000080:
        this.write(0x04000080, (this.soundcntL & 0xff00) | value);
        return;
      case 0x04000081:
        this.write(0x04000080, (this.soundcntL & 0x00ff) | (value << 8));
        return;
      case 0x04000082:
        this.write(0x04000082, (this.soundcntH & 0xff00) | value);
        return;
      case 0x04000083:
        this.write(0x04000082, (this.soundcntH & 0x00ff) | (value << 8));
        return;
      case 0x04000084:
        this.write(0x04000084, value);
        return;
      case 0x04000088:
        this.write(0x04000088, (this.soundbias & 0xff00) | value);
        return;
      case 0x04000089:
        this.write(0x04000088, (this.soundbias & 0x00ff) | (value << 8));
        return;
      default:
        // 0x85 and the other high halves hold nothing writable.
        return;
    }
  }

  /** One byte of the PSG block, routed to the single DMG register that lives there. */
  private writePsgByte(address: number, value: number): void {
    const target = this.psgTarget(address);
    if (target < 0) return;
    const channel = target >> 8;
    const register = target & 0xff;
    const clocksLength = (this.sequencerStep & 1) === 0;

    if (channel === 1) {
      if (register === 0) this.ch1.writeNr10(value);
      else if (register === 2) this.ch1.writeNrX1(value);
      else if (register === 3) this.ch1.writeNrX2(value);
      else if (register === 4) this.ch1.writeNrX3(value);
      else if (register === 5) this.ch1.writeNrX4(value, clocksLength);
      return;
    }
    if (channel === 2) {
      if (register === 0) this.ch2.writeNrX1(value);
      else if (register === 1) this.ch2.writeNrX2(value);
      else if (register === 4) this.ch2.writeNrX3(value);
      else if (register === 5) this.ch2.writeNrX4(value, clocksLength);
      return;
    }
    if (channel === 3) {
      if (register === 0) this.ch3.writeGbaNr30(value);
      else if (register === 2) this.ch3.writeNr31(value);
      else if (register === 3) this.ch3.writeGbaNr32(value);
      else if (register === 4) this.ch3.writeNr33(value);
      else if (register === 5) this.ch3.writeNr34(value, clocksLength);
      return;
    }
    if (register === 0) this.ch4.writeNr41(value);
    else if (register === 1) this.ch4.writeNr42(value);
    else if (register === 4) this.ch4.writeNr43(value);
    else if (register === 5) this.ch4.writeNr44(value, clocksLength);
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
   *
   * Returns `(channel << 8) | register`, or -1 for an address outside 0x60-0x7F. Packed
   * into an integer rather than an object because this runs on every sound register
   * write and the charter forbids allocating there.
   */
  private psgTarget(address: number): number {
    if (address >= 0x04000060 && address <= 0x04000067) {
      return 0x100 | (address - 0x04000060);
    }
    if (address >= 0x04000068 && address <= 0x0400006f) {
      return 0x200 | (address - 0x04000068);
    }
    if (address >= 0x04000070 && address <= 0x04000077) {
      return 0x300 | (address - 0x04000070);
    }
    // Channel 4 ends at 0x7F. Without this bound every higher address — wave RAM at
    // 0x90-0x9F and the FIFOs at 0xA0-0xA7 — resolved to a channel 4 register.
    if (address >= 0x04000078 && address <= 0x0400007f) {
      return 0x400 | (address - 0x04000078);
    }
    return -1;
  }

  /**
   * Reads one 16-bit PSG register, 0x04000060-0x0400007F.
   *
   * Two things make this more than a demux of the DMG read helpers:
   *
   *  1. **Each GBA register packs two DMG registers, low byte first.** SOUND1CNT_X is
   *     NR13 in its low half and NR14 in its high half; SOUND1CNT_H is NR11 then NR12
   *     ("in some cases two of the old 8bit registers are packed into a 16bit register
   *     and may be accessed as such" — GBATEK, GBA Sound Controller). `GbaMmu.readIo`
   *     takes the halfword returned here and slices the byte the CPU asked for out of
   *     it, so a value in the wrong half is a value in the wrong byte.
   *  2. **Unused and write-only GBA I/O bits read back 0, where the DMG's read back 1.**
   *     Every `readNrXX()` helper is DMG-shaped and ORs those 1s in (`readNrX4()`
   *     returns `0xBF | ...`), so each one must be masked down to the GBA's readable
   *     bits before it is composed — not simply shifted into place.
   *
   * The mask per register is exactly the union of the fields GBATEK ("GBA Sound Channel
   * 1-4") annotates R/W; everything it annotates W or "Not used" reads 0.
   *
   * **Where GBATEK is silent:** it never states what an unused or write-only *sound* bit
   * reads back as. Its only statement on the subject, "Reading from Unused or Write-Only
   * I/O Ports" (GBA Unpredictable Things), covers wholly-unused 32-bit fragments and says
   * a readable lower halfword "returns zero" — it says nothing about individual bits of a
   * readable register. The masks below were therefore derived from the R/W annotations
   * and then cross-checked against mGBA's `GBAIOWrite`, which records precisely these
   * bits in the I/O shadow its reads come from: 0x007F, 0xFFC0, 0x4000, 0xFFC0, 0x4000,
   * 0x00E0, 0xE000, 0x4000, 0xFF00, 0x40FF. All ten agree with the GBATEK-derived union,
   * so the two independent sources corroborate. (mGBA was read to understand the
   * hardware, per charter law 11; no code was taken.)
   */
  private readPsg(address: number): number {
    // A 16-bit register read is halfword-aligned — the ARM7TDMI forces address bit 0 low
    // on LDRH, and `GbaMmu.readIo` already passes `address & ~1` and does the byte slice
    // itself. Aligning here rather than switching on the raw address means the odd byte
    // addresses resolve to the same halfword instead of falling into the dead odd-offset
    // branches this function used to have (NR14 was reachable only at 0x64, NR44 not at
    // all, because the bus never calls with an odd address).
    switch (address & ~1) {
      // SOUND1CNT_L (4000060h), sweep. GBATEK: bits 0-2 shift, 3 direction, 4-6 time, all
      // R/W; bits 7-15 not used. Mask 0x007F. Only DMG register that is not packed.
      case 0x04000060:
        return this.ch1.readNr10() & 0x007f;

      // SOUND1CNT_H (4000062h). GBATEK: bits 0-5 length W-only, 6-7 duty R/W (low byte =
      // NR11), bits 8-15 envelope R/W (high byte = NR12). Mask 0xFFC0.
      case 0x04000062:
        return ((this.ch1.readNrX2() & 0xff) << 8) | (this.ch1.readNrX1() & 0xc0);

      // SOUND1CNT_X (4000064h). GBATEK: bits 0-10 frequency W-only, 11-13 not used, 14
      // length flag R/W, 15 initial W-only. Mask 0x4000 — the low byte (NR13) reads 0
      // entirely, and only NR14 bit 6 survives into the high byte.
      case 0x04000064:
        return (this.ch1.readNrX4() & 0x40) << 8;

      // SOUND2CNT_L (4000068h). GBATEK: channel 2 "works exactly as channel 1, except
      // that it doesn't have a Tone Envelope/Sweep Register". Mask 0xFFC0.
      case 0x04000068:
        return ((this.ch2.readNrX2() & 0xff) << 8) | (this.ch2.readNrX1() & 0xc0);

      // SOUND2CNT_H (400006Ch), same shape as SOUND1CNT_X. Mask 0x4000.
      case 0x0400006c:
        return (this.ch2.readNrX4() & 0x40) << 8;

      // SOUND3CNT_L (4000070h). GBATEK: bits 0-4 not used, 5 wave RAM dimension, 6 bank
      // number, 7 channel off/playback, all R/W; bits 8-15 not used. Mask 0x00E0. This is
      // the one register with no DMG counterpart, so `readGbaNr30()` already returns GBA
      // bit positions with GBA zeroes; the mask is belt-and-braces.
      case 0x04000070:
        return this.ch3.readGbaNr30() & 0x00e0;

      // SOUND3CNT_H (4000072h). GBATEK: bits 0-7 length W-only (NR31 reads 0), 8-12 not
      // used, 13-14 "Sound Volume" R/W, 15 "Force Volume (0=Use above, 1=Force 75%
      // regardless of above)" R/W. Mask 0xE000. `readGbaNr32` is used rather than the DMG
      // `readNr32`, which has no force bit and ORs `0x9F` of DMG 1-padding in.
      case 0x04000072:
        return (this.ch3.readGbaNr32() & 0xe0) << 8;

      // SOUND3CNT_X (4000074h), same shape as SOUND1CNT_X. Mask 0x4000.
      case 0x04000074:
        return (this.ch3.readNr34() & 0x40) << 8;

      // SOUND4CNT_L (4000078h). GBATEK: bits 0-5 length W-only (NR41 reads 0), 6-7 not
      // used, 8-15 envelope R/W (NR42). Mask 0xFF00. This register matched no branch at
      // all before and read back 0.
      case 0x04000078:
        return (this.ch4.readNr42() & 0xff) << 8;

      // SOUND4CNT_H (400007Ch). GBATEK: bits 0-2 dividing ratio, 3 counter width, 4-7
      // shift clock, all R/W (NR43, fully readable); 8-13 not used; 14 length flag R/W;
      // 15 initial W-only. Mask 0x40FF. NR44 was unreachable before this.
      case 0x0400007c:
        return (this.ch4.readNr43() & 0xff) | ((this.ch4.readNr44() & 0x40) << 8);

      // 0x66, 0x6A, 0x6E, 0x76, 0x7A and 0x7E are gaps in the sound block — GBATEK's I/O
      // map lists no register there. Open-bus behaviour for unmapped I/O belongs to the
      // bus, not the APU, so this reports 0.
      default:
        return 0;
    }
  }

  private writePsg(address: number, value: number): void {
    const target = this.psgTarget(address);
    if (target < 0) return;
    const channel = target >> 8;
    const register = target & 0xff;
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
      if (register === 0) this.ch3.writeGbaNr30(low);
      else if (register === 2) {
        this.ch3.writeNr31(low);
        this.ch3.writeGbaNr32(high);
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
