/**
 * Compatibility sweep across every system — the Phase 15 close-out.
 *
 * Runs the whole accuracy corpus and prints one table. Commercial ROMs are NEVER involved:
 * every ROM here is freely-distributable homebrew or a test program, fetched by the scripts
 * in this directory and gitignored. See docs/legal.md.
 */
import { execFileSync } from 'node:child_process';

interface Suite {
  readonly name: string;
  readonly system: 'GB' | 'GBC' | 'GBA';
  readonly script: string;
  readonly args?: readonly string[];
}

const SUITES: readonly Suite[] = [
  { name: 'SingleStepTests/sm83 (CPU)', system: 'GB', script: 'scripts/run-sm83.ts' },
  { name: 'Blargg cpu_instrs + timing', system: 'GB', script: 'scripts/run-blargg.ts' },
  { name: 'Blargg sound (DMG + CGB)', system: 'GBC', script: 'scripts/run-sound.ts' },
  { name: 'Mooneye acceptance', system: 'GB', script: 'scripts/run-mooneye.ts' },
  { name: 'Screenshots + Mealybug PPU', system: 'GBC', script: 'scripts/run-screenshots.ts' },
  { name: 'jsmolka gba-tests', system: 'GBA', script: 'scripts/run-gba-cpu.ts' },
];

function run(suite: Suite): string {
  try {
    const out = execFileSync('npx', ['vite-node', suite.script, ...(suite.args ?? [])], {
      encoding: 'utf8',
      cwd: new URL('..', import.meta.url).pathname,
    });
    return summarise(out);
  } catch (error) {
    // A non-zero exit means failures, not a crash — the output still holds the summary.
    const out = (error as { stdout?: string }).stdout ?? '';
    return out ? summarise(out) : 'ERROR';
  }
}

/** Pulls the final summary line out of a runner's output. */
function summarise(output: string): string {
  const lines = output
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Prefer an explicit total ('x/y' or 'N passed'); fall back to the last numeric line.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (/\d+\s*\/\s*\d+|passed/.test(line) && !line.startsWith('✅') && !line.startsWith('❌')) {
      return line;
    }
  }
  return lines[lines.length - 1] ?? 'no output';
}

console.log('\nWebBoy compatibility sweep\n' + '='.repeat(58));
for (const suite of SUITES) {
  const result = run(suite);
  console.log(`${suite.system.padEnd(4)} ${suite.name.padEnd(30)} ${result}`);
}
console.log(
  '\nAll ROMs are freely-distributable homebrew or test programs.\n' +
    'No commercial ROM is fetched, bundled, or committed. See docs/legal.md.\n',
);
