import { beforeEach, describe, expect, it } from 'vitest';
import { GbaApu } from '../../packages/emulator/src/gba/audio/GbaApu.js';
import {
  SoundFifo,
  FIFO_CAPACITY,
  FIFO_REFILL_THRESHOLD,
} from '../../packages/emulator/src/gba/audio/SoundFifo.js';
import { GameBoyAdvanceCore } from '../../packages/emulator/src/gba/GameBoyAdvanceCore.js';
import { StateReader, StateWriter } from '../../packages/emulator/src/gb/state/StateBuffer.js';

const SOUNDCNT_L = 0x04000080;
const SOUNDCNT_H = 0x04000082;
const SOUNDCNT_X = 0x04000084;
const FIFO_A = 0x040000a0;

describe('Direct Sound FIFO', () => {
  let fifo: SoundFifo;
  beforeEach(() => {
    fifo = new SoundFifo();
    fifo.reset();
  });

  it('holds 32 bytes, matching the hardware 8x32-bit queue', () => {
    for (let i = 0; i < 40; i++) fifo.push(i);
    expect(fifo.length).toBe(FIFO_CAPACITY);
  });

  it('pops one byte per timer overflow, oldest first', () => {
    fifo.push(10);
    fifo.push(20);
    fifo.tickTimer();
    expect(fifo.sample).toBe(10);
    fifo.tickTimer();
    expect(fifo.sample).toBe(20);
  });

  it('TREATS SAMPLES AS SIGNED: 0xFF is -1, not 255', () => {
    fifo.push(0xff);
    fifo.push(0x80);
    fifo.tickTimer();
    expect(fifo.sample).toBe(-1);
    fifo.tickTimer();
    expect(fifo.sample).toBe(-128);
  });

  it('unpacks a 32-bit word least significant byte first', () => {
    fifo.pushWord(0x04030201);
    for (const expected of [1, 2, 3, 4]) {
      fifo.tickTimer();
      expect(fifo.sample).toBe(expected);
    }
  });

  it('HOLDS THE LAST SAMPLE when starved rather than snapping to silence', () => {
    fifo.push(50);
    fifo.tickTimer();
    expect(fifo.sample).toBe(50);
    fifo.tickTimer(); // empty now
    expect(fifo.sample).toBe(50); // a dropout would be far more audible
  });

  it('asks for a refill once it falls to half empty', () => {
    for (let i = 0; i < FIFO_CAPACITY; i++) fifo.push(i);
    expect(fifo.needsRefill).toBe(false);
    while (fifo.length > FIFO_REFILL_THRESHOLD) fifo.tickTimer();
    expect(fifo.needsRefill).toBe(true);
  });
});

describe('GBA APU registers', () => {
  let apu: GbaApu;
  beforeEach(() => {
    apu = new GbaApu();
    apu.reset();
    apu.write(SOUNDCNT_X, 0x80); // master enable
  });

  it('reports the master enable bit', () => {
    expect(apu.read(SOUNDCNT_X) & 0x80).toBe(0x80);
    apu.write(SOUNDCNT_X, 0x00);
    expect(apu.read(SOUNDCNT_X) & 0x80).toBe(0);
  });

  it('ignores PSG writes while powered down', () => {
    apu.write(SOUNDCNT_X, 0x00);
    apu.write(SOUNDCNT_L, 0x77);
    expect(apu.read(SOUNDCNT_L)).toBe(0);
  });

  it('CLEARS A FIFO when the reset bit is written', () => {
    apu.write(FIFO_A, 0x1234);
    expect(apu.fifoA.length).toBeGreaterThan(0);
    apu.write(SOUNDCNT_H, 0x0800); // bit 11 resets FIFO A
    expect(apu.fifoA.length).toBe(0);
  });

  it('does not store the FIFO reset bits in the register', () => {
    apu.write(SOUNDCNT_H, 0x8800);
    expect(apu.read(SOUNDCNT_H) & 0x8800).toBe(0);
  });

  it('accepts a 32-bit FIFO word from DMA', () => {
    apu.writeFifoWord(0, 0x04030201);
    expect(apu.fifoA.length).toBe(4);
  });
});

describe('Direct Sound timing', () => {
  let apu: GbaApu;
  beforeEach(() => {
    apu = new GbaApu();
    apu.reset();
    apu.write(SOUNDCNT_X, 0x80);
  });

  it('POPS ONLY ON THE SELECTED TIMER, not on every overflow', () => {
    apu.write(SOUNDCNT_H, 0x0000); // FIFO A follows timer 0
    apu.writeFifoWord(0, 0x04030201);

    apu.notifyTimerOverflow(1); // wrong timer
    expect(apu.fifoA.length).toBe(4);

    apu.notifyTimerOverflow(0);
    expect(apu.fifoA.length).toBe(3);
  });

  it('follows timer 1 when SOUNDCNT_H selects it', () => {
    apu.write(SOUNDCNT_H, 0x0400); // bit 10: FIFO A on timer 1
    apu.writeFifoWord(0, 0x04030201);
    apu.notifyTimerOverflow(0);
    expect(apu.fifoA.length).toBe(4);
    apu.notifyTimerOverflow(1);
    expect(apu.fifoA.length).toBe(3);
  });

  it('REQUESTS A DMA REFILL when the queue runs low', () => {
    // Both FIFOs default to timer 0, and an empty FIFO B legitimately asks for data on
    // every overflow — so only FIFO A's requests are counted here.
    const refills: number[] = [];
    apu.onFifoRefill = (fifo) => {
      if (fifo === 0) refills.push(fifo);
    };
    apu.write(SOUNDCNT_H, 0x0000);

    for (let i = 0; i < FIFO_CAPACITY; i++) apu.fifoA.push(i);
    // The refill fires AT the threshold, so the pop that brings the queue down to 16
    // is the one that asks for more — not the one after it.
    for (let i = 0; i < FIFO_CAPACITY - FIFO_REFILL_THRESHOLD - 1; i++) {
      apu.notifyTimerOverflow(0);
    }
    expect(refills).toHaveLength(0);
    expect(apu.fifoA.length).toBe(FIFO_REFILL_THRESHOLD + 1);

    apu.notifyTimerOverflow(0);
    expect(apu.fifoA.length).toBe(FIFO_REFILL_THRESHOLD);
    expect(refills).toContain(0);
  });

  it('stays silent while the master enable is off', () => {
    apu.write(SOUNDCNT_X, 0x00);
    apu.writeFifoWord(0, 0x7f7f7f7f);
    apu.notifyTimerOverflow(0);
    expect(apu.fifoA.sample).toBe(0);
  });
});

