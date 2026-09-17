/**
 * Lock-free single-producer / single-consumer ring buffer for audio samples.
 *
 * The emulator writes; the AudioWorklet reads. Neither ever blocks, and nothing allocates
 * once constructed — an allocation here would surface as a GC pause, which is audible.
 *
 * Backed by a SharedArrayBuffer when cross-origin isolation allows it, and a plain
 * ArrayBuffer otherwise (single-threaded fallback).
 */
export class RingBuffer {
  static readonly READ_INDEX = 0;
  static readonly WRITE_INDEX = 1;

  readonly indices: Int32Array;
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly capacity: number;

  constructor(capacity: number, shared = false) {
    this.capacity = capacity;
    const IndexBuffer =
      shared && typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer;
    this.indices = new Int32Array(new IndexBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
    this.left = new Float32Array(new IndexBuffer(capacity * Float32Array.BYTES_PER_ELEMENT));
    this.right = new Float32Array(new IndexBuffer(capacity * Float32Array.BYTES_PER_ELEMENT));
  }

  /** Samples waiting to be played. */
  get available(): number {
    const write = Atomics.load(this.indices, RingBuffer.WRITE_INDEX);
    const read = Atomics.load(this.indices, RingBuffer.READ_INDEX);
    return (write - read + this.capacity) % this.capacity;
  }

  get free(): number {
    return this.capacity - 1 - this.available;
  }

  /** Producer side. Drops the sample when full rather than blocking. */
  push(left: number, right: number): boolean {
    const write = Atomics.load(this.indices, RingBuffer.WRITE_INDEX);
    const next = (write + 1) % this.capacity;
    if (next === Atomics.load(this.indices, RingBuffer.READ_INDEX)) return false;

    this.left[write] = left;
    this.right[write] = right;
    Atomics.store(this.indices, RingBuffer.WRITE_INDEX, next);
    return true;
  }

  /**
   * Consumer side. Fills the output blocks, repeating the last sample on underrun rather
   * than emitting silence — a repeated sample is far less audible than a gap.
   */
  pull(outLeft: Float32Array, outRight: Float32Array): number {
    let read = Atomics.load(this.indices, RingBuffer.READ_INDEX);
    const write = Atomics.load(this.indices, RingBuffer.WRITE_INDEX);

    let lastLeft = 0;
    let lastRight = 0;
    let filled = 0;

    for (let i = 0; i < outLeft.length; i++) {
      if (read !== write) {
        lastLeft = this.left[read]!;
        lastRight = this.right[read]!;
        read = (read + 1) % this.capacity;
        filled++;
      }
      outLeft[i] = lastLeft;
      outRight[i] = lastRight;
    }

    Atomics.store(this.indices, RingBuffer.READ_INDEX, read);
    return filled;
  }
}
