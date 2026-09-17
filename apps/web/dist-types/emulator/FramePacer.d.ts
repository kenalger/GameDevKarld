/**
 * Converts wall-clock time into a count of emulated frames to run.
 *
 * The Game Boy runs at ~59.7275 Hz, not 60. On a 60 Hz display that difference beats at
 * roughly one duplicated frame every 3.7 seconds. Forcing 60 would change game speed and
 * audio pitch, so we accumulate against the real rate instead.
 *
 * Pure and synchronous on purpose — this is the piece that must be unit-testable.
 */
export declare class FramePacer {
    /** Never run more than this many emulated frames for one tick. */
    static readonly MAX_FRAMES_PER_TICK = 4;
    /** A gap larger than this means the tab was hidden or the thread was blocked. */
    static readonly MAX_DELTA_MS = 250;
    private readonly msPerFrame;
    private accumulator;
    private lastTime;
    constructor(framesPerSecond: number);
    /**
     * Discard accumulated time. Call when resuming from a pause or a hidden tab, so the
     * emulator does not "catch up" by running a burst of frames the player never saw.
     */
    reset(): void;
    /** How many emulated frames to run for the tick at `now` (a `performance.now()` value). */
    advance(now: number): number;
}
//# sourceMappingURL=FramePacer.d.ts.map