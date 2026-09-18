import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import {
  StateFormatError,
  STATE_MAGIC,
  STATE_VERSION,
} from '../../packages/emulator/src/gb/state/StateBuffer.js';
import { buttonBit } from '../../packages/emulator/src/gb/input/Joypad.js';
import { buildRom } from '../harness/rom.js';

const ROM = new URL('../roms/little-things-gb/tellinglys.gb', import.meta.url).pathname;
const romAvailable = existsSync(ROM);

function loadReal(): GameBoyCore {
  const core = new GameBoyCore();
  core.loadRom(new Uint8Array(readFileSync(ROM)));
  return core;
}

function synthetic(type = 0x03): GameBoyCore {
  const core = new GameBoyCore();
  core.loadRom(buildRom({ cartridgeType: type, romBanks: 4, ramSizeCode: 0x02 }));
  return core;
}

/** FNV-1a over the framebuffer — a cheap whole-screen fingerprint. */
const screenHash = (core: GameBoyCore): string => {
  const buffer = core.getFrameBuffer();
  let hash = 0x811c9dc5;
  for (let i = 0; i < buffer.length; i += 4) {
    hash = Math.imul(hash ^ buffer[i]!, 0x01000193) >>> 0;
  }
  return hash.toString(16);
};

const cpuHash = (core: GameBoyCore): string => {
  const s = core.getInspector().getCpuSnapshot();
  return [s.a, s.f, s.b, s.c, s.d, s.e, s.h, s.l, s.pc, s.sp, s.ime ? 1 : 0, s.cycles].join(':');
};

describe('save state container', () => {
  it('starts with the magic number and format version', () => {
    // The whole container is little-endian, magic included.
    const data = new DataView(synthetic().serialize());
    expect(data.getUint32(0, true)).toBe(STATE_MAGIC);
    expect(data.getUint16(4, true)).toBe(STATE_VERSION);
  });

  it('refuses a file that is not a save state', () => {
    const core = synthetic();
    const junk = new Uint8Array(64).fill(0xab);
    expect(() => core.deserialize(junk.buffer as ArrayBuffer)).toThrow(StateFormatError);
    expect(() => core.deserialize(junk.buffer as ArrayBuffer)).toThrow(/not a WebBoy save state/);
  });

  it('REFUSES A FUTURE FORMAT rather than misparsing it', () => {
    const core = synthetic();
    const state = core.serialize();
    new DataView(state).setUint16(4, STATE_VERSION + 1, true);
    expect(() => core.deserialize(state)).toThrow(/different version of WebBoy/);
  });

  it('refuses a state belonging to a different game', () => {
    const a = synthetic();
    const b = new GameBoyCore();
    b.loadRom(buildRom({ title: 'OTHER', cartridgeType: 0x03, romBanks: 4, ramSizeCode: 0x02 }));
    expect(() => b.deserialize(a.serialize())).toThrow(/different game/);
  });

  it('refuses a truncated state instead of reading past the end', () => {
    const core = synthetic();
    const full = new Uint8Array(core.serialize());
    const cut = full.slice(0, Math.floor(full.length / 2));
    expect(() => core.deserialize(cut.buffer as ArrayBuffer)).toThrow(StateFormatError);
  });

  it('refuses to save or load with no ROM', () => {
    const empty = new GameBoyCore();
    expect(() => empty.serialize()).toThrow(/No ROM is loaded/);
  });
});

