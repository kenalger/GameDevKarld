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
export declare class AudioOutput {
    private context;
    private node;
    private gain;
    private ring;
    private underruns;
    private muted;
    private volume;
    get sampleRate(): number;
    get running(): boolean;
    stats(): AudioStats;
    /**
     * Starts audio. MUST be called from a user gesture — browsers create an `AudioContext`
     * in the `suspended` state and only a gesture may resume it.
     */
    start(): Promise<void>;
    suspend(): Promise<void>;
    close(): Promise<void>;
    setMuted(muted: boolean): void;
    setVolume(volume: number): void;
    /** The emulator's sample sink. */
    push(left: number, right: number): void;
    /**
     * Multiplier for the emulator's output rate, nudged to keep the buffer near its target.
     *
     * Running slightly fast when the buffer is draining and slightly slow when it is filling
     * keeps long-term drift bounded without ever dropping a sample.
     */
    driftCorrection(): number;
    /** Asks the worklet for its underrun count. Cheap; call at most a few times a second. */
    requestStats(): void;
}
//# sourceMappingURL=AudioOutput.d.ts.map