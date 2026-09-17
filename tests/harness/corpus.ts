import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where fetch-test-roms.sh puts the corpus. Gitignored — ROM data is never committed. */
export const ROM_ROOT = new URL('../roms/', import.meta.url).pathname;

export interface CorpusEntry {
  readonly suite: string;
  readonly name: string;
  readonly path: string;
}

/**
 * The gate order from docs/plan/README.md, mapped onto the real corpus layout.
 *
 * A suite is not attempted until the suites above it pass — chasing Mealybug before
 * cpu_instrs wastes days. `phase` is the phase whose exit gate this suite belongs to.
 */
export interface SuiteSpec {
  readonly suite: string;
  readonly dir: string;
  readonly phase: string;
}

export const SUITE_ORDER: readonly SuiteSpec[] = [
  { suite: 'blargg/cpu_instrs', dir: 'blargg/cpu_instrs/individual', phase: '02' },
  { suite: 'blargg/instr_timing', dir: 'blargg/instr_timing', phase: '03' },
  { suite: 'blargg/mem_timing', dir: 'blargg/mem_timing/individual', phase: '03' },
  { suite: 'mooneye/acceptance', dir: 'mooneye-test-suite/acceptance', phase: '03' },
  { suite: 'dmg-acid2', dir: 'dmg-acid2', phase: '04' },
  { suite: 'mooneye/emulator-only', dir: 'mooneye-test-suite/emulator-only', phase: '06' },
  { suite: 'blargg/dmg_sound', dir: 'blargg/dmg_sound/rom_singles', phase: '07' },
  { suite: 'cgb-acid2', dir: 'cgb-acid2', phase: '11' },
  { suite: 'blargg/cgb_sound', dir: 'blargg/cgb_sound/rom_singles', phase: '11' },
  { suite: 'mealybug', dir: 'mealybug-tearoom-tests/ppu', phase: '04' },
];

export function corpusAvailable(): boolean {
  return existsSync(ROM_ROOT) && readdirSync(ROM_ROOT).length > 0;
}

export function discoverRoms(dir: string, suite: string): CorpusEntry[] {
  if (!existsSync(dir)) return [];
  const out: CorpusEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...discoverRoms(full, suite));
    } else if (/\.gbc?$/i.test(entry.name)) {
      out.push({ suite, name: entry.name.replace(/\.gbc?$/i, ''), path: full });
    }
  }
  return out;
}