/** THE PHASE 08 EXIT GATE. */
describe.skipIf(!romAvailable)('round-trip determinism', () => {
  it('SERIALIZE -> DESERIALIZE -> 1000 FRAMES is identical to running uninterrupted', () => {
    const reference = loadReal();
    for (let f = 0; f < 300; f++) reference.runFrame();

    const state = reference.serialize();

    // The reference keeps going for another 1000 frames.
    for (let f = 0; f < 1000; f++) reference.runFrame();

    // A fresh core restores the state and runs the same 1000 frames.
    const restored = loadReal();
    restored.deserialize(state);
    for (let f = 0; f < 1000; f++) restored.runFrame();

    expect(screenHash(restored)).toBe(screenHash(reference));
    expect(cpuHash(restored)).toBe(cpuHash(reference));
  });

  it('round-trips with input applied after the restore', () => {
    const reference = loadReal();
    for (let f = 0; f < 200; f++) reference.runFrame();
    const state = reference.serialize();

    const drive = (core: GameBoyCore): void => {
      for (let f = 0; f < 500; f++) {
        core.setInput(f > 100 && f < 200 ? buttonBit('start') : 0);
        core.runFrame();
      }
    };

    drive(reference);
    const restored = loadReal();
    restored.deserialize(state);
    drive(restored);

    expect(screenHash(restored)).toBe(screenHash(reference));
    expect(cpuHash(restored)).toBe(cpuHash(reference));
  });

  it('restores into the SAME core it was taken from', () => {
    const core = loadReal();
    for (let f = 0; f < 200; f++) core.runFrame();
    const state = core.serialize();
    const expected = (() => {
      for (let f = 0; f < 300; f++) core.runFrame();
      return { screen: screenHash(core), cpu: cpuHash(core) };
    })();

    core.deserialize(state);
    for (let f = 0; f < 300; f++) core.runFrame();
    expect(screenHash(core)).toBe(expected.screen);
    expect(cpuHash(core)).toBe(expected.cpu);
  });

  it('survives an export/import cycle through a byte array', () => {
    const core = loadReal();
    for (let f = 0; f < 150; f++) core.runFrame();

    // Simulate writing to a file and reading it back.
    const exported = new Uint8Array(core.serialize());
    const file = Uint8Array.from(exported);

    const restored = loadReal();
    restored.deserialize(file.buffer.slice(0) as ArrayBuffer);
    for (let f = 0; f < 200; f++) restored.runFrame();

    for (let f = 0; f < 200; f++) core.runFrame();
    expect(screenHash(restored)).toBe(screenHash(core));
  });

  it('carries cartridge RAM across the round trip', () => {
    const core = synthetic(0x03);
    core.mmu.write(0x0000, 0x0a);
    for (let i = 0; i < 32; i++) core.mmu.write(0xa000 + i, (i * 7) & 0xff);

    const state = core.serialize();

    const restored = synthetic(0x03);
    restored.deserialize(state);
    restored.mmu.write(0x0000, 0x0a);
    for (let i = 0; i < 32; i++) expect(restored.mmu.read(0xa000 + i)).toBe((i * 7) & 0xff);
  });

  it('carries VRAM, OAM and work RAM', () => {
    const core = synthetic();
    core.mmu.write(0xff40, 0x00); // LCD off so VRAM/OAM are reachable
    core.mmu.write(0x8000, 0x5a);
    core.mmu.write(0xfe00, 0x3c);
    core.mmu.write(0xc000, 0x99);
    core.mmu.write(0xff80, 0x42); // HRAM

    const restored = synthetic();
    restored.deserialize(core.serialize());
    restored.mmu.write(0xff40, 0x00);
    expect(restored.mmu.read(0x8000)).toBe(0x5a);
    expect(restored.mmu.read(0xfe00)).toBe(0x3c);
    expect(restored.mmu.read(0xc000)).toBe(0x99);
    expect(restored.mmu.read(0xff80)).toBe(0x42);
  });
});

/**
 * Game Boy Color state.
 *
 * These exist because a player reported that loading a state turned the game into
 * "graphic horror", while all twelve tests above passed. Two blind spots put together:
 *
 *  1. Every test above builds a DMG cartridge, so no CGB register was ever in a state.
 *  2. The round-trip tests save and restore at the SAME moment, in the same core. Any
 *     field that was not written to the buffer still held the right value in memory, so
 *     the restore looked perfect. Only loading a state from a DIFFERENT moment exposes
 *     it — which is the only thing a player ever does.
 *
 * So each test below overwrites the state between the save and the load. That is the
 * part that matters; without it every one of them passes against the bug.
 */
function cgbCore(): GameBoyCore {
  const core = new GameBoyCore();
  core.loadRom(buildRom({ cartridgeType: 0x03, romBanks: 4, ramSizeCode: 0x02, cgbFlag: 0x80 }));
  return core;
}

