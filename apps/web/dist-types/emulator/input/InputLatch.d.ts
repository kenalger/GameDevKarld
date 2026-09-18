import { type GameBoyButton } from '@webboy/emulator';
/**
 * The three things a player can press with. Each keeps its own held state.
 *
 * Without this separation every source shares one bitmask, so ANY source releasing a
 * button clears it for all of them: hold Z on the keyboard, tap the on-screen A button and
 * lift, and A releases in the game while the key is still physically down — and it never
 * re-presses, because the keydown already fired and auto-repeat is suppressed.
 */
export declare const SOURCE: {
    readonly keyboard: 0;
    readonly touch: 1;
    readonly gamepad: 2;
};
export type InputSourceId = (typeof SOURCE)[keyof typeof SOURCE];
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
    /** Held buttons per source. The union is what the emulator sees. */
    private readonly heldBy;
    /** Bitmask of buttons pressed since the last sample, whether or not still held. */
    private sticky;
    press(button: GameBoyButton, source?: InputSourceId): void;
    release(button: GameBoyButton, source?: InputSourceId): void;
    /** Every source OR'd together — one button, held by anyone, is held. */
    private get held();
    isHeld(button: GameBoyButton): boolean;
    /**
     * Clears held state. Call on blur or tab-hide so nothing is left stuck down.
     *
     * With a source, only that source is cleared and the sticky bits survive — a keyboard
     * blur must not discard a tap the touch layer just registered. Without one, everything
     * goes, which is what a hidden tab wants.
     */
    releaseAll(source?: InputSourceId): void;
    /**
     * Returns the state the emulator should see for the next frame, and clears the sticky
     * bits. Call exactly once per frame, as late as possible before running it.
     */
    sample(): number;
    /** Current state without consuming the sticky bits. For UI display only. */
    peek(): number;
}
//# sourceMappingURL=InputLatch.d.ts.map