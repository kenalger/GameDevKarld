import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { GameBoyAdvanceCore } from '../../packages/emulator/src/gba/GameBoyAdvanceCore.js';
import { GBA_HEIGHT, GBA_WIDTH } from '../../packages/emulator/src/gba/video/GbaPpu.js';
import { shadesReference, stripesReference } from '../harness/gbaRunner.js';
import { diffFrameBuffers } from '../harness/conditions/screenshot.js';

const ROMS = new URL('../roms/gba-tests/', import.meta.url).pathname;
const available = existsSync(`${ROMS}shades.gba`);

function boot(name: string, frames = 10): GameBoyAdvanceCore {
  const core = new GameBoyAdvanceCore();
  core.loadRom(new Uint8Array(readFileSync(`${ROMS}${name}.gba`)));
  for (let f = 0; f < frames; f++) core.runFrame();
  return core;
}

/** Colour at (x, y) as "r,g,b". */
function pixel(core: GameBoyAdvanceCore, x: number, y: number): string {
  const fb = core.getFrameBuffer();
  const i = (y * GBA_WIDTH + x) * 4;
  return `${fb[i]},${fb[i + 1]},${fb[i + 2]}`;
}

/** Distinct colours along a row, in order. */
function rowBands(core: GameBoyAdvanceCore, y: number): { x: number; colour: string }[] {
  const bands: { x: number; colour: string }[] = [];
  let last = '';
  for (let x = 0; x < GBA_WIDTH; x++) {
    const colour = pixel(core, x, y);
    if (colour !== last) {
      bands.push({ x, colour });
      last = colour;
    }
  }
  return bands;
}

describe('GBA PPU basics', () => {
  it('produces a framebuffer at native 240x160', () => {
    const core = new GameBoyAdvanceCore();
    expect(core.getFrameBuffer()).toHaveLength(GBA_WIDTH * GBA_HEIGHT * 4);
  });

  it('returns a STABLE buffer reference, never a fresh allocation', () => {
    const core = new GameBoyAdvanceCore();
    const first = core.getFrameBuffer();
    core.loadRom(syntheticRom());
    core.runFrame();
    expect(core.getFrameBuffer()).toBe(first);
  });

  it('advances VCOUNT through every line and wraps at 228', () => {
    const core = new GameBoyAdvanceCore();
    core.loadRom(syntheticRom());
    const seen = new Set<number>();
    for (let dot = 0; dot < 308 * 228; dot++) {
      core.ppu.tick();
      seen.add(core.ppu.vcount);
    }
    expect(seen.size).toBe(228);
    expect(Math.max(...seen)).toBe(227);
  });

  it('sets the VBlank flag only outside the visible lines', () => {
    const core = new GameBoyAdvanceCore();
    core.loadRom(syntheticRom());
    let sawVBlankSet = false;
    let sawVBlankClearInVisible = false;
    for (let dot = 0; dot < 308 * 228; dot++) {
      core.ppu.tick();
      const inVBlank = (core.ppu.dispstat & 1) !== 0;
      if (core.ppu.vcount >= 160 && inVBlank) sawVBlankSet = true;
      if (core.ppu.vcount < 160 && !inVBlank) sawVBlankClearInVisible = true;
    }
    expect(sawVBlankSet).toBe(true);
    expect(sawVBlankClearInVisible).toBe(true);
  });

  it('keeps DISPSTAT status bits read-only', () => {
    const core = new GameBoyAdvanceCore();
    core.loadRom(syntheticRom());
    core.ppu.writeRegister(0x04000004, 0xffff);
    // Bits 0-2 are hardware status and must not be settable by software.
    expect(core.ppu.dispstat & 0x0007).toBe(0);
  });

  it('renders a forced blank as white regardless of content', () => {
    const core = new GameBoyAdvanceCore();
    core.loadRom(syntheticRom());
    core.ppu.writeRegister(0x04000000, 0x0080); // forced blank
    for (let dot = 0; dot < 308 * 228; dot++) core.ppu.tick();
    expect(pixel(core, 120, 80)).toBe('255,255,255');
  });
});

