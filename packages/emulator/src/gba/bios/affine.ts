import type { BiosMemory } from './BiosMemory.js';
import { s16 } from './BiosMemory.js';

/**
 * The BIOS rotation/scaling calls: SWI 0Eh BgAffineSet and SWI 0Fh ObjAffineSet.
 *
 * Structure layouts, field widths and the offset/stride rules come from GBATEK, "BIOS
 * Rotation/Scaling Functions". GBATEK documents the *fields* but not the arithmetic, so
 * the matrix itself is taken from Tonc, "BIOS Calls" (swi.html), which gives
 *
 *     P = | sx*cos(a)   -sx*sin(a) |
 *         | sy*sin(a)    sy*cos(a) |
 *
 * and from Tonc, "Affine backgrounds" (affbg.html), whose `bg_rotscale_ex` listing gives
 * both the fixed-point form — `pa = sx*cosa>>12` — and the start coordinates:
 *
 *     dx = tex_x - (pa*scr_x + pb*scr_y)
 *     dy = tex_y - (pc*scr_x + pd*scr_y)
 */

/**
 * Sine in .12 fixed point, 256 steps to the turn.
 *
 * GBATEK: *"Rotation angles are specified as 0-FFFFh (covering a range of 360 degrees),
 * however, the GBA BIOS recurses only the upper 8bit"* — so 256 entries is not a
 * simplification, it is the hardware's resolution. Built once at module load; the SWI path
 * only indexes it.
 */
const SIN_12 = new Int32Array(256);
for (let i = 0; i < 256; i++) SIN_12[i] = Math.round(Math.sin((i * 2 * Math.PI) / 256) * 0x1000);

/** Cosine is the sine table a quarter turn along. */
function cos12(angle: number): number {
  return SIN_12[(angle + 64) & 0xff]!;
}

function sin12(angle: number): number {
  return SIN_12[angle & 0xff]!;
}

/**
 * SWI 0Fh ObjAffineSet.
 *
 * Source entries are 6 bytes (s16 sx, s16 sy, u16 angle). The four results are written
 * `offset` bytes apart — GBATEK: *"If the Offset value is 2, the parameters are stored
 * contiguously. If the value is 8, they match the structure of OAM"* — so one entry spans
 * four offsets in the destination.
 */
export function objAffineSet(
  mem: BiosMemory,
  source: number,
  destination: number,
  count: number,
  offset: number,
): void {
  let src = source >>> 0;
  let dst = destination >>> 0;
  for (let i = 0; i < count; i++) {
    const sx = s16(mem.read16(src));
    const sy = s16(mem.read16(src + 2));
    const angle = (mem.read16(src + 4) >>> 8) & 0xff;
    src = (src + 6) >>> 0;

    const cos = cos12(angle);
    const sin = sin12(angle);
    mem.write16(dst, ((sx * cos) >> 12) & 0xffff);
    mem.write16((dst + offset) >>> 0, ((-sx * sin) >> 12) & 0xffff);
    mem.write16((dst + 2 * offset) >>> 0, ((sy * sin) >> 12) & 0xffff);
    mem.write16((dst + 3 * offset) >>> 0, ((sy * cos) >> 12) & 0xffff);
    dst = (dst + 4 * offset) >>> 0;
  }
}

/**
 * SWI 0Eh BgAffineSet.
 *
 * Source entries are 20 bytes: s32 centre X, s32 centre Y, s16 display X, s16 display Y,
 * s16 scale X, s16 scale Y, u16 angle — 18 bytes of fields in a struct the compiler aligns
 * to 4. Destination entries are 16: s16 pa, pb, pc, pd then s32 start X, start Y.
 */
export function bgAffineSet(
  mem: BiosMemory,
  source: number,
  destination: number,
  count: number,
): void {
  let src = source >>> 0;
  let dst = destination >>> 0;
  for (let i = 0; i < count; i++) {
    const centreX = mem.read32(src) | 0;
    const centreY = mem.read32(src + 4) | 0;
    const displayX = s16(mem.read16(src + 8));
    const displayY = s16(mem.read16(src + 10));
    const sx = s16(mem.read16(src + 12));
    const sy = s16(mem.read16(src + 14));
    const angle = (mem.read16(src + 16) >>> 8) & 0xff;
    src = (src + 20) >>> 0;

    const cos = cos12(angle);
    const sin = sin12(angle);
    // The written matrix is s16, and the start coordinates are computed from the written
    // (truncated) values, not from the full-precision products.
    const pa = (((sx * cos) >> 12) << 16) >> 16;
    const pb = (((-sx * sin) >> 12) << 16) >> 16;
    const pc = (((sy * sin) >> 12) << 16) >> 16;
    const pd = (((sy * cos) >> 12) << 16) >> 16;

    mem.write16(dst, pa & 0xffff);
    mem.write16((dst + 2) >>> 0, pb & 0xffff);
    mem.write16((dst + 4) >>> 0, pc & 0xffff);
    mem.write16((dst + 6) >>> 0, pd & 0xffff);
    mem.write32((dst + 8) >>> 0, (centreX - (pa * displayX + pb * displayY)) >>> 0);
    mem.write32((dst + 12) >>> 0, (centreY - (pc * displayX + pd * displayY)) >>> 0);
    dst = (dst + 16) >>> 0;
  }
}
