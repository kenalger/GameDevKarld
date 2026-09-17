import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { GameBoyAdvanceCore } from '../../packages/emulator/src/gba/GameBoyAdvanceCore.js';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import {
  StateFormatError,
  STATE_MAGIC_GBA,
  STATE_VERSION,
} from '../../packages/emulator/src/gb/state/StateBuffer.js';
import { buildRom } from '../harness/rom.js';

const ROMS = new URL('../roms/gba-tests/', import.meta.url).pathname;
const available = existsSync(`${ROMS}arm.gba`);

function load(rom = 'sram'): GameBoyAdvanceCore {
  const core = new GameBoyAdvanceCore();
  core.loadRom(new Uint8Array(readFileSync(`${ROMS}${rom}.gba`)));
  return core;
}

/** FNV-1a over the framebuffer — a cheap whole-screen fingerprint. */
function screenHash(core: GameBoyAdvanceCore): string {
  const buffer = core.getFrameBuffer();
  let hash = 0x811c9dc5;
  for (let i = 0; i < buffer.length; i += 4) hash = Math.imul(hash ^ buffer[i]!, 0x01000193) >>> 0;
  return hash.toString(16);
}

function cpuHash(core: GameBoyAdvanceCore): string {
  const r = core.cpu.regs;
  return [...r.r, r.cpsr, core.cpu.cycles].join(':');
}

describe.skipIf(!available)('GBA save state container', () => {
  it('starts with the GBA magic number and format version', () => {
    const data = new DataView(load().serialize());
    expect(data.getUint32(0, true)).toBe(STATE_MAGIC_GBA);
    expect(data.getUint16(4, true)).toBe(STATE_VERSION);
  });

  it('refuses a file that is not a save state', () => {
    const junk = new Uint8Array(64).fill(0xab);
    expect(() => load().deserialize(junk.buffer as ArrayBuffer)).toThrow(/not a WebBoy save state/);
  });

  it('REFUSES A FUTURE FORMAT rather than misparsing it', () => {
    const core = load();
    const state = core.serialize();
    new DataView(state).setUint16(4, STATE_VERSION + 1, true);
    expect(() => core.deserialize(state)).toThrow(StateFormatError);
  });

  it('refuses a state belonging to a different game', () => {
    const state = load('sram').serialize();
    expect(() => load('flash64').deserialize(state)).toThrow(/different game/);
  });

  /**
   * The two systems share a buffer format and nothing else. Without distinct magics a GB
   * core would read GBA sections as its own and restore silent garbage.
   */
  it('REFUSES A GAME BOY STATE, and a Game Boy refuses a GBA one', () => {
    const gb = new GameBoyCore();
    gb.loadRom(buildRom({ cartridgeType: 0x03, romBanks: 4, ramSizeCode: 0x02 }));

    expect(() => load().deserialize(gb.serialize())).toThrow(/Game Boy save state/);
    expect(() => gb.deserialize(load().serialize())).toThrow(/Game Boy Advance save state/);
  });
});

describe.skipIf(!available)('GBA save state round-trip', () => {
  it('restores an identical machine: same screen, same CPU, same cycle count', () => {
    const core = load('arm');
    for (let i = 0; i < 12; i++) core.runFrame();

    const state = core.serialize();
    const screen = screenHash(core);
    const cpu = cpuHash(core);

    // Run on past the snapshot so the core is demonstrably somewhere else.
    for (let i = 0; i < 6; i++) core.runFrame();
    expect(cpuHash(core)).not.toBe(cpu);

    core.deserialize(state);
    expect(cpuHash(core)).toBe(cpu);
    expect(screenHash(core)).toBe(screen);
  });

  it('DIVERGES INTO THE SAME FUTURE: a restored core continues identically', () => {
    const a = load('arm');
    for (let i = 0; i < 10; i++) a.runFrame();
    const state = a.serialize();

    // Advance the original, and a second core restored from the same state.
    for (let i = 0; i < 8; i++) a.runFrame();

    const b = load('arm');
    b.deserialize(state);
    for (let i = 0; i < 8; i++) b.runFrame();

    expect(cpuHash(b)).toBe(cpuHash(a));
    expect(screenHash(b)).toBe(screenHash(a));
  });

  it('carries VRAM, IWRAM and the cartridge backup across the round trip', () => {
    const core = load('sram');
    for (let i = 0; i < 4; i++) core.runFrame();

    core.mmu.write8(0x03000100, 0x5a);
    core.mmu.write16(0x06004000, 0x1234);
    core.mmu.backup.loadSaveData(new Uint8Array(0x8000).fill(0x99));

    const state = core.serialize();

    const restored = load('sram');
    restored.deserialize(state);
    expect(restored.mmu.read8(0x03000100)).toBe(0x5a);
    expect(restored.mmu.read16(0x06004000)).toBe(0x1234);
    expect(restored.mmu.read8(0x0e000000)).toBe(0x99);
  });

  it('survives an export/import cycle through a byte array', () => {
    const core = load('arm');
    for (let i = 0; i < 8; i++) core.runFrame();
    const cpu = cpuHash(core);

    // Copy through a plain array, as IndexedDB storage would.
    const bytes = new Uint8Array(core.serialize());
    const copy = new Uint8Array(bytes);

    const restored = load('arm');
    restored.deserialize(copy.buffer as ArrayBuffer);
    expect(cpuHash(restored)).toBe(cpu);
  });
});