describe('mixing', () => {
  function collect(configure: (apu: GbaApu) => void, cycles = 4000): number[] {
    const apu = new GbaApu();
    apu.reset();
    apu.write(SOUNDCNT_X, 0x80);
    configure(apu);
    const samples: number[] = [];
    apu.setOutputRate(48000, (left) => samples.push(left));
    for (let i = 0; i < cycles; i++) apu.tick();
    return samples;
  }

  it('emits samples at the requested host rate', () => {
    const apu = new GbaApu();
    apu.reset();
    apu.write(SOUNDCNT_X, 0x80);
    let count = 0;
    apu.setOutputRate(48000, () => count++);
    // One emulated second at the GBA's 16.78 MHz clock.
    for (let i = 0; i < 16777216; i++) apu.tick();
    expect(count).toBeGreaterThan(47000);
    expect(count).toBeLessThan(49000);
  });

  it('produces silence with nothing enabled', () => {
    const samples = collect(() => undefined);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s === 0)).toBe(true);
  });

  it('ROUTES DIRECT SOUND to the enabled side only', () => {
    const apu = new GbaApu();
    apu.reset();
    apu.write(SOUNDCNT_X, 0x80);
    // FIFO A: left enabled (bit 9), right disabled, full volume (bit 2).
    apu.write(SOUNDCNT_H, 0x0200 | 0x0004);
    apu.writeFifoWord(0, 0x7f7f7f7f);
    apu.notifyTimerOverflow(0);

    const left: number[] = [];
    const right: number[] = [];
    apu.setOutputRate(48000, (l, r) => {
      left.push(l);
      right.push(r);
    });
    for (let i = 0; i < 4000; i++) apu.tick();

    expect(left.some((s) => s > 0)).toBe(true);
    expect(right.every((s) => s === 0)).toBe(true);
  });

  it('halves Direct Sound output when the volume bit is clear', () => {
    const readFirst = (volumeBit: number): number => {
      const apu = new GbaApu();
      apu.reset();
      apu.write(SOUNDCNT_X, 0x80);
      apu.write(SOUNDCNT_H, 0x0200 | volumeBit);
      apu.writeFifoWord(0, 0x7f7f7f7f);
      apu.notifyTimerOverflow(0);
      let first = 0;
      let seen = false;
      apu.setOutputRate(48000, (l) => {
        if (!seen) {
          first = l;
          seen = true;
        }
      });
      for (let i = 0; i < 4000; i++) apu.tick();
      return first;
    };
    const full = readFirst(0x0004);
    const half = readFirst(0x0000);
    expect(half).toBeCloseTo(full / 2, 5);
  });

  it('keeps output within -1..1 even with everything at maximum', () => {
    const samples = collect((apu) => {
      apu.write(SOUNDCNT_H, 0x0f0f);
      apu.write(SOUNDCNT_L, 0xff77);
      apu.writeFifoWord(0, 0x7f7f7f7f);
      apu.writeFifoWord(1, 0x7f7f7f7f);
      apu.notifyTimerOverflow(0);
    });
    expect(samples.every((s) => s >= -1 && s <= 1)).toBe(true);
  });
});

describe('integration with the GBA core', () => {
  function syntheticRom(): Uint8Array {
    const rom = new Uint8Array(0x200);
    rom[0x03] = 0xea;
    rom[0xb2] = 0x96;
    return rom;
  }

  it('routes sound registers through the bus', () => {
    const core = new GameBoyAdvanceCore();
    core.loadRom(syntheticRom());
    core.mmu.write16(SOUNDCNT_X, 0x80);
    expect(core.mmu.read16(SOUNDCNT_X) & 0x80).toBe(0x80);
  });

  it('DELIVERS A DMA FIFO WRITE into the queue, four bytes per word', () => {
    const core = new GameBoyAdvanceCore();
    core.loadRom(syntheticRom());
    core.mmu.write16(SOUNDCNT_X, 0x80);
    // A 32-bit write is how DMA feeds the FIFO.
    core.mmu.write32(FIFO_A, 0x04030201);
    expect(core.apu.fifoA.length).toBe(4);
  });

  it('closes the timer -> APU -> DMA loop', () => {
    const core = new GameBoyAdvanceCore();
    core.loadRom(syntheticRom());
    core.mmu.write16(SOUNDCNT_X, 0x80);
    core.mmu.write16(SOUNDCNT_H, 0x0000); // FIFO A on timer 0
    core.apu.writeFifoWord(0, 0x04030201);

    // Timer 0: reload 0xFFFF so it overflows almost immediately, prescaler 1.
    core.mmu.write16(0x04000100, 0xffff);
    core.mmu.write16(0x04000102, 0x0080);
    core.mmu.timers.tick(4);

    expect(core.apu.fifoA.length).toBeLessThan(4);
  });
});

