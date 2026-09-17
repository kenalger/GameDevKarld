import { buttonBit, type GameBoyButton } from '@webboy/emulator';

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
export class InputLatch {
  /** Bitmask of buttons physically held. */
  private held = 0;

  /** Bitmask of buttons pressed since the last sample, whether or not still held. */
  private sticky = 0;

  press(button: GameBoyButton): void {
    const bit = buttonBit(button);
    this.held |= bit;
    this.sticky |= bit;
  }

  release(button: GameBoyButton): void {
    this.held &= ~buttonBit(button);
  }

  isHeld(button: GameBoyButton): boolean {
    return (this.held & buttonBit(button)) !== 0;
  }

  /** Clears everything. Call on blur or tab-hide so nothing is left stuck down. */
  releaseAll(): void {
    this.held = 0;
    this.sticky = 0;
  }

  /**
   * Returns the state the emulator should see for the next frame, and clears the sticky
   * bits. Call exactly once per frame, as late as possible before running it.
   */
  sample(): number {
    const state = this.held | this.sticky;
    this.sticky = 0;
    return state;
  }

  /** Current state without consuming the sticky bits. For UI display only. */
  peek(): number {
    return this.held;
  }
}
