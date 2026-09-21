import { LengthCounter } from './components.js';
import type { StateReader, StateWriter } from '../state/StateBuffer.js';

const VOLUME_SHIFT = [4, 0, 1, 2] as const;

/**
 * T-cycles after the channel touches a wave-RAM byte during which the CPU can reach it.
 *
 * On a DMG, an access outside this window reads 0xFF and a write is dropped. Blargg's
 * 09 and 12 tests exist precisely to measure it.
 */
const ACCESS_WINDOW_T = 2;

/**
 * Channel 3 — 32 four-bit samples played from wave RAM (0xFF30-0xFF3F).
 *
 * Its DAC is a dedicated bit (NR30 bit 7) rather than the envelope, and wave RAM is not
 * freely accessible while the channel is playing.
 */
export class WaveChannel {
  enabled = false;
  private dacOn = false;
  private frequency = 0;
  private timer = 0;
  private position = 0;
  private volumeCode = 0;
  private sample = 0;
  private accessWindow = 0;

  readonly length = new LengthCounter(256);
  readonly ram = new Uint8Array(16);

  /** Wave RAM is part of the state: the game writes the waveform once and never again. */
  saveState(w: StateWriter): void {
    w.bool(this.enabled);
    w.bool(this.dacOn);
    w.u16(this.frequency);
    w.u16(this.timer);
    w.u8(this.position);
    w.u8(this.volumeCode);
    w.u8(this.sample);
    w.u8(this.accessWindow);
    this.length.saveState(w);
    w.bytesOf(this.ram);
  }

  loadState(r: StateReader): void {
    this.enabled = r.bool();
    this.dacOn = r.bool();
    this.frequency = r.u16();
    this.timer = r.u16();
    this.position = r.u8();
    this.volumeCode = r.u8();
    this.sample = r.u8();
    this.accessWindow = r.u8();
    this.length.loadState(r);
    const ram = r.bytesOf();
    if (ram.length === this.ram.length) this.ram.set(ram);
  }

  reset(): void {
    this.enabled = false;
    this.dacOn = false;
    this.frequency = 0;
    this.timer = 0;
    this.position = 0;
    this.volumeCode = 0;
    this.sample = 0;
    this.length.reset();
    // Wave RAM survives an APU power cycle on a DMG, so it is NOT cleared here.
  }

  get dacEnabled(): boolean {
    return this.dacOn;
  }

  output(): number {
    if (!this.enabled || !this.dacOn) return 0;
    const shift = VOLUME_SHIFT[this.volumeCode]!;
    return (this.sample >> shift) / 7.5 - 1;
  }

  tickT(): void {
    if (this.accessWindow > 0) this.accessWindow--;
    if (--this.timer > 0) return;

    // Wave runs at twice the rate of the pulse channels.
    this.timer = (2048 - this.frequency) * 2;
    this.position = (this.position + 1) & 31;
    const byte = this.ram[this.position >> 1]!;
    this.sample = (this.position & 1) === 0 ? byte >> 4 : byte & 0x0f;

    // The CPU can only reach wave RAM in the instant the channel is touching it.
    this.accessWindow = ACCESS_WINDOW_T;
  }

  clockLength(): void {
    if (this.length.clock()) this.enabled = false;
  }

  /**
   * While the channel plays, the CPU sees the byte the channel is currently reading rather
   * than the address it asked for. On a DMG, access outside a narrow window reads 0xFF.
   */
  readRam(offset: number): number {
    if (!this.enabled) return this.ram[offset]!;
    // While playing, the CPU sees the byte the channel is touching — and only during the
    // brief window in which it is touching it. Otherwise the bus reads 0xFF.
    return this.accessWindow > 0 ? this.ram[this.position >> 1]! : 0xff;
  }

  writeRam(offset: number, value: number): void {
    if (!this.enabled) {
      this.ram[offset] = value & 0xff;
      return;
    }
    // Same window: a write outside it is dropped entirely.
    if (this.accessWindow > 0) this.ram[this.position >> 1] = value & 0xff;
  }

  readNr30(): number {
    return 0x7f | (this.dacOn ? 0x80 : 0);
  }

  writeNr30(value: number): void {
    this.dacOn = (value & 0x80) !== 0;
    if (!this.dacOn) this.enabled = false;
  }

  writeNr31(value: number): void {
    this.length.load(value & 0xff);
  }

  readNr32(): number {
    return 0x9f | (this.volumeCode << 5);
  }

  writeNr32(value: number): void {
    this.volumeCode = (value >> 5) & 0x03;
  }

  writeNr33(value: number): void {
    this.frequency = (this.frequency & 0x700) | value;
  }

  readNr34(): number {
    return 0xbf | (this.length.enabled ? 0x40 : 0);
  }

  writeNr34(value: number, nextStepClocksLength: boolean): void {
    this.frequency = (this.frequency & 0xff) | ((value & 0x07) << 8);

    const trigger = (value & 0x80) !== 0;
    if (this.length.writeControl((value & 0x40) !== 0, trigger, nextStepClocksLength)) {
      this.enabled = false;
    }
    if (!trigger) return;

    this.enabled = true;
    this.timer = (2048 - this.frequency) * 2;
    this.position = 0;
    if (!this.dacOn) this.enabled = false;
  }
}
