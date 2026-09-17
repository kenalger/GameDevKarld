/**
 * Converts wall-clock time into a count of emulated frames to run.
 *
 * The Game Boy runs at ~59.7275 Hz, not 60. On a 60 Hz display that difference beats at
 * roughly one duplicated frame every 3.7 seconds. Forcing 60 would change game speed and
 * audio pitch, so we accumulate against the real rate instead.
 *
 * Pure and synchronous on purpose — this is the piece that must be unit-testable.
 */
export class FramePacer {
  /** Never run more than this many emulated frames for one tick. */
  static readonly MAX_FRAMES_PER_TICK = 4;

  /** A gap larger than this means the tab was hidden or the thread was blocked. */
  static readonly MAX_DELTA_MS = 250;

  private readonly msPerFrame: number;
  private accumulator = 0;
  private lastTime: number | null = null;

  constructor(framesPerSecond: number) {
    if (!(framesPerSecond > 0)) {
      throw new RangeError(`framesPerSecond must be positive, got ${framesPerSecond}`);
    }
    this.msPerFrame = 1000 / framesPerSecond;
  }

  /**
   * Discard accumulated time. Call when resuming from a pause or a hidden tab, so the
   * emulator does not "catch up" by running a burst of frames the player never saw.
   */
  reset(): void {
    this.accumulator = 0;
    this.lastTime = null;
  }

  /** How many emulated frames to run for the tick at `now` (a `performance.now()` value). */
  advance(now: number): number {
    if (this.lastTime === null) {
      this.lastTime = now;
      return 0;
    }

    let delta = now - this.lastTime;
    this.lastTime = now;

    // A backwards or absurd clock is treated as a single frame's worth, never as debt.
    if (delta < 0 || delta > FramePacer.MAX_DELTA_MS) {
      delta = this.msPerFrame;
    }

    this.accumulator += delta;

    let frames = 0;
    while (this.accumulator >= this.msPerFrame && frames < FramePacer.MAX_FRAMES_PER_TICK) {
      this.accumulator -= this.msPerFrame;
      frames++;
    }

    // Hit the cap: drop the backlog instead of carrying debt forever.
    if (frames === FramePacer.MAX_FRAMES_PER_TICK) {
      this.accumulator = 0;
    }

    return frames;
  }
}
