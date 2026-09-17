/** Flag bits in F. The low nibble does not exist in hardware. */
export const FLAG_Z = 0x80;
export const FLAG_N = 0x40;
export const FLAG_H = 0x20;
export const FLAG_C = 0x10;

/**
 * The SM83 register file.
 *
 * The one rule that trips up every implementation: **the low nibble of F is hardwired to
 * zero.** `POP AF` with 0xFF on the stack reads back 0xF0. Enforced in the `f` setter, so
 * no caller can get it wrong.
 */
export class Registers {
  a = 0;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  h = 0;
  l = 0;
  pc = 0;
  sp = 0;

  private _f = 0;

  get f(): number {
    return this._f;
  }

  set f(value: number) {
    this._f = value & 0xf0;
  }

  get af(): number {
    return ((this.a << 8) | this._f) & 0xffff;
  }

  set af(value: number) {
    this.a = (value >>> 8) & 0xff;
    this._f = value & 0xf0;
  }

  get bc(): number {
    return ((this.b << 8) | this.c) & 0xffff;
  }

  set bc(value: number) {
    this.b = (value >>> 8) & 0xff;
    this.c = value & 0xff;
  }

  get de(): number {
    return ((this.d << 8) | this.e) & 0xffff;
  }

  set de(value: number) {
    this.d = (value >>> 8) & 0xff;
    this.e = value & 0xff;
  }

  get hl(): number {
    return ((this.h << 8) | this.l) & 0xffff;
  }

  set hl(value: number) {
    this.h = (value >>> 8) & 0xff;
    this.l = value & 0xff;
  }

  get flagZ(): boolean {
    return (this._f & FLAG_Z) !== 0;
  }

  get flagN(): boolean {
    return (this._f & FLAG_N) !== 0;
  }

  get flagH(): boolean {
    return (this._f & FLAG_H) !== 0;
  }

  get flagC(): boolean {
    return (this._f & FLAG_C) !== 0;
  }

  reset(): void {
    this.a = this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this._f = 0;
    this.pc = 0;
    this.sp = 0;
  }
}
