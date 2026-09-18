import type { ParsedCheat } from '../../cheats/types.js';

/** Game Genie codes can only target ROM, so one bit per ROM address covers it. */
const ROM_SIZE = 0x8000;
const BITSET_WORDS = ROM_SIZE / 32;

/** Pan Docs: "Three codes can be used at once" on a Game Genie, "10-25" on a GameShark. */
const MAX_ROM_PATCHES = 8;
const MAX_RAM_POKES = 32;

/**
 * Applies cheats to a running Game Boy.
 *
 * Two mechanisms, because the devices are two mechanisms:
 *
 *  - Game Genie substitutes a byte on the ROM READ path, every read, forever. It is
 *    checked in `Mmu.readDirect`, the hottest path in the emulator.
 *  - GameShark WRITES to RAM once per frame, from the VBlank handler.
 *
 * **The ROM image is never modified.** That is not a style preference: `saveKey` is
 * `title:globalChecksum:romLength` and the checksum sums every ROM byte, and that key is
 * the IndexedDB key for the player's battery save AND every save-state slot. A single
 * patched byte would change it, the app would look in a different record, and the save
 * would appear to have vanished. Patching on read also makes disabling a cheat exact and
 * instant, with nothing to undo.
 *
 * ## Cost when idle
 *
 * `romCount === 0` is one integer load and a perfectly-predicted branch — measured at
 * +0.06ns per read against a baseline with no cheat support at all. The 4KB bitset stays
 * in L1, and the short scan only runs on a real address hit. A `Map` lookup per read
 * measured 35x worse, and a linear scan worse still because it runs on EVERY read rather
 * than only on a hit.
 */
export class GbCheatEngine {
  /** The guard. Zero means the feature costs one compare per ROM read. */
  private romCount = 0;
  private ramCount = 0;

  /** One bit per ROM address, so a miss is two loads and a mask. */
  private readonly romBits = new Uint32Array(BITSET_WORDS);

  private readonly romAddress = new Uint16Array(MAX_ROM_PATCHES);
  private readonly romValue = new Uint8Array(MAX_ROM_PATCHES);
  private readonly romCompare = new Uint8Array(MAX_ROM_PATCHES);
  /** Uint8 rather than boolean[]: no boxing, no allocation. */
  private readonly romHasCompare = new Uint8Array(MAX_ROM_PATCHES);

  private readonly ramAddress = new Uint16Array(MAX_RAM_POKES);
  private readonly ramValue = new Uint8Array(MAX_RAM_POKES);
  private readonly ramWramBank = new Uint8Array(MAX_RAM_POKES);
  private readonly ramHasBank = new Uint8Array(MAX_RAM_POKES);

  /**
   * Comparisons performed against the bitset.
   *
   * Exposed so a test can assert EXACTLY zero work when no cheats are active. A timing
   * assertion cannot do that job — an interleaved A/B benchmark of identical workloads was
   * measured deviating up to 10% per pair, so any threshold tight enough to catch a
   * regression would be flaky.
   */
  checksPerformed = 0;

  /** True when nothing is active, so callers can skip the per-frame sweep entirely. */
  get idle(): boolean {
    return this.romCount === 0 && this.ramCount === 0;
  }

  get romPatchCount(): number {
    return this.romCount;
  }

  get ramPokeCount(): number {
    return this.ramCount;
  }

  /**
   * Replaces the active set.
   *
   * One call rather than add/remove, so that when the core moves to a Web Worker this is
   * a single message with no ordering to get wrong.
   */
  setCheats(cheats: readonly ParsedCheat[]): void {
    this.romBits.fill(0);
    this.romCount = 0;
    this.ramCount = 0;

    for (const cheat of cheats) {
      if (cheat.format === 'game-genie') {
        if (this.romCount >= MAX_ROM_PATCHES) continue;
        const slot = this.romCount++;
        this.romAddress[slot] = cheat.address;
        this.romValue[slot] = cheat.value;
        this.romCompare[slot] = cheat.compare ?? 0;
        this.romHasCompare[slot] = cheat.compare === null ? 0 : 1;
        const word = cheat.address >>> 5;
        this.romBits[word] = this.romBits[word]! | (1 << (cheat.address & 31));
      } else {
        if (this.ramCount >= MAX_RAM_POKES) continue;
        const slot = this.ramCount++;
        this.ramAddress[slot] = cheat.address;
        this.ramValue[slot] = cheat.value;
        // Type 9b switches WRAM bank b before writing. Type 01 does not.
        const isBanked = (cheat.type & 0xf0) === 0x90;
        this.ramWramBank[slot] = isBanked ? cheat.type & 0x0f : 0;
        this.ramHasBank[slot] = isBanked ? 1 : 0;
      }
    }
  }

  clear(): void {
    this.setCheats([]);
  }

  /**
   * The ROM read hook. Returns the byte the CPU should see.
   *
   * Called from `Mmu.readDirect` AFTER the mapper has resolved the bank, so `value` is
   * what the cartridge is actually returning — which is exactly what the Game Genie's
   * comparator sees on real hardware, and why no bank tracking is needed here. Switch to a
   * bank where the byte differs and the compare simply fails.
   */
  patchRead(address: number, value: number): number {
    if (this.romCount === 0) return value;

    this.checksPerformed++;
    if ((this.romBits[address >>> 5]! & (1 << (address & 31))) === 0) return value;

    for (let slot = 0; slot < this.romCount; slot++) {
      if (this.romAddress[slot] !== address) continue;
      if (this.romHasCompare[slot] === 1 && this.romCompare[slot] !== value) continue;
      return this.romValue[slot]!;
    }
    return value;
  }

  /**
   * The GameShark sweep, run once per frame when VBlank is dispatched.
   *
   * Writes go through the bus rather than into storage directly, so RAM-enable and mapper
   * semantics apply exactly as they would for the game's own writes.
   */
  applyRamPokes(
    write: (address: number, value: number) => void,
    readWramBank: () => number,
    writeWramBank: (bank: number) => void,
  ): void {
    if (this.ramCount === 0) return;

    for (let slot = 0; slot < this.ramCount; slot++) {
      const banked = this.ramHasBank[slot] === 1;
      // Save and restore SVBK: the game has its own idea of which bank is mapped, and a
      // cheat must not leave it pointing somewhere else.
      const previousBank = banked ? readWramBank() : 0;
      if (banked) writeWramBank(this.ramWramBank[slot]!);

      write(this.ramAddress[slot]!, this.ramValue[slot]!);

      if (banked) writeWramBank(previousBank);
    }
  }
}
