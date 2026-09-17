import { describe, expect, it } from 'vitest';
import {
  disassemble,
  disassembleRange,
} from '../../packages/emulator/src/gb/debug/disassembler.js';

/** Disassembles a byte sequence placed at 0x0100. */
const at = (...bytes: number[]) => {
  const memory = new Uint8Array(0x10000);
  memory.set(bytes, 0x0100);
  return disassemble(0x0100, (a) => memory[a & 0xffff]!);
};

const text = (...bytes: number[]): string => at(...bytes).text;

describe('disassembler', () => {
  it.each([
    [[0x00], 'NOP', 1],
    [[0x76], 'HALT', 1],
    [[0x10], 'STOP', 1],
    [[0xf3], 'DI', 1],
    [[0xfb], 'EI', 1],
    [[0x27], 'DAA', 1],
    [[0x2f], 'CPL', 1],
    [[0xc9], 'RET', 1],
    [[0xd9], 'RETI', 1],
    [[0xe9], 'JP (HL)', 1],
  ] as const)('decodes %s', (bytes, expected, length) => {
    const instruction = at(...bytes);
    expect(instruction.text).toBe(expected);
    expect(instruction.length).toBe(length);
  });

  it('decodes the LD r,r block', () => {
    expect(text(0x40)).toBe('LD B,B');
    expect(text(0x47)).toBe('LD B,A');
    expect(text(0x7e)).toBe('LD A,(HL)');
    expect(text(0x70)).toBe('LD (HL),B');
  });

  it('decodes the ALU block', () => {
    expect(text(0x80)).toBe('ADD A,B');
    expect(text(0x8f)).toBe('ADC A,A');
    expect(text(0x96)).toBe('SUB (HL)');
    expect(text(0xa8)).toBe('XOR B');
    expect(text(0xbe)).toBe('CP (HL)');
  });

  it('decodes immediates and reports their length', () => {
    expect(at(0x3e, 0x42).text).toBe('LD A,$42');
    expect(at(0x3e, 0x42).length).toBe(2);
    expect(at(0x01, 0x34, 0x12).text).toBe('LD BC,$1234');
    expect(at(0x01, 0x34, 0x12).length).toBe(3);
    expect(at(0xc3, 0x50, 0x01).text).toBe('JP $0150');
  });

  it('shows relative jumps as signed offsets', () => {
    expect(at(0x18, 0x05).text).toBe('JR +$05');
    expect(at(0x18, 0xfb).text).toBe('JR -$05');
    expect(at(0x20, 0x10).text).toBe('JR NZ,+$10');
  });

  it('decodes the CB page', () => {
    expect(text(0xcb, 0x00)).toBe('RLC B');
    expect(text(0xcb, 0x37)).toBe('SWAP A');
    expect(text(0xcb, 0x46)).toBe('BIT 0,(HL)');
    expect(text(0xcb, 0x86)).toBe('RES 0,(HL)');
    expect(text(0xcb, 0xff)).toBe('SET 7,A');
    expect(at(0xcb, 0x00).length).toBe(2);
  });

  it('decodes stack and restart instructions', () => {
    expect(text(0xc5)).toBe('PUSH BC');
    expect(text(0xf1)).toBe('POP AF');
    expect(text(0xc7)).toBe('RST $00');
    expect(text(0xff)).toBe('RST $38');
  });

  it('decodes the high-page and SP forms', () => {
    expect(at(0xe0, 0x40).text).toBe('LDH ($40),A');
    expect(at(0xf0, 0x44).text).toBe('LDH A,($44)');
    expect(at(0xe8, 0xfe).text).toBe('ADD SP,-$02');
    expect(at(0xf8, 0x02).text).toBe('LD HL,SP+$02');
    expect(at(0x08, 0x00, 0xc0).text).toBe('LD ($C000),SP');
  });

  it('renders an unknown opcode as data rather than guessing', () => {
    expect(text(0xd3)).toBe('DB $D3');
  });

  it('walks a range, advancing by each instruction length', () => {
    const memory = new Uint8Array(0x10000);
    memory.set([0x00, 0x3e, 0x42, 0xc3, 0x50, 0x01], 0x0100);
    const listing = disassembleRange(0x0100, 3, (a) => memory[a & 0xffff]!);

    expect(listing.map((i) => i.text)).toEqual(['NOP', 'LD A,$42', 'JP $0150']);
    expect(listing.map((i) => i.address)).toEqual([0x0100, 0x0101, 0x0103]);
  });

  it('never throws on any opcode, including the illegal ones', () => {
    const memory = new Uint8Array(0x10000);
    for (let opcode = 0; opcode < 256; opcode++) {
      memory[0x0100] = opcode;
      expect(() => disassemble(0x0100, (a) => memory[a & 0xffff]!)).not.toThrow();
    }
  });
});
