import { describe, expect, it } from 'vitest';
import {
  biosArcTan,
  biosArcTan2,
  biosDiv,
  biosSqrt,
  divResult,
} from '../../packages/emulator/src/gba/bios/arithmetic.js';
import { cpuFastSet, cpuSet } from '../../packages/emulator/src/gba/bios/memcopy.js';
import {
  bitUnPack,
  diffUnFilter,
  huffUnComp,
  lz77UnComp,
  rlUnComp,
} from '../../packages/emulator/src/gba/bios/decompress.js';
import { bgAffineSet, objAffineSet } from '../../packages/emulator/src/gba/bios/affine.js';
import type { BiosMemory } from '../../packages/emulator/src/gba/bios/BiosMemory.js';
import { GameBoyAdvanceCore } from '../../packages/emulator/src/gba/GameBoyAdvanceCore.js';

/**
 * The GBA BIOS, which WebBoy emulates natively because it cannot ship Nintendo's image.
 *
 * Every vector here is taken from GBATEK's "BIOS Functions" chapter and cited at the
 * assertion. These are pure integer routines: there is no excuse for testing them by
 * running a game and squinting.
 */

/* ------------------------------- test doubles -------------------------------- */

/** A flat little-endian memory, addressed from zero. */
class FlatMemory implements BiosMemory {
  readonly bytes: Uint8Array;
  /** Set to make 8-bit writes throw, the way VRAM effectively ignores them. */
  rejectByteWrites = false;

  constructor(size = 0x400) {
    this.bytes = new Uint8Array(size);
  }

  read8(address: number): number {
    return this.bytes[address >>> 0]!;
  }
  read16(address: number): number {
    const a = (address & ~1) >>> 0;
    return this.bytes[a]! | (this.bytes[a + 1]! << 8);
  }
  read32(address: number): number {
    const a = (address & ~3) >>> 0;
    return (
      (this.bytes[a]! | (this.bytes[a + 1]! << 8) | (this.bytes[a + 2]! << 16)) +
      this.bytes[a + 3]! * 0x1000000
    );
  }
  write8(address: number, value: number): void {
    if (this.rejectByteWrites) throw new Error(`8-bit write to ${address.toString(16)}`);
    this.bytes[address >>> 0] = value & 0xff;
  }
  write16(address: number, value: number): void {
    const a = (address & ~1) >>> 0;
    this.bytes[a] = value & 0xff;
    this.bytes[a + 1] = (value >>> 8) & 0xff;
  }
  write32(address: number, value: number): void {
    const a = (address & ~3) >>> 0;
    this.bytes[a] = value & 0xff;
    this.bytes[a + 1] = (value >>> 8) & 0xff;
    this.bytes[a + 2] = (value >>> 16) & 0xff;
    this.bytes[a + 3] = (value >>> 24) & 0xff;
  }

  /** Loads bytes at an address, for building a compressed stream by hand. */
  load(address: number, ...values: number[]): void {
    for (let i = 0; i < values.length; i++) this.bytes[address + i] = values[i]! & 0xff;
  }

  slice(address: number, length: number): number[] {
    return Array.from(this.bytes.subarray(address, address + length));
  }
}

/* --------------------------------- arithmetic -------------------------------- */

