import { readFileSync } from 'node:fs';
import { GameBoyAdvanceCore } from '../../packages/emulator/src/gba/GameBoyAdvanceCore.js';
import { GBA_HEIGHT, GBA_WIDTH } from '../../packages/emulator/src/gba/video/GbaPpu.js';
import type { GbaMmu } from '../../packages/emulator/src/gba/memory/GbaMmu.js';
import { diffFrameBuffers } from './conditions/screenshot.js';

export interface GbaTestResult {
  readonly passed: boolean;
  /** The rendered result line, as recognised from the mode-4 framebuffer. */
  readonly text: string;
  readonly steps: number;
}

/**
 * Runs a jsmolka/gba-tests *framework* ROM and reads its verdict off the screen.
 *
 * ONLY THE FRAMEWORK ROMS. arm, thumb, memory, none, sram, flash64, flash128 and bios all
 * include `lib/text.asm`, run in BG mode 4 and print "All tests passed" or "Failed test
 * NNN". The ROMs under jsmolka's `ppu/` directory — hello, shades, stripes — are not built
 * on that framework at all: they set up a background, draw a picture and `b idle`, with no
 * text and no numbered assertions. Pointing this function at one of those reads the text
 * band of a mode-4 framebuffer that does not exist and always reports failure. Use
 * `runGbaVisualTest` for those.
 *
 * WHY THE SCREEN. The obvious approach — read R12 after the ROM halts — silently reports
 * PASS for everything, because `m_test_eval` pushes R0-R12 before evaluating and pops them
 * back before the final `b .`. A negative control (deliberately corrupting execution) proved
 * that reading R12 cannot distinguish pass from fail. These ROMs report on screen, so the
 * harness reads the screen.
 *
 * The check is deliberately coarse: the pass and fail texts differ in length and in their
 * first glyph, which is enough to tell them apart without a full OCR.
 */
export function runGbaTest(romPath: string, maxSteps = 20_000_000): GbaTestResult {
  // THE WHOLE MACHINE, not a CPU on a bus. An earlier version of this harness ran Arm7 +
  // GbaMmu with a stubbed SWI handler and a hand-toggled DISPSTAT VBlank bit, which meant
  // two of the four things bios.gba tests — the value a protected BIOS read returns after
  // a SWI, and after an interrupt — could not be exercised at all, and no interrupt could
  // ever fire. The core wires the native BIOS, the PPU and the interrupt path together,
  // so the ROM sees the same machine a player would.
  const core = new GameBoyAdvanceCore();
  core.loadRom(new Uint8Array(readFileSync(romPath)));
  const cpu = core.cpu;

  let steps = 0;
  for (; steps < maxSteps; steps++) {
    core.stepInstruction();
    // Both outcomes end in a tight `b .`; when PC stops moving, the ROM is done.
    if (steps % 5000 === 0) {
      const pc = cpu.regs.r[15]!;
      for (let k = 0; k < 4; k++) core.stepInstruction();
      if (cpu.regs.r[15] === pc) break;
    }
  }

  const text = renderResultLine(core.mmu);
  return { passed: isPassText(text), text, steps };
}

/** The framework draws its result line at y = 76..83. */
const TEXT_TOP = 70;
const TEXT_BOTTOM = 90;

/** Extracts the drawn glyphs from the mode-4 framebuffer as an ASCII bitmap. */
function renderResultLine(mmu: GbaMmu): string {
  const rows: string[] = [];
  // Full screen WIDTH so the message is never clipped (an earlier 160px crop truncated the
  // pass text), but only the text band vertically: memory.gba writes test patterns into the
  // top of VRAM, and those are data, not glyphs.
  for (let y = TEXT_TOP; y < TEXT_BOTTOM; y++) {
    let row = '';
    for (let x = 0; x < 240; x++) row += mmu.vram[y * 240 + x] !== 0 ? '#' : '.';
    if (row.includes('#')) rows.push(row);
  }
  return rows.join('\n');
}

/**
 * Distinguishes "All tests passed" from "Failed test NNN" by the rendered text's extent.
 *
 * The framework centres each message, so the two differ measurably and unambiguously:
 *
 *   pass  "All tests passed"  x = 57..182, width 126
 *   fail  "Failed test NNN"   x = 61..160, width 100
 *
 * Both measured from this emulator — the fail case by deliberately sabotaging execution.
 * That negative control is the point: an earlier version of this harness read R12 after the
 * halt and reported PASS even for a broken CPU, because `m_test_eval` pushes R0-R12 before
 * evaluating and pops them back before the final `b .`.
 */
const PASS_WIDTH = 126;
const WIDTH_TOLERANCE = 4;

function isPassText(text: string): boolean {
  const rows = text.split('\n').filter((row) => row.includes('#'));
  if (rows.length < 5) return false;

  let leftmost = Number.POSITIVE_INFINITY;
  let rightmost = -1;
  for (const row of rows) {
    const first = row.indexOf('#');
    if (first >= 0 && first < leftmost) leftmost = first;
    rightmost = Math.max(rightmost, row.lastIndexOf('#'));
  }
  if (rightmost < 0) return false;

  return Math.abs(rightmost - leftmost + 1 - PASS_WIDTH) <= WIDTH_TOLERANCE;
}

/* ------------------------------ visual verdicts ----------------------------- */

export interface GbaVisualResult {
  readonly passed: boolean;
  /** Differing-pixel count and bounding box, or "pixel-exact". */
  readonly text: string;
  readonly differing: number;
}

/**
 * Runs a ROM that reports by what it DRAWS, and diffs the whole framebuffer.
 *
 * jsmolka's `ppu/` ROMs carry no pass/fail text, so there is nothing to read — the only
 * honest verdict is a pixel comparison against a reference. The reference is derived from
 * the ROM's assembly plus GBATEK rather than captured from this emulator: a screenshot we
 * generated ourselves would pass by construction and could never catch the bug it exists
 * to catch.
 */
