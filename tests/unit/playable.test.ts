import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import { buttonBit } from '../../packages/emulator/src/gb/input/Joypad.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../../packages/emulator/src/gb/ppu/Ppu.js';

/**
 * MILESTONE M3 — FIRST PLAYABLE.
 *
 * The roadmap's first definition of success, and deliberately NOT Pokémon: a legal
 * homebrew ROM loads from the user's device and actually plays — it executes, renders,
 * responds to input, keeps time, resets and pauses.
 *
 * `tellinglys` is a freely-distributable homebrew that measures joypad-interrupt entropy by
 * sampling LY when a button is pressed, which makes it an unusually good end-to-end probe:
 * it exercises the CPU, PPU, timing and input together, and it visibly reacts.
 */
const ROM = new URL('../roms/little-things-gb/tellinglys.gb', import.meta.url).pathname;
const available = existsSync(ROM);

function load(): GameBoyCore {
  const core = new GameBoyCore();
  core.loadRom(new Uint8Array(readFileSync(ROM)));
  return core;
}

const snapshot = (core: GameBoyCore): string => {
  const buffer = core.getFrameBuffer();
  let hash = 0x811c9dc5;
  for (let i = 0; i < buffer.length; i += 4) {
    hash = Math.imul(hash ^ buffer[i]!, 0x01000193) >>> 0;
  }
  return hash.toString(16);
};

describe.skipIf(!available)('M3 — first playable', () => {
  it('loads a homebrew ROM and renders a real picture', () => {
    const core = load();
    for (let f = 0; f < 120; f++) core.runFrame();

    const buffer = core.getFrameBuffer();
    expect(buffer).toHaveLength(SCREEN_WIDTH * SCREEN_HEIGHT * 4);

    // Not a blank screen: a real frame has more than one distinct colour.
    const shades = new Set<string>();
    for (let i = 0; i < buffer.length; i += 4) {
      shades.add(`${buffer[i]},${buffer[i + 1]},${buffer[i + 2]}`);
    }
    expect(shades.size).toBeGreaterThan(1);
  });

  it('RESPONDS TO INPUT: pressing a button changes what is on screen', () => {
    const core = load();
    for (let f = 0; f < 120; f++) core.runFrame();
    const before = snapshot(core);

    // Hold Start for a while, exactly as the host loop would.
    for (let f = 0; f < 30; f++) {
      core.setInput(buttonBit('start'));
      core.runFrame();
    }
    for (let f = 0; f < 30; f++) {
      core.setInput(0);
      core.runFrame();
    }

    expect(snapshot(core)).not.toBe(before);
  });

  it('keeps running deterministically: same input, same output', () => {
    const run = (): string => {
      const core = load();
      for (let f = 0; f < 200; f++) {
        core.setInput(f > 100 && f < 140 ? buttonBit('a') : 0);
        core.runFrame();
      }
      return snapshot(core);
    };
    expect(run()).toBe(run());
  });

  it('reset returns the machine to a byte-identical starting state', () => {
    const core = load();
    for (let f = 0; f < 60; f++) core.runFrame();
    const afterFirstRun = snapshot(core);

    core.reset();
    for (let f = 0; f < 60; f++) core.runFrame();
    expect(snapshot(core)).toBe(afterFirstRun);

    const fresh = load();
    for (let f = 0; f < 60; f++) fresh.runFrame();
    expect(snapshot(core)).toBe(snapshot(fresh));
  });

  it('pause stops emulated time, and resume loses none of it', () => {
    const core = load();
    for (let f = 0; f < 60; f++) core.runFrame();

    core.pause();
    const paused = snapshot(core);
    const cyclesAtPause = core.cpu.cycles;
    for (let f = 0; f < 30; f++) core.runFrame(); // should be inert
    expect(snapshot(core)).toBe(paused);
    expect(core.cpu.cycles).toBe(cyclesAtPause);

    core.resume();
    for (let f = 0; f < 30; f++) core.runFrame();
    expect(core.cpu.cycles).toBeGreaterThan(cyclesAtPause);

    // A paused-then-resumed run matches an uninterrupted one exactly.
    const reference = load();
    for (let f = 0; f < 90; f++) reference.runFrame();
    expect(snapshot(core)).toBe(snapshot(reference));
  });

  it('fires the joypad interrupt at varying points in the frame, not a fixed one', () => {
    // This is what tellinglys actually measures: a naive emulator that only samples input
    // at VBlank always reports the same LY, which is detectable.
    const core = load();
    for (let f = 0; f < 120; f++) core.runFrame();

    const seen = new Set<number>();
    for (let f = 0; f < 40; f++) {
      // Press part-way through a frame rather than on the boundary.
      const dots = 1000 + f * 137;
      for (let d = 0; d < dots; d++) core.cpu.tickT(1);
      core.setInput(f % 2 === 0 ? buttonBit('a') : 0);
      seen.add(core.ppu.ly);
      core.runFrame();
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