describe('BIOS arithmetic (GBATEK, "BIOS Arithmetic Functions")', () => {
  it('Div follows the documented example: -1234 / 10 = -123 remainder -4, |q| = 123', () => {
    // GBATEK, SWI 06h: "For example, incoming -1234, 10 should return -123, -4, +123."
    expect(biosDiv(-1234, 10)).toBe(true);
    expect(divResult[0]).toBe(-123);
    expect(divResult[1]).toBe(-4);
    expect(divResult[2]).toBe(123);
  });

  it('Div truncates toward zero and gives the remainder the numerator’s sign', () => {
    biosDiv(7, 2);
    expect([divResult[0], divResult[1], divResult[2]]).toEqual([3, 1, 3]);
    biosDiv(-7, 2);
    expect([divResult[0], divResult[1], divResult[2]]).toEqual([-3, -1, 3]);
    biosDiv(7, -2);
    expect([divResult[0], divResult[1], divResult[2]]).toEqual([-3, 1, 3]);
    biosDiv(-7, -2);
    expect([divResult[0], divResult[1], divResult[2]]).toEqual([3, -1, 3]);
  });

  it('Div reports a zero denominator rather than inventing a result', () => {
    // GBATEK only says the routine "usually gets caught in an endless loop upon division
    // by zero", so there is no documented result to return.
    expect(biosDiv(1234, 0)).toBe(false);
  });

  it('Sqrt returns the integer root, per the documented examples', () => {
    // GBATEK, SWI 08h: "The result is an integer value, so Sqrt(2) would return 1" and
    // "Sqrt(2 shl 30) would return 1.41421 shl 15" — 1.41421 * 0x8000 = 46340.
    expect(biosSqrt(2)).toBe(1);
    expect(biosSqrt(2 * 2 ** 30)).toBe(46340);
    expect(biosSqrt(0)).toBe(0);
    expect(biosSqrt(0x10000)).toBe(256);
    // The result is a 16-bit number: sqrt(0xFFFFFFFF) is exactly 65535.
    expect(biosSqrt(0xffffffff)).toBe(65535);
  });

  it('Sqrt is exact at every perfect square boundary it is given', () => {
    for (const root of [1, 2, 255, 256, 1000, 40000, 65534, 65535]) {
      expect(biosSqrt(root * root)).toBe(root);
      expect(biosSqrt(root * root - 1)).toBe(root - 1);
    }
  });

  it('ArcTan maps a 1.1.14 tangent onto the BIOS angle unit', () => {
    // GBATEK, SWI 09h: input is "1bit sign, 1bit integral part, 14bit decimal part",
    // output "in a range of C000h-4000h" — a quarter turn is 0x4000, so tan(1) = 45
    // degrees = 0x2000.
    expect(biosArcTan(0)).toBe(0);
    expect(biosArcTan(0x4000)).toBe(0x2000);
    expect(biosArcTan(0xc000)).toBe(0xe000); // tan = -1 -> -45 degrees
  });

  it('ArcTan2 covers all four quadrants over 0000h-FFFFh', () => {
    // GBATEK, SWI 0Ah: "r0 0000h-FFFFh for 0<=THETA<2PI".
    const one = 0x4000; // 1.0 in 1.1.14
    expect(biosArcTan2(one, 0)).toBe(0x0000);
    expect(biosArcTan2(0, one)).toBe(0x4000);
    expect(biosArcTan2(-one & 0xffff, 0)).toBe(0x8000);
    expect(biosArcTan2(0, -one & 0xffff)).toBe(0xc000);
    expect(biosArcTan2(one, one)).toBe(0x2000);
    expect(biosArcTan2(-one & 0xffff, one)).toBe(0x6000);
    expect(biosArcTan2(0, 0)).toBe(0);
  });
});

/* --------------------------------- memory copy ------------------------------- */

