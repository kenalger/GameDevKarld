/**
 * Runs the Blargg suites — the Phase 02/03 exit gates.
 *
 * Results arrive on one of two channels, and several ROMs use only the second:
 *   1. Serial (0xFF01/0xFF02) — prints the failing sub-test by name.
 *   2. Memory at 0xA000, behind the signature 0xDE 0xB0 0x61, status byte at 0xA000
 *      (0x80 = running, 0x00 = pass, anything else = failure code).
 *
 * Usage: npm run blargg [-- <substring filter>]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GameBoyCore } from '../packages/emulator/src/gb/GameBoyCore.js';

const ROOT = new URL('../tests/roms/', import.meta.url).pathname;
const SUITES: readonly (readonly [string, string])[] = [
  ['blargg/cpu_instrs', 'blargg/cpu_instrs/individual'],
  ['blargg/instr_timing', 'blargg/instr_timing'],
  ['blargg/mem_timing', 'blargg/mem_timing/individual'],
  ['blargg/mem_timing-2', 'blargg/mem_timing-2/rom_singles'],
  ['blargg/halt_bug', 'blargg'],
];

const MAX_FRAMES = 2500;
const filter = process.argv.slice(2).filter((a) => a !== '--');

if (!existsSync(ROOT)) {
  console.error('error: tests/roms/ missing. Run `npm run fetch-test-roms` first.');
  process.exit(1);
}

function readMemoryReport(core: GameBoyCore): { done: boolean; passed: boolean; text: string } {
  if (
    core.mmu.read(0xa001) !== 0xde ||
    core.mmu.read(0xa002) !== 0xb0 ||
    core.mmu.read(0xa003) !== 0x61
  ) {
    return { done: false, passed: false, text: '' };
  }
  const status = core.mmu.read(0xa000);
  if (status === 0x80) return { done: false, passed: false, text: '' };

  let text = '';
  for (let i = 0; i < 256; i++) {
    const byte = core.mmu.read(0xa004 + i);
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return { done: true, passed: status === 0x00, text };
}

let pass = 0;
let fail = 0;

for (const [suite, dir] of SUITES) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) continue;
  const roms = readdirSync(full)
    .filter((f) => /\.gbc?$/i.test(f))
    .filter((f) => filter.length === 0 || filter.some((s) => f.includes(s)))
    .sort();
  if (roms.length === 0) continue;

  console.log(`\n${suite}`);
  for (const rom of roms) {
    const core = new GameBoyCore();
    core.loadRom(new Uint8Array(readFileSync(join(full, rom))));

    let verdict: 'pass' | 'fail' | 'timeout' = 'timeout';
    let report = '';
    let frames = 0;

    for (; frames < MAX_FRAMES; frames++) {
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

      const memory = readMemoryReport(core);
      if (memory.done) {
        verdict = memory.passed ? 'pass' : 'fail';
        report = memory.text;
        break;
      }
    }

    const name = rom.replace(/\.gbc?$/i, '');
    const output = report.replace(/\s+/g, ' ').trim();
    if (verdict === 'pass') {
      pass++;
      console.log(`  ✅ ${name}`);
    } else {
      fail++;
      console.log(`  ❌ ${name} (${verdict}, ${frames} frames) ${output.slice(0, 160)}`);
    }
  }
}

console.log(`\nBlargg: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