/**
 * A save-state audit found the Game Boy state was missing every CGB register because they
 * lived in dedicated `Mmu` fields rather than the serialized `io` array. The GBA APU had
 * the identical shape of bug: sound-register writes are routed straight to the channel
 * objects and never touch the bus's `io` array, and `GbaApu.saveState` wrote the two
 * SOUNDCNT registers and the FIFOs but not `ch1`-`ch4`. These tests pin the fix.
 */
describe('GBA PSG channels in a save state', () => {
  function roundTrip(apu: GbaApu): GbaApu {
    const w = new StateWriter();
    apu.saveState(w);
    const restored = new GbaApu();
    restored.reset();
    restored.loadState(new StateReader(w.finish()));
    return restored;
  }

  it('CARRIES THE FOUR PSG CHANNELS, which live outside the io array', () => {
    const apu = new GbaApu();
    apu.reset();
    apu.write(SOUNDCNT_X, 0x80); // power on, or every channel write is dropped
    apu.write(0x04000062, 0xf740); // ch1: NR11 duty, NR12 envelope
    apu.write(0x04000064, 0x8700); // ch1: frequency + trigger
    apu.write(0x0400006a, 0xa980); // ch2: NR21/NR22
    apu.write(0x0400007c, 0x0053); // ch4: NR43

    const probes = [0x04000062, 0x04000064, 0x0400006a, 0x0400007c] as const;
    const before = probes.map((address) => apu.read(address));

    const blank = new GbaApu();
    blank.reset();
    // Guard: if a fresh APU already read back the same values the test proves nothing.
    expect(probes.map((address) => blank.read(address))).not.toEqual(before);

    expect(probes.map((address) => roundTrip(apu).read(address))).toEqual(before);
  });

  it('carries the channel ENABLE bits, which SOUNDCNT_X reports', () => {
    const apu = new GbaApu();
    apu.reset();
    apu.write(SOUNDCNT_X, 0x80);
    apu.write(0x04000062, 0xf700);
    apu.write(0x04000064, 0x8700); // trigger channel 1

    const enabled = apu.read(SOUNDCNT_X) & 0x0f;
    expect(enabled).not.toBe(0);
    expect(roundTrip(apu).read(SOUNDCNT_X) & 0x0f).toBe(enabled);
  });
});

/**
 * Wave RAM, 0x04000090-0x0400009F.
 *
 * `GbaApu.write` handled 0x60-0x7F plus a short list of control registers and dropped
 * everything else, so channel 3's waveform could never be written: the channel played the
 * reset pattern forever. The GBA's wave RAM is also TWO banks of 16 bytes rather than the
 * Game Boy's one — "the currently selected Bank Number (Bit 6) will be played back, while
 * reading/writing to/from wave RAM will address the other (not selected) bank", and with
 * the dimension bit set "output will start by replaying the currently selected bank"
 * before running on into the other (GBATEK, GBA Sound Channel 3 - Wave Output).
 */
