import type { StateReader, StateWriter } from '../../gb/state/StateBuffer.js';
/** When a channel fires. */
export const TIMING_IMMEDIATE = 0;
export const TIMING_VBLANK = 1;
export const TIMING_HBLANK = 2;
/** Channel 1/2: sound FIFO. Channel 3: video capture. Channel 0: prohibited. */
export const TIMING_SPECIAL = 3;

/** Address control modes for source and destination. */
const ADDR_INCREMENT = 0;
const ADDR_DECREMENT = 1;
const ADDR_FIXED = 2;
const ADDR_INCREMENT_RELOAD = 3;

export interface DmaMemory {
  read16(address: number): number;
  read32(address: number): number;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
}

/**
 * One DMA channel.
 *
 * The four channels differ in more than priority: channel 0 has the highest priority and
 * cannot use the special timing, channels 1 and 2 use it to refill the sound FIFOs, and
 * channel 3 uses it for video capture and is the only one that can write to ROM-space.
 * Word count widths differ too — channel 3 counts 16 bits, the rest 14.
 */
export class DmaChannel {
  source = 0;
  destination = 0;
  count = 0;
  control = 0;

  /** Latched at enable time; the visible registers stay untouched while running. */
  private internalSource = 0;
  private internalDestination = 0;
  private internalCount = 0;

  active = false;

  constructor(
    readonly index: number,
    private readonly memory: DmaMemory,
    private readonly onInterrupt: (channel: number) => void,
  ) {}

  /** The internal latches must be saved: a state taken mid-transfer resumes from them. */
  saveState(w: StateWriter): void {
    w.u32(this.source);
    w.u32(this.destination);
    w.u32(this.count);
    w.u32(this.control);
    w.u32(this.internalSource);
    w.u32(this.internalDestination);
    w.u32(this.internalCount);
    w.bool(this.active);
  }

  loadState(r: StateReader): void {
    this.source = r.u32();
    this.destination = r.u32();
    this.count = r.u32();
    this.control = r.u32();
    this.internalSource = r.u32();
    this.internalDestination = r.u32();
    this.internalCount = r.u32();
    this.active = r.bool();
  }

  reset(): void {
    this.source = 0;
    this.destination = 0;
    this.count = 0;
    this.control = 0;
    this.internalSource = 0;
    this.internalDestination = 0;
    this.internalCount = 0;
    this.active = false;
  }

  get enabled(): boolean {
    return (this.control & 0x8000) !== 0;
  }

  get timing(): number {
    return (this.control >>> 12) & 3;
  }

  get repeats(): boolean {
    return (this.control & 0x0200) !== 0;
  }

  get transfersWords(): boolean {
    return (this.control & 0x0400) !== 0;
  }

  private get destinationControl(): number {
    return (this.control >>> 5) & 3;
  }

  private get sourceControl(): number {
    return (this.control >>> 7) & 3;
  }

  private get maxCount(): number {
    return this.index === 3 ? 0x10000 : 0x4000;
  }

  /** Writing the control register with bit 15 newly set latches and possibly starts. */
  writeControl(value: number): void {
    const wasEnabled = this.enabled;
    this.control = value & 0xffff;

    if (!wasEnabled && this.enabled) {
      this.latch();
      if (this.timing === TIMING_IMMEDIATE) this.active = true;
    } else if (!this.enabled) {
      this.active = false;
    }
  }

  private latch(): void {
    // Source and destination alignment follow the transfer width.
    const align = this.transfersWords ? ~3 : ~1;
    this.internalSource = (this.source & align) >>> 0;
    this.internalDestination = (this.destination & align) >>> 0;
    this.internalCount = this.count === 0 ? this.maxCount : this.count;
  }

  /** Called when the PPU enters VBlank or HBlank. */
  notifyTiming(timing: number): void {
    if (!this.enabled || this.timing !== timing) return;
    this.active = true;
  }

