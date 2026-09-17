/**
 * Lock-free single-producer / single-consumer ring buffer for audio samples.
 *
 * The emulator writes; the AudioWorklet reads. Neither ever blocks, and nothing allocates
 * once constructed — an allocation here would surface as a GC pause, which is audible.
 *
 * Backed by a SharedArrayBuffer when cross-origin isolation allows it, and a plain
 * ArrayBuffer otherwise (single-threaded fallback).
 */
export declare class RingBuffer {
    static readonly READ_INDEX = 0;
    static readonly WRITE_INDEX = 1;
    readonly indices: Int32Array;
    readonly left: Float32Array;
    readonly right: Float32Array;
    readonly capacity: number;
    constructor(capacity: number, shared?: boolean);
    /** Samples waiting to be played. */
    get available(): number;
    get free(): number;
    /** Producer side. Drops the sample when full rather than blocking. */
    push(left: number, right: number): boolean;
    /**
     * Consumer side. Fills the output blocks, repeating the last sample on underrun rather
     * than emitting silence — a repeated sample is far less audible than a gap.
     */
    pull(outLeft: Float32Array, outRight: Float32Array): number;
}
//# sourceMappingURL=RingBuffer.d.ts.map