describe('GBA wave RAM', () => {
  const SOUND3CNT_L = 0x04000070;
  const SOUND3CNT_H = 0x04000072;
  const SOUND3CNT_X = 0x04000074;
  const WAVE_RAM = 0x04000090;

  function poweredApu(): GbaApu {
    const apu = new GbaApu();
    apu.reset();
    apu.write(SOUNDCNT_X, 0x80);
    return apu;
  }

  /** Fills one bank: select the OTHER bank for playback, then write. */
  function loadBank(apu: GbaApu, bank: 0 | 1, byteAt: (index: number) => number): void {
    apu.write(SOUND3CNT_L, bank === 0 ? 0x40 : 0x00);
    for (let i = 0; i < 16; i += 2) {
      apu.write(WAVE_RAM + i, (byteAt(i) & 0xff) | ((byteAt(i + 1) & 0xff) << 8));
    }
  }

  /** Every distinct channel-3 output level seen over `ticks` cycles. */
  function levels(apu: GbaApu, ticks = 4000): Set<number> {
    const seen = new Set<number>();
    for (let i = 0; i < ticks; i++) {
      apu.tick();
      seen.add(apu.ch3.output());
    }
    return seen;
  }

  it('STORES A WRITTEN WAVEFORM instead of dropping the write', () => {
    const apu = poweredApu();
    loadBank(apu, 0, (i) => i * 0x11);
    for (let i = 0; i < 16; i++) expect(apu.ch3.ram[i]).toBe((i * 0x11) & 0xff);
  });

  it('addresses the bank that is NOT selected for playback', () => {
    const apu = poweredApu();
    apu.write(SOUND3CNT_L, 0x40); // bank 1 plays, so the CPU reaches bank 0
    apu.write(WAVE_RAM, 0xbeef);
    expect([apu.ch3.ram[0], apu.ch3.ram[1]]).toEqual([0xef, 0xbe]);
    expect(apu.ch3.ram2[0]).toBe(0);
  });

  it('reads the bank it wrote, and the other one after the bank bit flips', () => {
    const apu = poweredApu();
    apu.write(SOUND3CNT_L, 0x40);
    apu.write(WAVE_RAM, 0x1234);
    expect(apu.read(WAVE_RAM)).toBe(0x1234);

    apu.write(SOUND3CNT_L, 0x00); // bank 0 plays now, so the CPU sees bank 1
    expect(apu.read(WAVE_RAM)).toBe(0x0000);
  });

  it('PLAYS THE WRITTEN WAVEFORM rather than the reset pattern', () => {
    const apu = poweredApu();
    // Alternating extremes: nibbles 15 and 0, which are the two ends of the DAC.
    loadBank(apu, 0, (i) => (i % 2 === 0 ? 0xf0 : 0x0f));
    apu.write(SOUND3CNT_L, 0x80); // bank 0 plays, DAC on
    apu.write(SOUND3CNT_H, 0x2000); // volume 100%
    apu.write(SOUND3CNT_X, 0x87ff); // trigger, frequency 2047 so samples come fast

    const seen = levels(apu);
    expect(seen.has(1)).toBe(true);
    expect(seen.has(-1)).toBe(true);
  });

  it('SPANS BOTH BANKS when the dimension bit is set, and only one when it is clear', () => {
    const configure = (dimension: number): Set<number> => {
      const apu = poweredApu();
      loadBank(apu, 0, () => 0x00); // bank 0: nibble 0 everywhere
      loadBank(apu, 1, () => 0xff); // bank 1: nibble 15 everywhere
      apu.write(SOUND3CNT_L, 0x80 | dimension); // bank 0 first, DAC on
      apu.write(SOUND3CNT_H, 0x2000);
      apu.write(SOUND3CNT_X, 0x87ff);
      return levels(apu);
    };

    // One bank: the all-zero bank 0, so the output never leaves the bottom of the DAC.
    expect(configure(0x00)).toEqual(new Set([-1]));
    // Two banks: playback runs on into bank 1 and reaches the top.
    expect(configure(0x20)).toEqual(new Set([-1, 1]));
  });

  it('carries the waveform and the bank bits through a save state', () => {
    const apu = poweredApu();
    loadBank(apu, 0, (i) => 0xa0 + i);
    loadBank(apu, 1, (i) => 0x50 + i);
    apu.write(SOUND3CNT_L, 0xa0); // two banks, bank 0 selected

    const w = new StateWriter();
    apu.saveState(w);
    const state = w.finish();

    // The game plays on and rewrites everything — without this the test passes against
    // a save that never wrote wave RAM at all.
    apu.write(SOUND3CNT_L, 0x00);
    for (let i = 0; i < 16; i += 2) apu.write(WAVE_RAM + i, 0xffff);
    apu.write(SOUND3CNT_L, 0x40);
    for (let i = 0; i < 16; i += 2) apu.write(WAVE_RAM + i, 0xffff);
    expect(apu.ch3.ram[0]).toBe(0xff);

    apu.loadState(new StateReader(state));

    for (let i = 0; i < 16; i++) {
      expect(apu.ch3.ram[i]).toBe(0xa0 + i);
      expect(apu.ch3.ram2[i]).toBe(0x50 + i);
    }
    expect(apu.read(SOUND3CNT_L)).toBe(0xa0);
  });
});

/**
 * 8-bit writes to sound registers.
 *
 * `GbaMmu.writeIo` had no APU branch at all, so a byte store — `STRB` to one envelope or
 * length byte is ordinary code — fell through to the `io` array and never reached the
 * APU. The PSG block is the Game Boy's own registers packed two to a halfword: "in some
 * cases two of the old 8bit registers are packed into a 16bit register and may be
 * accessed as such" (GBATEK, GBA Sound Controller). So a byte write addresses exactly one
 * DMG register and must NOT be widened into a halfword write, which would re-run the
 * neighbour's side effects.
 */
