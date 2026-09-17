/**
 * Runs the SingleStepTests SM83 suite — the Phase 01 exit gate.
 *
 * Usage: npm run sm83           (all 500 opcode files)
 *        npm run sm83 -- 27 cb\ 46
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runOpcodeFile } from '../tests/harness/sm83.js';

const ROOT = new URL('../tests/sm83/', import.meta.url).pathname;

if (!existsSync(ROOT)) {
  console.error('error: tests/sm83/ missing. Run `npm run fetch-cpu-tests` first.');
  process.exit(1);
}

const filter = process.argv.slice(2);
const files = readdirSync(ROOT)
  .filter((f) => f.endsWith('.json'))
  .filter((f) => filter.length === 0 || filter.includes(f.replace('.json', '')))
  .sort();

let totalCases = 0;
let totalPassed = 0;
const failingOpcodes: { opcode: string; passed: number; total: number; failures: string[] }[] = [];

for (const file of files) {
  const report = runOpcodeFile(join(ROOT, file), file.replace('.json', ''));
  totalCases += report.total;
  totalPassed += report.passed;
  if (report.passed !== report.total) failingOpcodes.push(report);
}

const pct = totalCases === 0 ? 0 : (totalPassed / totalCases) * 100;
console.log(
  `\nSM83: ${totalPassed.toLocaleString()}/${totalCases.toLocaleString()} cases (${pct.toFixed(3)}%) across ${files.length} opcodes`,
);
console.log(`Failing opcodes: ${failingOpcodes.length}`);

for (const report of failingOpcodes.slice(0, 25)) {
  console.log(`\n  ${report.opcode}: ${report.passed}/${report.total}`);
  for (const failure of report.failures) console.log(`    ${failure}`);
}
if (failingOpcodes.length > 25) {
  console.log(`\n  … and ${failingOpcodes.length - 25} more opcodes`);
}

process.exit(failingOpcodes.length === 0 ? 0 : 1);