export function runGbaVisualTest(
  romPath: string,
  expected: Uint8ClampedArray,
  frames = 10,
): GbaVisualResult {
  const core = new GameBoyAdvanceCore();
  core.loadRom(new Uint8Array(readFileSync(romPath)));
  for (let f = 0; f < frames; f++) core.runFrame();

  const diff = diffFrameBuffers(core.getFrameBuffer(), expected, GBA_WIDTH, GBA_HEIGHT);
  if (diff.differing === 0) {
    return { passed: true, text: `pixel-exact over ${diff.total} pixels`, differing: 0 };
  }
  const b = diff.bounds!;
  return {
    passed: false,
    differing: diff.differing,
    text:
      `${diff.differing}/${diff.total} pixels differ, ` +
      `bounds x=${b.minX}..${b.maxX} y=${b.minY}..${b.maxY}`,
  };
}

/**
 * The expected frame for `ppu/stripes.gba`, derived from its source.
 *
 * stripes.asm (jsmolka/gba-tests, MIT) does exactly five things:
 *
 *   DISPCNT  = 1 shl 8   -> BG mode 0, BG0 enabled, forced blank off.
 *   BG0CNT   = 0x41 shl 2 = 0x104
 *              bits 0-1  priority 0
 *              bits 2-3  character base block 1 -> 0x06004000 (GBATEK: 16 KByte units)
 *              bit  7    0 -> 16/16 colours, i.e. 4bpp
 *              bits 8-12 screen base block 1    -> 0x06000800 (GBATEK: 2 KByte units)
 *   palette entry 0 = 0x560B, entry 1 = 0x6290 (BGR555).
 *   tile data: 32 bytes of 0x11 at 0x06004000 -> tile 0 is colour index 1 everywhere.
 *              Tile 1 (0x06004020) is never written and stays 0 = transparent.
 *   screen map: halfword 1 written every FOUR bytes from 0x06000800, so map entry 0 = 1,
 *              entry 1 = 0, entry 2 = 1 ... Per GBATEK's text-mode screen entry, bits 0-9
 *              are the tile number, so even entries select the BLANK tile 1 and odd
 *              entries the filled tile 0.
 *
 * The result is 8-pixel vertical stripes, starting at x=0 with the backdrop (palette entry
 * 0 shows wherever the BG pixel is transparent), uniform down all 160 lines because both
 * scroll registers stay 0 and the map repeats every two tiles.
 *
 * BGR555 -> RGB888 by the standard 5-bit replication, `c << 3 | c >> 2`:
 *   0x560B = R 11, G 16, B 21 -> ( 90, 132, 173)
 *   0x6290 = R 16, G 20, B 24 -> (132, 165, 198)
 * These are written out as literals on purpose. The expansion curve is a display choice,
 * not something GBATEK dictates, so if it ever changes this constant must be changed with
 * it as a deliberate act rather than silently tracking the renderer.
 */
export function stripesReference(): Uint8ClampedArray {
  const BACKDROP = [90, 132, 173];
  const STRIPE = [132, 165, 198];
  const rgba = new Uint8ClampedArray(GBA_WIDTH * GBA_HEIGHT * 4);
  for (let y = 0; y < GBA_HEIGHT; y++) {
    for (let x = 0; x < GBA_WIDTH; x++) {
      const colour = ((x >> 3) & 1) === 0 ? BACKDROP : STRIPE;
      const i = (y * GBA_WIDTH + x) * 4;
      rgba[i] = colour[0]!;
      rgba[i + 1] = colour[1]!;
      rgba[i + 2] = colour[2]!;
      rgba[i + 3] = 0xff;
    }
  }
  return rgba;
}

/**
 * The expected frame for `ppu/shades.gba`, derived from its source.
 *
 * shades.asm sets up the same mode-0 background as stripes (DISPCNT = 1 shl 8, BG0CNT =
 * 0x41 shl 2, so char base block 1 and screen base block 1, 4bpp) and then builds a ramp:
 *
 *   palette: 16 entries, `add r0, 2 shl 10` each time -> entry t is BGR555 t * 0x0800,
 *            i.e. red 0, green 0, blue = 2t.
 *   tiles:   16 tiles, tile t filled with the byte t * 0x11 -> both 4bpp nibbles are t, so
 *            every pixel of tile t is colour index t.
 *   map:     each row writes each tile index to TWO adjacent entries before incrementing,
 *            so tile t occupies columns 2t and 2t+1 — a 16-pixel band. All 32 rows match.
 *
 * 240 pixels / 16 = 15 visible bands, t = 0..14. Band 0 is colour index 0, which is
 * transparent, so it shows the backdrop — which is palette entry 0, also black, so the two
 * readings agree.
 *
 * Blue channel per band, BGR555 blue 2t expanded by `c << 3 | c >> 2`, computed by hand
 * for the same reason as `stripesReference`: the expansion curve is a display choice, not
 * something GBATEK dictates, so it must not silently track the renderer.
 */
const SHADE_BLUES = [0, 16, 33, 49, 66, 82, 99, 115, 132, 148, 165, 181, 198, 214, 231];

export function shadesReference(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(GBA_WIDTH * GBA_HEIGHT * 4);
  for (let y = 0; y < GBA_HEIGHT; y++) {
    for (let x = 0; x < GBA_WIDTH; x++) {
      const i = (y * GBA_WIDTH + x) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = SHADE_BLUES[x >> 4]!;
      rgba[i + 3] = 0xff;
    }
  }
  return rgba;
}
