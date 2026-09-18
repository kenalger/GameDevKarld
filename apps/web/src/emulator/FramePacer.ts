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
  /** Never run more than this many emulated frames for one tick, at 1x speed. */
  static readonly MAX_FRAMES_PER_TICK = 4;

  /** Bounds on the speed multiplier. Beyond 8x a 60Hz tick cannot keep up anyway. */
  static readonly MIN_SPEED = 0.25;
  static readonly MAX_SPEED = 8;

  /** A gap larger than this means the tab was hidden or the thread was blocked. */
  static readonly MAX_DELTA_MS = 250;

  private readonly baseMsPerFrame: number;
  private msPerFrame: number;
  private maxFramesPerTick = FramePacer.MAX_FRAMES_PER_TICK;
  private speedMultiplier = 1;
  private accumulator = 0;
  private lastTime: number | null = null;

  constructor(framesPerSecond: number) {
    if (!(framesPerSecond > 0)) {
      throw new RangeError(`framesPerSecond must be positive, got ${framesPerSecond}`);
    }
    this.baseMsPerFrame = 1000 / framesPerSecond;
    this.msPerFrame = this.baseMsPerFrame;
  }

  get speed(): number {
    return this.speedMultiplier;
  }

  /**
   * Runs the game faster or slower than real time.
   *
   * Implemented by shrinking the per-frame budget rather than by running extra frames on
   * the side, so everything downstream — the sticky input latch, save states, the frame
   * counter — behaves exactly as it does at 1x. Emulation stays deterministic; only how
   * often it is asked to step changes.
   *
   * The per-tick cap scales too. It exists to stop a death spiral after a hitch, and a
   * fixed 4 would silently cap 4x and above at real time on a 60Hz display — the setting
   * would appear to do nothing.
   */
  setSpeed(multiplier: number): void {
    const clamped = Math.min(
      FramePacer.MAX_SPEED,
      Math.max(FramePacer.MIN_SPEED, Number.isFinite(multiplier) ? multiplier : 1),
    );
    this.speedMultiplier = clamped;
    this.msPerFrame = this.baseMsPerFrame / clamped;
    this.maxFramesPerTick = Math.max(
      FramePacer.MAX_FRAMES_PER_TICK,
      Math.ceil(FramePacer.MAX_FRAMES_PER_TICK * clamped),
    );
    // Drop the backlog: time accumulated at the old rate means nothing at the new one.
    this.accumulator = 0;
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
    while (this.accumulator >= this.msPerFrame && frames < this.maxFramesPerTick) {
      this.accumulator -= this.msPerFrame;
      frames++;
    }

    // Hit the cap: drop the backlog instead of carrying debt forever.
    if (frames === this.maxFramesPerTick) {
      this.accumulator = 0;
    }

    return frames;
  }
}
