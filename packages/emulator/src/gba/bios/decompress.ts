import type { BiosMemory } from './BiosMemory.js';

/**
 * The BIOS decompression calls. Source: GBATEK, "BIOS Decompression Functions"
 * (SWI 10h BitUnPack, 11h/12h LZ77UnComp Wram/Vram, 13h HuffUnComp, 14h/15h RLUnComp
 * Wram/Vram, 16h/17h/18h Diff8bit/Diff16bit UnFilter).
 *
 * The "Vram" variants exist because VRAM ignores 8-bit writes. GBATEK: *"The Wram function
 * is faster, and writes in units of 8bits. For the Vram function the destination must be
 * halfword aligned, data is written in units of 16bits."* Getting that wrong is invisible
 * in WRAM and silently blanks every tile a game decompresses straight into VRAM, so the
 * two variants share one byte sink that knows which width it is writing.
 */

/**
 * The output side of every decompressor: takes bytes, emits 8- or 16-bit writes.
 *
 * One reused module-level instance. SWIs are synchronous and never re-enter, and the
 * charter bans allocation on paths a game hits with real workloads.
 */
class ByteSink {
  private mem: BiosMemory | null = null;
  /** Address the next byte goes to. */
  address = 0;
  private halfword = false;
  /** The low byte of a halfword that has been written to, but not yet flushed. */
  private pending = 0;
  private hasPending = false;

  start(mem: BiosMemory, address: number, halfword: boolean): void {
    this.mem = mem;
    this.address = address >>> 0;
    this.halfword = halfword;
    this.pending = 0;
    this.hasPending = false;
  }

  put(byte: number): void {
    const value = byte & 0xff;
    if (!this.halfword) {
      this.mem!.write8(this.address, value);
      this.address = (this.address + 1) >>> 0;
      return;
    }
    if (!this.hasPending) {
      this.pending = value;
      this.hasPending = true;
    } else {
      this.mem!.write16((this.address - 1) >>> 0, this.pending | (value << 8));
      this.hasPending = false;
    }
    this.address = (this.address + 1) >>> 0;
  }

  /**
   * Reads back an already-produced byte, for an LZ77 back-reference.
   *
   * In halfword mode the most recent byte may still be sitting in the pending half rather
   * than in memory — a back-reference of disp=0 reads it, and reading memory would return
   * stale data.
   */
  get(address: number): number {
    const addr = address >>> 0;
    if (this.halfword && this.hasPending && addr === (this.address - 1) >>> 0) {
      return this.pending;
    }
    return this.mem!.read8(addr);
  }

  /** Writes out an odd trailing byte; the high half is zero, as a 16-bit write must be. */
  finish(): void {
    if (this.halfword && this.hasPending) {
      this.mem!.write16((this.address - 1) >>> 0, this.pending);
      this.hasPending = false;
    }
    this.mem = null;
  }
}

const sink = new ByteSink();

/**
 * SWI 11h / 12h — LZ77UnComp, Wram (8-bit writes) and Vram (16-bit writes) variants.
 *
 * GBATEK: header bit 8-31 is the decompressed size; each flag byte covers eight blocks,
 * MSB first; *"Block Type 1 - Compressed - Copy N+3 Bytes from Dest-Disp-1 to Dest"* with
 * the displacement's MSBs in bits 0-3 of the first block byte.
 */
export function lz77UnComp(
  mem: BiosMemory,
  source: number,
  destination: number,
  halfword: boolean,
): void {
  let src = source >>> 0;
  let remaining = mem.read32(src) >>> 8;
  src = (src + 4) >>> 0;
  sink.start(mem, destination, halfword);

  while (remaining > 0) {
    const flags = mem.read8(src);
    src = (src + 1) >>> 0;
    for (let bit = 7; bit >= 0 && remaining > 0; bit--) {
      if (((flags >>> bit) & 1) === 0) {
        sink.put(mem.read8(src));
        src = (src + 1) >>> 0;
        remaining--;
        continue;
      }
      const first = mem.read8(src);
      const second = mem.read8((src + 1) >>> 0);
      src = (src + 2) >>> 0;
      const length = (first >>> 4) + 3;
      const back = (((first & 0xf) << 8) | second) + 1;
      for (let i = 0; i < length && remaining > 0; i++) {
        sink.put(sink.get((sink.address - back) >>> 0));
        remaining--;
      }
    }
  }
  sink.finish();
}

/**
 * SWI 14h / 15h — RLUnComp, Wram and Vram variants.
 *
 * GBATEK: flag bit 7 selects compressed, bits 0-6 hold the length as *"uncompressed N-1,
 * compressed N-3"*.
 */
export function rlUnComp(
  mem: BiosMemory,
  source: number,
  destination: number,
  halfword: boolean,
): void {
  let src = source >>> 0;
  let remaining = mem.read32(src) >>> 8;
  src = (src + 4) >>> 0;
  sink.start(mem, destination, halfword);

  while (remaining > 0) {
    const flag = mem.read8(src);
    src = (src + 1) >>> 0;
    if ((flag & 0x80) !== 0) {
      const length = (flag & 0x7f) + 3;
      const byte = mem.read8(src);
      src = (src + 1) >>> 0;
      for (let i = 0; i < length && remaining > 0; i++, remaining--) sink.put(byte);
    } else {
      const length = (flag & 0x7f) + 1;
      for (let i = 0; i < length && remaining > 0; i++, remaining--) {
        sink.put(mem.read8(src));
        src = (src + 1) >>> 0;
      }
    }
  }
  sink.finish();
}

