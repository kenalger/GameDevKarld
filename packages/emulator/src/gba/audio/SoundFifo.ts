import type { StateReader, StateWriter } from '../../gb/state/StateBuffer.js';

/** The hardware FIFO holds 8 x 32 bits. */
export const FIFO_CAPACITY = 32;
/** DMA is asked to refill once the FIFO falls to this depth or below. */
export const FIFO_REFILL_THRESHOLD = 16;

/**
 * One Direct Sound FIFO.
 *
 * This is the channel real GBA games use for music: a timer overflow pops ONE signed byte,
 * and when the queue drops to half empty the DMA engine pushes 16 more bytes in. Modelling
 * it as an averaged sample rate instead of a real queue gets the pitch subtly wrong and
 * makes the DMA interaction impossible to express.
 */
export class SoundFifo {
  private readonly bytes = new Int8Array(FIFO_CAPACITY);
  private head = 0;
  private count = 0;

  /** The sample currently held by the sound circuit, between timer overflows. */
  private current = 0;

  reset(): void {
    this.bytes.fill(0);
    this.head = 0;
    this.count = 0;
    this.current = 0;
  }

  /** The queued bytes are live audio the game already handed over — they must persist. */
  saveState(w: StateWriter): void {
    w.bytesOf(new Uint8Array(this.bytes.buffer, this.bytes.byteOffset, FIFO_CAPACITY));
    w.u8(this.head);
    w.u8(this.count);
    w.u8(this.current & 0xff);
  }

  loadState(r: StateReader): void {
    r.intoArray(new Uint8Array(this.bytes.buffer, this.bytes.byteOffset, FIFO_CAPACITY));
    this.head = r.u8();
    this.count = r.u8();
    this.current = (r.u8() << 24) >> 24;
  }

  get length(): number {
    return this.count;
  }

  /** True once the queue is low enough that DMA should refill it. */
  get needsRefill(): boolean {
    return this.count <= FIFO_REFILL_THRESHOLD;
  }

  /** Queues one signed byte. Full FIFOs drop the write, as hardware does. */
  push(value: number): void {
    if (this.count >= FIFO_CAPACITY) return;
    this.bytes[(this.head + this.count) % FIFO_CAPACITY] = (value << 24) >> 24;
    this.count++;
  }

  /** Queues a 32-bit word as four bytes, least significant first. */
  pushWord(value: number): void {
    for (let shift = 0; shift < 32; shift += 8) this.push((value >>> shift) & 0xff);
  }

  /**
   * Advances the sound circuit by one timer overflow.
   *
   * An empty FIFO holds the last sample rather than snapping to silence — a dropout is far
   * more audible than a repeated sample.
   */
  tickTimer(): void {
    if (this.count === 0) return;
    this.current = this.bytes[this.head]!;
    this.head = (this.head + 1) % FIFO_CAPACITY;
    this.count--;
  }

  /** The sample the circuit is currently holding, as a signed byte. */
  get sample(): number {
    return this.current;
  }
}