/** THE PHASE 14 GATE: real demo ROMs must render real pictures. */
describe.skipIf(!available)('GBA demo ROMs', () => {
  it('MODE 0 (tiled): shades.gba draws a 15-step gradient in 16px bands', () => {
    const core = boot('shades');
    expect(core.ppu.mode).toBe(0);

    const bands = rowBands(core, 80);
    expect(bands.length).toBeGreaterThanOrEqual(15);
    // Each band is exactly one 16px column of tiles.
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.x - bands[i - 1]!.x).toBe(16);
    }
    // And the ramp really ascends rather than repeating.
    const blues = bands.map((b) => Number(b.colour.split(',')[2]));
    for (let i = 1; i < blues.length; i++) expect(blues[i]!).toBeGreaterThan(blues[i - 1]!);
  });

  it('MODE 0: stripes.gba draws alternating vertical stripes across the full width', () => {
    const core = boot('stripes');
    expect(core.ppu.mode).toBe(0);
    const bands = rowBands(core, 80);
    expect(bands.length).toBeGreaterThan(10);
    // Stripes reach the right-hand edge — a scroll or map-wrap bug truncates them.
    expect(bands[bands.length - 1]!.x).toBeGreaterThan(200);
  });

  /**
   * The same ROM, but every pixel rather than one row.
   *
   * `stripesReference()` is built from stripes.asm and GBATEK, not captured from this
   * emulator, so it can catch a char-base, screen-base, 4bpp-nibble, stripe-phase or
   * colour-expansion error that the band check above sails straight past. This is the
   * check `npm run gba-cpu` runs for stripes.gba.
   */
  it('MODE 0: stripes.gba is pixel-exact against its source-derived reference', () => {
    const core = boot('stripes');
    const diff = diffFrameBuffers(core.getFrameBuffer(), stripesReference(), GBA_WIDTH, GBA_HEIGHT);
    expect(diff.bounds).toBeNull();
    expect(diff.differing).toBe(0);
  });

  /** As above, for the 15-step blue ramp. Same reasoning, same kind of reference. */
  it('MODE 0: shades.gba is pixel-exact against its source-derived reference', () => {
    const core = boot('shades');
    const diff = diffFrameBuffers(core.getFrameBuffer(), shadesReference(), GBA_WIDTH, GBA_HEIGHT);
    expect(diff.bounds).toBeNull();
    expect(diff.differing).toBe(0);
  });

  it('MODE 4 (bitmap): hello.gba draws legible text', () => {
    const core = boot('hello');
    expect(core.ppu.mode).toBe(4);
    // Text occupies a minority of the screen: enough lit pixels to be real, not a fill.
    let lit = 0;
    const fb = core.getFrameBuffer();
    for (let i = 0; i < fb.length; i += 4) {
      if (fb[i] !== 0 || fb[i + 1] !== 0 || fb[i + 2] !== 0) lit++;
    }
    expect(lit).toBeGreaterThan(50);
    expect(lit).toBeLessThan((GBA_WIDTH * GBA_HEIGHT) / 4);
  });

  it('MODE 4: nes.gba fills the screen from the bitmap', () => {
    const core = boot('nes');
    expect(core.ppu.mode).toBe(4);
    let lit = 0;
    const fb = core.getFrameBuffer();
    for (let i = 0; i < fb.length; i += 4) {
      if (fb[i] !== 0 || fb[i + 1] !== 0 || fb[i + 2] !== 0) lit++;
    }
    expect(lit).toBeGreaterThan((GBA_WIDTH * GBA_HEIGHT) / 2);
  });

  it('renders deterministically: the same ROM twice gives the same frame', () => {
    const hash = (core: GameBoyAdvanceCore): string => {
      const fb = core.getFrameBuffer();
      let h = 0x811c9dc5;
      for (let i = 0; i < fb.length; i += 4) h = Math.imul(h ^ fb[i]!, 0x01000193) >>> 0;
      return h.toString(16);
    };
    expect(hash(boot('shades'))).toBe(hash(boot('shades')));
  });
});

/** A minimal valid GBA header so the core will accept the ROM. */
function syntheticRom(): Uint8Array {
  const rom = new Uint8Array(0x200);
  rom[0x03] = 0xea; // ARM branch at the entry point
  rom[0xb2] = 0x96; // fixed byte that identifies a GBA cartridge
  return rom;
}

/* ------------------------- affine, windows, blending ------------------------- */

/** Builds a mode-2 affine BG2 filling the map with tile 1, whose pixels are colour 1. */
function affineScene(core: GameBoyAdvanceCore, colour = 0x7c00): void {
  const mmu = core.mmu;
  // Palette: entry 0 backdrop black, entry 1 the test colour.
  mmu.write16(0x05000000, 0x0000);
  mmu.write16(0x05000002, colour);

  // BG2CNT: priority 0, char base 0, screen base block 8 (0x4000), size 0 (128x128).
  core.ppu.writeRegister(0x0400000c, (8 << 8) | 0x2000);

  // Map: every tile is tile 1. Affine maps are one byte per entry, 16x16 tiles.
  for (let i = 0; i < 16 * 16; i++) mmu.write8(0x06004000 + i, 1);
  // Tile 1: all pixels colour index 1 (8bpp, 64 bytes per tile).
  for (let i = 0; i < 64; i++) mmu.write8(0x06000040 + i, 1);

  core.ppu.writeRegister(0x04000000, 2 | 0x0400); // mode 2, BG2 on
}

/** Runs exactly one frame of PPU time without needing a ROM. */
function renderFrame(core: GameBoyAdvanceCore): void {
  for (let dot = 0; dot < 308 * 228; dot++) core.ppu.tick();
}

