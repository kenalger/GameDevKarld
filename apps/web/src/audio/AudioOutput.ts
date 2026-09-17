import { RingBuffer } from './RingBuffer.js';

/** ~85ms at 48kHz. Deep enough to survive a GC pause, shallow enough not to feel laggy. */
const BUFFER_SAMPLES = 4096;

/** Target fill, as a fraction of capacity. Drift is corrected toward this. */
const TARGET_FILL = 0.5;

export interface AudioStats {
  readonly available: number;
  readonly capacity: number;
  readonly underruns: number;
  readonly sampleRate: number;
  readonly running: boolean;
}

/**
 * Web Audio output.
 *
 * Three decisions that matter more than the code:
 *
 * 1. **AudioWorklet, never ScriptProcessorNode.** The latter is deprecated and runs on the
 *    main thread, so it glitches whenever the UI does anything.
 * 2. **The device picks the sample rate**, not us — 44100, 48000, sometimes 96000. The APU
 *    decimates from its native 1048576 Hz to whatever `AudioContext` reports.
 * 3. **Drift is corrected by nudging the resample ratio**, never by dropping or duplicating
 *    samples. A dropped sample is an audible click; a 0.2% pitch shift is inaudible.
 */
export class AudioOutput {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private ring: RingBuffer | null = null;
  private underruns = 0;
  private muted = false;
  private volume = 0.7;

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000;
  }

  get running(): boolean {
    return this.context?.state === 'running';
  }

  stats(): AudioStats {
    return {
      available: this.ring?.available ?? 0,
      capacity: this.ring?.capacity ?? 0,
      underruns: this.underruns,
      sampleRate: this.sampleRate,
      running: this.running,
    };
  }

  /**
   * Starts audio. MUST be called from a user gesture — browsers create an `AudioContext`
   * in the `suspended` state and only a gesture may resume it.
   */
  async start(): Promise<void> {
    if (this.context) {
      await this.context.resume();
      return;
    }

    const context = new AudioContext({ latencyHint: 'interactive' });
    this.context = context;

    // Cross-origin isolation is required for SharedArrayBuffer; without it the ring falls
    // back to a plain ArrayBuffer, which still works because everything is single-threaded
    // until the core moves to a Worker in Phase 10.
    const shared = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    this.ring = new RingBuffer(BUFFER_SAMPLES, shared);

    await context.audioWorklet.addModule('/webboy-audio-worklet.js');

    this.node = new AudioWorkletNode(context, 'webboy-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        indices: this.ring.indices.buffer,
        left: this.ring.left.buffer,
        right: this.ring.right.buffer,
        capacity: this.ring.capacity,
      },
    });

    this.node.port.onmessage = (event: MessageEvent<{ underruns: number }>) => {
      this.underruns = event.data.underruns;
    };

    this.gain = context.createGain();
    this.gain.gain.value = this.muted ? 0 : this.volume;
    this.node.connect(this.gain).connect(context.destination);

    await context.resume();
  }

  async suspend(): Promise<void> {
    await this.context?.suspend();
  }

  async close(): Promise<void> {
    this.node?.port.postMessage('stop');
    this.node?.disconnect();
    this.gain?.disconnect();
    await this.context?.close();
    this.context = null;
    this.node = null;
    this.gain = null;
    this.ring = null;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : this.volume;
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.gain && !this.muted) this.gain.gain.value = this.volume;
  }

  /** The emulator's sample sink. */
  push(left: number, right: number): void {
    this.ring?.push(left, right);
  }

  /**
   * Multiplier for the emulator's output rate, nudged to keep the buffer near its target.
   *
   * Running slightly fast when the buffer is draining and slightly slow when it is filling
   * keeps long-term drift bounded without ever dropping a sample.
   */
  driftCorrection(): number {
    const ring = this.ring;
    if (!ring || ring.capacity === 0) return 1;
    const fill = ring.available / ring.capacity;
    const error = fill - TARGET_FILL;
    // At most ±0.5% — well below the threshold of audible pitch change.
    return 1 + Math.max(-0.005, Math.min(0.005, error * 0.02));
  }

  /** Asks the worklet for its underrun count. Cheap; call at most a few times a second. */
  requestStats(): void {
    this.node?.port.postMessage('stats');
  }
}
