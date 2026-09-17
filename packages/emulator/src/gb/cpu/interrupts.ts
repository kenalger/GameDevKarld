/** Interrupt request bits, in hardware priority order (bit 0 highest). */
export const INT_VBLANK = 0x01;
export const INT_STAT = 0x02;
export const INT_TIMER = 0x04;
export const INT_SERIAL = 0x08;
export const INT_JOYPAD = 0x10;

/** Handler addresses, indexed by bit position. */
export const INT_VECTORS = [0x0040, 0x0048, 0x0050, 0x0058, 0x0060] as const;

export const INT_MASK = 0x1f;

/**
 * IE / IF / IME.
 *
 * IME is owned by the CPU (it is not memory-mapped); IE and IF live here and are exposed
 * to the bus at 0xFFFF and 0xFF0F respectively. The upper 3 bits of IF read as 1.
 */
export class InterruptController {
  /** 0xFFFF — Interrupt Enable. */
  ie = 0;

  /** 0xFF0F — Interrupt Flag. Upper bits read as 1 on hardware. */
  private _if = 0;

  get if(): number {
    return this._if | 0xe0;
  }

  set if(value: number) {
    this._if = value & INT_MASK;
  }

  request(mask: number): void {
    this._if |= mask & INT_MASK;
  }

  clear(mask: number): void {
    this._if &= ~mask & INT_MASK;
  }

  /** Enabled AND requested. Non-zero wakes the CPU from HALT even when IME is clear. */
  get pending(): number {
    return this.ie & this._if & INT_MASK;
  }

  reset(): void {
    this.ie = 0;
    this._if = 0;
  }
}
