import type { InputLatch } from './InputLatch.js';
/**
 * Gamepad support.
 *
 * The Gamepad API is **poll-based, not event-based** — there is no "button pressed" event,
 * so this is read once per frame from inside the emulator loop rather than from a listener.
 */
export declare class GamepadInput {
    private readonly latch;
    constructor(latch: InputLatch);
    private readonly held;
    get connected(): boolean;
    /** Call once per frame, before sampling the latch. */
    poll(): void;
    releaseAll(): void;
}
//# sourceMappingURL=GamepadInput.d.ts.map