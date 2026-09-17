import { readFileSync } from 'node:fs';
import { Arm7, VECTOR_SWI } from '../../packages/emulator/src/gba/cpu/Arm7.js';
import { GbaMmu } from '../../packages/emulator/src/gba/memory/GbaMmu.js';

export interface GbaTestResult {
  readonly passed: boolean;
  /** The rendered result line, as recognised from the mode-4 framebuffer. */
  readonly text: string;
  readonly steps: number;
}

/**
 * Runs a jsmolka/gba-tests ROM and reads its verdict off the screen.
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
  const mmu = new GbaMmu();
  mmu.reset();
  mmu.loadRom(new Uint8Array(readFileSync(romPath)));

  const cpu = new Arm7(mmu);
  cpu.reset();

  // A minimal BIOS: SWIs return immediately, except Div which these ROMs use to render
  // the failing test number.
  new DataView(mmu.bios.buffer).setUint32(VECTOR_SWI, 0xe1b0f00e, true);
  cpu.softwareInterrupt = () => {
    const r = cpu.regs.r;
    const a = r[0]! | 0;
    const b = r[1]! | 0;
    r[0] = (b === 0 ? 0 : Math.trunc(a / b)) >>> 0;
    r[1] = (b === 0 ? 0 : a % b) >>> 0;
    r[3] = Math.abs(r[0]! | 0) >>> 0;
  };

  // The framework spins on DISPSTAT's VBlank flag; with no PPU attached, toggle it so the
  // wait always terminates.
  let vblank = 0;
  const read16 = mmu.read16.bind(mmu);
  mmu.read16 = (address: number): number =>
    address >>> 0 === 0x04000004 ? (vblank ^= 1) : read16(address);

  let steps = 0;
  for (; steps < maxSteps; steps++) {
    cpu.step();
    // Both outcomes end in a tight `b .`; when PC stops moving, the ROM is done.
    if (steps % 5000 === 0) {
      const pc = cpu.regs.r[15]!;
      for (let k = 0; k < 4; k++) cpu.step();
      if (cpu.regs.r[15] === pc) break;
    }
  }

  const text = renderResultLine(mmu);
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
