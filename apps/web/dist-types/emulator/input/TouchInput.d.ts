import type { GameBoyButton } from '@webboy/emulator';
import type { InputLatch } from './InputLatch.js';
/**
 * Multi-touch handling for the on-screen controls.
 *
 * Two properties this must have, and both are easy to get wrong:
 *
 *  1. **Multitouch.** A player has to hold a direction AND press A. Tracking a single
 *     "current button" makes the game unplayable, so every pointer is tracked by its own
 *     `pointerId`.
 *  2. **Sliding.** Rolling a thumb from Left to Up across the d-pad must change direction
 *     without lifting. That means re-resolving which control a pointer is over on every
 *     move, not just on the initial press.
 *
 * Pure apart from the element lookup, so the mapping logic is unit-testable.
 */
export declare class TouchInput {
    private readonly latch;
    /** Resolves a viewport coordinate to a button, or null when outside every control. */
    private readonly hitTest;
    /** pointerId -> the button it is currently holding. */
    private readonly active;
    constructor(latch: InputLatch, 
    /** Resolves a viewport coordinate to a button, or null when outside every control. */
    hitTest: (x: number, y: number) => GameBoyButton | null);
    down(pointerId: number, x: number, y: number): void;
    move(pointerId: number, x: number, y: number): void;
    up(pointerId: number): void;
    /** Releases everything. For blur, tab-hide and pointer cancellation. */
    releaseAll(): void;
    get activeCount(): number;
    private moveTo;
    private isHeldByAnother;
}
//# sourceMappingURL=TouchInput.d.ts.map