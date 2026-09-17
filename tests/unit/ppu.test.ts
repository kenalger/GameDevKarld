import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../../packages/emulator/src/gb/ppu/Ppu.js';
import { PALETTE_GREY } from '../../packages/emulator/src/gb/ppu/palette.js';
import { decodePng } from '../harness/png.js';
import { diffFrameBuffers } from '../harness/conditions/screenshot.js';
import { buildRom } from '../harness/rom.js';

const ACID2_ROM = new URL('../roms/dmg-acid2/dmg-acid2.gb', import.meta.url).pathname;
const ACID2_REF = new URL('../roms/dmg-acid2/dmg-acid2-dmg.png', import.meta.url).pathname;
const acid2Available = existsSync(ACID2_ROM) && existsSync(ACID2_REF);

describe('PPU', () => {
  const core = (): GameBoyCore => {
    const c = new GameBoyCore();
    c.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2 }));
    return c;
  };

  it('produces a framebuffer at native resolution', () => {
    expect(core().getFrameBuffer()).toHaveLength(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  });

  it('returns a STABLE buffer reference, never a fresh allocation per frame', () => {
    const c = core();
    const first = c.getFrameBuffer();
    c.runFrame();
    expect(c.getFrameBuffer()).toBe(first);
  });

  it('keeps mode 3 within the hardware-legal 172-289 dots', () => {
    const c = core();
    let start = -1;
    let end = -1;
    for (let dot = 0; dot < 456 * 3; dot++) {
      const before = c.ppu.currentMode;
      c.cpu.tickT(1);
      if (dot > 456) {
        if (before !== 3 && c.ppu.currentMode === 3 && start < 0) start = dot;
        if (start > 0 && end < 0 && c.ppu.currentMode === 0) end = dot;
      }
    }
    const length = end - start;
    expect(length).toBeGreaterThanOrEqual(172);
    expect(length).toBeLessThanOrEqual(289);
  });

  it('locks the CPU out of VRAM during mode 3 and OAM during modes 2 and 3', () => {
    const c = core();
    let sawVramLock = false;
    let sawOamLock = false;
    for (let dot = 0; dot < 456 * 2; dot++) {
      c.cpu.tickT(1);
      if (c.ppu.currentMode === 3 && c.mmu.read(0x8000) === 0xff) sawVramLock = true;
      if (c.ppu.currentMode === 2 && c.mmu.read(0xfe00) === 0xff) sawOamLock = true;
    }
    expect(sawVramLock).toBe(true);
    expect(sawOamLock).toBe(true);
  });

  it('advances LY through every line and wraps at 154', () => {
    const c = core();
    const seen = new Set<number>();
    for (let dot = 0; dot < 70224; dot++) {
      c.cpu.tickT(1);
      seen.add(c.ppu.ly);
    }
    expect(seen.size).toBe(154);
    expect(Math.max(...seen)).toBe(153);
  });

  it('parks LY and reports mode 0 while the LCD is off', () => {
    const c = core();
    c.mmu.write(0xff40, 0x00);
    for (let dot = 0; dot < 5000; dot++) c.cpu.tickT(1);
    expect(c.ppu.ly).toBe(0);
    expect(c.ppu.currentMode).toBe(0);
  });
});

/** THE PHASE 04 EXIT GATE. */
describe.skipIf(!acid2Available)('dmg-acid2', () => {
  it('renders pixel-exact against the reference screenshot', () => {
    const c = new GameBoyCore();
    // References are rendered with the standard greyscale panel; the palette is a display
    // choice, not emulation state.
    c.ppu.palette = PALETTE_GREY;
    c.loadRom(new Uint8Array(readFileSync(ACID2_ROM)));
    for (let f = 0; f < 60; f++) c.runFrame();

    const expected = decodePng(readFileSync(ACID2_REF));
    const diff = diffFrameBuffers(c.getFrameBuffer(), expected.rgba, SCREEN_WIDTH, SCREEN_HEIGHT);

    if (diff.differing !== 0) {
      const b = diff.bounds!;
      throw new Error(
        `${diff.differing}/${diff.total} pixels differ; bounds x=${b.minX}..${b.maxX} y=${b.minY}..${b.maxY}`,
      );
    }
    expect(diff.differing).toBe(0);
  });
});

/**
 * The LY=LYC comparison has its own clock, and that clock stops with the PPU.
 *
 * Mooneye's stat_lyc_onoff walks every combination: the bit is retained across a power-off,
 * an LYC write while off is inert, and switching back on runs exactly one comparison. The
 * STAT interrupt line is frozen the same way — otherwise turning the LCD on manufactures a
 * rising edge for a condition that was already true.
 */
