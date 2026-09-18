import { describe, expect, it } from 'vitest';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import {
  decodeCheat,
  decodeGameGenie,
  decodeGameShark,
  CheatParseError,
} from '../../packages/emulator/src/index.js';
import { buildRom } from '../harness/rom.js';

/**
 * Decode fixtures are LITERAL, never round-trips.
 *
 * A round-trip test is worthless for this format: writing `ror8(x ^ 0xBA, 2)` instead of
 * `ror8(x, 2) ^ 0xBA` still round-trips perfectly while getting all 256 possible compare
 * bytes wrong. These expected values were computed from Pan Docs' field description and
 * cross-checked against three independent implementations (SameBoy, VBA-M, mGBA), which
 * agree on every input despite reaching the answer four different ways.
 *
 * Source: https://gbdev.io/pandocs/Shark_Cheats.html
 */
describe('cheat code decoding', () => {
  describe('Game Genie', () => {
    const vectors: [code: string, address: number, value: number, compare: number][] = [
      ['3E1-50F-E0A', 0x0150, 0x3e, 0x00],
      ['C92-34E-803', 0x1234, 0xc9, 0x5a],
      ['FFF-FF8-105', 0x7fff, 0xff, 0xff],
      ['000-00F-E0A', 0x0000, 0x00, 0x00],
    ];

    it.each(vectors)('decodes %s', (code, address, value, compare) => {
      expect(decodeGameGenie(code)).toEqual({
        format: 'game-genie',
        address,
        value,
        compare,
      });
    });

    it('XORS THE HIGH NIBBLE with 0xF: FFF-FF8 is 0x7FFF, not 0xFFFF', () => {
      expect(decodeGameGenie('FFF-FF8-105').address).toBe(0x7fff);
    });

    it('IGNORES THE H NIBBLE — two codes differing only in H decode alike', () => {
      // Pan Docs calls H "Unknown, maybe checksum and/or else"; every implementation
      // surveyed discards it.
      const a = decodeGameGenie('C92-34E-803');
      const b = decodeGameGenie('C92-34E-8F3');
      expect(a).toEqual(b);
    });

    it('decodes the 6-character form with NO compare byte', () => {
      expect(decodeGameGenie('C92-34E')).toEqual({
        format: 'game-genie',
        address: 0x1234,
        value: 0xc9,
        compare: null,
      });
    });

    it('accepts a code without dashes, and in lower case', () => {
      expect(decodeGameGenie('c9234e803')).toEqual(decodeGameGenie('C92-34E-803'));
    });

    it('rejects a code that is not hex', () => {
      expect(() => decodeGameGenie('ZZZ-ZZZ-ZZZ')).toThrow(CheatParseError);
    });

    it('rejects the wrong length', () => {
      expect(() => decodeGameGenie('ABC-DE')).toThrow(/9 characters/);
    });
  });

  describe('GameShark', () => {
    it("decodes Pan Docs' own worked example, 010238CD", () => {
      // Pan Docs: "cheat code 010238CD switches to SRAM bank $01, and writes $02 at
      // address $CD38". The address is little-endian in the code string.
      expect(decodeGameShark('010238CD')).toEqual({
        format: 'gameshark',
        type: 0x01,
        value: 0x02,
        address: 0xcd38,
      });
    });

    it('READS THE ADDRESS LITTLE-ENDIAN — 38CD means 0xCD38', () => {
      expect(decodeGameShark('010238CD').address).toBe(0xcd38);
      expect(decodeGameShark('010238CD').address).not.toBe(0x38cd);
    });

    it('accepts a 9x type, which switches WRAM bank before writing', () => {
      const cheat = decodeGameShark('9305C0D0');
      expect(cheat.type).toBe(0x93);
      expect(cheat.value).toBe(0x05);
    });

    it('REFUSES the 8x type rather than desynchronising the mapper', () => {
      // 8x selects a cartridge RAM bank, which means writing the MBC control registers
      // behind the game's back — on MBC1 that can also move the mapped ROM bank.
      expect(() => decodeGameShark('8105C0D0')).toThrow(/not supported/);
    });
  });

  describe('format auto-detection', () => {
    it('picks Game Genie for 9 and 6 characters, GameShark for 8', () => {
      expect(decodeCheat('C92-34E-803').format).toBe('game-genie');
      expect(decodeCheat('C92-34E').format).toBe('game-genie');
      expect(decodeCheat('010238CD').format).toBe('gameshark');
    });

    it('rejects anything else with a message naming both shapes', () => {
      expect(() => decodeCheat('12345')).toThrow(/ABC-DEF-GHI/);
    });
  });
});

/** A ROM whose every byte is known, so a patch is unambiguous. */
function patternRom(): Uint8Array {
  const rom = buildRom({ cartridgeType: 0x01, romBanks: 4 }); // MBC1
  for (let i = 0x0200; i < 0x4000; i++) rom[i] = i & 0xff;
  return rom;
}

