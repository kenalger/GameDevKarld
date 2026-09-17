import type { EmulatorCore } from '@webboy/emulator';
import type { StopCondition, TestResult } from './types.js';

export interface RunOptions {
  readonly name: string;
  readonly core: EmulatorCore;
  readonly rom?: Uint8Array;
  readonly stopCondition: StopCondition;
  /** Frame budget. Exhausting it is a TIMEOUT, which is a failure — never a suspended run. */
  readonly maxFrames: number;
}

/**
 * Headless test-ROM runner. No canvas, no React, no DOM.
 *
 * Every phase gate in docs/plan/ is called by this function.
 */
export function runTest(options: RunOptions): TestResult {
  const { name, core, rom, stopCondition, maxFrames } = options;
  const started = performance.now();

  stopCondition.reset?.();
  if (rom) core.loadRom(rom);
  core.reset();
  core.resume();

  for (let frame = 1; frame <= maxFrames; frame++) {
    core.runFrame();
    const verdict = stopCondition.evaluate(core, frame);
    if (verdict) {
      return {
        name,
        outcome: verdict.outcome,
        detail: verdict.detail,
        framesRun: frame,
        durationMs: performance.now() - started,
      };
    }
  }

  return {
    name,
    outcome: 'timeout',
    detail: `No verdict within ${maxFrames} frames (${stopCondition.name}).`,
    framesRun: maxFrames,
    durationMs: performance.now() - started,
  };
}