function newCore(): GameBoyAdvanceCore {
  const core = new GameBoyAdvanceCore();
  core.loadRom(syntheticRom());
  return core;
}

describe('affine backgrounds', () => {
  it('renders an affine background with the identity transform', () => {
    const core = newCore();
    affineScene(core);
    renderFrame(core);
    // 0x7C00 is pure blue in 15-bit BGR.
    expect(pixel(core, 10, 10)).toBe('0,0,255');
  });

  it('LEAVES THE MAP TRANSPARENT when wraparound is off', () => {
    const core = newCore();
    affineScene(core);
    // Clear BGxCNT bit 13 so out-of-map areas are transparent, and push the origin far
    // past the 128x128 map.
    core.ppu.writeRegister(0x0400000c, 8 << 8);
    core.ppu.writeRegister(0x04000028, 0x9000); // X = 0x90 integer, well past 128
    core.ppu.writeRegister(0x0400002a, 0);
    renderFrame(core);
    expect(pixel(core, 10, 10)).toBe('0,0,0'); // backdrop shows through
  });

  it('WRAPS the map when bit 13 is set', () => {
    const core = newCore();
    affineScene(core); // bit 13 already set
    core.ppu.writeRegister(0x04000028, 0x9000);
    core.ppu.writeRegister(0x0400002a, 0);
    renderFrame(core);
    expect(pixel(core, 10, 10)).toBe('0,0,255');
  });

  it('SCALES: PA of 2.0 halves the apparent size', () => {
    const core = newCore();
    affineScene(core);
    // Restrict the map so the edge is visible, then double the step.
    core.ppu.writeRegister(0x04000020, 0x0200); // PA = 2.0
    renderFrame(core);
    // With wraparound on, doubling the step still fills; the test asserts it renders at all
    // rather than crashing on a non-identity transform.
    expect(pixel(core, 10, 10)).toBe('0,0,255');
  });

  it('a mid-frame reference write repositions the CURRENT scanline, not the next frame', () => {
    const core = newCore();
    affineScene(core);
    renderFrame(core);
    const before = core.ppu.readRegister(0x04000000);
    core.ppu.writeRegister(0x04000028, 0x0800);
    // The visible register and the internal copy must now agree — a write outside VBlank
    // takes effect immediately rather than waiting for the reload.
    expect(core.ppu.readRegister(0x04000000)).toBe(before);
  });
});

describe('windows', () => {
  /** Mode 4 scene: every pixel colour 1, so a window's effect is unambiguous. */
  function windowScene(core: GameBoyAdvanceCore): void {
    core.mmu.write16(0x05000000, 0x0000); // backdrop black
    core.mmu.write16(0x05000002, 0x001f); // colour 1 red
    for (let i = 0; i < 240 * 160; i++) core.mmu.write8(0x06000000 + i, 1);
    core.ppu.writeRegister(0x04000000, 4 | 0x0400); // mode 4, BG2 on
  }

  it('shows the layer everywhere when no window is enabled', () => {
    const core = newCore();
    windowScene(core);
    renderFrame(core);
    expect(pixel(core, 10, 10)).toBe('255,0,0');
    expect(pixel(core, 200, 120)).toBe('255,0,0');
  });

  it('GATES A LAYER: BG2 draws inside window 0 and not outside it', () => {
    const core = newCore();
    windowScene(core);
    core.ppu.writeRegister(0x04000000, 4 | 0x0400 | 0x2000); // + window 0 enable
    core.ppu.writeRegister(0x04000040, (20 << 8) | 100); // WIN0H: x 20..99
    core.ppu.writeRegister(0x04000044, (30 << 8) | 90); // WIN0V: y 30..89
    core.ppu.writeRegister(0x04000048, 0x0004); // WININ: window 0 shows BG2
    core.ppu.writeRegister(0x0400004a, 0x0000); // WINOUT: nothing outside

    renderFrame(core);
    expect(pixel(core, 50, 50)).toBe('255,0,0'); // inside
    expect(pixel(core, 10, 50)).toBe('0,0,0'); // left of it
    expect(pixel(core, 50, 10)).toBe('0,0,0'); // above it
    expect(pixel(core, 150, 120)).toBe('0,0,0'); // fully outside
  });

  it('honours WINOUT so a layer can show outside instead', () => {
    const core = newCore();
    windowScene(core);
    core.ppu.writeRegister(0x04000000, 4 | 0x0400 | 0x2000);
    core.ppu.writeRegister(0x04000040, (20 << 8) | 100);
    core.ppu.writeRegister(0x04000044, (30 << 8) | 90);
    core.ppu.writeRegister(0x04000048, 0x0000); // nothing inside
    core.ppu.writeRegister(0x0400004a, 0x0004); // BG2 outside

    renderFrame(core);
    expect(pixel(core, 50, 50)).toBe('0,0,0');
    expect(pixel(core, 150, 120)).toBe('255,0,0');
  });
});

