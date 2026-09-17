import type { InterruptController } from '../cpu/interrupts.js';
import { INT_JOYPAD } from '../cpu/interrupts.js';
import type { StateReader, StateWriter } from '../state/StateBuffer.js';

/**
 * The eight Game Boy buttons.
 *
 * Bit positions are the hardware's: 0-3 are the direction row, 4-7 the action row, in the
 * order they appear in the low nibble of 0xFF00.
 */
export const BUTTON = {
  right: 0,
  left: 1,
  up: 2,
  down: 3,
  a: 4,
  b: 5,
  select: 6,
  start: 7,
} as const;

export type GameBoyButton = keyof typeof BUTTON;

export const ALL_BUTTONS = Object.keys(BUTTON) as readonly GameBoyButton[];

export const DIRECTION_MASK = 0x0f;
export const ACTION_MASK = 0xf0;

/** Turns a button name into its bit. */
export const buttonBit = (button: GameBoyButton): number => 1 << BUTTON[button];

/**
 * The joypad register (0xFF00).
 *
 * Two things about it catch everyone out:
 *
 *  1. **It is inverted.** A bit reads 0 when the button is PRESSED.
 *  2. **It is multiplexed.** Software clears bit 4 or bit 5 to select the direction row or
 *     the action row, then reads bits 0-3. With neither row selected the low nibble reads
 *     all ones; with both selected the rows are combined.
 *
 * The joypad interrupt fires on a high-to-low transition of any selected line, and is used
 * almost exclusively to wake the CPU from STOP.
 */
export class Joypad {
  /** One bit per button; 1 means PRESSED. Inverted on the way out, not in here. */
  private pressed = 0x00;

  /** Row-select bits 4 and 5, as last written. */
  private select = 0x30;

  constructor(private readonly interrupts: InterruptController) {}

  reset(): void {
    this.pressed = 0x00;
    // Post-boot P1 reads 0xCF, so both row-select bits are CLEAR, not set. Mooneye's
    // boot_hwio checks this exact value.
    this.select = 0x00;
  }

  /**
   * Applies a complete button state.
   *
   * The whole state is replaced at once, at a defined point in emulated time, rather than
   * being poked from DOM event handlers — those arrive asynchronously relative to the
   * emulator and would drop or double-count a fast tap.
   */
  setState(pressedMask: number): void {
    const next = pressedMask & 0xff;
    if (next === this.pressed) return;
    const before = this.lowNibble();
    this.pressed = next;
    this.raiseIfFalling(before);
  }

  isPressed(button: GameBoyButton): boolean {
    return (this.pressed & buttonBit(button)) !== 0;
  }

  getState(): number {
    return this.pressed;
  }

  read(): number {
    // Bits 6-7 are unused and always read as 1.
    return 0xc0 | this.select | this.lowNibble();
  }

  write(value: number): void {
    const before = this.lowNibble();
    this.select = value & 0x30;
    this.raiseIfFalling(before);
  }

  /** Bits 0-3 as the CPU sees them: 0 = pressed, and only for selected rows. */
  private lowNibble(): number {
    let nibble = 0x0f;
    if ((this.select & 0x10) === 0) nibble &= ~(this.pressed & 0x0f) & 0x0f;
    if ((this.select & 0x20) === 0) nibble &= ~((this.pressed >> 4) & 0x0f) & 0x0f;
    return nibble;
  }

  /** Any selected line going 1 -> 0 raises the joypad interrupt. */
  private raiseIfFalling(before: number): void {
    const after = this.lowNibble();
    if ((before & ~after & 0x0f) !== 0) this.interrupts.request(INT_JOYPAD);
  }

  saveState(w: StateWriter): void {
    w.u8(this.pressed);
    w.u8(this.select);
  }

  loadState(s: StateReader): void {
    this.pressed = s.u8();
    this.select = s.u8();
  }
}