describe('8-bit sound register writes', () => {
  const SOUND1CNT_H = 0x04000062;
  const SOUND1CNT_X = 0x04000064;
  const FIFO_B = 0x040000a4;

  function poweredApu(): GbaApu {
    const apu = new GbaApu();
    apu.reset();
    apu.write(SOUNDCNT_X, 0x80);
    return apu;
  }

  function poweredCore(): GameBoyAdvanceCore {
    const core = new GameBoyAdvanceCore();
    const rom = new Uint8Array(0x200);
    rom[0x03] = 0xea;
    rom[0xb2] = 0x96;
    core.loadRom(rom);
    core.mmu.write8(SOUNDCNT_X, 0x80);
    return core;
  }

  it('REACHES THE APU THROUGH THE BUS instead of landing in the io array', () => {
    const core = poweredCore();
    expect(core.apu.read(SOUNDCNT_X) & 0x80).toBe(0x80);

    core.mmu.write8(SOUND1CNT_H + 1, 0xf7); // NR12, the high byte of the packed pair
    expect(core.apu.ch1.envelope.read()).toBe(0xf7);
  });

  it('writes ONE of the two packed registers, leaving its neighbour alone', () => {
    const apu = poweredApu();
    apu.write(SOUND1CNT_H, 0xf740); // NR11 = 0x40, NR12 = 0xf7
    apu.write8(SOUND1CNT_H, 0x80); // NR11 only: duty 2

    expect(apu.ch1.envelope.read()).toBe(0xf7);
    expect(apu.ch1.readNrX1() & 0xc0).toBe(0x80);
  });

  it('DOES NOT RE-TRIGGER when only the frequency-low byte is written', () => {
    const apu = poweredApu();
    apu.write(SOUND1CNT_H, 0xf000); // NR12: volume 15, so the DAC is powered
    apu.write(SOUND1CNT_X, 0x8700); // halfword: NR13 = 0x00, NR14 = 0x87 (trigger)
    expect(apu.ch1.enabled).toBe(true);

    apu.write8(SOUND1CNT_H + 1, 0x00); // envelope to zero: DAC off, channel off
    expect(apu.ch1.enabled).toBe(false);
    apu.write8(SOUND1CNT_H + 1, 0xf0); // DAC back on, still not triggered

    apu.write8(SOUND1CNT_X, 0x55); // NR13 alone
    // Widening this into a halfword write would re-apply the 0x87 sitting in NR14 and
    // restart the channel.
    expect(apu.ch1.enabled).toBe(false);

    apu.write8(SOUND1CNT_X + 1, 0x87); // NR14: now it really is a trigger
    expect(apu.ch1.enabled).toBe(true);
  });

  it('reaches every channel, including the noise LFSR controls', () => {
    const apu = poweredApu();
    apu.write8(0x04000079, 0xa7); // NR42: envelope
    apu.write8(0x0400007c, 0x5b); // NR43: clock shift 5, 7-bit width, divisor 3
    expect(apu.ch4.readNr42()).toBe(0xa7);
    expect(apu.ch4.readNr43()).toBe(0x5b);
  });

  it('queues ONE BYTE per 8-bit FIFO write', () => {
    const apu = poweredApu();
    apu.write8(0x040000a0, 0x42);
    expect(apu.fifoA.length).toBe(1);
    apu.notifyTimerOverflow(0);
    expect(apu.fifoA.sample).toBe(0x42);

    apu.write8(FIFO_B + 3, 0x80); // any byte lane of FIFO B
    expect(apu.fifoB.length).toBe(1);
    apu.notifyTimerOverflow(0);
    expect(apu.fifoB.sample).toBe(-128); // samples are signed
  });

  it('read-modify-writes the registers that are natively 16 bits', () => {
    const apu = poweredApu();
    apu.write(SOUNDCNT_L, 0x1234);
    apu.write8(SOUNDCNT_L, 0x77);
    expect(apu.read(SOUNDCNT_L)).toBe(0x1277);
    apu.write8(SOUNDCNT_L + 1, 0x56);
    expect(apu.read(SOUNDCNT_L)).toBe(0x5677);
  });

  it('powers the APU down through a byte write to SOUNDCNT_X', () => {
    const apu = poweredApu();
    apu.write8(SOUNDCNT_X, 0x00);
    expect(apu.read(SOUNDCNT_X) & 0x80).toBe(0);
    apu.write8(SOUNDCNT_X, 0x80);
    expect(apu.read(SOUNDCNT_X) & 0x80).toBe(0x80);
  });

  it('writes wave RAM a byte at a time', () => {
    const core = poweredCore();
    core.mmu.write8(0x04000070, 0x40); // bank 1 plays, the CPU reaches bank 0
    core.mmu.write8(0x04000091, 0x9c);
    expect(core.apu.ch3.ram[1]).toBe(0x9c);
    expect(core.apu.ch3.ram[0]).toBe(0x00);
  });

  it('feeds a FIFO through the bus, which is how a byte-wide sample write arrives', () => {
    const core = poweredCore();
    core.mmu.write8(0x040000a0, 0x7f);
    expect(core.apu.fifoA.length).toBe(1);
  });
});

/**
 * PSG register READS.
 *
 * `GbaMmu.readIo` fetches the sound block as a halfword and slices the requested byte out
 * of it, so `GbaApu.readPsg` must return the whole 16-bit register with each of the two
 * packed DMG registers in its correct half. It did not: SOUND1CNT_X returned NR14 in the
 * LOW byte, SOUND1CNT_H/SOUND2CNT_L/SOUND3CNT_H returned only their low register and
 * dropped the envelope/volume half, SOUND4CNT_L matched no branch and read back 0, and the
 * NR14/NR44 branches sat at odd offsets the bus never calls with, making NR44 unreachable.
 * Nothing caught it because no test read a GBA sound register back at all.
 *
 * Every expectation below cites GBATEK, "GBA Sound Channel 1-4". The read mask per
 * register is the union of the fields GBATEK annotates R/W; W-only and "Not used" fields
 * read 0 (GBATEK does not state this for sound registers — see the note on `readPsg`).
 */
