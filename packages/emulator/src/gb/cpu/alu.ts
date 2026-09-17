import { FLAG_C, FLAG_H, FLAG_N, FLAG_Z } from './registers.js';

/**
 * ALU primitives.
 *
 * Every function returns `(result << 8) | flags` packed into one number rather than an
 * object — this runs ~4 million times per emulated second and the charter forbids
 * allocation in the hot path.
 */

const pack = (result: number, flags: number): number => ((result & 0xff) << 8) | flags;

export const resultOf = (packed: number): number => (packed >>> 8) & 0xff;
export const flagsOf = (packed: number): number => packed & 0xf0;

export function add8(a: number, b: number): number {
  const sum = a + b;
  const result = sum & 0xff;
  let flags = 0;
  if (result === 0) flags |= FLAG_Z;
  if ((a & 0x0f) + (b & 0x0f) > 0x0f) flags |= FLAG_H;
  if (sum > 0xff) flags |= FLAG_C;
  return pack(result, flags);
}

export function adc8(a: number, b: number, carry: number): number {
  const sum = a + b + carry;
  const result = sum & 0xff;
  let flags = 0;
  if (result === 0) flags |= FLAG_Z;
  if ((a & 0x0f) + (b & 0x0f) + carry > 0x0f) flags |= FLAG_H;
  if (sum > 0xff) flags |= FLAG_C;
  return pack(result, flags);
}

export function sub8(a: number, b: number): number {
  const diff = a - b;
  const result = diff & 0xff;
  let flags = FLAG_N;
  if (result === 0) flags |= FLAG_Z;
  if ((a & 0x0f) < (b & 0x0f)) flags |= FLAG_H;
  if (diff < 0) flags |= FLAG_C;
  return pack(result, flags);
}

export function sbc8(a: number, b: number, carry: number): number {
  const diff = a - b - carry;
  const result = diff & 0xff;
  let flags = FLAG_N;
  if (result === 0) flags |= FLAG_Z;
  if ((a & 0x0f) - (b & 0x0f) - carry < 0) flags |= FLAG_H;
  if (diff < 0) flags |= FLAG_C;
  return pack(result, flags);
}

export function and8(a: number, b: number): number {
  const result = a & b & 0xff;
  return pack(result, (result === 0 ? FLAG_Z : 0) | FLAG_H);
}

export function or8(a: number, b: number): number {
  const result = (a | b) & 0xff;
  return pack(result, result === 0 ? FLAG_Z : 0);
}

export function xor8(a: number, b: number): number {
  const result = (a ^ b) & 0xff;
  return pack(result, result === 0 ? FLAG_Z : 0);
}

/** INC r — preserves the carry flag, which is why it is not `add8(x, 1)`. */
export function inc8(value: number, currentFlags: number): number {
  const result = (value + 1) & 0xff;
  let flags = currentFlags & FLAG_C;
  if (result === 0) flags |= FLAG_Z;
  if ((value & 0x0f) === 0x0f) flags |= FLAG_H;
  return pack(result, flags);
}

/** DEC r — likewise preserves carry. */
export function dec8(value: number, currentFlags: number): number {
  const result = (value - 1) & 0xff;
  let flags = (currentFlags & FLAG_C) | FLAG_N;
  if (result === 0) flags |= FLAG_Z;
  if ((value & 0x0f) === 0x00) flags |= FLAG_H;
  return pack(result, flags);
}

/**
 * DAA — branches on the N flag, correcting differently after subtraction than after
 * addition, and does NOT clear C on the add path. The classic source of "passes every
 * test but Blargg 04".
 */
export function daa(a: number, flags: number): number {
  let result = a;
  let carry = flags & FLAG_C;

  if ((flags & FLAG_N) === 0) {
    if (carry !== 0 || result > 0x99) {
      result = (result + 0x60) & 0xff;
      carry = FLAG_C;
    }
    if ((flags & FLAG_H) !== 0 || (result & 0x0f) > 0x09) {
      result = (result + 0x06) & 0xff;
    }
  } else {
    if (carry !== 0) result = (result - 0x60) & 0xff;
    if ((flags & FLAG_H) !== 0) result = (result - 0x06) & 0xff;
  }

  let out = (flags & FLAG_N) | carry;
  if (result === 0) out |= FLAG_Z;
  return pack(result, out);
}

/* -------------------------------------------------------------------------- */
/* Rotates and shifts. The A-register forms (RLCA/RRCA/RLA/RRA) always clear Z; */
/* the CB-prefixed forms set it from the result. Same math, different Z rule.    */
/* -------------------------------------------------------------------------- */

export function rlc(value: number, setZero: boolean): number {
  const carry = (value >>> 7) & 1;
  const result = ((value << 1) | carry) & 0xff;
  return pack(result, (setZero && result === 0 ? FLAG_Z : 0) | (carry ? FLAG_C : 0));
}

export function rrc(value: number, setZero: boolean): number {
  const carry = value & 1;
  const result = ((value >>> 1) | (carry << 7)) & 0xff;
  return pack(result, (setZero && result === 0 ? FLAG_Z : 0) | (carry ? FLAG_C : 0));
}

export function rl(value: number, carryIn: number, setZero: boolean): number {
  const carry = (value >>> 7) & 1;
  const result = ((value << 1) | carryIn) & 0xff;
  return pack(result, (setZero && result === 0 ? FLAG_Z : 0) | (carry ? FLAG_C : 0));
}

export function rr(value: number, carryIn: number, setZero: boolean): number {
  const carry = value & 1;
  const result = ((value >>> 1) | (carryIn << 7)) & 0xff;
  return pack(result, (setZero && result === 0 ? FLAG_Z : 0) | (carry ? FLAG_C : 0));
}

export function sla(value: number): number {
  const carry = (value >>> 7) & 1;
  const result = (value << 1) & 0xff;
  return pack(result, (result === 0 ? FLAG_Z : 0) | (carry ? FLAG_C : 0));
}

/** SRA preserves bit 7 (arithmetic shift). */
export function sra(value: number): number {
  const carry = value & 1;
  const result = ((value >>> 1) | (value & 0x80)) & 0xff;
  return pack(result, (result === 0 ? FLAG_Z : 0) | (carry ? FLAG_C : 0));
}

export function srl(value: number): number {
  const carry = value & 1;
  const result = (value >>> 1) & 0xff;
  return pack(result, (result === 0 ? FLAG_Z : 0) | (carry ? FLAG_C : 0));
}

export function swap(value: number): number {
  const result = ((value << 4) | (value >>> 4)) & 0xff;
  return pack(result, result === 0 ? FLAG_Z : 0);
}

/** BIT b,r — sets Z from the tested bit, H always, N clear, and PRESERVES C. */
export function bit(value: number, index: number, currentFlags: number): number {
  const isZero = (value & (1 << index)) === 0;
  return (currentFlags & FLAG_C) | FLAG_H | (isZero ? FLAG_Z : 0);
}
