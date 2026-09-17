/**
 * Screenshot tests — the Phase 04 exit gate.
 *
 * Runs a ROM for N frames and compares the framebuffer to the reference PNG shipped with
 * the test, reporting a differing-pixel COUNT and BOUNDING BOX. "Looks wrong" is not a
 * result anyone can act on.
 *
 * Usage: npm run screenshots [-- <substring>]
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { GameBoyCore } from '../packages/emulator/src/gb/GameBoyCore.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../packages/emulator/src/gb/ppu/Ppu.js';
import { PALETTE_GREY } from '../packages/emulator/src/gb/ppu/palette.js';
import { decodePng } from '../tests/harness/png.js';
import { diffFrameBuffers } from '../tests/harness/conditions/screenshot.js';

const ROOT = new URL('../tests/roms/', import.meta.url).pathname;
const OUT = new URL('../tests/screenshots/', import.meta.url).pathname;

interface Case {
  readonly name: string;
  readonly rom: string;
  readonly reference: string;
  readonly frames: number;
  /** DMG references are rendered in the standard greyscale panel. */
  readonly greyscale: boolean;
}

const CASES: readonly Case[] = [
  {
    name: 'dmg-acid2',
    rom: 'dmg-acid2/dmg-acid2.gb',
    reference: 'dmg-acid2/dmg-acid2-dmg.png',
    frames: 60,
    greyscale: true,
  },
  {
    // CGB output is true colour, so it is compared as-is rather than through a palette.
    name: 'cgb-acid2',
    rom: 'cgb-acid2/cgb-acid2.gbc',
    reference: 'cgb-acid2/cgb-acid2.png',
    frames: 60,
    greyscale: false,
  },
  {
    name: 'cgb-acid-hell',
    rom: 'cgb-acid-hell/cgb-acid-hell.gbc',
    reference: 'cgb-acid-hell/cgb-acid-hell.png',
    frames: 60,
    greyscale: false,
  },
];

/**
 * Mealybug Tearoom: 24 mid-scanline PPU tests, discovered rather than listed.
 *
 * These are screenshot tests and nothing else — they carry no Mooneye register signature,
 * so the accuracy scoreboard was reporting all 32 as "timeout", which reads like a hang
 * and told nobody anything. Each ROM here has a `<name>_dmg_blob.png` reference beside it;
 * the eight without one are CGB-only and are not run.
 */
function mealybugCases(): Case[] {
  const dir = ROOT + 'mealybug-tearoom-tests/ppu/';
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.gb'))
    .map((f) => f.replace(/\.gb$/, ''))
    .filter((name) => existsSync(`${dir}${name}_dmg_blob.png`))
    .sort()
    .map((name) => ({
      name: `mealybug/${name}`,
      rom: `mealybug-tearoom-tests/ppu/${name}.gb`,
      reference: `mealybug-tearoom-tests/ppu/${name}_dmg_blob.png`,
      frames: 30,
      greyscale: true,
    }));
}

const filter = process.argv.slice(2).filter((a) => a !== '--');
let pass = 0;
let fail = 0;

const mealybug = mealybugCases();
let mealybugPass = 0;
let mealybugFail = 0;

for (const testCase of [...CASES, ...mealybug]) {
  const isMealybug = testCase.name.startsWith('mealybug/');
  if (filter.length > 0 && !filter.some((f) => testCase.name.includes(f))) continue;

  const romPath = ROOT + testCase.rom;
  const refPath = ROOT + testCase.reference;
  if (!existsSync(romPath) || !existsSync(refPath)) {
    console.log(`  ⚪ ${testCase.name} — ROM or reference missing`);
    continue;
  }

  const core = new GameBoyCore();
  // Reference screenshots use the standard greyscale panel (255/170/85/0). The green DMG
  // palette is a display choice, not emulation state, so compare in the references' palette.
  if (testCase.greyscale) core.ppu.palette = PALETTE_GREY;
  core.loadRom(new Uint8Array(readFileSync(romPath)));
  for (let f = 0; f < testCase.frames; f++) core.runFrame();

  const expected = decodePng(readFileSync(refPath));
  if (expected.width !== SCREEN_WIDTH || expected.height !== SCREEN_HEIGHT) {
    console.log(`  ❌ ${testCase.name} — reference is ${expected.width}x${expected.height}`);
    fail++;
    continue;
  }

  const actual = core.getFrameBuffer();
  const diff = diffFrameBuffers(actual, expected.rgba, SCREEN_WIDTH, SCREEN_HEIGHT);

  if (diff.differing === 0) {
    if (isMealybug) mealybugPass++;
    else pass++;
    if (!isMealybug || filter.length > 0) console.log(`  ✅ ${testCase.name} — pixel-exact`);
    continue;
  }

  {
    if (isMealybug) mealybugFail++;
    else fail++;
    const b = diff.bounds!;
    if (!isMealybug || filter.length > 0) {
      console.log(
        `  ❌ ${testCase.name} — ${diff.differing}/${diff.total} pixels differ, ` +
          `bounds x=${b.minX}..${b.maxX} y=${b.minY}..${b.maxY}`,
      );
    }
    if (isMealybug) continue;
    try {
      writeFileSync(OUT + `${testCase.name}-actual.txt`, renderAscii(actual));
      writeFileSync(OUT + `${testCase.name}-expected.txt`, renderAscii(expected.rgba));
      console.log(`     wrote ASCII dumps to tests/screenshots/`);
    } catch {
      /* directory may not exist; the diff numbers are the important part */
    }
  }
}

/** Coarse ASCII view, for eyeballing a failure without opening an image. */
function renderAscii(rgba: Uint8ClampedArray | Uint8Array): string {
  const shades = ' .:#';
  let out = '';
  for (let y = 0; y < SCREEN_HEIGHT; y++) {
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const i = (y * SCREEN_WIDTH + x) * 4;
      const luma = (rgba[i]! * 2 + rgba[i + 1]! * 5 + rgba[i + 2]!) / 8;
      out += shades[Math.min(3, 3 - Math.floor((luma / 256) * 4))] ?? ' ';
    }
    out += '\n';
  }
  return out;
}

// One combined final line, because the compatibility sweep reads the last summary it
// finds — a second trailing line would silently replace the acid2 verdict with this one.
const mealybugSummary = mealybug.length > 0 ? ` · Mealybug ${mealybugPass}/${mealybug.length}` : '';
console.log(`\nScreenshots: ${pass} passed, ${fail} failed${mealybugSummary}`);
// Mealybug is reported, not gated: it measures behaviour this PPU does not claim yet.
process.exit(fail === 0 ? 0 : 1);
