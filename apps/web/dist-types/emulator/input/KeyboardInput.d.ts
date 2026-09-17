import type { InputLatch } from './InputLatch.js';
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
    constructor(latch: InputLatch);
    setBindings(bindings: Bindings): void;
    getBindings(): Bindings;
    attach(target?: Window): () => void;
    private readonly onKeyDown;
    private readonly onKeyUp;
    /** Losing focus mid-press would otherwise leave the player holding a direction forever. */
    private readonly onBlur;
    private readonly onVisibilityChange;
}
//# sourceMappingURL=KeyboardInput.d.ts.map