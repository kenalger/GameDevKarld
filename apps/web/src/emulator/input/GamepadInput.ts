import { ALL_BUTTONS, type GameBoyButton } from '@webboy/emulator';
import { SOURCE, type InputLatch } from './InputLatch.js';

/** Standard-gamepad button indices. */
const BUTTON_MAP: Partial<Record<number, GameBoyButton>> = {
  0: 'a', // south
  1: 'b', // east
  2: 'b', // west — a second B is friendlier than leaving it dead
  3: 'a',
  8: 'select',
  9: 'start',
  12: 'up',
  13: 'down',
  14: 'left',
  15: 'right',
};

/** Sticks drift; anything under this is not a deliberate push. */
const DEADZONE = 0.5;

/**
 * Gamepad support.
 *
 * The Gamepad API is **poll-based, not event-based** — there is no "button pressed" event,
 * so this is read once per frame from inside the emulator loop rather than from a listener.
 */
export class GamepadInput {
  constructor(private readonly latch: InputLatch) {}

  private readonly held = new Set<GameBoyButton>();

  get connected(): boolean {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return false;
    return navigator.getGamepads().some((pad) => pad !== null);
  }

  /** Call once per frame, before sampling the latch. */
  poll(): void {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;

    const pressed = new Set<GameBoyButton>();
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;

      pad.buttons.forEach((button, index) => {
        const mapped = BUTTON_MAP[index];
        if (mapped && button.pressed) pressed.add(mapped);
      });

      // Left stick doubles as a d-pad, with a deadzone so drift does not walk the player
      // into a wall.
      const [x = 0, y = 0] = pad.axes;
      if (x < -DEADZONE) pressed.add('left');
      if (x > DEADZONE) pressed.add('right');
      if (y < -DEADZONE) pressed.add('up');
      if (y > DEADZONE) pressed.add('down');
    }

    for (const button of ALL_BUTTONS) {
      const isDown = pressed.has(button);
      const wasDown = this.held.has(button);
      if (isDown && !wasDown) {
        this.latch.press(button, SOURCE.gamepad);
        this.held.add(button);
      } else if (!isDown && wasDown) {
        this.latch.release(button, SOURCE.gamepad);
        this.held.delete(button);
      }
    }
  }

  releaseAll(): void {
    for (const button of this.held) this.latch.release(button, SOURCE.gamepad);
    this.held.clear();
  }
}
