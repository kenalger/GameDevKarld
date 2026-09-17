import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runOpcodeFile } from '../harness/sm83.js';

const ROOT = new URL('../sm83/', import.meta.url).pathname;
const available = existsSync(ROOT) && readdirSync(ROOT).some((f) => f.endsWith('.json'));

/**
 * THE PHASE 01 EXIT GATE.
 *
 * SingleStepTests/sm83 — 500 opcode files x 1000 cases, each with an initial state, a
 * final state and per-M-cycle bus activity. All of it must pass, not "most of it".
 *
 * The corpus is gitignored (it is 31MB of generated data); `npm run fetch-cpu-tests`
 * pulls it. Skipped rather than silently passing when absent — see docs/testing.md.
 */
describe.skipIf(!available)('SingleStepTests/sm83', () => {
  const files = readdirSync(ROOT)
    .filter((f) => f.endsWith('.json'))
    .sort();

  it('has the full corpus of 500 opcode files', () => {
    expect(files).toHaveLength(500);
  });

  for (const file of files) {
    const opcode = file.replace('.json', '');
    it(`${opcode} — 1000 cases, registers, flags, memory and cycle-by-cycle bus`, () => {
      const report = runOpcodeFile(join(ROOT, file), opcode);
      if (report.passed !== report.total) {
        throw new Error(
          `${report.passed}/${report.total} passed.\n  ${report.failures.join('\n  ')}`,
        );
      }
      expect(report.passed).toBe(report.total);
    });
  }
});

it.skipIf(available)('SM83 corpus is absent — run `npm run fetch-cpu-tests`', () => {
  // Present so a skipped gate is visible in the report rather than looking like a pass.
  expect(available).toBe(false);
});
