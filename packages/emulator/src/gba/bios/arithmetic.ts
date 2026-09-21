/**
 * The GBA BIOS arithmetic calls, implemented natively.
 *
 * WebBoy ships no BIOS image — it is Nintendo's copyright — so every SWI is emulated from
 * its documented behaviour. Source for this file: GBATEK, "BIOS Arithmetic Functions"
 * (SWI 06h Div, 07h DivArm, 08h Sqrt, 09h ArcTan, 0Ah ArcTan2).
 *
 * These are pure integer functions with no bus access, which is why they live apart from
 * the dispatcher: they are the easiest thing in the emulator to test exhaustively.
 */

/** Two PI, for the BIOS angle unit where 0x10000 covers a full turn. */
const TURN = 0x10000;

/**
 * Div results, in register order: r0 = quotient, r1 = remainder, r3 = |quotient|.
 *
 * A module-level buffer rather than a returned object: a game's inner loop can call Div
 * thousands of times a frame and the charter bans allocation in that path.
 */
export const divResult = new Int32Array(3);

/**
 * SWI 06h Div — signed division of r0 by r1.
 *
 * GBATEK: *"r0 Number DIV Denom ;signed / r1 Number MOD Denom ;signed / r3 ABS (Number DIV
 * Denom) ;unsigned"*, and *"For example, incoming -1234, 10 should return -123, -4, +123"*
 * — so the quotient truncates toward zero and the remainder takes the sign of the
 * numerator, which is exactly what JavaScript's `/` with truncation and `%` already do.
 *
 * Returns false for a zero denominator. GBATEK only says the real routine *"usually gets
 * caught in an endless loop upon division by zero"*, which is not a result this emulator
 * can reproduce without hanging the host, so the caller's registers are left untouched.
 * Flagged as an ambiguity rather than guessed at.
 */
export function biosDiv(numerator: number, denominator: number): boolean {
  const n = numerator | 0;
  const d = denominator | 0;
  if (d === 0) return false;

  // `| 0` truncates toward zero and wraps 0x80000000 / -1 the same way the ARM does.
  const quotient = (n / d) | 0;
  divResult[0] = quotient;
  divResult[1] = n % d;
  divResult[2] = Math.abs(quotient) | 0;
  return true;
}

/**
 * SWI 08h Sqrt — integer square root of an unsigned 32-bit number.
 *
 * GBATEK: *"r0 unsigned 32bit number"* in, *"r0 unsigned 16bit number"* out, and *"The
 * result is an integer value, so Sqrt(2) would return 1"*. sqrt(0xFFFFFFFF) = 65535, so
 * the result always fits 16 bits.
 */
export function biosSqrt(value: number): number {
  const x = value >>> 0;
  let root = Math.floor(Math.sqrt(x));
  // Math.sqrt is correctly rounded but the floor of a double can still land one off at
  // the top of the 32-bit range; nail it with the exact integer comparison.
  if ((root + 1) * (root + 1) <= x) root++;
  else if (root * root > x) root--;
  return root & 0xffff;
}

/**
 * SWI 09h ArcTan — arc tangent of a 1.1.14 fixed-point tangent.
 *
 * GBATEK: *"r0 Tan, 16bit (1bit sign, 1bit integral part, 14bit decimal part)"*, returning
 * *"-PI/2<THETA/<PI/2 in a range of C000h-4000h"* — the BIOS angle unit, where 0x4000 is a
 * quarter turn.
 *
 * DEVIATION, deliberate: the real routine is a polynomial approximation whose coefficients
 * exist only inside the BIOS ROM, and GBATEK notes *"there is a problem in accuracy with
 * THETA<-PI/4, PI/4<THETA"*. Copying those coefficients would mean copying the BIOS, so
 * this computes the true arc tangent instead. Results agree with hardware to within a few
 * units near the axes and are *more* accurate than hardware away from them.
 */
export function biosArcTan(tangent: number): number {
  const t = ((tangent << 16) >> 16) / 0x4000;
  return Math.round((Math.atan(t) * TURN) / (2 * Math.PI)) & 0xffff;
}

/**
 * SWI 0Ah ArcTan2 — the quadrant-corrected arc tangent.
 *
 * GBATEK: *"r0 X, 16bit (1bit sign, 1bit integral part, 14bit decimal part) / r1 Y"*,
 * returning *"0000h-FFFFh for 0<=THETA<2PI"*. So +X is 0, +Y is 0x4000, -X is 0x8000 and
 * -Y is 0xC000. Same deliberate deviation as ArcTan: true maths, not the BIOS polynomial.
 */
export function biosArcTan2(x: number, y: number): number {
  const fx = (x << 16) >> 16;
  const fy = (y << 16) >> 16;
  if (fx === 0 && fy === 0) return 0;
  let angle = Math.atan2(fy, fx);
  if (angle < 0) angle += 2 * Math.PI;
  return Math.round((angle * TURN) / (2 * Math.PI)) & 0xffff;
}
