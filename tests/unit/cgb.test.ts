import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../../packages/emulator/src/gb/ppu/Ppu.js';
import { expand } from '../../packages/emulator/src/gb/ppu/cgbPalette.js';
import { decodePng } from '../harness/png.js';
import { diffFrameBuffers } from '../harness/conditions/screenshot.js';
import { buildRom } from '../harness/rom.js';

const ACID2 = new URL('../roms/cgb-acid2/cgb-acid2.gbc', import.meta.url).pathname;
const ACID2_REF = new URL('../roms/cgb-acid2/cgb-acid2.png', import.meta.url).pathname;
const available = existsSync(ACID2) && existsSync(ACID2_REF);

const cgbCore = (): GameBoyCore => {
  const core = new GameBoyCore();
  core.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2, cgbFlag: 0xc0 }));
  return core;
};

describe('CGB detection', () => {
  it('enters CGB mode from the cartridge header, not a separate core', () => {
    expect(cgbCore().cgb).toBe(true);
    const dmg = new GameBoyCore();
    dmg.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2, cgbFlag: 0x00 }));
    expect(dmg.cgb).toBe(false);
  });

  it('leaves A = 0x11 after boot, which is how software detects a CGB', () => {
    expect(cgbCore().getInspector().getCpuSnapshot().a).toBe(0x11);
  });
});

describe('colour expansion', () => {
  it('USES c<<3 | c>>2, not c*8 — otherwise white never reaches 0xFF', () => {
    expect(expand(0x7fff)).toBe(0xffffff); // all 5-bit channels at max = pure white
    expect(expand(0x0000)).toBe(0x000000);
    expect(expand(0x001f)).toBe(0xff0000); // red only
    expect(expand(0x03e0)).toBe(0x00ff00); // green only
    expect(expand(0x7c00)).toBe(0x0000ff); // blue only
  });
});

describe('CGB registers', () => {
  let core: GameBoyCore;
  beforeEach(() => {
    core = cgbCore();
  });

  it('banks VRAM through 0xFF4F', () => {
    core.mmu.write(0xff40, 0x00); // LCD off so VRAM is reachable
    core.mmu.write(0xff4f, 0x00);
    core.mmu.write(0x8000, 0xaa);
    core.mmu.write(0xff4f, 0x01);
    core.mmu.write(0x8000, 0xbb);

    expect(core.mmu.read(0x8000)).toBe(0xbb);
    core.mmu.write(0xff4f, 0x00);
    expect(core.mmu.read(0x8000)).toBe(0xaa);
  });

  it('banks WRAM through 0xFF70, with bank 0 ALIASING TO 1', () => {
    core.mmu.write(0xff70, 0x01);
    core.mmu.write(0xd000, 0x11);
    core.mmu.write(0xff70, 0x02);
    core.mmu.write(0xd000, 0x22);

    expect(core.mmu.read(0xd000)).toBe(0x22);
    core.mmu.write(0xff70, 0x01);
    expect(core.mmu.read(0xd000)).toBe(0x11);

    // Selecting bank 0 must give bank 1, not a second view of WRAM0.
    core.mmu.write(0xff70, 0x00);
    expect(core.mmu.read(0xd000)).toBe(0x11);
  });

  it('auto-increments the palette index on WRITE only', () => {
    core.mmu.write(0xff68, 0x80); // index 0, auto-increment on
    core.mmu.write(0xff69, 0x12);
    core.mmu.write(0xff69, 0x34);
    core.mmu.write(0xff68, 0x00); // index 0, auto-increment off
    expect(core.mmu.read(0xff69)).toBe(0x12);
    expect(core.mmu.read(0xff69)).toBe(0x12); // read must NOT advance
  });

  it('keeps CGB registers invisible on a DMG cartridge', () => {
    const dmg = new GameBoyCore();
    dmg.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2, cgbFlag: 0x00 }));
    for (const address of [0xff4f, 0xff68, 0xff69, 0xff70, 0xff4d]) {
      expect(dmg.mmu.read(address)).toBe(0xff);
    }
  });
});

/** THE PHASE 11 EXIT GATE. */
describe.skipIf(!available)('cgb-acid2', () => {
  it('renders pixel-exact against the reference screenshot', () => {
    const core = new GameBoyCore();
    core.loadRom(new Uint8Array(readFileSync(ACID2)));
    expect(core.cgb).toBe(true);
    for (let f = 0; f < 60; f++) core.runFrame();

    const expected = decodePng(readFileSync(ACID2_REF));
    const diff = diffFrameBuffers(
      core.getFrameBuffer(),
      expected.rgba,
      SCREEN_WIDTH,
      SCREEN_HEIGHT,
    );
    if (diff.differing !== 0) {
      const b = diff.bounds!;
      throw new Error(
        `${diff.differing}/${diff.total} pixels differ; bounds x=${b.minX}..${b.maxX} y=${b.minY}..${b.maxY}`,
      );
    }
    expect(diff.differing).toBe(0);
  });
});
