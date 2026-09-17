/**
 * ALU helpers for the ARM7TDMI.
 *
 * Every result is a 32-bit unsigned integer (`>>> 0`). Flags are returned through the
 * `carryOut` / `overflowOut` module-level slots rather than allocated objects — this code
 * runs ~16 million times per emulated second and must not allocate.
 */

export let carryOut = false;
export let overflowOut = false;

export const SHIFT_LSL = 0;
export const SHIFT_LSR = 1;
export const SHIFT_ASR = 2;
export const SHIFT_ROR = 3;

/**
 * The barrel shifter.
 *
 * Sets `carryOut` to the shifter carry. The edge cases are what ARMWrestler hammers:
 *
 *  - LSL #0 leaves the value and carry unchanged.
 *  - LSR #0 in an immediate encoding means LSR #32: result 0, carry = bit 31.
 *  - ASR #0 in an immediate encoding means ASR #32: result is all sign bits.
 *  - ROR #0 in an immediate encoding is RRX: rotate through carry by one.
 *  - Register-specified shifts of 32 and more have their own rules, and a shift by
 *    register never gets the #0 special cases.
 */
export function shift(
  value: number,
  type: number,
  amount: number,
  carryIn: boolean,
  byRegister: boolean,
): number {
  value >>>= 0;

  if (byRegister && amount === 0) {
    carryOut = carryIn;
    return value;
  }

  switch (type) {
    case SHIFT_LSL:
      if (amount === 0) {
        carryOut = carryIn;
        return value;
      }
      if (amount < 32) {
        carryOut = ((value >>> (32 - amount)) & 1) !== 0;
        return (value << amount) >>> 0;
      }
      carryOut = amount === 32 && (value & 1) !== 0;
      return 0;

    case SHIFT_LSR:
      if (amount === 0) amount = 32; // immediate LSR #0 encodes LSR #32
      if (amount < 32) {
        carryOut = ((value >>> (amount - 1)) & 1) !== 0;
        return value >>> amount;
      }
      carryOut = amount === 32 && (value & 0x80000000) !== 0;
      return 0;

    case SHIFT_ASR:
      if (amount === 0 || amount >= 32) {
        carryOut = (value & 0x80000000) !== 0;
        return (value & 0x80000000) !== 0 ? 0xffffffff : 0;
      }
      carryOut = ((value >>> (amount - 1)) & 1) !== 0;
      return (value >> amount) >>> 0;

    default: {
      if (amount === 0) {
        // RRX: one-bit rotate through the carry flag.
        carryOut = (value & 1) !== 0;
        return ((value >>> 1) | (carryIn ? 0x80000000 : 0)) >>> 0;
      }
      amount &= 31;
      if (amount === 0) {
        // A register-specified rotate by a multiple of 32 leaves the value alone but
        // still updates carry from bit 31.
        carryOut = (value & 0x80000000) !== 0;
        return value;
      }
      carryOut = ((value >>> (amount - 1)) & 1) !== 0;
      return ((value >>> amount) | (value << (32 - amount))) >>> 0;
    }
  }
}

export function add(a: number, b: number, carry: number): number {
  a >>>= 0;
  b >>>= 0;
  const result = (a + b + carry) >>> 0;
  // Carry out of bit 31: only observable through the wider arithmetic.
  carryOut = a + b + carry > 0xffffffff;
  // Overflow: both operands share a sign that the result does not.
  overflowOut = ((a ^ result) & (b ^ result) & 0x80000000) !== 0;
  return result;
}

export function sub(a: number, b: number, carry: number): number {
  a >>>= 0;
  b >>>= 0;
  // ARM's SBC subtracts (1 - carry); a plain SUB passes carry = 1.
  const result = (a - b - (1 - carry)) >>> 0;
  carryOut = a >= b + (1 - carry);
  overflowOut = ((a ^ b) & (a ^ result) & 0x80000000) !== 0;
  return result;
}

/** Decodes an ARM data-processing immediate: an 8-bit value rotated right by 2*rot. */
export function rotateImmediate(imm8: number, rot: number, carryIn: boolean): number {
  const amount = (rot * 2) & 31;
  if (amount === 0) {
    carryOut = carryIn;
    return imm8 >>> 0;
  }
  const value = ((imm8 >>> amount) | (imm8 << (32 - amount))) >>> 0;
  carryOut = (value & 0x80000000) !== 0;
  return value;
}

/** Sign-extends the low `bits` bits of `value`. */
export function signExtend(value: number, bits: number): number {
  const shiftBy = 32 - bits;
  return (value << shiftBy) >> shiftBy;
}

/** Counts set bits — the register-list size for LDM/STM and PUSH/POP. */
export function popCount(value: number): number {
  let count = 0;
  for (let v = value >>> 0; v !== 0; v &= v - 1) count++;
  return count;
}
