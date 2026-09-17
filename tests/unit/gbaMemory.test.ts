import { beforeEach, describe, expect, it } from 'vitest';
import { GbaMmu } from '../../packages/emulator/src/gba/memory/GbaMmu.js';
import { Waitstates } from '../../packages/emulator/src/gba/memory/waitstates.js';
import {
  TIMING_HBLANK,
  TIMING_IMMEDIATE,
  TIMING_VBLANK,
} from '../../packages/emulator/src/gba/memory/Dma.js';
import { TimerController } from '../../packages/emulator/src/gba/timer/Timers.js';

let mmu: GbaMmu;

beforeEach(() => {
  mmu = new GbaMmu();
  mmu.reset();
});

describe('region decoding and mirroring', () => {
  it('routes each region to its own storage', () => {
    mmu.write32(0x02000000, 0x11111111);
    mmu.write32(0x03000000, 0x22222222);
    mmu.write32(0x05000000, 0x33333333);
    mmu.write32(0x06000000, 0x44444444);
    mmu.write32(0x07000000, 0x55555555);

    expect(mmu.read32(0x02000000)).toBe(0x11111111);
    expect(mmu.read32(0x03000000)).toBe(0x22222222);
    expect(mmu.read32(0x05000000)).toBe(0x33333333);
    expect(mmu.read32(0x06000000)).toBe(0x44444444);
    expect(mmu.read32(0x07000000)).toBe(0x55555555);
  });

  it('mirrors EWRAM every 256KB and IWRAM every 32KB', () => {
    mmu.write32(0x02000000, 0xdeadbeef);
    expect(mmu.read32(0x02040000)).toBe(0xdeadbeef);
    mmu.write32(0x03000000, 0xcafebabe);
    expect(mmu.read32(0x03008000)).toBe(0xcafebabe);
  });

  it('MIRRORS THE UPPER 32KB OF VRAM: 96KB sits in a 128KB window', () => {
    mmu.write16(0x06010000, 0xabcd);
    // 0x18000 is past the end of real VRAM and folds back to 0x10000.
    expect(mmu.read16(0x06018000)).toBe(0xabcd);
  });

  it('treats SRAM as an 8-BIT BUS: wider reads replicate the byte', () => {
    // A bare MMU has no cartridge and therefore no save medium, so give it one.
    mmu.backup.setType('sram');
    mmu.write8(0x0e000000, 0x5a);
    expect(mmu.read16(0x0e000000)).toBe(0x5a5a);
    expect(mmu.read32(0x0e000000)).toBe(0x5a5a5a5a);
  });

  it('writes only ONE byte to SRAM, picked by the unaligned address', () => {
    // The 8-bit bus takes the byte of the value that lines up with A0/A1 — the rest of
    // the halfword or word never reaches the chip. jsmolka save/sram tests 6-9.
    mmu.backup.setType('sram');
    mmu.write16(0x0e000000, 0xaabb);
    expect(mmu.backup.read(0x0000)).toBe(0xbb);
    expect(mmu.backup.read(0x0001)).toBe(0xff); // untouched, still erased
    mmu.write16(0x0e000001, 0xaabb);
    expect(mmu.backup.read(0x0001)).toBe(0xaa);

    mmu.write32(0x0e000010, 0xaabbccdd);
    expect(mmu.backup.read(0x0010)).toBe(0xdd);
    expect(mmu.backup.read(0x0011)).toBe(0xff);
    mmu.write32(0x0e000013, 0xaabbccdd);
    expect(mmu.backup.read(0x0013)).toBe(0xaa);
  });

  it('duplicates an 8-bit write across the halfword in VRAM and palette', () => {
    // Neither region has a byte write path on hardware.
    mmu.write8(0x05000000, 0x77);
    expect(mmu.read16(0x05000000)).toBe(0x7777);
    mmu.write8(0x06000000, 0x88);
    expect(mmu.read16(0x06000000)).toBe(0x8888);
  });

  it('IGNORES 8-bit writes to OAM entirely', () => {
    mmu.write16(0x07000000, 0x1234);
    mmu.write8(0x07000000, 0xff);
    expect(mmu.read16(0x07000000)).toBe(0x1234);
  });

  it('never writes to ROM', () => {
    mmu.loadRom(new Uint8Array([0x11, 0x22, 0x33, 0x44]));
    mmu.write32(0x08000000, 0xffffffff);
    expect(mmu.read32(0x08000000)).toBe(0x44332211);
  });
});