describe('the cheat engine on a running core', () => {
  it('SUBSTITUTES A BYTE ON THE ROM READ PATH', () => {
    const core = new GameBoyCore();
    core.loadRom(patternRom());
    const original = core.getInspector().readMemory(0x1234);
    expect(original).toBe(0x34);

    core.mmu.cheats.setCheats([decodeGameGenie('C92-34E-803')]); // -> 0x1234 = 0xC9, cmp 0x5A
    // The compare is 0x5A and the ROM holds 0x34, so it must NOT apply.
    expect(core.getInspector().readMemory(0x1234)).toBe(0x34);
  });

  it('THE COMPARE BYTE GATES THE PATCH', () => {
    const core = new GameBoyCore();
    core.loadRom(patternRom());

    // Build a code whose compare matches what the ROM actually holds at 0x1234 (0x34).
    core.mmu.cheats.setCheats([
      { format: 'game-genie', address: 0x1234, value: 0xc9, compare: 0x34 },
    ]);
    expect(core.getInspector().readMemory(0x1234)).toBe(0xc9);

    // Same address, a compare that does not match: the read passes through untouched.
    core.mmu.cheats.setCheats([
      { format: 'game-genie', address: 0x1234, value: 0xc9, compare: 0x99 },
    ]);
    expect(core.getInspector().readMemory(0x1234)).toBe(0x34);
  });

  it('a 6-character code with no compare patches unconditionally', () => {
    const core = new GameBoyCore();
    core.loadRom(patternRom());
    core.mmu.cheats.setCheats([
      { format: 'game-genie', address: 0x1234, value: 0xab, compare: null },
    ]);
    expect(core.getInspector().readMemory(0x1234)).toBe(0xab);
  });

  it('DISABLING RESTORES THE ORIGINAL BYTE IMMEDIATELY', () => {
    const core = new GameBoyCore();
    core.loadRom(patternRom());
    core.mmu.cheats.setCheats([
      { format: 'game-genie', address: 0x1234, value: 0xc9, compare: 0x34 },
    ]);
    expect(core.getInspector().readMemory(0x1234)).toBe(0xc9);

    core.mmu.cheats.clear();
    expect(core.getInspector().readMemory(0x1234)).toBe(0x34);
  });

  /**
   * The save-corruption guard.
   *
   * saveKey is `title:globalChecksum:romLength` and the checksum sums every ROM byte. It
   * is the IndexedDB key for the battery save AND every save-state slot, so an in-place
   * ROM patch would silently point the app at a different record and the player's save
   * would appear to vanish.
   */
  it('NEVER MUTATES THE ROM IMAGE, so the save key cannot move', () => {
    const rom = patternRom();
    const pristine = Uint8Array.from(rom);

    const core = new GameBoyCore();
    core.loadRom(rom);
    const keyBefore = core.getCartridgeInfo()?.saveKey;

    core.mmu.cheats.setCheats([
      { format: 'game-genie', address: 0x1234, value: 0xc9, compare: 0x34 },
      { format: 'game-genie', address: 0x0150, value: 0x00, compare: null },
    ]);
    core.runFrame();

    expect(rom).toEqual(pristine);
    expect(core.getCartridgeInfo()?.saveKey).toBe(keyBefore);
  });

  it('applies several codes at once', () => {
    const core = new GameBoyCore();
    core.loadRom(patternRom());
    core.mmu.cheats.setCheats([
      { format: 'game-genie', address: 0x1234, value: 0xaa, compare: null },
      { format: 'game-genie', address: 0x1235, value: 0xbb, compare: null },
      { format: 'game-genie', address: 0x1236, value: 0xcc, compare: null },
    ]);
    const read = core.getInspector().readMemory.bind(core.getInspector());
    expect([read(0x1234), read(0x1235), read(0x1236)]).toEqual([0xaa, 0xbb, 0xcc]);
  });

  /**
   * The performance guard, and the reason it is a counter rather than a stopwatch.
   *
   * An interleaved A/B benchmark of two IDENTICAL workloads was measured deviating up to
   * 10% per pair on an idle machine, so any timing threshold tight enough to catch a
   * per-read map lookup would be flaky. This is exact and machine-independent.
   */
  it('DOES EXACTLY ZERO WORK PER READ when no cheats are active', () => {
    const core = new GameBoyCore();
    core.loadRom(patternRom());
    core.mmu.cheats.checksPerformed = 0;

    for (let frame = 0; frame < 60; frame++) core.runFrame();

    expect(core.mmu.cheats.checksPerformed).toBe(0);
  });

  it('does zero work per read when codes are loaded but then cleared', () => {
    const core = new GameBoyCore();
    core.loadRom(patternRom());
    core.mmu.cheats.setCheats([
      { format: 'game-genie', address: 0x1234, value: 0xc9, compare: 0x34 },
    ]);
    core.runFrame();

    core.mmu.cheats.clear();
    core.mmu.cheats.checksPerformed = 0;
    for (let frame = 0; frame < 60; frame++) core.runFrame();

    expect(core.mmu.cheats.checksPerformed).toBe(0);
  });
});
