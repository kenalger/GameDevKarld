import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import {
  StateFormatError,
  STATE_MAGIC,
  STATE_MAGIC_GBA,
  STATE_VERSION,
  readStateHeader,
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

/**
 * The header peek behind the slot list's "older format" marking.
 *
 * The states panel calls this for every slot it draws, so getting it wrong either hides
 * a perfectly good state or offers an unloadable one as available — and the second is how
 * the CGB corruption reached a player in the first place.
 */
describe('readStateHeader', () => {
  const header = (magic: number, version: number): Uint8Array => {
    const bytes = new Uint8Array(6);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, magic, true);
    view.setUint16(4, version, true);
    return bytes;
  };

  it('reads the version off a state this build just wrote', () => {
    const state = new Uint8Array(synthetic().serialize());
    expect(readStateHeader(state)).toEqual({ magic: STATE_MAGIC, version: STATE_VERSION });
  });

  it('reports an older format rather than refusing to read it', () => {
    // The point of the function: a version 2 state is readable ENOUGH to be labelled.
    expect(readStateHeader(header(STATE_MAGIC, 2))).toEqual({ magic: STATE_MAGIC, version: 2 });
  });

  it('recognises a GBA state, which is a different container', () => {
    expect(readStateHeader(header(STATE_MAGIC_GBA, 1))?.magic).toBe(STATE_MAGIC_GBA);
  });

  it('returns null for data that is not a save state at all', () => {
    expect(readStateHeader(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBeNull();
  });

  it('returns null rather than reading past the end of a short buffer', () => {
    expect(readStateHeader(new Uint8Array(5))).toBeNull();
    expect(readStateHeader(new Uint8Array(0))).toBeNull();
  });

  it('reads through a view with a non-zero byte offset', () => {
    // IndexedDB hands back arrays that may be views onto a larger buffer; using
    // `data.buffer` without the offset would read the wrong six bytes.
    const backing = new Uint8Array(16);
    backing.set(header(STATE_MAGIC, 7), 8);
    const view = backing.subarray(8);
    expect(readStateHeader(view)).toEqual({ magic: STATE_MAGIC, version: 7 });
  });
});

/**
 * APU state — the third sighting of the same bug shape.
 *
 * The CGB registers above lived in dedicated `Mmu` fields rather than the serialized `io`
 * array; the GBA APU's channels lived on the channel objects. The Game Boy APU section
 * was the same: it wrote the mixer registers, the sequencer step and wave RAM, and
 * NOTHING per channel. Duty, frequency, phase, every length counter, every envelope,
 * channel 1's sweep (including `sweepNegateUsed`) and channel 4's LFSR were all dropped,
 * so a restored state came back silent, stuck, or playing the wrong note.
 *
 * Every test here overwrites the audio state between the save and the load. Without that
 * step they all pass against the bug, because the fields never written to the buffer
 * still held the right values in memory.
 */
describe('save state — audio', () => {
  /** Distinctive per-channel state: a sweep, a decaying envelope, a waveform, 7-bit noise. */
  function primeAudio(core: GameBoyCore): void {
    core.mmu.write(0xff26, 0x80); // APU on
    core.mmu.write(0xff24, 0x85); // NR50: VIN left, volumes 0 and 5
    core.mmu.write(0xff25, 0x5a); // NR51: an asymmetric panning

    // Channel 1: sweep period 3 / negate / shift 2, duty 2, envelope 13 decaying.
    core.mmu.write(0xff10, 0x3a);
    core.mmu.write(0xff11, 0xa0);
    core.mmu.write(0xff12, 0xd3);
    core.mmu.write(0xff13, 0x34);
    core.mmu.write(0xff14, 0x85);

    // Channel 2: a different duty, a rising envelope, length enabled.
    core.mmu.write(0xff16, 0x50);
    core.mmu.write(0xff17, 0x3a);
    core.mmu.write(0xff18, 0x99);
    core.mmu.write(0xff19, 0xc2);

    // Channel 3: a written waveform. Wave RAM first — a write while the channel plays is
    // dropped by the hardware.
    for (let i = 0; i < 16; i++) core.mmu.write(0xff30 + i, (i * 0x11) ^ 0x3c);
    core.mmu.write(0xff1a, 0x80);
    core.mmu.write(0xff1b, 0x40);
    core.mmu.write(0xff1c, 0x40);
    core.mmu.write(0xff1d, 0x12);
    core.mmu.write(0xff1e, 0x86);

    // Channel 4: 7-bit LFSR, so the register contents alone cannot reproduce it.
    core.mmu.write(0xff20, 0x10);
    core.mmu.write(0xff21, 0xb6);
    core.mmu.write(0xff22, 0x3b);
    core.mmu.write(0xff23, 0x80);
  }

  /** What the game does next: a completely different piece of music. */
  function overwriteAudio(core: GameBoyCore): void {
    core.mmu.write(0xff26, 0x00); // power cycle: every register zeroed
    core.mmu.write(0xff26, 0x80);
    core.mmu.write(0xff24, 0x77);
    core.mmu.write(0xff25, 0xff);
    core.mmu.write(0xff10, 0x07);
    core.mmu.write(0xff11, 0x1f);
    core.mmu.write(0xff12, 0x71);
    core.mmu.write(0xff13, 0xc1);
    core.mmu.write(0xff14, 0x87);
    core.mmu.write(0xff16, 0xc0);
    core.mmu.write(0xff17, 0xf1);
    core.mmu.write(0xff19, 0x81);
    core.mmu.write(0xff1a, 0x00); // channel 3 off, so wave RAM is writable again
    for (let i = 0; i < 16; i++) core.mmu.write(0xff30 + i, 0xff);
    core.mmu.write(0xff21, 0xf1);
    core.mmu.write(0xff22, 0x00);
    core.mmu.write(0xff23, 0x80);
  }

  /**
   * Runs the APU and fingerprints what comes out.
   *
   * The four channel outputs rather than the mixed stream, because the mixer's
   * accumulator is host-rate wiring and deliberately not part of the state. This still
   * sees duty phase, sweep frequency, envelope volume, wave position and the LFSR.
   */
  function audioFingerprint(core: GameBoyCore, ticks = 60000): string {
    const values: string[] = [];
    for (let i = 0; i < ticks; i++) {
      // Bit 12 of the divider gives the 512 Hz frame sequencer its falling edge.
      core.apu.tickT((i & 0x1000) !== 0);
      if ((i & 0x3f) === 0) {
        values.push(
          core.apu.ch1.output().toFixed(3),
          core.apu.ch2.output().toFixed(3),
          core.apu.ch3.output().toFixed(3),
          core.apu.ch4.output().toFixed(3),
        );
      }
    }
    return values.join(',');
  }

  it('CARRIES EVERY CHANNEL: duty phase, sweep, envelopes, wave RAM and the LFSR', () => {
    const core = synthetic();
    primeAudio(core);
    audioFingerprint(core); // let the envelopes decay and the sweep shift

    const state = core.serialize();
    const expected = audioFingerprint(core);

    core.deserialize(state);
    expect(audioFingerprint(core)).toBe(expected);

    // And the part that matters: the same restore after the state has been replaced.
    core.deserialize(state);
    overwriteAudio(core);
    const scrambled = audioFingerprint(core);
    expect(scrambled).not.toBe(expected); // the overwrite really did change the sound

    core.deserialize(state);
    expect(audioFingerprint(core)).toBe(expected);
  });

  it('carries the length counters, which no register exposes in full', () => {
    const core = synthetic();
    primeAudio(core);
    audioFingerprint(core, 20000);
    const lengths = [
      core.apu.ch1.length.value,
      core.apu.ch2.length.value,
      core.apu.ch3.length.value,
      core.apu.ch4.length.value,
    ];
    expect(lengths.some((value) => value !== 0)).toBe(true);

    const state = core.serialize();
    overwriteAudio(core);
    expect([
      core.apu.ch1.length.value,
      core.apu.ch2.length.value,
      core.apu.ch3.length.value,
      core.apu.ch4.length.value,
    ]).not.toEqual(lengths);

    core.deserialize(state);
    expect([
      core.apu.ch1.length.value,
      core.apu.ch2.length.value,
      core.apu.ch3.length.value,
      core.apu.ch4.length.value,
    ]).toEqual(lengths);
  });

  it('carries a HALF-DECAYED ENVELOPE, not just the register it was loaded from', () => {
    const core = synthetic();
    primeAudio(core);
    // The envelope steps at 64 Hz divided by its period of 3, so this needs real time:
    // about 196k T-cycles per volume step.
    for (let i = 0; i < 500000; i++) core.apu.tickT((i & 0x1000) !== 0);
    const volume = core.apu.ch1.envelope.volume;
    // Mid-decay: below the 13 it was loaded with, above silence.
    expect(volume).toBeGreaterThan(0);
    expect(volume).toBeLessThan(13);

    const state = core.serialize();
    overwriteAudio(core);
    expect(core.apu.ch1.envelope.volume).not.toBe(volume);

    core.deserialize(state);
    expect(core.apu.ch1.envelope.volume).toBe(volume);
  });

  it('carries wave RAM and the mixer registers', () => {
    const core = synthetic();
    primeAudio(core);
    const waveform = Array.from(core.apu.ch3.ram);

    const state = core.serialize();
    overwriteAudio(core);
    expect(Array.from(core.apu.ch3.ram)).not.toEqual(waveform);

    core.deserialize(state);
    expect(Array.from(core.apu.ch3.ram)).toEqual(waveform);
    expect(core.mmu.read(0xff24)).toBe(0x85); // NR50, VIN bit included
    expect(core.mmu.read(0xff25)).toBe(0x5a); // NR51
  });
});