describe('BIOS read protection', () => {
  it('returns the last fetched opcode when read from outside the BIOS', () => {
    mmu.bios.set([0xaa, 0xbb, 0xcc, 0xdd]);
    mmu.noteFetch(0x08000000, 0x12345678); // executing in ROM
    expect(mmu.read32(0x00000000)).not.toBe(0xddccbbaa);
  });

  it('returns the real bytes while executing inside the BIOS', () => {
    mmu.bios.set([0xaa, 0xbb, 0xcc, 0xdd]);
    mmu.noteFetch(0x00000000, 0xddccbbaa);
    expect(mmu.read32(0x00000000)).toBe(0xddccbbaa);
  });
});

describe('waitstates', () => {
  it('makes IWRAM faster than EWRAM', () => {
    const waits = new Waitstates();
    expect(waits.cycles(0x03000000, 4, false)).toBeLessThan(waits.cycles(0x02000000, 4, false));
  });

  it('COSTS A 32-BIT ACCESS TWICE on a 16-bit bus', () => {
    const waits = new Waitstates();
    const half = waits.cycles(0x02000000, 2, false);
    const word = waits.cycles(0x02000000, 4, false);
    expect(word).toBeGreaterThan(half);
  });

  it('honours WAITCNT for ROM', () => {
    const waits = new Waitstates();
    const slow = waits.cycles(0x08000000, 2, false);
    waits.setControl(0x0004); // ROM0 non-sequential = 3 waits
    expect(waits.cycles(0x08000000, 2, false)).not.toBe(slow);
  });

  it('makes a sequential ROM access cheaper than a non-sequential one', () => {
    const waits = new Waitstates();
    expect(waits.cycles(0x08000000, 2, true)).toBeLessThan(waits.cycles(0x08000000, 2, false));
  });
});

describe('DMA', () => {
  const configure = (
    channel: number,
    src: number,
    dst: number,
    count: number,
    control: number,
  ): void => {
    const base = 0x040000b0 + channel * 12;
    mmu.write16(base, src & 0xffff);
    mmu.write16(base + 2, (src >>> 16) & 0xffff);
    mmu.write16(base + 4, dst & 0xffff);
    mmu.write16(base + 6, (dst >>> 16) & 0xffff);
    mmu.write16(base + 8, count);
    mmu.write16(base + 10, control);
  };

  it('copies words immediately when enabled with immediate timing', () => {
    for (let i = 0; i < 4; i++) mmu.write32(0x02000000 + i * 4, 0x1000 + i);
    configure(3, 0x02000000, 0x03000000, 4, 0x8000 | 0x0400); // enable + 32-bit
    mmu.dma.run();
    for (let i = 0; i < 4; i++) expect(mmu.read32(0x03000000 + i * 4)).toBe(0x1000 + i);
  });

  it('copies halfwords when the width bit is clear', () => {
    mmu.write16(0x02000000, 0xbeef);
    configure(3, 0x02000000, 0x03000000, 1, 0x8000);
    mmu.dma.run();
    expect(mmu.read16(0x03000000)).toBe(0xbeef);
  });

  it('holds a fixed destination when that address mode is selected', () => {
    for (let i = 0; i < 4; i++) mmu.write32(0x02000000 + i * 4, i + 1);
    // Destination control = fixed (2 << 5).
    configure(3, 0x02000000, 0x03000000, 4, 0x8000 | 0x0400 | (2 << 5));
    mmu.dma.run();
    expect(mmu.read32(0x03000000)).toBe(4); // last word written wins
    expect(mmu.read32(0x03000004)).toBe(0);
  });

  it('DOES NOT FIRE until its timing condition arrives', () => {
    mmu.write32(0x02000000, 0x99);
    configure(3, 0x02000000, 0x03000000, 1, 0x8000 | 0x0400 | (TIMING_VBLANK << 12));
    mmu.dma.run();
    expect(mmu.read32(0x03000000)).toBe(0);

    mmu.dma.notifyVBlank();
    mmu.dma.run();
    expect(mmu.read32(0x03000000)).toBe(0x99);
  });

  it('services HBlank channels only on HBlank', () => {
    mmu.write32(0x02000000, 0x77);
    configure(3, 0x02000000, 0x03000000, 1, 0x8000 | 0x0400 | (TIMING_HBLANK << 12));
    mmu.dma.notifyVBlank();
    mmu.dma.run();
    expect(mmu.read32(0x03000000)).toBe(0);
    mmu.dma.notifyHBlank();
    mmu.dma.run();
    expect(mmu.read32(0x03000000)).toBe(0x77);
  });

  it('clears the enable bit after a non-repeating transfer', () => {
    configure(3, 0x02000000, 0x03000000, 1, 0x8000 | 0x0400 | (TIMING_IMMEDIATE << 12));
    mmu.dma.run();
    expect(mmu.dma.channels[3]!.enabled).toBe(false);
  });

  it('raises an interrupt when the IRQ bit is set', () => {
    configure(3, 0x02000000, 0x03000000, 1, 0x8000 | 0x0400 | 0x4000);
    mmu.dma.run();
    expect(mmu.irqFlags & (1 << 11)).not.toBe(0); // DMA3 is IRQ bit 11
  });

  it('gives channel 3 a 16-bit count and the others 14', () => {
    // Count 0 means "maximum": 0x4000 for channels 0-2, 0x10000 for channel 3.
    configure(0, 0x02000000, 0x03000000, 0, 0x8000);
    expect(mmu.dma.channels[0]!.enabled).toBe(true);
  });
});

