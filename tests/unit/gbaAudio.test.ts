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
