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
