import type { BiosMemory } from './BiosMemory.js';

/**
 * SWI 0Bh CpuSet and SWI 0Ch CpuFastSet. Source: GBATEK, "BIOS Memory Copy".
 *
 * Both take their length in *units*, not bytes, and both encode fill-versus-copy in bit 24
 * of the same register as the length. CpuSet additionally picks the unit width with bit 26
 * (0 = 16-bit, 1 = 32-bit); CpuFastSet is 32-bit only and rounds the count up.
 */

/** GBATEK: *"Bit 0-20 Wordcount"*. */
const COUNT_MASK = 0x1fffff;
/** GBATEK: *"Bit 24 Fixed Source Address (0=Copy, 1=Fill by WORD[r0])"*. */
const FIXED_SOURCE = 1 << 24;
/** GBATEK: *"Bit 26 Datasize (0=16bit, 1=32bit)"*. */
const DATASIZE_32 = 1 << 26;

/**
 * Is this address inside the BIOS?
 *
 * GBATEK: *"On GBA, NDS7 and DSi7, these two functions will silently reject to do anything
 * if the source start or end addresses are reaching into the BIOS area."* Reproducing the
 * refusal matters: it is how the read protection stays airtight.
 */
function inBios(address: number): boolean {
  return address >>> 0 < 0x4000;
}

/** SWI 0Bh CpuSet — copy or fill, in 16- or 32-bit units. */
export function cpuSet(
  mem: BiosMemory,
  source: number,
  destination: number,
  control: number,
): void {
  const count = control & COUNT_MASK;
  const fixed = (control & FIXED_SOURCE) !== 0;
  const words = (control & DATASIZE_32) !== 0;
  const unit = words ? 4 : 2;

  let src = source >>> 0;
  const dst = destination >>> 0;
  if (count === 0 || inBios(src) || inBios((src + count * unit - 1) >>> 0)) return;

  if (words) {
    const fill = fixed ? mem.read32(src) : 0;
    for (let i = 0; i < count; i++) {
      mem.write32((dst + i * 4) >>> 0, fixed ? fill : mem.read32(src));
      if (!fixed) src = (src + 4) >>> 0;
    }
    return;
  }

  const fill = fixed ? mem.read16(src) : 0;
  for (let i = 0; i < count; i++) {
    mem.write16((dst + i * 2) >>> 0, fixed ? fill : mem.read16(src));
    if (!fixed) src = (src + 2) >>> 0;
  }
}

/**
 * SWI 0Ch CpuFastSet — copy or fill in 32-byte blocks.
 *
 * GBATEK: *"On the GBA, the length should be a multiple of 8 words (32 bytes) (otherwise
 * the GBA is forcefully rounding-up the length)"*, because the routine is built out of
 * `LDMIA/STMIA [Rb]!,r2-r9`. A count of 9 words therefore moves 16.
 */
export function cpuFastSet(
  mem: BiosMemory,
  source: number,
  destination: number,
  control: number,
): void {
  const count = (control & COUNT_MASK & ~7) + ((control & COUNT_MASK & 7) !== 0 ? 8 : 0);
  const fixed = (control & FIXED_SOURCE) !== 0;

  let src = source >>> 0;
  const dst = destination >>> 0;
  if (count === 0 || inBios(src) || inBios((src + count * 4 - 1) >>> 0)) return;

  const fill = fixed ? mem.read32(src) : 0;
  for (let i = 0; i < count; i++) {
    mem.write32((dst + i * 4) >>> 0, fixed ? fill : mem.read32(src));
    if (!fixed) src = (src + 4) >>> 0;
  }
}
