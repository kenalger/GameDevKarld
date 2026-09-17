import { type GameBoyButton } from '@webboy/emulator';
/**
 * Buffers button state between DOM events and emulated time.
 *
 * DOM events arrive asynchronously relative to the emulator. Sampling only the *current*
 * physical state once per frame would silently drop a tap that started and ended between
 * two frames — which at ~60Hz is an entirely achievable human action and feels like the
 * emulator ignoring you.
 *
 * So two things are tracked: what is held right now, and what was pressed *at any point*
 * since the last sample. Their union is what the emulator sees, which guarantees every
 * press registers for at least one frame.
 *
 * Pure and synchronous — no DOM, so it is directly unit-testable.
 */
export declare class InputLatch {
    /** Bitmask of buttons physically held. */
    private held;
    /** Bitmask of buttons pressed since the last sample, whether or not still held. */
    private sticky;
    press(button: GameBoyButton): void;
    release(button: GameBoyButton): void;
    isHeld(button: GameBoyButton): boolean;
    /** Clears everything. Call on blur or tab-hide so nothing is left stuck down. */
    releaseAll(): void;
    /**
     * Returns the state the emulator should see for the next frame, and clears the sticky
     * bits. Call exactly once per frame, as late as possible before running it.
     */
    sample(): number;
    /** Current state without consuming the sticky bits. For UI display only. */
    peek(): number;
}
//# sourceMappingURL=InputLatch.d.ts.map