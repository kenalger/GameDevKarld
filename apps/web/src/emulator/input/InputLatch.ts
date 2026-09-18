import { buttonBit, type GameBoyButton } from '@webboy/emulator';

/**
 * The three things a player can press with. Each keeps its own held state.
 *
 * Without this separation every source shares one bitmask, so ANY source releasing a
 * button clears it for all of them: hold Z on the keyboard, tap the on-screen A button and
 * lift, and A releases in the game while the key is still physically down — and it never
 * re-presses, because the keydown already fired and auto-repeat is suppressed.
 */
export const SOURCE = { keyboard: 0, touch: 1, gamepad: 2 } as const;
export type InputSourceId = (typeof SOURCE)[keyof typeof SOURCE];

const SOURCE_COUNT = 3;

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
  /** Held buttons per source. The union is what the emulator sees. */
  private readonly heldBy = new Uint8Array(SOURCE_COUNT);

  /** Bitmask of buttons pressed since the last sample, whether or not still held. */
  private sticky = 0;

  press(button: GameBoyButton, source: InputSourceId = SOURCE.keyboard): void {
    const bit = buttonBit(button);
    this.heldBy[source] = this.heldBy[source]! | bit;
    this.sticky |= bit;
  }

  release(button: GameBoyButton, source: InputSourceId = SOURCE.keyboard): void {
    this.heldBy[source] = this.heldBy[source]! & ~buttonBit(button);
  }

  /** Every source OR'd together — one button, held by anyone, is held. */
  private get held(): number {
    return this.heldBy[0]! | this.heldBy[1]! | this.heldBy[2]!;
  }

  isHeld(button: GameBoyButton): boolean {
    return (this.held & buttonBit(button)) !== 0;
  }

  /**
   * Clears held state. Call on blur or tab-hide so nothing is left stuck down.
   *
   * With a source, only that source is cleared and the sticky bits survive — a keyboard
   * blur must not discard a tap the touch layer just registered. Without one, everything
   * goes, which is what a hidden tab wants.
   */
  releaseAll(source?: InputSourceId): void {
    if (source === undefined) {
      this.heldBy.fill(0);
      this.sticky = 0;
      return;
    }
    this.heldBy[source] = 0;
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