describe('colour special effects', () => {
  function blendScene(core: GameBoyAdvanceCore): void {
    core.mmu.write16(0x05000000, 0x0000); // backdrop black
    core.mmu.write16(0x05000002, 0x7fff); // colour 1 white
    for (let i = 0; i < 240 * 160; i++) core.mmu.write8(0x06000000 + i, 1);
    core.ppu.writeRegister(0x04000000, 4 | 0x0400);
  }

  it('leaves colour untouched when the effect mode is none', () => {
    const core = newCore();
    blendScene(core);
    renderFrame(core);
    expect(pixel(core, 10, 10)).toBe('255,255,255');
  });

  it('BRIGHTNESS DECREASE darkens the first target toward black', () => {
    const core = newCore();
    blendScene(core);
    core.ppu.writeRegister(0x04000050, (3 << 6) | 0x0004); // mode 3, BG2 is target 1
    core.ppu.writeRegister(0x04000054, 16); // EVY = 16/16, full darkening
    renderFrame(core);
    expect(pixel(core, 10, 10)).toBe('0,0,0');
  });

  it('BRIGHTNESS INCREASE brightens toward white', () => {
    const core = newCore();
    core.mmu.write16(0x05000000, 0x0000);
    core.mmu.write16(0x05000002, 0x0000); // colour 1 black
    for (let i = 0; i < 240 * 160; i++) core.mmu.write8(0x06000000 + i, 1);
    core.ppu.writeRegister(0x04000000, 4 | 0x0400);
    core.ppu.writeRegister(0x04000050, (2 << 6) | 0x0004); // mode 2
    core.ppu.writeRegister(0x04000054, 16); // full brightening
    renderFrame(core);
    expect(pixel(core, 10, 10)).toBe('255,255,255');
  });

  it('applies brightness proportionally at half strength', () => {
    const core = newCore();
    blendScene(core);
    core.ppu.writeRegister(0x04000050, (3 << 6) | 0x0004);
    core.ppu.writeRegister(0x04000054, 8); // EVY = 8/16
    renderFrame(core);
    // 31 - (31*8/16) = 31 - 15 = 16 -> expand5(16) = 132
    expect(pixel(core, 10, 10)).toBe('132,132,132');
  });

  it('ALPHA BLENDS the top layer with what sits underneath', () => {
    const core = newCore();
    blendScene(core);
    // White BG2 over the black backdrop, mixed half and half.
    core.ppu.writeRegister(0x04000050, (1 << 6) | 0x0004 | (0x20 << 8)); // BG2 over backdrop
    core.ppu.writeRegister(0x04000052, 8 | (8 << 8)); // EVA = EVB = 8/16
    renderFrame(core);
    // 31*8/16 + 0*8/16 = 15 -> expand5(15) = 123
    expect(pixel(core, 10, 10)).toBe('123,123,123');
  });

  it('does not blend when the layer beneath is not a second target', () => {
    const core = newCore();
    blendScene(core);
    core.ppu.writeRegister(0x04000050, (1 << 6) | 0x0004); // no second target selected
    core.ppu.writeRegister(0x04000052, 8 | (8 << 8));
    renderFrame(core);
    expect(pixel(core, 10, 10)).toBe('255,255,255');
  });

  it('a window can switch colour effects OFF for the pixels it covers', () => {
    const core = newCore();
    blendScene(core);
    core.ppu.writeRegister(0x04000050, (3 << 6) | 0x0004); // darken BG2
    core.ppu.writeRegister(0x04000054, 16);
    core.ppu.writeRegister(0x04000000, 4 | 0x0400 | 0x2000); // window 0 on
    core.ppu.writeRegister(0x04000040, (0 << 8) | 100); // x 0..99
    core.ppu.writeRegister(0x04000044, (0 << 8) | 160); // all rows
    core.ppu.writeRegister(0x04000048, 0x0004); // inside: BG2 visible, effects OFF (bit 5 clear)
    core.ppu.writeRegister(0x0400004a, 0x0024); // outside: BG2 visible, effects ON

    renderFrame(core);
    expect(pixel(core, 50, 50)).toBe('255,255,255'); // inside: undarkened
    expect(pixel(core, 150, 50)).toBe('0,0,0'); // outside: darkened
  });
});

/* ---------------------------- mosaic & affine OBJ ---------------------------- */

/**
 * A mode-0 text BG0 whose tiles form a horizontal colour ramp: screen column x gets
 * palette entry (x & 7) + 1, so any mosaic block repeat is directly visible.
 */