  /**
   * Runs the whole transfer.
   *
   * Modelled as a burst rather than interleaved with the CPU: DMA halts the CPU on
   * hardware anyway, so the observable difference is confined to cycle counts, not
   * ordering. Sound-FIFO transfers move a fixed 4 words regardless of the count field.
   */
  run(): number {
    if (!this.active) return 0;

    const words = this.transfersWords;
    const fifo = this.timing === TIMING_SPECIAL && (this.index === 1 || this.index === 2);
    const units = fifo ? 4 : this.internalCount;
    const step = words || fifo ? 4 : 2;

    const destControl = fifo ? ADDR_FIXED : this.destinationControl;
    const srcControl = this.sourceControl;

    let source = this.internalSource;
    let destination = this.internalDestination;
    let cycles = 0;

    for (let i = 0; i < units; i++) {
      if (words || fifo) {
        this.memory.write32(destination, this.memory.read32(source));
      } else {
        this.memory.write16(destination, this.memory.read16(source));
      }
      cycles += 2;

      if (srcControl === ADDR_INCREMENT || srcControl === ADDR_INCREMENT_RELOAD) source += step;
      else if (srcControl === ADDR_DECREMENT) source -= step;

      if (destControl === ADDR_INCREMENT || destControl === ADDR_INCREMENT_RELOAD)
        destination += step;
      else if (destControl === ADDR_DECREMENT) destination -= step;

      source >>>= 0;
      destination >>>= 0;
    }

    this.internalSource = source;
    this.internalDestination = destination;
    this.active = false;

    if ((this.control & 0x4000) !== 0) this.onInterrupt(this.index);

    if (this.repeats && this.timing !== TIMING_IMMEDIATE) {
      // A repeating channel reloads its count, and mode 3 also reloads the destination.
      this.internalCount = this.count === 0 ? this.maxCount : this.count;
      if (this.destinationControl === ADDR_INCREMENT_RELOAD) {
        this.internalDestination = (this.destination & (this.transfersWords ? ~3 : ~1)) >>> 0;
      }
    } else {
      this.control &= ~0x8000;
    }

    return cycles;
  }
}

/**
 * The four-channel DMA controller.
 *
 * Channel priority is fixed: 0 beats 1 beats 2 beats 3, and a higher-priority channel
 * that becomes ready mid-transfer takes over on real hardware. Since transfers run as a
 * burst here, priority is applied by always servicing the lowest-numbered ready channel.
 */
export class DmaController {
  readonly channels: readonly DmaChannel[];

  constructor(memory: DmaMemory, onInterrupt: (channel: number) => void) {
    this.channels = [0, 1, 2, 3].map((i) => new DmaChannel(i, memory, onInterrupt));
  }

  reset(): void {
    for (const channel of this.channels) channel.reset();
  }

  saveState(w: StateWriter): void {
    for (const channel of this.channels) channel.saveState(w);
  }

  loadState(r: StateReader): void {
    for (const channel of this.channels) channel.loadState(r);
  }

  get busy(): boolean {
    return this.channels.some((channel) => channel.active);
  }

  /** Runs every ready channel in priority order. Returns cycles consumed. */
  run(): number {
    let cycles = 0;
    for (const channel of this.channels) {
      if (channel.active) cycles += channel.run();
    }
    return cycles;
  }

  notifyVBlank(): void {
    for (const channel of this.channels) channel.notifyTiming(TIMING_VBLANK);
  }

  notifyHBlank(): void {
    for (const channel of this.channels) channel.notifyTiming(TIMING_HBLANK);
  }

  notifyFifo(channelIndex: number): void {
    this.channels[channelIndex]?.notifyTiming(TIMING_SPECIAL);
  }

  read(address: number): number {
    const channel = this.channels[((address - 0x040000b0) / 12) | 0];
    if (!channel) return 0;
    // Only the control register reads back; the address and count registers are write-only.
    return (address & 0xf) === 0xa ? channel.control : 0;
  }

  write16(address: number, value: number): void {
    const offset = address - 0x040000b0;
    const index = Math.floor(offset / 12);
    const channel = this.channels[index];
    if (!channel) return;

    switch (offset % 12) {
      case 0:
        channel.source = (channel.source & 0xffff0000) | value;
        break;
      case 2:
        channel.source = ((value << 16) | (channel.source & 0xffff)) >>> 0;
        break;
      case 4:
        channel.destination = (channel.destination & 0xffff0000) | value;
        break;
      case 6:
        channel.destination = ((value << 16) | (channel.destination & 0xffff)) >>> 0;
        break;
      case 8:
        channel.count = value;
        break;
      default:
        channel.writeControl(value);
        break;
    }
  }
}