describe('save state — Game Boy Color', () => {
  it('CARRIES THE COLOUR PALETTES, which are not in the IO array', () => {
    const core = cgbCore();
    // Through the real registers, not by poking the arrays: 0xFF68-0xFF6B are intercepted
    // by the MMU, and that interception is exactly what the save missed.
    core.mmu.write(0xff68, 0x80); // BCPS: index 0, auto-increment on
    for (let i = 0; i < 64; i++) core.mmu.write(0xff69, i ^ 0x5a);
    core.mmu.write(0xff6a, 0x80); // OCPS
    for (let i = 0; i < 64; i++) core.mmu.write(0xff6b, i ^ 0xa5);

    const state = core.serialize();

    // The game plays on and repaints every colour white.
    core.mmu.write(0xff68, 0x80);
    for (let i = 0; i < 64; i++) core.mmu.write(0xff69, 0xff);
    core.mmu.write(0xff6a, 0x80);
    for (let i = 0; i < 64; i++) core.mmu.write(0xff6b, 0xff);

    core.deserialize(state);

    for (let i = 0; i < 64; i++) {
      expect(core.ppu.bgPalettes.bytes[i]).toBe(i ^ 0x5a);
      expect(core.ppu.objPalettes.bytes[i]).toBe(i ^ 0xa5);
    }
  });

  it('carries the palette write index and auto-increment flag', () => {
    const core = cgbCore();
    core.mmu.write(0xff68, 0x80 | 0x11); // index 0x11, auto-increment
    const state = core.serialize();
    core.mmu.write(0xff68, 0x00); // index 0, no auto-increment

    core.deserialize(state);

    // Reads back with bit 6 set, which is how the register always reads.
    expect(core.mmu.read(0xff68)).toBe(0x80 | 0x40 | 0x11);
  });

  it('CARRIES THE VRAM BANK, or tiles come back from the wrong bank', () => {
    const core = cgbCore();
    core.mmu.write(0xff4f, 1);
    const state = core.serialize();
    core.mmu.write(0xff4f, 0);

    core.deserialize(state);

    expect(core.ppu.vramBank).toBe(1);
  });

  it('CARRIES THE WRAM BANK, or the game reads its variables from the wrong 4KB', () => {
    const core = cgbCore();
    core.mmu.write(0xff70, 3);
    // Distinct bytes at the same address in two different banks.
    core.mmu.write(0xd000, 0xab);
    core.mmu.write(0xff70, 5);
    core.mmu.write(0xd000, 0xcd);
    core.mmu.write(0xff70, 3);

    const state = core.serialize();
    core.mmu.write(0xff70, 5);

    core.deserialize(state);

    expect(core.mmu.read(0xff70) & 0x07).toBe(3);
    expect(core.mmu.read(0xd000)).toBe(0xab);
  });

  it('carries the double-speed register', () => {
    const core = cgbCore();
    core.mmu.write(0xff4d, 0x01); // armed for a speed switch
    const state = core.serialize();
    core.mmu.write(0xff4d, 0x00);

    core.deserialize(state);

    expect(core.mmu.read(0xff4d) & 0x01).toBe(1);
  });

  it('CARRIES AN HBLANK HDMA IN FLIGHT, rather than resuming the running one', () => {
    const core = cgbCore();
    // Source 0x8000-aligned in ROM, destination in VRAM, HBlank mode, 16 blocks.
    core.mmu.write(0xff51, 0x00);
    core.mmu.write(0xff52, 0x00);
    core.mmu.write(0xff53, 0x00);
    core.mmu.write(0xff54, 0x00);
    core.mmu.write(0xff55, 0x80 | 0x0f); // bit 7 = HBlank mode, 16 blocks
    expect(core.mmu.read(0xff55) & 0x80).toBe(0); // bit 7 clear while active

    const state = core.serialize();

    // Cancel it, the way a game ending a transfer would.
    core.mmu.write(0xff55, 0x00);
    expect(core.mmu.read(0xff55) & 0x80).not.toBe(0);

    core.deserialize(state);

    // The transfer is active again, with its own remaining length.
    expect(core.mmu.read(0xff55) & 0x80).toBe(0);
  });
});