describe('GBA PSG register reads', () => {
  const SOUND1CNT_L = 0x04000060;
  const SOUND1CNT_H = 0x04000062;
  const SOUND1CNT_X = 0x04000064;
  const SOUND2CNT_L = 0x04000068;
  const SOUND2CNT_H = 0x0400006c;
  const SOUND3CNT_L = 0x04000070;
  const SOUND3CNT_H = 0x04000072;
  const SOUND3CNT_X = 0x04000074;
  const SOUND4CNT_L = 0x04000078;
  const SOUND4CNT_H = 0x0400007c;

  function poweredApu(): GbaApu {
    const apu = new GbaApu();
    apu.reset();
    apu.write(SOUNDCNT_X, 0x80);
    return apu;
  }

  function poweredCore(): GameBoyAdvanceCore {
    const core = new GameBoyAdvanceCore();
    const rom = new Uint8Array(0x200);
    rom[0x03] = 0xea;
    rom[0xb2] = 0x96;
    core.loadRom(rom);
    core.mmu.write16(SOUNDCNT_X, 0x80);
    return core;
  }

  // GBATEK SOUND1CNT_L: bits 0-2 sweep shift, 3 direction, 4-6 sweep time, all R/W;
  // bits 7-15 "Not used". Read mask 0x007F.
  it('SOUND1CNT_L returns the sweep fields and nothing above bit 6', () => {
    const apu = poweredApu();
    apu.write(SOUND1CNT_L, 0xffff);
    expect(apu.read(SOUND1CNT_L)).toBe(0x007f);
  });

  // GBATEK SOUND1CNT_H: bits 0-5 sound length "W", 6-7 duty R/W (these are NR11, the LOW
  // byte); bits 8-15 envelope step/direction/volume R/W (NR12, the HIGH byte).
  // Read mask 0xFFC0.
  it('SOUND1CNT_H returns duty in the low byte and the envelope in the high byte', () => {
    const apu = poweredApu();
    apu.write(SOUND1CNT_H, 0xf7ff); // NR11 = 0xFF (duty 3, length 63), NR12 = 0xF7
    expect(apu.read(SOUND1CNT_H)).toBe(0xf7c0); // length is write-only, so it reads 0
  });

  // GBATEK SOUND1CNT_X: bits 0-10 frequency "W", 11-13 "Not used", 14 length flag R/W,
  // 15 initial "W". Read mask 0x4000 — the whole low byte (NR13) is write-only.
  it('SOUND1CNT_X returns the length flag in BIT 14, not in the low byte', () => {
    const apu = poweredApu();
    apu.write(SOUND1CNT_H, 0xf000); // power the DAC so the trigger sticks
    apu.write(SOUND1CNT_X, 0xc7ff); // NR13 = 0xFF, NR14 = 0xC7: trigger + length enable
    expect(apu.read(SOUND1CNT_X)).toBe(0x4000);
  });

  it('SOUND1CNT_X reads 0 with the length flag clear, proving bit 14 is the only live bit', () => {
    const apu = poweredApu();
    apu.write(SOUND1CNT_H, 0xf000);
    apu.write(SOUND1CNT_X, 0x87ff); // trigger, no length enable
    expect(apu.read(SOUND1CNT_X)).toBe(0x0000);
  });

  // GBATEK SOUND2CNT_L: channel 2 "works exactly as channel 1, except that it doesn't
  // have a Tone Envelope/Sweep Register". Read mask 0xFFC0.
  it('SOUND2CNT_L returns duty and envelope in the same halves as channel 1', () => {
    const apu = poweredApu();
    apu.write(SOUND2CNT_L, 0xa1ff); // NR21 = 0xFF, NR22 = 0xA1
    expect(apu.read(SOUND2CNT_L)).toBe(0xa1c0);
  });

  // GBATEK SOUND2CNT_H: same layout as SOUND1CNT_X. Read mask 0x4000.
  it('SOUND2CNT_H returns the length flag in bit 14', () => {
    const apu = poweredApu();
    apu.write(SOUND2CNT_L, 0xf000);
    apu.write(SOUND2CNT_H, 0xc7ff);
    expect(apu.read(SOUND2CNT_H)).toBe(0x4000);
  });

  // GBATEK SOUND3CNT_L: bits 0-4 "Not used", 5 wave RAM dimension, 6 bank number,
  // 7 channel off/playback, all R/W; bits 8-15 "Not used". Read mask 0x00E0.
  it('SOUND3CNT_L returns dimension, bank and DAC, and nothing else', () => {
    const apu = poweredApu();
    apu.write(SOUND3CNT_L, 0xffff);
    expect(apu.read(SOUND3CNT_L)).toBe(0x00e0);
  });

  // GBATEK SOUND3CNT_H: bits 0-7 sound length "W" (NR31), 8-12 "Not used", 13-14 "Sound
  // Volume" R/W, 15 "Force Volume" R/W. Read mask 0xE000 — including bit 15.
  it('SOUND3CNT_H returns volume in BITS 13-14 and force in 15, with the length byte reading 0', () => {
    const apu = poweredApu();
    apu.write(SOUND3CNT_H, 0xffff); // NR31 = 0xFF (length), high = 0xFF (volume 3 + force)
    expect(apu.read(SOUND3CNT_H)).toBe(0xe000);
  });

  // GBATEK SOUND3CNT_X: same layout as SOUND1CNT_X. Read mask 0x4000.
  it('SOUND3CNT_X returns the length flag in bit 14', () => {
    const apu = poweredApu();
    apu.write(SOUND3CNT_L, 0x0080); // DAC on
    apu.write(SOUND3CNT_X, 0xc7ff);
    expect(apu.read(SOUND3CNT_X)).toBe(0x4000);
  });

  // GBATEK SOUND4CNT_L: bits 0-5 sound length "W" (NR41), 6-7 "Not used", 8-15 envelope
  // R/W (NR42). Read mask 0xFF00. THIS REGISTER MATCHED NO BRANCH AND READ BACK 0.
  it('SOUND4CNT_L returns the noise envelope in the HIGH byte, where it used to read 0', () => {
    const apu = poweredApu();
    apu.write(SOUND4CNT_L, 0xf83f); // NR41 = 0x3F (length), NR42 = 0xF8
    expect(apu.read(SOUND4CNT_L)).toBe(0xf800);
  });

  it('SOUND4CNT_L is nonzero at all once an envelope is written', () => {
    const apu = poweredApu();
    expect(apu.read(SOUND4CNT_L)).toBe(0x0000);
    apu.write(SOUND4CNT_L, 0x1000); // NR42 = 0x10: volume 1
    expect(apu.read(SOUND4CNT_L)).toBe(0x1000);
  });

  // GBATEK SOUND4CNT_H: bits 0-2 dividing ratio, 3 counter step/width, 4-7 shift clock,
  // all R/W (NR43, the low byte); 8-13 "Not used"; 14 length flag R/W; 15 initial "W".
  // Read mask 0x40FF. NR44 previously sat on an odd offset and was unreachable.
  it('SOUND4CNT_H returns NR43 in the low byte and the NR44 length flag in bit 14', () => {
    const apu = poweredApu();
    apu.write(SOUND4CNT_L, 0xf000); // DAC on so the trigger sticks
    apu.write(SOUND4CNT_H, 0xc059); // NR43 = 0x59, NR44 = 0xC0: trigger + length enable
    expect(apu.read(SOUND4CNT_H)).toBe(0x4059);
  });

  it('UNUSED BITS READ 0, unlike the DMG whose unimplemented bits read 1', () => {
    const apu = poweredApu();
    // Set every writable bit of every channel, then check nothing outside the GBATEK
    // R/W fields comes back set. A DMG-shaped read would return 0xBF-style padding.
    for (const address of [
      SOUND1CNT_L,
      SOUND1CNT_H,
      SOUND1CNT_X,
      SOUND2CNT_L,
      SOUND2CNT_H,
      SOUND3CNT_L,
      SOUND3CNT_H,
      SOUND3CNT_X,
      SOUND4CNT_L,
      SOUND4CNT_H,
    ]) {
      apu.write(address, 0xffff);
    }
    const masks: Array<[number, number]> = [
      [SOUND1CNT_L, 0x007f],
      [SOUND1CNT_H, 0xffc0],
      [SOUND1CNT_X, 0x4000],
      [SOUND2CNT_L, 0xffc0],
      [SOUND2CNT_H, 0x4000],
      [SOUND3CNT_L, 0x00e0],
      [SOUND3CNT_H, 0xe000],
      [SOUND3CNT_X, 0x4000],
      [SOUND4CNT_L, 0xff00],
      [SOUND4CNT_H, 0x40ff],
    ];
    for (const [address, mask] of masks) {
      const value = apu.read(address);
      expect({ address: address.toString(16), outside: value & ~mask }).toEqual({
        address: address.toString(16),
        outside: 0,
      });
    }
  });

  it('reads 0 at the gaps in the sound block, which hold no register', () => {
    const apu = poweredApu();
    for (const address of [0x04000066, 0x0400006a, 0x0400006e, 0x04000076, 0x0400007a]) {
      expect(apu.read(address)).toBe(0);
    }
  });

  /**
   * The defect lived on the bus path, not in `GbaApu` alone: `readIo` takes the halfword
   * and returns its low or high byte depending on address bit 0. A register whose halves
   * are swapped reads correctly through `GbaApu.read` as a 16-bit value only by accident,
   * and wrongly through every 8-bit access a game makes.
   */
  it('THROUGH THE BUS: each byte of SOUND1CNT_H lands in its own half', () => {
    const core = poweredCore();
    core.mmu.write16(SOUND1CNT_H, 0xf7ff);
    expect(core.mmu.read8(SOUND1CNT_H)).toBe(0xc0); // NR11: duty only
    expect(core.mmu.read8(SOUND1CNT_H + 1)).toBe(0xf7); // NR12: the envelope
    expect(core.mmu.read16(SOUND1CNT_H)).toBe(0xf7c0);
  });

  it('THROUGH THE BUS: SOUND4CNT_H gives NR43 at 0x7C and the length flag at 0x7D', () => {
    const core = poweredCore();
    core.mmu.write16(SOUND4CNT_L, 0xf000);
    core.mmu.write16(SOUND4CNT_H, 0xc059);
    expect(core.mmu.read8(SOUND4CNT_H)).toBe(0x59);
    expect(core.mmu.read8(SOUND4CNT_H + 1)).toBe(0x40);
  });

  it('THROUGH THE BUS: SOUND1CNT_X puts the length flag at 0x65, not 0x64', () => {
    const core = poweredCore();
    core.mmu.write16(SOUND1CNT_H, 0xf000);
    core.mmu.write16(SOUND1CNT_X, 0xc7ff);
    expect(core.mmu.read8(SOUND1CNT_X)).toBe(0x00); // NR13 is write-only
    expect(core.mmu.read8(SOUND1CNT_X + 1)).toBe(0x40); // NR14 bit 6
  });

  it('THROUGH THE BUS: SOUND4CNT_L delivers the envelope at 0x79', () => {
    const core = poweredCore();
    core.mmu.write16(SOUND4CNT_L, 0xf83f);
    expect(core.mmu.read8(SOUND4CNT_L)).toBe(0x00); // NR41 length is write-only
    expect(core.mmu.read8(SOUND4CNT_L + 1)).toBe(0xf8);
  });
});

