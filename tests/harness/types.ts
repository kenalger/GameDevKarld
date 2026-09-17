import type { EmulatorCore } from '@webboy/emulator';

/**
 * `screenshot` means the test is scored by comparing pixels, not by the Mooneye register
 * signature this scoreboard watches for — so running it here proves nothing either way.
 * It is NOT a pass. `npm run screenshots` is where those tests get a verdict.
 */
export type TestOutcome = 'pass' | 'fail' | 'timeout' | 'unavailable' | 'screenshot';

export interface TestResult {
  readonly name: string;
  readonly outcome: TestOutcome;
  /** Why it failed, or why the verdict could not be reached. */
  readonly detail: string;
  readonly framesRun: number;
  readonly durationMs: number;
}

/**
 * Decides when a run is over and what the verdict is.
 *
 * `evaluate` is called after every frame. Returning null means "keep going".
 *
 * Honesty rule: a condition whose hardware hooks do not exist yet MUST return
 * `unavailable`, never `pass`. A false green here poisons every later phase.
 */
export interface StopCondition {
  readonly name: string;
  reset?(): void;
  evaluate(
    core: EmulatorCore,
    frame: number,
  ): Omit<TestResult, 'name' | 'framesRun' | 'durationMs'> | null;
}
