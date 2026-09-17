import type { StateReader, StateWriter } from '../../gb/state/StateBuffer.js';

/**
 * GBA button bits, as they appear in KEYINPUT (0x04000130).
 *
 * The GBA adds L and R to the Game Boy's eight, and — like the DMG joypad — the register
 * is INVERTED: a bit reads 0 while its button is held.
 */
export const GBA_BUTTON = {
  a: 0,
  b: 1,
  select: 2,
  start: 3,
  right: 4,
  left: 5,
  up: 6,
  down: 7,
  r: 8,
  l: 9,
} as const;

export type GbaButton = keyof typeof GBA_BUTTON;

export const ALL_GBA_BUTTONS = Object.keys(GBA_BUTTON) as readonly GbaButton[];

export const gbaButtonBit = (button: GbaButton): number => 1 << GBA_BUTTON[button];

/** KEYCNT bit 14 enables the interrupt; bit 15 selects AND rather than OR matching. */
const KEYCNT_IRQ_ENABLE = 0x4000;
const KEYCNT_IRQ_AND = 0x8000;

/**
 * The GBA keypad (KEYINPUT 0x04000130, KEYCNT 0x04000132).
 *
 * The keypad interrupt is configurable in a way the DMG's is not: software picks a mask of
 * buttons and chooses whether ANY of them (OR) or ALL of them (AND) must be held. Games use
 * the AND mode for soft-reset combinations.
 */
export class GbaKeypad {
  /** One bit per button; 1 means PRESSED. Inverted on the way out, not in here. */
  private pressed = 0;
  private keycnt = 0;

  constructor(private readonly requestInterrupt: () => void) {}

  reset(): void {
    this.pressed = 0;
    this.keycnt = 0;
  }

  saveState(w: StateWriter): void {
    w.u16(this.pressed);
    w.u16(this.keycnt);
  }

  loadState(r: StateReader): void {
    this.pressed = r.u16();
    this.keycnt = r.u16();
  }

  /** Applies the complete button state at a defined point in emulated time. */
  setState(pressedMask: number): void {
    const next = pressedMask & 0x03ff;
    if (next === this.pressed) return;
    this.pressed = next;
    this.checkInterrupt();
  }

  getState(): number {
    return this.pressed;
  }

  isPressed(button: GbaButton): boolean {
    return (this.pressed & gbaButtonBit(button)) !== 0;
  }

  /** KEYINPUT: inverted, with the unused top bits reading as 1. */
  readKeyInput(): number {
    return (~this.pressed & 0x03ff) | 0xfc00;
  }

  readKeyControl(): number {
    return this.keycnt;
  }

  writeKeyControl(value: number): void {
    this.keycnt = value & 0xffff;
    this.checkInterrupt();
  }

  private checkInterrupt(): void {
    if ((this.keycnt & KEYCNT_IRQ_ENABLE) === 0) return;
    const mask = this.keycnt & 0x03ff;
    if (mask === 0) return;

    const matched =
      (this.keycnt & KEYCNT_IRQ_AND) !== 0
        ? (this.pressed & mask) === mask // ALL of the selected buttons
        : (this.pressed & mask) !== 0; // ANY of them

    if (matched) this.requestInterrupt();
  }
}

/**
 * Maps the shared 8-bit Game Boy button mask onto GBA bit positions.
 *
 * The two layouts differ, so the host's single input latch cannot be passed through
 * unchanged — this is where the translation belongs.
 */
export function fromGameBoyMask(gbMask: number): number {
  let out = 0;
  if ((gbMask & 0x01) !== 0) out |= gbaButtonBit('right');
  if ((gbMask & 0x02) !== 0) out |= gbaButtonBit('left');
  if ((gbMask & 0x04) !== 0) out |= gbaButtonBit('up');
  if ((gbMask & 0x08) !== 0) out |= gbaButtonBit('down');
  if ((gbMask & 0x10) !== 0) out |= gbaButtonBit('a');
  if ((gbMask & 0x20) !== 0) out |= gbaButtonBit('b');
  if ((gbMask & 0x40) !== 0) out |= gbaButtonBit('select');
  if ((gbMask & 0x80) !== 0) out |= gbaButtonBit('start');
  return out;
}
