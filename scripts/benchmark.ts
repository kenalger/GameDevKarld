/**
 * Headless performance benchmark.
 *
 * Reports emulated frames per second and per-frame percentiles with no browser, no canvas
 * and no React involved — an upper bound on what the core can do, and the number to watch
 * for a core regression.
 *
 * Usage: npm run bench [-- <frames>]
 */
import { readFileSync, existsSync } from 'node:fs';
import { GameBoyCore } from '../packages/emulator/src/gb/GameBoyCore.js';

const ROM = new URL('../tests/roms/little-things-gb/tellinglys.gb', import.meta.url).pathname;
const FRAMES = Number(process.argv.slice(2).filter((a) => a !== '--')[0] ?? 3000);
const TARGET_FPS = 4194304 / 70224;

if (!existsSync(ROM)) {
  console.error('error: benchmark ROM missing. Run `npm run fetch-test-roms` first.');
  process.exit(1);
}

const core = new GameBoyCore();
core.loadRom(new Uint8Array(readFileSync(ROM)));

// Warm up so JIT compilation is not counted as emulator cost.
for (let i = 0; i < 300; i++) core.runFrame();

const samples = new Float64Array(FRAMES);
const startInstructions = core.getInspector().getInstructionCount();
const started = performance.now();

for (let i = 0; i < FRAMES; i++) {
  const t0 = performance.now();
  core.runFrame();
  samples[i] = performance.now() - t0;
}

const elapsed = performance.now() - started;
const instructions = core.getInspector().getInstructionCount() - startInstructions;

const sorted = Float64Array.from(samples).sort();
const at = (p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

const fps = (FRAMES / elapsed) * 1000;
const budget = 1000 / TARGET_FPS;

console.log(`
Frames            ${FRAMES.toLocaleString()}
Wall clock        ${elapsed.toFixed(0)} ms
Emulated FPS      ${fps.toFixed(0)}  (${(fps / TARGET_FPS).toFixed(1)}x realtime)
Frame time p50    ${at(0.5).toFixed(3)} ms
Frame time p99    ${at(0.99).toFixed(3)} ms
Frame time max    ${at(1).toFixed(3)} ms
Budget @59.73Hz   ${budget.toFixed(2)} ms  -> p99 uses ${((at(0.99) / budget) * 100).toFixed(1)}% of it
Instructions/sec  ${(((instructions / elapsed) * 1000) / 1e6).toFixed(1)}M
`);

// The core must comfortably beat realtime; the browser needs headroom for paint and audio.
process.exit(at(0.99) < budget ? 0 : 1);