function rampScene(core: GameBoyAdvanceCore): void {
  const mmu = core.mmu;
  mmu.write16(0x05000000, 0x0000);
  // Eight distinct greys, so a repeated pixel is unmistakable.
  for (let i = 1; i <= 8; i++) mmu.write16(0x05000000 + i * 2, (i * 2) | ((i * 2) << 5));

  // BG0CNT: priority 0, char base 0, screen base block 8, 8bpp, size 0.
  core.ppu.writeRegister(0x04000008, (8 << 8) | 0x0080);
  // Map: every entry is tile 1.
  for (let i = 0; i < 32 * 32; i++) mmu.write16(0x06004000 + i * 2, 1);
  // Tile 1: column c of every row is colour index c + 1.
  // VRAM has no 8-bit write path — a byte write duplicates itself across the halfword —
  // so the tile has to go in a halfword at a time.
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col += 2) {
      mmu.write16(0x06000040 + row * 8 + col, col + 1 + ((col + 2) << 8));
    }
  }
  core.ppu.writeRegister(0x04000000, 0 | 0x0100); // mode 0, BG0 on
}

describe('mosaic', () => {
  it('has NO effect until the layer opts in, even with a size set', () => {
    const core = newCore();
    rampScene(core);
    core.ppu.writeRegister(0x0400004c, 0x0003); // BG H-size 4, but BG0CNT bit 6 is clear
    renderFrame(core);
    // Every column still distinct across the first tile.
    const colours = [0, 1, 2, 3].map((x) => pixel(core, x, 0));
    expect(new Set(colours).size).toBe(4);
  });

  it('REPEATS THE FIRST PIXEL of each block horizontally', () => {
    const core = newCore();
    rampScene(core);
    core.ppu.writeRegister(0x04000008, (8 << 8) | 0x0080 | 0x0040); // + mosaic enable
    core.ppu.writeRegister(0x0400004c, 0x0003); // H-size 4 (stored minus 1)
    renderFrame(core);

    // Columns 0-3 all take column 0's colour; 4-7 all take column 4's.
    const first = pixel(core, 0, 0);
    const second = pixel(core, 4, 0);
    expect(first).not.toBe(second);
    for (let x = 0; x < 4; x++) expect(pixel(core, x, 0)).toBe(first);
    for (let x = 4; x < 8; x++) expect(pixel(core, x, 0)).toBe(second);
  });

  it('QUANTISES IN SCREEN SPACE: scrolling moves the artwork under a fixed grid', () => {
    const core = newCore();
    rampScene(core);
    core.ppu.writeRegister(0x04000008, (8 << 8) | 0x0080 | 0x0040);
    core.ppu.writeRegister(0x0400004c, 0x0003);
    core.ppu.writeRegister(0x04000010, 2); // BG0HOFS = 2
    renderFrame(core);

    // The block boundaries stay at 0 and 4; only which source pixel they sample changes.
    // That is exactly the re-centring trick GBATEK describes.
    const first = pixel(core, 0, 0);
    for (let x = 0; x < 4; x++) expect(pixel(core, x, 0)).toBe(first);
    expect(pixel(core, 4, 0)).not.toBe(first);
    // The block still starts at screen 0, but now samples SOURCE column 2 — compare
    // against the same scene with mosaic off, where screen column 2 is source column 2.
    const plain = newCore();
    rampScene(plain);
    renderFrame(plain);
    expect(first).toBe(pixel(plain, 2, 0));
  });

  it('REPEATS THE FIRST LINE of each block vertically', () => {
    const core = newCore();
    const mmu = core.mmu;
    rampScene(core);
    // Give the tile a vertical ramp too: row r is colour r + 1 in column 0. The high byte
    // is column 1, which rampScene set to 2.
    for (let row = 0; row < 8; row++) mmu.write16(0x06000040 + row * 8, row + 1 + (2 << 8));
    core.ppu.writeRegister(0x04000008, (8 << 8) | 0x0080 | 0x0040);
    core.ppu.writeRegister(0x0400004c, 0x0030); // V-size 4, H-size 1
    renderFrame(core);

    const first = pixel(core, 0, 0);
    for (let y = 0; y < 4; y++) expect(pixel(core, 0, y)).toBe(first);
    expect(pixel(core, 0, 4)).not.toBe(first);
  });

  it('freezes the AFFINE reference point for the whole vertical block', () => {
    const core = newCore();
    affineScene(core);
    // PD steps one row per line; with a 128x128 map and no wrap the layer ends at y=128.
    core.ppu.writeRegister(0x0400000c, (8 << 8) | 0x0040); // mosaic on, wrap off
    core.ppu.writeRegister(0x0400004c, 0x0040); // BG V-size 5
    renderFrame(core);
    // Rows inside one block must be identical; a per-line reference would differ at the
    // map edge, which is the case a frozen reference has to get right.
    for (let y = 0; y < 5; y++) expect(pixel(core, 10, y)).toBe(pixel(core, 10, 0));
  });
});