describe('STAT LY=LYC is a latch, not a live comparison', () => {
  /** A core parked in VBlank at LY=0x90, with the LYC interrupt enabled. */
  function atVBlank(): GameBoyCore {
    const c = new GameBoyCore();
    c.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2 }));
    c.mmu.write(0xff41, 0x40); // STAT: LYC interrupt enable
    for (let i = 0; i < 200_000 && c.mmu.read(0xff44) !== 0x90; i++) c.cpu.tickT(4);
    expect(c.mmu.read(0xff44)).toBe(0x90);
    return c;
  }

  const statIrq = (c: GameBoyCore): boolean => (c.mmu.read(0xff0f) & 0x02) !== 0;

  it('RETAINS the comparison bit when the LCD is switched off', () => {
    const c = atVBlank();
    c.mmu.write(0xff45, 0x90); // LYC = LY, so the bit is set
    c.mmu.write(0xff40, 0x00); // LCD off — LY resets to 0, the bit must not follow
    expect(c.mmu.read(0xff44)).toBe(0);
    expect(c.mmu.read(0xff41)).toBe(0xc4);
  });

  it('IGNORES an LYC write while the LCD is off — the comparison clock is stopped', () => {
    const c = atVBlank();
    c.mmu.write(0xff45, 0x90);
    c.mmu.write(0xff40, 0x00);
    c.mmu.write(0xff0f, 0x00);

    c.mmu.write(0xff45, 0x01); // would clear the bit if the comparison still ran
    expect(c.mmu.read(0xff41)).toBe(0xc4);
    expect(statIrq(c)).toBe(false);
  });

  it('runs ONE comparison when the LCD comes back on', () => {
    const c = atVBlank();
    c.mmu.write(0xff45, 0x90);
    c.mmu.write(0xff40, 0x00);
    c.mmu.write(0xff45, 0x01); // inert while off
    c.mmu.write(0xff0f, 0x00);

    c.mmu.write(0xff40, 0x80); // on: LY is 0, LYC is 1 -> the bit clears
    expect(c.mmu.read(0xff41)).toBe(0xc0);
    expect(statIrq(c)).toBe(false); // falling, so no interrupt either
  });

  it('does NOT re-fire the interrupt when the bit was already set before the power-off', () => {
    const c = atVBlank();
    c.mmu.write(0xff45, 0x90);
    c.mmu.write(0xff40, 0x00);
    c.mmu.write(0xff45, 0x00); // inert; LY will also be 0, so the bit stays set
    c.mmu.write(0xff0f, 0x00);

    c.mmu.write(0xff40, 0x80);
    expect(c.mmu.read(0xff41)).toBe(0xc4); // still set...
    expect(statIrq(c)).toBe(false); // ...but it never changed, so there is no edge
  });

  it('reports MODE 0, not mode 2, on the first line after the LCD is switched on', () => {
    const c = atVBlank();
    c.mmu.write(0xff40, 0x00);
    c.mmu.write(0xff40, 0x80);
    // The OAM scan is happening; it is simply not reported.
    expect(c.mmu.read(0xff41) & 0x03).toBe(0);
  });
});

/**
 * Mode 3's length is the clock everything mid-scanline is measured against.
 *
 * Pandocs: "the minimum Mode 3 length is 160 + 12 = 172 dots", where the 12 "come from two
 * tile fetches at the beginning of Mode 3. One is the first tile in the scanline, the
 * other is simply discarded." A tile fetch is 6 dots, so both together are exactly 12 —
 * and a fetcher that spends 8 on each lands at 175 and shifts every raster effect left.
 */
describe('mode 3 length', () => {
  /** Mode 3 run lengths for three consecutive whole scanlines. */
  function mode3Runs(scx: number): number[] {
    const c = new GameBoyCore();
    c.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2 }));
    c.mmu.write(0xff40, 0x91); // LCD + BG on
    c.mmu.write(0xff43, scx);
    c.mmu.write(0xff42, 0);

    const runs: number[] = [];
    let last = -1;
    let run = 0;
    for (let dot = 0; dot < 456 * 6; dot++) {
      c.cpu.tickT(1);
      const mode = c.mmu.read(0xff41) & 3;
      if (mode !== last) {
        if (last === 3) runs.push(run);
        last = mode;
        run = 0;
      }
      run++;
    }
    return runs.slice(1, 4); // drop the partial line the LCD was switched on during
  }

  it('is EXACTLY 172 dots with no scroll, sprites or window', () => {
    expect(mode3Runs(0)).toEqual([172, 172, 172]);
  });

  it('is stretched one dot per pixel discarded by SCX % 8', () => {
    for (const scx of [1, 2, 3, 5, 7]) {
      expect(mode3Runs(scx)).toEqual([172 + scx, 172 + scx, 172 + scx]);
    }
  });

  it('leaves mode 0 to fill the rest of the 456-dot line', () => {
    const c = new GameBoyCore();
    c.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2 }));
    c.mmu.write(0xff40, 0x91);

    const runs = new Map<number, number[]>();
    let last = -1;
    let run = 0;
    for (let dot = 0; dot < 456 * 5; dot++) {
      c.cpu.tickT(1);
      const mode = c.mmu.read(0xff41) & 3;
      if (mode !== last) {
        if (last >= 0) runs.set(last, [...(runs.get(last) ?? []), run]);
        last = mode;
        run = 0;
      }
      run++;
    }
    // Drop the first run of each mode: the LCD was switched on part-way through a line.
    const settled = (mode: number): number[] => (runs.get(mode) ?? []).slice(1, 4);

    // 80 + 172 + 204 = 456. Mode 0 sits at its MAXIMUM precisely because mode 3 is at its
    // minimum, so getting mode 3 wrong silently corrupts HBlank timing too.
    expect(settled(2)).toEqual([80, 80, 80]);
    expect(settled(3)).toEqual([172, 172, 172]);
    expect(settled(0)).toEqual([204, 204, 204]);
  });
});