/**
 * SWI 13h — HuffUnCompReadNormal.
 *
 * GBATEK: header bits 0-3 are the data unit size in bits (normally 4 or 8); the tree size
 * byte holds *"Size of Tree Table/2-1 (ie. Offset to Compressed Bitstream)"*; a non-data
 * node's bits 0-5 are an offset such that *"Next child node0 is at (CurrentAddr AND NOT
 * 1)+Offset*2+2"*, with bit 7 flagging node0 as data and bit 6 node1; and the bitstream is
 * read in 32-bit units with bit 31 first.
 *
 * Output is written in 32-bit units — which is why there is no separate Vram variant.
 */
export function huffUnComp(mem: BiosMemory, source: number, destination: number): void {
  const src = source >>> 0;
  const header = mem.read32(src);
  const unitBits = header & 0xf;
  let remaining = header >>> 8;

  const treeSize = mem.read8((src + 4) >>> 0);
  const root = (src + 5) >>> 0;
  let stream = (src + 4 + (treeSize + 1) * 2) >>> 0;

  let dst = destination >>> 0;
  let out = 0;
  let outBits = 0;
  let word = 0;
  let wordBits = 0;
  let node = mem.read8(root);
  let nodeAddress = root;

  while (remaining > 0) {
    if (wordBits === 0) {
      word = mem.read32(stream);
      stream = (stream + 4) >>> 0;
      wordBits = 32;
    }
    const bit = (word >>> 31) & 1;
    word = (word << 1) >>> 0;
    wordBits--;

    const child = ((nodeAddress & ~1) + (node & 0x3f) * 2 + 2 + bit) >>> 0;
    const isData = (node & (bit !== 0 ? 0x40 : 0x80)) !== 0;
    const childNode = mem.read8(child);

    if (!isData) {
      node = childNode;
      nodeAddress = child;
      continue;
    }

    out |= (childNode & ((1 << unitBits) - 1)) << outBits;
    outBits += unitBits;
    if (outBits === 32) {
      mem.write32(dst, out >>> 0);
      dst = (dst + 4) >>> 0;
      remaining = remaining > 4 ? remaining - 4 : 0;
      out = 0;
      outBits = 0;
    }
    node = mem.read8(root);
    nodeAddress = root;
  }

  // A decompressed size that is not a multiple of four leaves a partial word. The BIOS
  // writes 32-bit units throughout, so the tail goes out as one too.
  if (outBits !== 0) mem.write32(dst, out >>> 0);
}

/**
 * SWI 10h — BitUnPack.
 *
 * GBATEK: the info block is *"16bit Length of Source Data in bytes / 8bit Width of Source
 * Units in bits / 8bit Width of Destination Units in bits / 32bit Data Offset (Bit 0-30),
 * and Zero Data Flag (Bit 31)"*, and *"The Data Offset is always added to all non-zero
 * source units. If the Zero Data Flag was set, it is also added to zero units."* Output is
 * written in 32-bit units.
 */
export function bitUnPack(
  mem: BiosMemory,
  source: number,
  destination: number,
  info: number,
): void {
  let src = source >>> 0;
  let dst = destination >>> 0;
  const length = mem.read16(info);
  const sourceWidth = mem.read8((info + 2) >>> 0);
  const destWidth = mem.read8((info + 3) >>> 0);
  const control = mem.read32((info + 4) >>> 0);
  const offset = control & 0x7fffffff;
  const offsetZero = control >>> 31 !== 0;

  if (sourceWidth === 0 || destWidth === 0) return;
  const sourceMask = (1 << sourceWidth) - 1;

  let out = 0;
  let outBits = 0;
  for (let i = 0; i < length; i++) {
    const byte = mem.read8(src);
    src = (src + 1) >>> 0;
    for (let shift = 0; shift < 8; shift += sourceWidth) {
      const unit = (byte >>> shift) & sourceMask;
      let value = unit;
      if (unit !== 0 || offsetZero) value = (value + offset) >>> 0;
      out = (out | (value << outBits)) >>> 0;
      outBits += destWidth;
      if (outBits >= 32) {
        mem.write32(dst, out >>> 0);
        dst = (dst + 4) >>> 0;
        out = 0;
        outBits = 0;
      }
    }
  }
  if (outBits !== 0) mem.write32(dst, out >>> 0);
}

/**
 * SWI 16h / 17h / 18h — Diff8bitUnFilter (Wram and Vram) and Diff16bitUnFilter.
 *
 * GBATEK: the stream is a first value followed by differences, and the header's bits 8-31
 * hold the size after decompression in bytes.
 */
export function diffUnFilter(
  mem: BiosMemory,
  source: number,
  destination: number,
  unitBytes: 1 | 2,
  halfword: boolean,
): void {
  let src = source >>> 0;
  let remaining = mem.read32(src) >>> 8;
  src = (src + 4) >>> 0;

  if (unitBytes === 1) {
    sink.start(mem, destination, halfword);
    let sum = 0;
    while (remaining > 0) {
      sum = (sum + mem.read8(src)) & 0xff;
      src = (src + 1) >>> 0;
      sink.put(sum);
      remaining--;
    }
    sink.finish();
    return;
  }

  // 16-bit units are always written as halfwords; there is no 8-bit variant to get wrong.
  let dst = destination >>> 0;
  let sum = 0;
  while (remaining > 1) {
    sum = (sum + mem.read16(src)) & 0xffff;
    src = (src + 2) >>> 0;
    mem.write16(dst, sum);
    dst = (dst + 2) >>> 0;
    remaining -= 2;
  }
}
