/**
 * AudioWorklet processor for WebBoy.
 *
 * Runs on the audio thread and does nothing but drain a ring buffer. No allocation, no
 * message passing per block — anything else here becomes a glitch.
 *
 * Deliberately NOT a ScriptProcessorNode: that API is deprecated, runs on the main thread,
 * and stutters the moment the UI does any work.
 */
class WebBoyProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { indices, left, right, capacity } = options.processorOptions;
    this.indices = new Int32Array(indices);
    this.left = new Float32Array(left);
    this.right = new Float32Array(right);
    this.capacity = capacity;
    this.underruns = 0;
    this.stopped = false;

    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.stopped = true;
      if (event.data === 'stats') {
        this.port.postMessage({ underruns: this.underruns, available: this.available() });
      }
    };
  }

  available() {
    const write = Atomics.load(this.indices, 1);
    const read = Atomics.load(this.indices, 0);
    return (write - read + this.capacity) % this.capacity;
  }

  process(_inputs, outputs) {
    if (this.stopped) return false;

    const output = outputs[0];
    const outLeft = output[0];
    const outRight = output[1] ?? output[0];

    let read = Atomics.load(this.indices, 0);
    const write = Atomics.load(this.indices, 1);

    let lastLeft = 0;
    let lastRight = 0;
    let starved = false;

    for (let i = 0; i < outLeft.length; i++) {
      if (read !== write) {
        lastLeft = this.left[read];
        lastRight = this.right[read];
        read = (read + 1) % this.capacity;
      } else {
        starved = true;
      }
      outLeft[i] = lastLeft;
      outRight[i] = lastRight;
    }

    if (starved) this.underruns++;
    Atomics.store(this.indices, 0, read);
    return true;
  }
}

registerProcessor('webboy-processor', WebBoyProcessor);