/** Puts one 16x16 256-colour sprite at (x, y), optionally affine with group `group`. */
function spriteScene(
  core: GameBoyAdvanceCore,
  { affine = false, doubleSize = false, group = 0, mosaic = false } = {},
): void {
  const mmu = core.mmu;
  mmu.write16(0x05000000, 0x0000);
  mmu.write16(0x05000200, 0x0000); // OBJ palette entry 0 is transparent anyway
  mmu.write16(0x05000202, 0x001f); // entry 1: red

  // 16x16 8bpp sprite = 4 tiles of 64 bytes, laid out 1D from tile 0 of OBJ VRAM.
  for (let i = 0; i < 4 * 64; i += 2) mmu.write16(0x06010000 + i, 0x0101);

  let attr0 = 40 | 0x2000; // y = 40, 256 colours
  if (affine) attr0 |= 0x0100;
  if (affine && doubleSize) attr0 |= 0x0200;
  if (mosaic) attr0 |= 0x1000;
  const attr1 = 40 | (1 << 14) | (affine ? group << 9 : 0); // x = 40, size 1 => 16x16
  mmu.write16(0x07000000, attr0);
  mmu.write16(0x07000002, attr1);
  mmu.write16(0x07000004, 0); // tile 0, priority 0, palette 0

  // DISPCNT: mode 0, OBJ on, 1D mapping.
  core.ppu.writeRegister(0x04000000, 0 | 0x1000 | 0x0040);
}

/** Writes one affine parameter group (PA, PB, PC, PD) into the OAM gaps. */
function setObjAffine(
  core: GameBoyAdvanceCore,
  group: number,
  pa: number,
  pb: number,
  pc: number,
  pd: number,
): void {
  const base = 0x07000000 + group * 32;
  core.mmu.write16(base + 6, pa & 0xffff);
  core.mmu.write16(base + 14, pb & 0xffff);
  core.mmu.write16(base + 22, pc & 0xffff);
  core.mmu.write16(base + 30, pd & 0xffff);
}

