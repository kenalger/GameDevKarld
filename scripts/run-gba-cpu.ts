/**
 * Runs the jsmolka/gba-tests suites against the real GBA bus — the Phase 12/13 gate.
 *
 * TWO KINDS OF ROM, TWO KINDS OF VERDICT. Most of these are built on jsmolka's test
 * framework: they run numbered assertions and print "All tests passed" or "Failed test
 * NNN" in BG mode 4, and the verdict is read off the rendered screen rather than from a
 * register — see tests/harness/gbaRunner.ts for why reading R12 silently reports PASS for
 * a broken CPU. `shades` and `stripes` are not. They live in jsmolka's `ppu/` directory, have
 * no assertions and print nothing at all; they draw a picture and halt. Their verdict is a
 * full-framebuffer diff against a reference derived from their assembly.
 *
 * Usage: npm run gba-cpu [-- arm|thumb|memory|none|sram|flash64|flash128|shades|stripes|bios]
 */
import { existsSync } from 'node:fs';
import {
  runGbaTest,
  runGbaVisualTest,
  shadesReference,
  stripesReference,
} from '../tests/harness/gbaRunner.js';

const ROOT = new URL('../tests/roms/gba-tests/', import.meta.url).pathname;
const filter = process.argv.slice(2).filter((a) => a !== '--');

/**
 * A framework ROM reads its result line; an image ROM supplies the frame it must produce.
 */
type Suite =
  | { readonly name: string; readonly reference?: undefined }
  | { readonly name: string; readonly reference: () => Uint8ClampedArray };

const SUITES: readonly Suite[] = (
  [
    { name: 'arm' },
    { name: 'thumb' },
    { name: 'memory' },
    { name: 'none' },
    { name: 'sram' },
    { name: 'flash64' },
    { name: 'flash128' },
    { name: 'shades', reference: shadesReference },
    { name: 'stripes', reference: stripesReference },
    { name: 'bios' },
  ] as const satisfies readonly Suite[]
).filter((s) => filter.length === 0 || filter.includes(s.name));

if (!existsSync(ROOT)) {
  console.error('error: tests/roms/gba-tests/ missing. Run `npm run fetch-gba-tests`.');
  process.exit(1);
}

let failures = 0;
for (const suite of SUITES) {
  const rom = `${ROOT}${suite.name}.gba`;
  const result = suite.reference ? runGbaVisualTest(rom, suite.reference()) : runGbaTest(rom);

  if (result.passed) {
    const detail = suite.reference ? result.text : 'all tests passed';
    console.log(`  ✅ ${suite.name}.gba — ${detail}`);
  } else {
    failures++;
    const detail = suite.reference ? result.text : `failed\n${result.text}`;
    console.log(`  ❌ ${suite.name}.gba — ${detail}`);
  }
}

console.log(`\nGBA: ${SUITES.length - failures} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