describe('CpuSet and CpuFastSet (GBATEK, "BIOS Memory Copy")', () => {
  const FIXED = 1 << 24;
  const WORDS = 1 << 26;

  // Addresses below 0x4000 are BIOS and the call would rightly refuse them, so these
  // vectors sit where a game's data would.
  const SRC = 0x4000;
  const DST = 0x5000;

  it('CpuSet copies halfwords and words', () => {
    const mem = new FlatMemory(0x8000);
    mem.load(SRC, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88);
    cpuSet(mem, SRC, DST, 4); // four halfwords
    expect(mem.slice(DST, 8)).toEqual([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);

    cpuSet(mem, SRC, DST + 0x40, 2 | WORDS); // two words
    expect(mem.slice(DST + 0x40, 8)).toEqual([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
  });

  it('CpuSet fills from a fixed source when bit 24 is set', () => {
    // GBATEK: "Bit 24 Fixed Source Address (0=Copy, 1=Fill by {HALF}WORD[r0])".
    const mem = new FlatMemory(0x8000);
    mem.load(SRC, 0xcd, 0xab);
    cpuSet(mem, SRC, DST, 3 | FIXED);
    expect(mem.slice(DST, 6)).toEqual([0xcd, 0xab, 0xcd, 0xab, 0xcd, 0xab]);
  });

  it('CpuSet refuses a source inside the BIOS', () => {
    // GBATEK: "these two functions will silently reject to do anything if the source start
    // or end addresses are reaching into the BIOS area."
    const mem = new FlatMemory(0x8000);
    mem.load(0x100, 0xff, 0xff, 0xff, 0xff);
    cpuSet(mem, 0x100, DST, 2); // source below 0x4000 is BIOS
    expect(mem.slice(DST, 4)).toEqual([0, 0, 0, 0]);
  });

  it('CpuFastSet rounds the word count up to a multiple of eight', () => {
    // GBATEK: "the length should be a multiple of 8 words (32 bytes) (otherwise the GBA is
    // forcefully rounding-up the length)" — a request for one word moves eight.
    const mem = new FlatMemory(0x8000);
    for (let i = 0; i < 32; i++) mem.bytes[0x4000 + i] = i + 1;
    cpuFastSet(mem, 0x4000, 0x5000, 1);
    expect(mem.slice(0x5000, 32)).toEqual(mem.slice(0x4000, 32));
    expect(mem.bytes[0x5020]).toBe(0); // and not a byte more
  });

  it('CpuFastSet fills 32-byte blocks from one word', () => {
    const mem = new FlatMemory(0x8000);
    mem.load(0x4000, 0x0d, 0xf0, 0xad, 0x8b);
    cpuFastSet(mem, 0x4000, 0x5000, 8 | FIXED);
    for (let i = 0; i < 8; i++) {
      expect(mem.slice(0x5000 + i * 4, 4)).toEqual([0x0d, 0xf0, 0xad, 0x8b]);
    }
  });
});

/* -------------------------------- decompression ------------------------------- */

describe('BIOS decompression (GBATEK, "BIOS Decompression Functions")', () => {
  /**
   * An LZ77 stream: four literals then one back-reference that overlaps itself.
   *
   * GBATEK: header "Bit 4-7 Compressed type (must be 1 for LZ77)", "Bit 8-31 Size of
   * decompressed data"; a flag byte whose bits select eight blocks MSB first; and
   * "Block Type 1 - Compressed - Copy N+3 Bytes from Dest-Disp-1 to Dest".
   */
  function buildLz77(mem: FlatMemory, at: number): void {
    mem.load(at, 0x10, 0x10, 0x00, 0x00); // type 1, 16 bytes out
    mem.load(at + 4, 0b00001000); // blocks 0-3 literal, block 4 compressed
    mem.load(at + 5, 0x41, 0x42, 0x43, 0x44); // "ABCD"
    mem.load(at + 9, 0x90, 0x03); // length 12, disp 3 -> copy from dest-4
  }

  it('LZ77UnCompWram expands an overlapping back-reference', () => {
    const mem = new FlatMemory();
    buildLz77(mem, 0x20);
    lz77UnComp(mem, 0x20, 0x80, false);
    expect(String.fromCharCode(...mem.slice(0x80, 16))).toBe('ABCDABCDABCDABCD');
    expect(mem.bytes[0x90]).toBe(0); // nothing written past the stated size
  });

  it('LZ77UnCompVram produces the same bytes WITHOUT any 8-bit write', () => {
    // The reason SWI 12h exists: VRAM ignores byte writes, so the Vram variant must emit
    // halfwords. A memory that refuses 8-bit writes is the only honest way to test it.
    const mem = new FlatMemory();
    mem.rejectByteWrites = true;
    buildLz77(mem, 0x20);
    expect(() => lz77UnComp(mem, 0x20, 0x80, true)).not.toThrow();
    expect(String.fromCharCode(...mem.slice(0x80, 16))).toBe('ABCDABCDABCDABCD');
  });

  it('LZ77UnCompWram would fail that same test, which is why the variant exists', () => {
    const mem = new FlatMemory();
    mem.rejectByteWrites = true;
    buildLz77(mem, 0x20);
    expect(() => lz77UnComp(mem, 0x20, 0x80, false)).toThrow();
  });

  /** GBATEK: flag "Bit 0-6 Expanded Data Length (uncompressed N-1, compressed N-3)". */
  function buildRle(mem: FlatMemory, at: number): void {
    mem.load(at, 0x30, 0x0a, 0x00, 0x00); // type 3, 10 bytes out
    mem.load(at + 4, 0x83, 0x58); // compressed: 'X' six times
    mem.load(at + 6, 0x03, 0x61, 0x62, 0x63, 0x64); // uncompressed: "abcd"
  }

  it('RLUnCompWram expands runs and literal blocks', () => {
    const mem = new FlatMemory();
    buildRle(mem, 0x20);
    rlUnComp(mem, 0x20, 0x80, false);
    expect(String.fromCharCode(...mem.slice(0x80, 10))).toBe('XXXXXXabcd');
  });

  it('RLUnCompVram writes halfwords only', () => {
    const mem = new FlatMemory();
    mem.rejectByteWrites = true;
    buildRle(mem, 0x20);
    expect(() => rlUnComp(mem, 0x20, 0x80, true)).not.toThrow();
    expect(String.fromCharCode(...mem.slice(0x80, 10))).toBe('XXXXXXabcd');
  });

  it('HuffUnComp decodes GBATEK’s own "Huff" example', () => {
    // GBATEK: "the 4-byte string "Huff" could be compressed to 6 bits: 10-11-0-0, with
    // root.0 pointing directly to data "f", and root.1 pointing to a child node, whose
    // nodes point to data "H" and data "u"."
    const mem = new FlatMemory();
    const at = 0x20;
    mem.load(at, 0x28, 0x04, 0x00, 0x00); // 8-bit units, type 2 (Huffman), 4 bytes out
    // GBATEK: the tree size byte is "Size of Tree Table/2-1 (ie. Offset to Compressed
    // Bitstream)", and the bitstream is "stored in units of 32bits" — so the table is
    // padded to land the bitstream on a word boundary, as a real encoder does.
    mem.load(at + 4, 0x03); // tree table: 8 bytes including this one
    // Root: offset 0, node0 is data ("f"), node1 is another node.
    mem.load(at + 5, 0x80);
    mem.load(at + 6, 0x66); // 'f'
    mem.load(at + 7, 0xc0); // child: both children are data
    mem.load(at + 8, 0x48, 0x75); // 'H', 'u'
    mem.load(at + 10, 0x00, 0x00); // padding
    // Bitstream, bit 31 first: 1 0 1 1 0 0 then padding.
    mem.load(at + 12, 0x00, 0x00, 0x00, 0xb0);

    huffUnComp(mem, at, 0x80);
    expect(String.fromCharCode(...mem.slice(0x80, 4))).toBe('Huff');
  });

  it('BitUnPack widens 1-bit units to 4-bit units and adds the data offset', () => {
    // GBATEK: "Used to increase the color depth of bitmaps or tile data... The Data Offset
    // is always added to all non-zero source units."
    const mem = new FlatMemory();
    mem.load(0x20, 0b10110001); // LSB first: 1,0,0,0,1,1,0,1
    mem.load(0x30, 0x01, 0x00, 0x01, 0x04, 0x00, 0x00, 0x00, 0x00); // len 1, 1->4 bits

    bitUnPack(mem, 0x20, 0x80, 0x30);
    expect(mem.read32(0x80) >>> 0).toBe(0x10110001);

    // With a data offset of 3 and the zero flag clear, only the set bits move.
    mem.load(0x30, 0x01, 0x00, 0x01, 0x04, 0x03, 0x00, 0x00, 0x00);
    bitUnPack(mem, 0x20, 0x90, 0x30);
    expect(mem.read32(0x90) >>> 0).toBe(0x40440004);

    // With the zero flag set (bit 31), zero units are offset too.
    mem.load(0x30, 0x01, 0x00, 0x01, 0x04, 0x03, 0x00, 0x00, 0x80);
    bitUnPack(mem, 0x20, 0xa0, 0x30);
    expect(mem.read32(0xa0) >>> 0).toBe(0x43443334);
  });

  it('Diff8bitUnFilter reverses GBATEK’s worked example', () => {
    // GBATEK: "unfiltered: 10 11 12 13 14 15 16 17 18 19 / filtered: 10 +1 +1 +1 ...".
    const mem = new FlatMemory();
    mem.load(0x20, 0x81, 0x0a, 0x00, 0x00); // size 1 (8-bit), type 8, 10 bytes
    mem.load(0x24, 10, 1, 1, 1, 1, 1, 1, 1, 1, 1);
    diffUnFilter(mem, 0x20, 0x80, 1, false);
    expect(mem.slice(0x80, 10)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('Diff8bitUnFilter’s Vram variant writes halfwords only', () => {
    const mem = new FlatMemory();
    mem.rejectByteWrites = true;
    mem.load(0x20, 0x81, 0x0a, 0x00, 0x00);
    mem.load(0x24, 10, 1, 1, 1, 1, 1, 1, 1, 1, 1);
    expect(() => diffUnFilter(mem, 0x20, 0x80, 1, true)).not.toThrow();
    expect(mem.slice(0x80, 10)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('Diff16bitUnFilter accumulates 16-bit units', () => {
    const mem = new FlatMemory();
    mem.load(0x20, 0x82, 0x08, 0x00, 0x00); // size 2 (16-bit), type 8, 8 bytes
    mem.write16(0x24, 0x1000);
    mem.write16(0x26, 0x0001);
    mem.write16(0x28, 0xffff); // wraps within 16 bits
    mem.write16(0x2a, 0x0002);
    diffUnFilter(mem, 0x20, 0x80, 2, false);
    expect([mem.read16(0x80), mem.read16(0x82), mem.read16(0x84), mem.read16(0x86)]).toEqual([
      0x1000, 0x1001, 0x1000, 0x1002,
    ]);
  });
});

/* ------------------------------ rotation / scaling ---------------------------- */

describe('ObjAffineSet and BgAffineSet (GBATEK, "BIOS Rotation/Scaling Functions")', () => {
  /** P = [sx*cos, -sx*sin; sy*sin, sy*cos] — Tonc, "BIOS Calls". */
  it('ObjAffineSet writes the identity matrix for scale 1.0 at angle 0', () => {
    const mem = new FlatMemory();
    mem.write16(0x20, 0x0100); // sx = 1.0 in 8.8
    mem.write16(0x22, 0x0100); // sy = 1.0
    mem.write16(0x24, 0x0000); // angle
    objAffineSet(mem, 0x20, 0x80, 1, 2);
    expect([mem.read16(0x80), mem.read16(0x82), mem.read16(0x84), mem.read16(0x86)]).toEqual([
      0x0100, 0x0000, 0x0000, 0x0100,
    ]);
  });

  it('ObjAffineSet rotates a quarter turn at angle 4000h', () => {
    // GBATEK: angles are "0-FFFFh (covering a range of 360 degrees)", of which "the GBA
    // BIOS recurses only the upper 8bit" — 0x4000 is 90 degrees.
    const mem = new FlatMemory();
    mem.write16(0x20, 0x0100);
    mem.write16(0x22, 0x0100);
    mem.write16(0x24, 0x4000);
    objAffineSet(mem, 0x20, 0x80, 1, 2);
    expect([mem.read16(0x80), mem.read16(0x82), mem.read16(0x84), mem.read16(0x86)]).toEqual([
      0x0000,
      0xff00, // -1.0
      0x0100,
      0x0000,
    ]);
  });

  it('ObjAffineSet honours the OAM stride of 8 bytes and processes an array', () => {
    // GBATEK: "If the Offset value is 2, the parameters are stored contiguously. If the
    // value is 8, they match the structure of OAM."
    const mem = new FlatMemory();
    for (let i = 0; i < 2; i++) {
      mem.write16(0x20 + i * 6, 0x0100);
      mem.write16(0x22 + i * 6, 0x0200);
      mem.write16(0x24 + i * 6, 0x0000);
    }
    objAffineSet(mem, 0x20, 0x80, 2, 8);
    expect(mem.read16(0x80)).toBe(0x0100); // pa, entry 0
    expect(mem.read16(0x88)).toBe(0x0000); // pb, 8 bytes on
    expect(mem.read16(0x90)).toBe(0x0000); // pc
    expect(mem.read16(0x98)).toBe(0x0200); // pd
    expect(mem.read16(0xa0)).toBe(0x0100); // entry 1 begins one full stride later
  });

  it('BgAffineSet writes the matrix and the documented start coordinates', () => {
    // dx = tex_x - (pa*scr_x + pb*scr_y), dy = tex_y - (pc*scr_x + pd*scr_y)
    // — Tonc, "Affine backgrounds", bg_rotscale_ex.
    const mem = new FlatMemory();
    mem.write32(0x20, 64 << 8); // centre X = 64.0 in 24.8
    mem.write32(0x24, 32 << 8); // centre Y = 32.0
    mem.write16(0x28, 120); // display X
    mem.write16(0x2a, 80); // display Y
    mem.write16(0x2c, 0x0100); // scale X
    mem.write16(0x2e, 0x0100); // scale Y
    mem.write16(0x30, 0x0000); // angle

    bgAffineSet(mem, 0x20, 0x80, 1);
    expect([mem.read16(0x80), mem.read16(0x82), mem.read16(0x84), mem.read16(0x86)]).toEqual([
      0x0100, 0x0000, 0x0000, 0x0100,
    ]);
    expect(mem.read32(0x88) | 0).toBe((64 << 8) - 0x100 * 120);
    expect(mem.read32(0x8c) | 0).toBe((32 << 8) - 0x100 * 80);
  });
});

/* ---------------------------- the machine-level view -------------------------- */

/**
 * Builds a core running `program` from the start of ROM.
 *
 * ARM opcodes are hand-encoded: these tests are about the BIOS, and a full assembler
 * would be more code than the thing under test.
 */
function coreRunning(program: number[]): GameBoyAdvanceCore {
  const rom = new Uint8Array(0x200);
  const view = new DataView(rom.buffer);
  for (let i = 0; i < program.length; i++) view.setUint32(i * 4, program[i]! >>> 0, true);
  const core = new GameBoyAdvanceCore();
  core.loadRom(rom);
  return core;
}

/** `swi #comment`, ARM encoding: cond=AL, 1111, 24-bit comment. */
function swi(comment: number): number {
  return 0xef000000 | ((comment & 0xff) << 16);
}

/** `mov rd, #imm8`. */
function movImm(rd: number, imm: number): number {
  return 0xe3a00000 | (rd << 12) | (imm & 0xff);
}

const BRANCH_SELF = 0xeafffffe;

describe('SWIs through the CPU', () => {
  it('SWI 06h Div returns its results in r0, r1 and r3', () => {
    const core = coreRunning([
      movImm(0, 100),
      movImm(1, 7),
      swi(0x06),
      BRANCH_SELF, //
    ]);
    for (let i = 0; i < 8; i++) core.stepInstruction();
    expect(core.cpu.regs.r[0]! | 0).toBe(14);
    expect(core.cpu.regs.r[1]! | 0).toBe(2);
    expect(core.cpu.regs.r[3]! | 0).toBe(14);
  });

  it('SWI 07h DivArm takes its operands the other way round', () => {
    // GBATEK: "incoming parameters are exchanged, r1/r0 (r0=Denom, r1=number)".
    const core = coreRunning([movImm(0, 7), movImm(1, 100), swi(0x07), BRANCH_SELF]);
    for (let i = 0; i < 8; i++) core.stepInstruction();
    expect(core.cpu.regs.r[0]! | 0).toBe(14);
    expect(core.cpu.regs.r[1]! | 0).toBe(2);
  });

  it('a SWI returns to the following instruction with the caller’s mode restored', () => {
    const core = coreRunning([movImm(0, 81), swi(0x08), movImm(2, 0x2a), BRANCH_SELF]);
    const modeBefore = core.cpu.regs.mode;
    for (let i = 0; i < 8; i++) core.stepInstruction();
    expect(core.cpu.regs.r[0]).toBe(9); // sqrt(81)
    expect(core.cpu.regs.r[2]).toBe(0x2a); // the instruction after the SWI really ran
    expect(core.cpu.regs.mode).toBe(modeBefore);
  });

  it('a SWI leaves SPSR_svc and the Supervisor stack where a game can find them', () => {
    // GBATEK, "How BIOS Processes SWIs": four words are pushed on the Supervisor stack and
    // popped again, so SP_svc must come back to where it started.
    const core = coreRunning([movImm(0, 4), swi(0x08), BRANCH_SELF]);
    for (let i = 0; i < 8; i++) core.stepInstruction();
    // Re-entering Supervisor mode shows the stack pointer the BIOS left.
    core.cpu.regs.switchMode(0x13);
    expect(core.cpu.regs.r[13]).toBe(0x03007fe0);
  });

  it('SWI 02h Halt stops the CPU until IE AND IF is non-zero', () => {
    // GBATEK: "Halt mode is terminated when any enabled interrupts are requested, that is
    // when (IE AND IF) is not zero... the state of CPUs IRQ disable bit in CPSR register,
    // and the IME register are don't care".
    const core = coreRunning([swi(0x02), movImm(4, 0x5a), BRANCH_SELF]);
    core.mmu.write16(0x04000208, 0); // IME off: Halt must still end
    for (let i = 0; i < 6; i++) core.stepInstruction();
    expect(core.cpu.halted).toBe(true);
    expect(core.cpu.regs.r[4]).toBe(0);

    core.mmu.write16(0x04000200, 0x0001); // IE: VBlank
    core.mmu.requestInterrupt(0x0001);
    for (let i = 0; i < 6; i++) core.stepInstruction();
    expect(core.cpu.halted).toBe(false);
    expect(core.cpu.regs.r[4]).toBe(0x5a);
  });

  it('an unimplemented SWI is recorded rather than crashing the machine', () => {
    const core = coreRunning([swi(0x1a), movImm(5, 0x33), BRANCH_SELF]);
    for (let i = 0; i < 8; i++) core.stepInstruction();
    expect(core.bios.unimplementedSwi).toBe(0x1a);
    expect(core.cpu.regs.r[5]).toBe(0x33); // execution continued
  });
});

describe('BIOS reset functions (GBATEK, "BIOS Reset Functions")', () => {
  it('SoftReset returns to ROM in system mode with the documented stack pointers', () => {
    // GBATEK, SWI 00h: sp_svc=3007FE0h, sp_irq=3007FA0h, sp_sys=3007F00h, the area
    // 3007E00h-3007FFFh zero-filled, "enters system mode", and "The GBA return address
    // 8bit flag is interpreted as 00h=8000000h (ROM)".
    const core = coreRunning([swi(0x00), BRANCH_SELF]);
    core.mmu.write32(0x03007e40, 0xdeadbeef); // inside the area SoftReset clears
    core.mmu.write8(0x03007ffa, 0); // return to ROM

    for (let i = 0; i < 4; i++) core.stepInstruction();

    expect(core.cpu.regs.r[15]! - 8).toBe(0x08000000);
    expect(core.cpu.regs.mode).toBe(0x1f);
    expect(core.cpu.regs.r[13]).toBe(0x03007f00);
    expect(core.mmu.read32(0x03007e40)).toBe(0);
    core.cpu.regs.switchMode(0x13);
    expect(core.cpu.regs.r[13]).toBe(0x03007fe0);
    core.cpu.regs.switchMode(0x12);
    expect(core.cpu.regs.r[13]).toBe(0x03007fa0);
  });

  it('RegisterRamReset clears what it is asked to and forces blank', () => {
    // GBATEK, SWI 01h: bit 3 clears VRAM, and "The function always switches the screen
    // into forced blank by setting DISPCNT=0080h (regardless of incoming R0)".
    const core = coreRunning([movImm(0, 0x08), swi(0x01), BRANCH_SELF]);
    core.mmu.write16(0x06000000, 0x1234);
    core.mmu.write16(0x02000000, 0x5678); // bit 0 not requested: must survive

    for (let i = 0; i < 6; i++) core.stepInstruction();

    expect(core.mmu.read16(0x06000000)).toBe(0);
    expect(core.mmu.read16(0x02000000)).toBe(0x5678);
    expect(core.mmu.read16(0x04000000)).toBe(0x0080);
  });
});

describe('VBlankIntrWait (GBATEK, "BIOS Halt Functions")', () => {
  it('waits for a real VBlank interrupt and then returns to the caller', () => {
    // GBATEK, SWI 05h: "Continues to wait in Halt status until a new V-Blank interrupt
    // occurs", via SWI 04h, whose caution reads: "the user interrupt handler MUST update
    // the BIOS Interrupt Flags value in RAM... at [3007FF8h]". So this handler does both
    // the IF acknowledge and the BIOS flag, exactly as a game's must.
    const core = coreRunning([
      movImm(6, 0), //
      swi(0x05),
      movImm(6, 0x77),
      BRANCH_SELF,
    ]);

    const handler = 0x03000000;
    const code = [
      0xe3a00001, // mov r0, #1
      0xe3a0c404, // mov r12, #0x04000000
      0xe28ccc02, // add r12, r12, #0x200
      0xe1cc00b2, // strh r0, [r12, #2]    ; IF = VBlank: acknowledge
      0xe3a01403, // mov r1, #0x03000000
      0xe2811c7f, // add r1, r1, #0x7f00
      0xe1d12fb8, // ldrh r2, [r1, #0xf8]  ; BIOS_IF at 3007FF8h
      0xe3822001, // orr r2, r2, #1
      0xe1c12fb8, // strh r2, [r1, #0xf8]
      0xe3a01403, // mov r1, #0x03000000
      0xe5912100, // ldr r2, [r1, #0x100]  ; count the handler's own invocations
      0xe2822001, // add r2, r2, #1
      0xe5812100, // str r2, [r1, #0x100]
      0xe1a0f00e, // mov pc, lr
    ];
    for (let i = 0; i < code.length; i++) core.mmu.write32(handler + i * 4, code[i]!);
    core.mmu.write32(0x03007ffc, handler);
    core.mmu.write16(0x04000004, 0x0008); // DISPSTAT: VBlank IRQ enable
    core.mmu.write16(0x04000200, 0x0001); // IE = VBlank

    // One frame is ~280k cycles, and a halted CPU advances one cycle per step.
    let steps = 0;
    while (core.cpu.regs.r[6] !== 0x77 && steps < 2_000_000) {
      core.stepInstruction();
      steps++;
    }

    expect(core.cpu.regs.r[6]).toBe(0x77); // the wait ended and the caller resumed
    // It must have WAITED. Returning straight away would also set r6, so the test insists
    // the interrupt handler ran and that a frame's worth of time went by first.
    expect(core.mmu.read32(0x03000100)).toBeGreaterThanOrEqual(1);
    expect(steps).toBeGreaterThan(10_000);
    expect(core.cpu.halted).toBe(false);
    expect(core.mmu.read16(0x03007ff8) & 1).toBe(0); // the flag it waited on was consumed
    expect(core.cpu.regs.mode).toBe(0x1f); // back in the caller's mode, not Supervisor
  });
});

describe('BIOS read protection (GBATEK, "Reading from BIOS Memory")', () => {
  it('reports the startup value before anything else has happened', () => {
    // The four observable values are what jsmolka/gba-tests bios.gba (MIT) asserts.
    const core = coreRunning([BRANCH_SELF]);
    expect(core.mmu.read32(0) >>> 0).toBe(0xe129f000);
  });

  it('changes to the after-SWI value once a SWI has run', () => {
    const core = coreRunning([movImm(0, 4), swi(0x08), BRANCH_SELF]);
    for (let i = 0; i < 8; i++) core.stepInstruction();
    expect(core.mmu.read32(0) >>> 0).toBe(0xe3a02004);
  });
});

describe('the BIOS interrupt handler', () => {
  it('pushes r0-r3/r12/lr, calls [3007FFCh] with lr = 138h, and returns', () => {
    // GBATEK, "BIOS Interrupt handling", gives the handler instruction by instruction.
    // The user handler here stores lr and the protected BIOS read, then returns.
    const handler = 0x03000000;
    const core = coreRunning([BRANCH_SELF]);

    // mov r0,#0 / ldr r1,[r0] / str r1,[r0,#0x100]... hand-encoded in IWRAM:
    const code = [
      0xe3a00000, // mov r0, #0
      0xe5901000, // ldr r1, [r0]        ; the "during IRQ" BIOS value
      0xe3a02403, // mov r2, #0x03000000
      0xe5821040, // str r1, [r2, #0x40]
      0xe582e044, // str lr, [r2, #0x44]
      0xe3a03001, // mov r3, #1
      0xe3a0c404, // mov r12, #0x04000000
      0xe28ccc02, // add r12, r12, #0x200
      0xe1cc30b2, // strh r3, [r12, #2]   ; IF = VBlank: acknowledge
      0xe1a0f00e, // mov pc, lr
    ];
    for (let i = 0; i < code.length; i++) core.mmu.write32(handler + i * 4, code[i]!);
    core.mmu.write32(0x03007ffc, handler);

    core.mmu.write16(0x04000200, 0x0001); // IE = VBlank
    core.mmu.write16(0x04000208, 1); // IME = 1
    const spBefore = core.cpu.regs.r[13]!;
    core.mmu.requestInterrupt(0x0001);
    for (let i = 0; i < 40; i++) core.stepInstruction();

    expect(core.mmu.read32(0x03000040) >>> 0).toBe(0xe25ef004); // read during the IRQ
    expect(core.mmu.read32(0x03000044) >>> 0).toBe(0x00000138); // lr given to the handler
    expect(core.mmu.read32(0) >>> 0).toBe(0xe55ec002); // read after the IRQ
    expect(core.cpu.regs.r[13]).toBe(spBefore); // back in the caller's bank, unchanged
    expect(core.cpu.regs.r[15]! - 8).toBe(0x08000000); // returned to the interrupted code
  });
});