/**
 * SOUND3CNT_H bit 15, the GBA-only force-75% volume override.
 *
 * GBATEK, GBA Sound Channel 3 - Wave Output:
 *
 *     13-14 R/W  Sound Volume  (0=Mute/Zero, 1=100%, 2=50%, 3=25%)
 *     15    R/W  Force Volume  (0=Use above, 1=Force 75% regardless of above)
 *
 * `WaveChannel` modelled neither half of this: the write path dropped the bit and the
 * mixer ignored it, so channel 3 played at the wrong level for any game that set it. The
 * register read was fixed first, which would have left the worse of the two bugs in place
 * and harder to find — the register would read back correctly while the audio stayed
 * wrong. The output test below is the one that matters; the readback test alone would
 * pass against a mixer that still ignored the bit.
 *
 * 75% is not a power of two, so it cannot be one of the `VOLUME_SHIFT` entries. It is
 * applied to the 4-bit sample before the DAC map — `(sample * 3) >> 2`, so 15 becomes 11.
 */
describe('GBA channel 3 force-75% volume', () => {
  const SOUND3CNT_L = 0x04000070;
  const SOUND3CNT_H = 0x04000072;
  const SOUND3CNT_X = 0x04000074;
  const WAVE_RAM = 0x04000090;

  /** Level for a full-scale sample (15) at each setting, through the shared DAC map. */
  const FULL_SCALE = 15 / 7.5 - 1; // volume code 1, 100%
  const QUARTER = (15 >> 2) / 7.5 - 1; // volume code 3, 25%
  const FORCED_75 = ((15 * 3) >> 2) / 7.5 - 1; // force bit, 11/15 of full scale

  /** A powered APU playing a wave RAM full of 0xFF, so every sample is 15. */
  function playingMaxWave(volumeHigh: number): GbaApu {
    const apu = new GbaApu();
    apu.reset();
    apu.write(SOUNDCNT_X, 0x80);
    // Bank 0 is the playback bank, so select bank 1 to make the CPU side reach bank 0.
    apu.write(SOUND3CNT_L, 0x40);
    for (let i = 0; i < 16; i += 2) apu.write(WAVE_RAM + i, 0xffff);
    apu.write(SOUND3CNT_L, 0x80); // bank 0 plays, DAC on
    apu.write(SOUND3CNT_H, volumeHigh << 8);
    apu.write(SOUND3CNT_X, 0x8000); // trigger
    return apu;
  }

  function peakOutput(apu: GbaApu, ticks = 20000): number {
    let peak = -Infinity;
    for (let i = 0; i < ticks; i++) {
      apu.tick();
      const level = apu.ch3.output();
      if (level > peak) peak = level;
    }
    return peak;
  }

  it('THE MIXER HONOURS THE BIT: output drops to 75% with the volume code at 100%', () => {
    expect(peakOutput(playingMaxWave(0x20))).toBeCloseTo(FULL_SCALE, 6);
    expect(peakOutput(playingMaxWave(0xa0))).toBeCloseTo(FORCED_75, 6);
    // Guard: the two settings must not coincide, or this asserts nothing.
    expect(FORCED_75).not.toBeCloseTo(FULL_SCALE, 6);
  });

  it('OVERRIDES the volume code rather than combining with it — 75% is LOUDER than 25%', () => {
    // A mixer that ignored bit 15 would return the 25% level for both. A mixer that
    // multiplied the two would return something quieter than 25%, not louder.
    expect(peakOutput(playingMaxWave(0x60))).toBeCloseTo(QUARTER, 6);
    expect(peakOutput(playingMaxWave(0xe0))).toBeCloseTo(FORCED_75, 6);
    expect(FORCED_75).toBeGreaterThan(QUARTER);
  });

  it('reads back in bit 15 of SOUND3CNT_H', () => {
    const apu = playingMaxWave(0xa0);
    expect(apu.read(SOUND3CNT_H)).toBe(0xa000);
    apu.write(SOUND3CNT_H, 0x2000); // clear it again
    expect(apu.read(SOUND3CNT_H)).toBe(0x2000);
  });

  it('CARRIES THROUGH A SAVE STATE, and is not silently re-derived on load', () => {
    const apu = playingMaxWave(0xa0);
    const w = new StateWriter();
    apu.saveState(w);
    const state = w.finish();

    // Overwrite the bit before restoring — without this the test passes against a
    // saveState that never wrote it at all.
    apu.write(SOUND3CNT_H, 0x2000);
    expect(apu.read(SOUND3CNT_H)).toBe(0x2000);
    expect(peakOutput(apu)).toBeCloseTo(FULL_SCALE, 6);

    apu.loadState(new StateReader(state));
    expect(apu.read(SOUND3CNT_H)).toBe(0xa000);
    expect(peakOutput(apu)).toBeCloseTo(FORCED_75, 6);
  });

  it('is GBA-only: the Game Boy path cannot set it, since DMG NR32 bit 7 is unused', () => {
    // The DMG APU calls `writeNr32`, which must leave the force bit alone. Writing 0xFF
    // through it sets volume code 3 and nothing else.
    const apu = playingMaxWave(0x20);
    apu.ch3.writeNr32(0xff);
    expect(apu.read(SOUND3CNT_H)).toBe(0x6000); // volume 3, force clear
    expect(peakOutput(apu)).toBeCloseTo(QUARTER, 6);
  });
});
