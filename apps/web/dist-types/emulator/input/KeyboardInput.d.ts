import { type InputLatch } from './InputLatch.js';
import { type Bindings } from './bindings.js';
/**
 * Translates keyboard events into latch updates.
 *
 * Deliberately narrow: it maps a physical key to a button and writes to the latch. It never
 * touches the emulator, and it never reads emulator state.
 */
export declare class KeyboardInput {
    private readonly latch;
    private bindings;
    private attached;
    /** True while a rebind is capturing, so keystrokes reach the UI and not the game. */
    private suppressed;
    constructor(latch: InputLatch);
    setBindings(bindings: Bindings): void;
    getBindings(): Bindings;
    /** Releasing on the way in AND out: a key held across the change must not stick. */
    setSuppressed(suppressed: boolean): void;
    attach(target?: Window): () => void;
    private readonly onKeyDown;
    private readonly onKeyUp;
    /** Losing focus mid-press would otherwise leave the player holding a direction forever. */
    private readonly onBlur;
    private readonly onVisibilityChange;
}
//# sourceMappingURL=KeyboardInput.d.ts.map