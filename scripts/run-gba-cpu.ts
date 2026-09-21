/**
 * Runs the jsmolka/gba-tests suites against the real GBA bus — the Phase 12/13 gate.
 *
 * The verdict is read off the rendered screen, not from a register: see the comment in
 * tests/harness/gbaRunner.ts for why reading R12 silently reports PASS for a broken CPU.
 *
 * Usage: npm run gba-cpu [-- arm|thumb|memory|none|sram|flash64|flash128]
 */
import { existsSync } from 'node:fs';
import { runGbaTest } from '../tests/harness/gbaRunner.js';

const ROOT = new URL('../tests/roms/gba-tests/', import.meta.url).pathname;
const filter = process.argv.slice(2).filter((a) => a !== '--');
const SUITES = [
  'arm',
  'thumb',
  'memory',
  'none',
  'sram',
  'flash64',
  'flash128',
  'stripes',
  'bios',
].filter((s) => filter.length === 0 || filter.includes(s));

if (!existsSync(ROOT)) {
  console.error('error: tests/roms/gba-tests/ missing. Run `npm run fetch-gba-tests`.');
  process.exit(1);
}

let failures = 0;
for (const suite of SUITES) {
  const result = runGbaTest(`${ROOT}${suite}.gba`);
  if (result.passed) {
    console.log(`  ✅ ${suite}.gba — all tests passed`);
  } else {
    failures++;
    console.log(`  ❌ ${suite}.gba — failed\n${result.text}`);
  }
}

console.log(`\nGBA: ${SUITES.length - failures} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
