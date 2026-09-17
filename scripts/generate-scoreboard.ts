/**
 * Runs the accuracy corpus and writes tests/scoreboard.md + tests/scoreboard.json.
 *
 * Run: npm run scoreboard
 *
 * Everything reading `unavailable` today is correct — the hardware those tests need does
 * not exist yet. `unavailable` is NOT a pass and is never counted as one.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GameBoyCore } from '../packages/emulator/src/gb/GameBoyCore.js';
import { runTest } from '../tests/harness/runner.js';
import { mooneyeCondition } from '../tests/harness/conditions/mooneye.js';
import { blarggCondition } from '../tests/harness/conditions/blargg.js';
import { generateScoreboard, renderScoreboardMarkdown } from '../tests/harness/scoreboard.js';
import { ROM_ROOT, SUITE_ORDER, discoverRoms } from '../tests/harness/corpus.js';
import type { TestResult } from '../tests/harness/types.js';
import { EXPECTED_FAILURES } from '../tests/expected-failures.js';

const MAX_FRAMES = 1500;

/** Suites judged by pixel comparison, which this runner cannot do. */
const SCREENSHOT_SUITES = new Set(['dmg-acid2', 'cgb-acid2', 'cgb-acid-hell', 'mealybug']);

if (!existsSync(ROM_ROOT)) {
  console.error('error: tests/roms/ is missing. Run `npm run fetch-test-roms` first.');
  process.exit(1);
}

const results: (TestResult & { suite: string })[] = [];

for (const spec of SUITE_ORDER) {
  const dir = join(ROM_ROOT, spec.dir);
  const roms = discoverRoms(dir, spec.suite);
  if (roms.length === 0) {
    console.warn(`warn: no ROMs found for ${spec.suite} at ${relative(ROM_ROOT, dir)}`);
    continue;
  }
  for (const rom of roms) {
    // Running a screenshot test through the register protocol just burns 1500 frames and
    // reports "timeout", which reads like a hang. Record what it actually is.
    if (SCREENSHOT_SUITES.has(spec.suite)) {
      results.push({
        name: rom.name,
        outcome: 'screenshot' as const,
        detail: 'pixel-compared by `npm run screenshots`',
        framesRun: 0,
        durationMs: 0,
        suite: spec.suite,
      });
      continue;
    }

    const core = new GameBoyCore();
    const condition = spec.suite.startsWith('blargg')
      ? blarggCondition(core.serial)
      : mooneyeCondition();
    let result;
    try {
      result = runTest({
        name: rom.name,
        core,
        rom: new Uint8Array(readFileSync(rom.path)),
        stopCondition: condition,
        maxFrames: MAX_FRAMES,
      });
    } catch (cause) {
      // An unsupported mapper or bad header is a real result, not a crash.
      result = {
        name: rom.name,
        outcome: 'unavailable' as const,
        detail: cause instanceof Error ? cause.message : String(cause),
        framesRun: 0,
        durationMs: 0,
      };
    }
    results.push({ ...result, suite: spec.suite });
  }
}

const board = generateScoreboard(results, EXPECTED_FAILURES);
writeFileSync(new URL('../tests/scoreboard.md', import.meta.url), renderScoreboardMarkdown(board));
writeFileSync(
  new URL('../tests/scoreboard.json', import.meta.url),
  JSON.stringify(board, null, 2) + '\n',
);

const t = board.totals;
console.log(
  `scoreboard: ${t.pass} pass · ${t.fail} fail · ${t.timeout} timeout · ${t.screenshot} screenshot · ` +
    `${t['expected-fail']} expected-fail · ${t.unavailable} unavailable (${board.entries.length} tests)`,
);
