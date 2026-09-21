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
 *
 * The GBA reuses this hardware with one difference: its wave RAM is TWO banks of 16 bytes
 * rather than one. SOUND3CNT_L bit 5 is the dimension (0 = one bank / 32 digits, 1 = two
 * banks / 64 digits) and bit 6 is the bank number; "the currently selected Bank Number
 * (Bit 6) will be played back, while reading/writing to/from wave RAM will address the
 * other (not selected) bank" (GBATEK, GBA Sound Channel 3 - Wave Output). That mode is
 * opt-in via the constructor so the DMG path is untouched.
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

  /* -- GBA only: the second wave RAM bank and its select bits -- */
  private twoBanks = false;
  private waveBank = 0;
  /** 31 for a single 32-digit bank, 63 when playback spans both banks. */
  private positionMask = 31;

  readonly length = new LengthCounter(256);
  readonly ram = new Uint8Array(16);
  /** GBA bank 1. Unused on the Game Boy, which has a single 16-byte block. */
  readonly ram2 = new Uint8Array(16);

  /** `gbaBanks` enables the GBA's two-bank wave RAM. */
  constructor(private readonly gbaBanks = false) {}

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
    w.bool(this.twoBanks);
    w.u8(this.waveBank);
    this.length.saveState(w);
    w.bytesOf(this.ram);
    w.bytesOf(this.ram2);
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
    this.twoBanks = r.bool();
    this.waveBank = r.u8() & 1;
    this.positionMask = this.gbaBanks && this.twoBanks ? 63 : 31;
    this.length.loadState(r);
    const ram = r.bytesOf();
    if (ram.length === this.ram.length) this.ram.set(ram);
    const ram2 = r.bytesOf();
    if (ram2.length === this.ram2.length) this.ram2.set(ram2);
  }

  reset(): void {
    this.enabled = false;
    this.dacOn = false;
    this.frequency = 0;
    this.timer = 0;
    this.position = 0;
    this.volumeCode = 0;
    this.sample = 0;
    this.twoBanks = false;
    this.waveBank = 0;
    this.positionMask = 31;
    this.length.reset();
    // Wave RAM survives an APU power cycle on a DMG, so it is NOT cleared here — and the
    // GBA's two banks are the same storage, so they survive too.
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
    this.position = (this.position + 1) & this.positionMask;
    const byte = this.playbackByte(this.position);
    // Upper nibble first: "as CH3 plays, it reads wave RAM left to right, upper nibble
    // first" (Pan Docs, Audio Registers - FF30-FF3F).
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

  /**
   * The wave RAM byte holding sample `position`.
   *
   * One bank on the Game Boy. On the GBA in two-bank mode playback "will start by
   * replaying the currently selected bank" and then runs on into the other, giving 64
   * digits (GBATEK, GBA Sound Channel 3 - Wave Output).
   */
  private playbackByte(position: number): number {
    if (!this.gbaBanks) return this.ram[position >> 1]!;
    const bank = this.twoBanks && position >= 32 ? this.waveBank ^ 1 : this.waveBank;
    const source = bank === 0 ? this.ram : this.ram2;
    return source[(position & 31) >> 1]!;
  }

  /** GBA only: the bank the CPU reaches — always the one that is NOT playing. */
  private get cpuBank(): Uint8Array {
    return this.waveBank === 0 ? this.ram2 : this.ram;
  }

  /**
   * GBA SOUND3CNT_L. Bit 5 is the wave RAM dimension, bit 6 the bank number, bit 7 the
   * DAC — the DMG's NR30 with two extra bits (GBATEK).
   */
  writeGbaNr30(value: number): void {
    this.twoBanks = (value & 0x20) !== 0;
    this.waveBank = (value >>> 6) & 1;
    this.positionMask = this.twoBanks ? 63 : 31;
    this.position &= this.positionMask;
    this.writeNr30(value);
  }

  /** Unused GBA I/O bits read back as 0, unlike the DMG's 1s. */
  readGbaNr30(): number {
    return (this.twoBanks ? 0x20 : 0) | (this.waveBank << 6) | (this.dacOn ? 0x80 : 0);
  }

  /** GBA wave RAM, 0x04000090-0x0400009F: the bank that is not currently playing. */
  readGbaRam(offset: number): number {
    return this.cpuBank[offset & 0x0f]!;
  }

  writeGbaRam(offset: number, value: number): void {
    this.cpuBank[offset & 0x0f] = value & 0xff;
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