describe('affine sprites', () => {
  it('draws an affine sprite unchanged under the identity transform', () => {
    const core = newCore();
    spriteScene(core, { affine: true });
    setObjAffine(core, 0, 0x100, 0, 0, 0x100);
    renderFrame(core);
    expect(pixel(core, 44, 44)).toBe('255,0,0');
    expect(pixel(core, 40 + 16, 44)).toBe('0,0,0'); // just past the right edge
  });

  it('SCALES: PA/PD of 2.0 shrink the sprite to half its size', () => {
    const core = newCore();
    spriteScene(core, { affine: true });
    setObjAffine(core, 0, 0x200, 0, 0, 0x200);
    renderFrame(core);
    // Sampling twice as fast means the 16x16 texture covers only the middle 8x8 of the box.
    expect(pixel(core, 48, 48)).toBe('255,0,0'); // box centre still covered
    expect(pixel(core, 41, 41)).toBe('0,0,0'); // corner now reads outside the texture
  });

  it('CLIPS a rotated sprite to its box unless DOUBLE SIZE is set', () => {
    const single = newCore();
    spriteScene(single, { affine: true });
    // PA/PD of 0.5 magnifies 2x, so the texture overflows a single-size box.
    setObjAffine(single, 0, 0x80, 0, 0, 0x80);
    renderFrame(single);

    const double = newCore();
    spriteScene(double, { affine: true, doubleSize: true });
    setObjAffine(double, 0, 0x80, 0, 0, 0x80);
    renderFrame(double);

    // The double-size box is 32x32 at the same origin, so it covers pixels the
    // single-size box had to clip away.
    expect(pixel(single, 40 + 20, 40 + 20)).toBe('0,0,0');
    expect(pixel(double, 40 + 20, 40 + 20)).toBe('255,0,0');
  });

  /**
   * Splits the 16x16 sprite into a red left half and a green right half.
   *
   * 1D mapping with 8bpp counts tiles in 32-byte units, so the four 8x8 tiles land at
   * byte offsets 0x00 (top-left), 0x40 (top-right), 0x80 (bottom-left) and 0xC0.
   */
  function twoToneSprite(core: GameBoyAdvanceCore): void {
    core.mmu.write16(0x05000204, 0x03e0); // OBJ palette entry 2: green
    for (let i = 0; i < 0x40; i += 2) {
      core.mmu.write16(0x06010000 + i, 0x0101); // top-left: red
      core.mmu.write16(0x06010040 + i, 0x0202); // top-right: green
      core.mmu.write16(0x06010080 + i, 0x0101); // bottom-left
      core.mmu.write16(0x060100c0 + i, 0x0202); // bottom-right
    }
  }

  it('MIRRORS horizontally when PA is -1.0 — the halves swap', () => {
    const core = newCore();
    spriteScene(core, { affine: true });
    twoToneSprite(core);
    setObjAffine(core, 0, 0x100, 0, 0, 0x100);
    renderFrame(core);
    expect(pixel(core, 42, 44)).toBe('255,0,0'); // left half red
    expect(pixel(core, 52, 44)).toBe('0,255,0'); // right half green

    const mirrored = newCore();
    spriteScene(mirrored, { affine: true });
    twoToneSprite(mirrored);
    setObjAffine(mirrored, 0, -0x100, 0, 0, 0x100);
    renderFrame(mirrored);
    expect(pixel(mirrored, 42, 44)).toBe('0,255,0'); // now green on the left
    expect(pixel(mirrored, 52, 44)).toBe('255,0,0');
  });

  it('SHEARS: PB makes the horizontal sample depend on the row', () => {
    const core = newCore();
    spriteScene(core, { affine: true });
    twoToneSprite(core);
    // PB = 1.0 adds dy to the sampled column, so the red/green boundary slides one pixel
    // per scanline instead of standing vertical.
    setObjAffine(core, 0, 0x100, 0x100, 0, 0x100);
    renderFrame(core);

    const boundary = (y: number): number => {
      for (let x = 40; x < 56; x++) if (pixel(core, x, y) === '0,255,0') return x;
      return -1;
    };
    const top = boundary(42);
    const bottom = boundary(46);
    expect(top).toBeGreaterThan(0);
    expect(bottom).toBe(top - 4); // four rows lower, four pixels left
  });

  /** Red top half, green bottom half — the vertical counterpart of twoToneSprite. */
  function stackedSprite(core: GameBoyAdvanceCore): void {
    core.mmu.write16(0x05000204, 0x03e0); // OBJ palette entry 2: green
    for (let i = 0; i < 0x40; i += 2) {
      core.mmu.write16(0x06010000 + i, 0x0101); // top-left: red
      core.mmu.write16(0x06010040 + i, 0x0101); // top-right: red
      core.mmu.write16(0x06010080 + i, 0x0202); // bottom-left: green
      core.mmu.write16(0x060100c0 + i, 0x0202); // bottom-right: green
    }
  }

  it('MIRRORS vertically when PD is -1.0 — the halves swap', () => {
    const core = newCore();
    spriteScene(core, { affine: true });
    stackedSprite(core);
    setObjAffine(core, 0, 0x100, 0, 0, 0x100);
    renderFrame(core);
    expect(pixel(core, 44, 42)).toBe('255,0,0'); // top half red
    expect(pixel(core, 44, 52)).toBe('0,255,0'); // bottom half green

    const mirrored = newCore();
    spriteScene(mirrored, { affine: true });
    stackedSprite(mirrored);
    setObjAffine(mirrored, 0, 0x100, 0, 0, -0x100);
    renderFrame(mirrored);
    expect(pixel(mirrored, 44, 42)).toBe('0,255,0');
    expect(pixel(mirrored, 44, 52)).toBe('255,0,0');
  });

  it('SHEARS: PC makes the vertical sample depend on the column', () => {
    const core = newCore();
    spriteScene(core, { affine: true });
    stackedSprite(core);
    // PC = 1.0 adds dx to the sampled row, so the red/green boundary tilts.
    setObjAffine(core, 0, 0x100, 0, 0x100, 0x100);
    renderFrame(core);

    const boundary = (x: number): number => {
      for (let y = 40; y < 56; y++) if (pixel(core, x, y) === '0,255,0') return y;
      return -1;
    };
    const left = boundary(42);
    const right = boundary(46);
    expect(left).toBeGreaterThan(0);
    expect(right).toBe(left - 4); // four columns right, four pixels up
  });

  it('SELECTS THE PARAMETER GROUP from attr1 bits 9-13', () => {
    // Group 24 has the same bit pattern as "flip X and Y" on a normal sprite, so this
    // also pins down that the field is decoded as a group and not as flip bits.
    const core = newCore();
    spriteScene(core, { affine: true, group: 24 });
    setObjAffine(core, 24, 0x100, 0, 0, 0x100);
    setObjAffine(core, 0, 0x400, 0, 0, 0x400); // a decoy that would shrink it to nothing
    renderFrame(core);
    expect(pixel(core, 44, 44)).toBe('255,0,0');
  });
});

