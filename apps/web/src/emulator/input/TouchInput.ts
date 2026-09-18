import type { GameBoyButton } from '@webboy/emulator';
import { SOURCE, type InputLatch } from './InputLatch.js';

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
export class TouchInput {
  /** pointerId -> the button it is currently holding. */
  private readonly active = new Map<number, GameBoyButton>();

  constructor(
    private readonly latch: InputLatch,
    /** Resolves a viewport coordinate to a button, or null when outside every control. */
    private readonly hitTest: (x: number, y: number) => GameBoyButton | null,
  ) {}

  down(pointerId: number, x: number, y: number): void {
    this.moveTo(pointerId, x, y);
  }

  move(pointerId: number, x: number, y: number): void {
    if (!this.active.has(pointerId)) return;
    this.moveTo(pointerId, x, y);
  }

  up(pointerId: number): void {
    const button = this.active.get(pointerId);
    if (button === undefined) return;
    this.active.delete(pointerId);
    // Only release if no OTHER pointer is still holding the same button.
    if (!this.isHeldByAnother(button)) this.latch.release(button, SOURCE.touch);
  }

  /** Releases everything. For blur, tab-hide and pointer cancellation. */
  releaseAll(): void {
    for (const button of this.active.values()) this.latch.release(button, SOURCE.touch);
    this.active.clear();
  }

  get activeCount(): number {
    return this.active.size;
  }

  private moveTo(pointerId: number, x: number, y: number): void {
    const next = this.hitTest(x, y);
    const previous = this.active.get(pointerId);
    if (next === previous) return;

    if (previous !== undefined && !this.isHeldByAnother(previous, pointerId)) {
      this.latch.release(previous, SOURCE.touch);
    }

    if (next === null) {
      this.active.delete(pointerId);
      return;
    }

    this.active.set(pointerId, next);
    this.latch.press(next, SOURCE.touch);
  }

  private isHeldByAnother(button: GameBoyButton, excluding?: number): boolean {
    for (const [id, held] of this.active) {
      if (id !== excluding && held === button) return true;
    }
    return false;
  }
}