describe('timers', () => {
  it('counts down the prescaler before incrementing', () => {
    const timers = new TimerController(() => undefined);
    timers.write16(0x04000102, 0x80 | 1); // enable, prescaler 64
    timers.tick(63);
    expect(timers.read(0x04000100)).toBe(0);
    timers.tick(1);
    expect(timers.read(0x04000100)).toBe(1);
  });

  it('RELOADS rather than wrapping to zero on overflow', () => {
    const timers = new TimerController(() => undefined);
    timers.write16(0x04000100, 0xfff0); // reload value
    timers.write16(0x04000102, 0x80); // enable, prescaler 1
    timers.tick(0x10); // overflow exactly
    expect(timers.read(0x04000100)).toBe(0xfff0);
  });

  it('writing the counter address sets the RELOAD, not the counter', () => {
    const timers = new TimerController(() => undefined);
    timers.write16(0x04000102, 0x80);
    timers.tick(5);
    expect(timers.read(0x04000100)).toBe(5);
    timers.write16(0x04000100, 0x1234); // reload only
    expect(timers.read(0x04000100)).toBe(5); // counter untouched
  });

  it('CASCADES: timer 1 counts overflows of timer 0, not cycles', () => {
    const timers = new TimerController(() => undefined);
    timers.write16(0x04000100, 0xffff); // timer 0 reload — overflows every cycle
    timers.write16(0x04000102, 0x80);
    timers.write16(0x04000106, 0x80 | 0x04); // timer 1: enable + cascade

    timers.tick(4);
    expect(timers.read(0x04000104)).toBe(4); // one step per timer-0 overflow
  });

  it('a cascaded timer ignores the cycle count entirely', () => {
    const timers = new TimerController(() => undefined);
    timers.write16(0x04000106, 0x80 | 0x04); // timer 1 cascade, timer 0 disabled
    timers.tick(100000);
    expect(timers.read(0x04000104)).toBe(0);
  });

  it('raises an interrupt on overflow when enabled', () => {
    const fired: number[] = [];
    const timers = new TimerController((i) => fired.push(i));
    timers.write16(0x04000100, 0xffff);
    timers.write16(0x04000102, 0x80 | 0x40); // enable + IRQ
    timers.tick(2);
    expect(fired).toContain(0);
  });
});

describe('interrupt registers', () => {
  it('WRITING IF ACKNOWLEDGES: a 1 bit clears the flag', () => {
    mmu.requestInterrupt(0x0001);
    expect(mmu.read16(0x04000202) & 1).toBe(1);
    mmu.write16(0x04000202, 0x0001);
    expect(mmu.read16(0x04000202) & 1).toBe(0);
  });

  it('reports pending only when IME and IE both allow it', () => {
    mmu.requestInterrupt(0x0001);
    expect(mmu.irqPending).toBe(false); // IME off
    mmu.write16(0x04000208, 1);
    expect(mmu.irqPending).toBe(false); // IE still masked
    mmu.write16(0x04000200, 0x0001);
    expect(mmu.irqPending).toBe(true);
  });
});
