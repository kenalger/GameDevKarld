import { describe, expect, it } from 'vitest';
import { StubCore, SCREEN_SIZE } from '@webboy/emulator';
import {
  runTest,
  diffFrameBuffers,
  screenshotCondition,
  mooneyeCondition,
  blarggCondition,
  generateScoreboard,
  renderScoreboardMarkdown,
} from '../harness/index.js';
import type { StopCondition, TestResult } from '../harness/types.js';

const { width, height } = SCREEN_SIZE.GB;

describe('runner', () => {
  it('stops as soon as a condition returns a verdict', () => {
    const condition: StopCondition = {
      name: 'stop-at-3',
      evaluate: (_core, frame) =>
        frame === 3 ? { outcome: 'pass', detail: 'reached frame 3' } : null,
    };
    const result = runTest({
      name: 'stops-early',
      core: new StubCore(),
      stopCondition: condition,
      maxFrames: 100,
    });
    expect(result.outcome).toBe('pass');
    expect(result.framesRun).toBe(3);
  });

  it('reports a hang as a timeout, not a suspended run', () => {
    const never: StopCondition = { name: 'never', evaluate: () => null };
    const result = runTest({
      name: 'hangs',
      core: new StubCore(),
      stopCondition: never,
      maxFrames: 10,
    });
    expect(result.outcome).toBe('timeout');
    expect(result.framesRun).toBe(10);
    expect(result.detail).toContain('10 frames');
  });

  it('calls reset on the condition before running', () => {
    let resets = 0;
    const condition: StopCondition = {
      name: 'counts-resets',
      reset: () => void resets++,
      evaluate: () => ({ outcome: 'pass', detail: 'done' }),
    };
    runTest({ name: 'reset', core: new StubCore(), stopCondition: condition, maxFrames: 5 });
    expect(resets).toBe(1);
  });
});

describe('screenshot diff', () => {
  const blank = (): Uint8ClampedArray => new Uint8ClampedArray(width * height * 4);

  it('reports zero differing pixels for identical buffers', () => {
    const diff = diffFrameBuffers(blank(), blank(), width, height);
    expect(diff.differing).toBe(0);
    expect(diff.bounds).toBeNull();
    expect(diff.total).toBe(width * height);
  });

  it('counts differing pixels and reports a tight bounding box', () => {
    const actual = blank();
    const expected = blank();
    // Two pixels: (10, 5) and (12, 9).
    for (const [x, y] of [
      [10, 5],
      [12, 9],
    ] as const) {
      actual[(y * width + x) * 4] = 0xff;
    }
    const diff = diffFrameBuffers(actual, expected, width, height);
    expect(diff.differing).toBe(2);
    expect(diff.bounds).toEqual({ minX: 10, minY: 5, maxX: 12, maxY: 9 });
  });

  it('detects a difference in any channel, including alpha', () => {
    const actual = blank();
    const expected = blank();
    actual[3] = 0x01;
    expect(diffFrameBuffers(actual, expected, width, height).differing).toBe(1);
  });

  it('throws on a buffer size mismatch rather than silently passing', () => {
    expect(() => diffFrameBuffers(new Uint8ClampedArray(8), blank(), width, height)).toThrow(
      RangeError,
    );
  });

  it('passes a screenshot condition when the core matches the reference', () => {
    const reference = new StubCore();
    reference.runFrame();
    const expected = new Uint8ClampedArray(reference.getFrameBuffer());

    const result = runTest({
      name: 'stub-frame-1',
      core: new StubCore(),
      stopCondition: screenshotCondition(expected, width, height, 1),
      maxFrames: 5,
    });
    expect(result.outcome).toBe('pass');
  });

  it('fails a screenshot condition with a pixel count, not a vague message', () => {
    const wrong = new Uint8ClampedArray(width * height * 4).fill(0x7f);
    const result = runTest({
      name: 'stub-mismatch',
      core: new StubCore(),
      stopCondition: screenshotCondition(wrong, width, height, 1),
      maxFrames: 5,
    });
    expect(result.outcome).toBe('fail');
    expect(result.detail).toMatch(/\d+\/\d+ pixels differ/);
    expect(result.detail).toContain('bounds');
  });
});

describe('honesty of unimplemented conditions', () => {
  // The load-bearing property of this harness before Phase 01: a condition that cannot
  // reach a verdict must say so. A false pass here would poison every later gate.
  it('mooneye reports unavailable against a core with no CPU', () => {
    const result = runTest({
      name: 'no-cpu',
      core: new StubCore(),
      stopCondition: mooneyeCondition(),
      maxFrames: 5,
    });
    expect(result.outcome).toBe('unavailable');
    expect(result.outcome).not.toBe('pass');
    expect(result.detail).toContain('no execution');
  });

  it('blargg reports unavailable with no serial and no execution', () => {
    const result = runTest({
      name: 'no-bus',
      core: new StubCore(),
      stopCondition: blarggCondition(),
      maxFrames: 5,
    });
    expect(result.outcome).toBe('unavailable');
    expect(result.detail).toContain('Phase 02');
  });
});

describe('scoreboard', () => {
  const results: (TestResult & { suite: string })[] = [
    {
      suite: 'blargg',
      name: 'cpu_instrs',
      outcome: 'pass',
      detail: 'ok',
      framesRun: 1,
      durationMs: 1,
    },
    {
      suite: 'mealybug',
      name: 'm3_bgp',
      outcome: 'fail',
      detail: '12 pixels differ',
      framesRun: 1,
      durationMs: 1,
    },
    {
      suite: 'mooneye',
      name: 'timer',
      outcome: 'timeout',
      detail: 'hung',
      framesRun: 9,
      durationMs: 1,
    },
  ];

  it('reclassifies a listed failure as expected-fail, carrying its reason', () => {
    const board = generateScoreboard(
      results,
      new Map([
        ['mealybug/m3_bgp', { subsystem: 'PPU', reason: 'scanline renderer; needs pixel FIFO' }],
      ]),
    );
    expect(board.totals.pass).toBe(1);
    expect(board.totals['expected-fail']).toBe(1);
    expect(board.totals.timeout).toBe(1);
    expect(board.totals.fail).toBe(0);

    const entry = board.entries.find((e) => e.test === 'm3_bgp');
    expect(entry?.subsystem).toBe('PPU');
    expect(entry?.reason).toContain('pixel FIFO');
  });

  it('never silently absorbs an unlisted failure', () => {
    const board = generateScoreboard(results);
    expect(board.totals.fail).toBe(1);
    expect(board.totals['expected-fail']).toBe(0);
  });

  it('renders markdown with totals and a row per test', () => {
    const md = renderScoreboardMarkdown(generateScoreboard(results));
    expect(md).toContain('# Accuracy Scoreboard');
    expect(md).toContain('cpu_instrs');
    expect(md).toContain('1 pass');
    expect(md).toContain('is not a pass');
  });
});
