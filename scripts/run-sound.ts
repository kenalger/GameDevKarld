/**
 * Runs the Blargg sound suites — the Phase 07 exit gate.
 *
 * Usage: npm run sound [-- <substring>]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GameBoyCore } from '../packages/emulator/src/gb/GameBoyCore.js';

const ROOT = new URL('../tests/roms/', import.meta.url).pathname;
const SUITES: readonly (readonly [string, string])[] = [
  ['blargg/dmg_sound', 'blargg/dmg_sound/rom_singles'],
  ['blargg/cgb_sound', 'blargg/cgb_sound/rom_singles'],
];
const MAX_FRAMES = 2500;
const filter = process.argv.slice(2).filter((a) => a !== '--');

let pass = 0;
let fail = 0;

for (const [suite, dir] of SUITES) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) continue;
  const roms = readdirSync(full)
    .filter((f) => /\.gbc?$/i.test(f))
    .filter((f) => filter.length === 0 || filter.some((s) => f.includes(s)))
    .sort();

  console.log(`\n${suite}`);
  for (const rom of roms) {
    const core = new GameBoyCore();
    core.loadRom(new Uint8Array(readFileSync(join(full, rom))));

    let verdict: 'pass' | 'fail' | 'timeout' = 'timeout';
    let report = '';
    for (let f = 0; f < MAX_FRAMES; f++) {
      core.runFrame();

      const serial = core.serial.text;
      if (serial.includes('Passed')) {
        verdict = 'pass';
        report = serial;
        break;
      }
      if (serial.includes('Failed')) {
        verdict = 'fail';
        report = serial;
        break;
      }

      // Several sound ROMs report only through the 0xA000 memory protocol.
      if (
        core.mmu.read(0xa001) === 0xde &&
        core.mmu.read(0xa002) === 0xb0 &&
        core.mmu.read(0xa003) === 0x61
      ) {
        const status = core.mmu.read(0xa000);
        if (status !== 0x80) {
          let text = '';
          for (let i = 0; i < 256; i++) {
            const byte = core.mmu.read(0xa004 + i);
            if (byte === 0) break;
            text += String.fromCharCode(byte);
          }
          verdict = status === 0x00 ? 'pass' : 'fail';
          report = text;
          break;
        }
      }
    }

    const name = rom.replace(/\.gbc?$/i, '');
    if (verdict === 'pass') {
      pass++;
      console.log(`  ✅ ${name}`);
    } else {
      fail++;
      console.log(`  ❌ ${name} (${verdict}) ${report.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    }
  }
}

console.log(`\nBlargg sound: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