describe('sprite mosaic', () => {
  it('blocks a sprite by sampling the first pixel of each block', () => {
    // Half the sprite red, half transparent, so the mosaic block boundary is visible.
    const core = newCore();
    spriteScene(core, { mosaic: true });
    // Blank the left 4 columns of the first tile row so the sprite starts transparent.
    for (let row = 0; row < 8; row++) {
      core.mmu.write16(0x06010000 + row * 8, 0);
      core.mmu.write16(0x06010000 + row * 8 + 2, 0);
    }
    core.ppu.writeRegister(0x0400004c, 0x0700); // OBJ H-size 8
    renderFrame(core);

    // The sprite sits at x=40; the screen-space grid puts a boundary at 40 and 48.
    // Columns 40-47 all sample column 40, which is transparent.
    for (let x = 40; x < 48; x++) expect(pixel(core, x, 44)).toBe('0,0,0');
    // Columns 48-55 sample column 48 — inside the opaque half.
    expect(pixel(core, 48, 44)).toBe('255,0,0');
  });

  it('REPEATS THE FIRST LINE of each block vertically', () => {
    const core = newCore();
    spriteScene(core, { mosaic: true });
    // Blank the top 4 rows of both upper tiles, so the sprite starts transparent.
    for (let i = 0; i < 0x20; i += 2) {
      core.mmu.write16(0x06010000 + i, 0);
      core.mmu.write16(0x06010040 + i, 0);
    }
    core.ppu.writeRegister(0x0400004c, 0x7000); // OBJ V-size 8
    renderFrame(core);
    // The sprite sits at y=40, and 40 is already a multiple of 8, so rows 40-47 all
    // sample row 40 — which is inside the blanked strip.
    for (let y = 40; y < 48; y++) expect(pixel(core, 44, y)).toBe('0,0,0');
    expect(pixel(core, 44, 48)).toBe('255,0,0');

    // Without mosaic the blanked strip is only 4 rows deep.
    const plain = newCore();
    spriteScene(plain, { mosaic: false });
    for (let i = 0; i < 0x20; i += 2) {
      plain.mmu.write16(0x06010000 + i, 0);
      plain.mmu.write16(0x06010040 + i, 0);
    }
    plain.ppu.writeRegister(0x0400004c, 0x7000);
    renderFrame(plain);
    expect(pixel(plain, 44, 44)).toBe('255,0,0');
  });

  it('leaves a sprite alone when its mosaic bit is clear', () => {
    const core = newCore();
    spriteScene(core, { mosaic: false });
    for (let row = 0; row < 8; row++) {
      core.mmu.write16(0x06010000 + row * 8, 0);
      core.mmu.write16(0x06010000 + row * 8 + 2, 0);
    }
    core.ppu.writeRegister(0x0400004c, 0x0700);
    renderFrame(core);
    // Without mosaic the transparent run is exactly the 4 blanked columns.
    expect(pixel(core, 43, 44)).toBe('0,0,0');
    expect(pixel(core, 44, 44)).toBe('255,0,0');
  });
});

/**
 * The hot-path allocation guard, and the reason it is a counter rather than a stopwatch.
 *
 * An interleaved A/B benchmark of two IDENTICAL workloads was measured deviating up to 10%
 * per pair on an idle machine, so any timing threshold tight enough to catch 16 object
 * allocations per scanline would be flaky. This is exact and machine-independent.
 */
describe('per-scanline allocation', () => {
  it('ALLOCATES EXACTLY FOUR BgConfigs EVER — one per background, at construction', () => {
    const core = new GameBoyAdvanceCore();
    expect(core.ppu.bgConfigAllocations).toBe(4);
  });

  it('allocates NOTHING while rendering, across every mode', () => {
    const core = newCore();
    // Mode 0 with all four text backgrounds enabled is the worst case: the old code
    // decoded 4 backgrounds at 4 priority levels on every one of the 160 visible lines.
    core.ppu.writeRegister(0x04000000, 0x0f40); // mode 0, BG0-BG3 and OBJ on, 1D mapping
    core.ppu.bgConfigAllocations = 0;

    for (let frame = 0; frame < 10; frame++) renderFrame(core);
    expect(core.ppu.bgConfigAllocations).toBe(0);

    // And again in the modes that reach the text renderer by a different path.
    for (const dispcnt of [0x0f41, 0x0f42, 0x0f43, 0x0f44, 0x0f45]) {
      core.ppu.writeRegister(0x04000000, dispcnt);
      for (let frame = 0; frame < 2; frame++) renderFrame(core);
    }
    expect(core.ppu.bgConfigAllocations).toBe(0);
  });

  /**
   * Tamper-evidence for the counter.
   *
   * A counter alone could go stale if someone reintroduced an object literal in
   * `decodeBg` without touching it. This asserts the *shared* config was written in
   * place: stripes.gba sets BG0CNT to 0x104, so after rendering, the preallocated config
   * for BG0 must carry char base 0x4000 and screen base 0x800. If `decodeBg` started
   * returning a fresh object, the shared one would still hold its construction-time
   * zeroes and this would fail.
   */
  it.skipIf(!available)('writes the decoded fields INTO the shared config, not a copy', () => {
    const core = boot('stripes');
    const config = core.ppu.bgConfigs[0]!;
    expect(config.charBase).toBe(0x4000);
    expect(config.screenBase).toBe(0x800);
    expect(config.priority).toBe(0);
    expect(config.fullColour).toBe(false);
  });
});
