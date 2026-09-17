/**
 * GBA access timing.
 *
 * Every region has its own cost and bus width, and ROM additionally has software-controlled
 * waitstates plus a prefetch buffer. Timing-sensitive games depend on this, so it is not
 * optional detail — but it is all driven by WAITCNT, so it lives in one table.
 */

/** Non-sequential ROM waitstates, indexed by the 2-bit WAITCNT field. */
const ROM_N_WAIT = [4, 3, 2, 8] as const;
/** Sequential ROM waitstates for each of the three ROM mirrors. */
const ROM_S_WAIT_0 = [2, 1] as const;
const ROM_S_WAIT_1 = [4, 1] as const;
const ROM_S_WAIT_2 = [8, 1] as const;
/** SRAM waitstates share the non-sequential table. */
const SRAM_WAIT = ROM_N_WAIT;

export class Waitstates {
  /** WAITCNT (0x04000204). */
  private control = 0;

  /** Cycles for a 16-bit access, per region index (address >>> 24). */
  private readonly n16 = new Int32Array(16);
  private readonly s16 = new Int32Array(16);

  constructor() {
    this.setControl(0);
  }

  get waitcnt(): number {
    return this.control;
  }

  setControl(value: number): void {
    this.control = value & 0xffff;

    const sram = SRAM_WAIT[value & 3]!;
    const rom0n = ROM_N_WAIT[(value >>> 2) & 3]!;
    const rom0s = ROM_S_WAIT_0[(value >>> 4) & 1]!;
    const rom1n = ROM_N_WAIT[(value >>> 5) & 3]!;
    const rom1s = ROM_S_WAIT_1[(value >>> 7) & 1]!;
    const rom2n = ROM_N_WAIT[(value >>> 8) & 3]!;
    const rom2s = ROM_S_WAIT_2[(value >>> 10) & 1]!;

    // BIOS, IWRAM, I/O and OAM are on the internal 32-bit bus: one cycle, no waiting.
    for (let region = 0; region < 16; region++) {
      this.n16[region] = 1;
      this.s16[region] = 1;
    }
    // EWRAM is 16-bit with 2 waitstates.
    this.n16[0x2] = this.s16[0x2] = 3;
    // Palette and VRAM are 16-bit but unwaited.
    this.n16[0x5] = this.s16[0x5] = 1;
    this.n16[0x6] = this.s16[0x6] = 1;

    this.n16[0x8] = this.n16[0x9] = 1 + rom0n;
    this.s16[0x8] = this.s16[0x9] = 1 + rom0s;
    this.n16[0xa] = this.n16[0xb] = 1 + rom1n;
    this.s16[0xa] = this.s16[0xb] = 1 + rom1s;
    this.n16[0xc] = this.n16[0xd] = 1 + rom2n;
    this.s16[0xc] = this.s16[0xd] = 1 + rom2s;

    this.n16[0xe] = this.s16[0xe] = 1 + sram;
    this.n16[0xf] = this.s16[0xf] = 1 + sram;
  }

  /**
   * Cycles an access costs.
   *
   * A 32-bit access to a 16-bit bus costs two halfword accesses — the first
   * non-sequential, the second sequential — which is why EWRAM is so much slower than
   * IWRAM for word-sized work.
   */
  cycles(address: number, width: number, sequential: boolean): number {
    const region = (address >>> 24) & 0xf;
    const base = sequential ? this.s16[region]! : this.n16[region]!;

    if (width !== 4) return base;

    // 32-bit on a 16-bit bus: two halfword accesses.
    const narrow = region === 0x2 || region === 0x5 || region === 0x6 || region >= 0x8;
    return narrow ? base + this.s16[region]! : base;
  }
}
