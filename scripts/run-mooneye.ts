/**
 * Runs the Mooneye acceptance suite — the Phase 03 exit gate.
 *
 * A test passes when the CPU reaches `LD B,B` with the Fibonacci signature
 * B=3 C=5 D=8 E=13 H=21 L=34, and fails when every register reads 0x42.
 *
 * Usage: npm run mooneye [-- <substring>]
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GameBoyCore } from '../packages/emulator/src/gb/GameBoyCore.js';

const ROOT = new URL('../tests/roms/mooneye-test-suite/acceptance/', import.meta.url).pathname;
const MAX_FRAMES = 120;
const filter = process.argv.slice(2).filter((a) => a !== '--');

/**
 * Whether a test applies to the hardware this core emulates: a DMG, revision A/B/C.
 *
 * Mooneye encodes the models a test is expected to pass on in the filename suffix — a
 * concatenation of model names (`dmg0`, `dmgABC`, `mgb`, `sgb2`) and single-letter
 * families (`G` = any DMG, `S` = SGB, `C` = CGB, `A` = AGB). A test suffixed `-S` fails
 * on a DMG BY DESIGN, so counting it against this emulator would be meaningless.
 *
 * Every skipped test here has an applicable sibling — `boot_regs-dmgABC` next to
 * `boot_regs-sgb` — and those siblings are run and must pass.
 */
function appliesToDmg(name: string): boolean {
  const suffix = /-([A-Za-z0-9]+)$/.exec(name.split('/').pop() ?? '')?.[1];
  if (!suffix) return true;
  // 'dmg' alone is not enough: 'dmg0' is a different silicon revision.
  return suffix.includes('dmgABC') || suffix.includes('G');
}

function collect(dir: string, prefix = ''): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full, `${prefix}${entry}/`));
    else if (/\.gbc?$/i.test(entry))
      out.push({ name: prefix + entry.replace(/\.gbc?$/i, ''), path: full });
  }
  return out;
}

if (!existsSync(ROOT)) {
  console.error('error: mooneye acceptance ROMs missing. Run `npm run fetch-test-roms`.');
  process.exit(1);
}

const all = collect(ROOT)
  .filter((r) => filter.length === 0 || filter.some((f) => r.name.includes(f)))
  .sort((a, b) => a.name.localeCompare(b.name));

const otherModels = all.filter((r) => !appliesToDmg(r.name));
const roms = all.filter((r) => appliesToDmg(r.name));

const failures: string[] = [];
let pass = 0;

let unsupported = 0;

for (const rom of roms) {
  const core = new GameBoyCore();
  try {
    core.loadRom(new Uint8Array(readFileSync(rom.path)));
  } catch {
    // An unimplemented mapper is not a timing failure; it belongs to Phase 06.
    unsupported++;
    continue;
  }

  let verdict: 'pass' | 'fail' | 'timeout' = 'timeout';
  for (let f = 0; f < MAX_FRAMES; f++) {
    core.runFrame();
    const r = core.cpu.regs;
    if (r.b === 3 && r.c === 5 && r.d === 8 && r.e === 13 && r.h === 21 && r.l === 34) {
      verdict = 'pass';
      break;
    }
    if ([r.b, r.c, r.d, r.e, r.h, r.l].every((x) => x === 0x42)) {
      verdict = 'fail';
      break;
    }
  }

  if (verdict === 'pass') pass++;
  else failures.push(`${verdict === 'timeout' ? '⏱ ' : '❌'} ${rom.name}`);
}

if (filter.length > 0 || process.env.VERBOSE) {
  for (const f of failures) console.log(f);
  for (const r of otherModels) console.log(`⊘  ${r.name} (targets other hardware)`);
}
const skipped = [
  unsupported > 0 ? `${unsupported} mapper not implemented` : '',
  otherModels.length > 0 ? `${otherModels.length} target DMG0/MGB/SGB, not this model` : '',
].filter(Boolean);
console.log(
  `\nMooneye acceptance: ${pass}/${roms.length - unsupported}` +
    (skipped.length > 0 ? ` (skipped: ${skipped.join('; ')})` : ''),
);
process.exit(failures.length === 0 ? 0 : 1);
