import { beforeEach, describe, expect, it } from 'vitest';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import { buildRom } from '../harness/rom.js';

let core: GameBoyCore;

beforeEach(() => {
  core = new GameBoyCore();
  core.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2 }));
});

const NR52 = 0xff26;
const NR51 = 0xff25;
const NR50 = 0xff24;

describe('APU power', () => {
  it('reports powered state in NR52 bit 7', () => {
    expect(core.mmu.read(NR52) & 0x80).toBe(0x80);
    core.mmu.write(NR52, 0x00);
    expect(core.mmu.read(NR52) & 0x80).toBe(0);
  });

  it('zeroes the mixer registers when powered off', () => {
    core.mmu.write(NR50, 0x77);
    core.mmu.write(NR51, 0xff);
    core.mmu.write(NR52, 0x00);
    expect(core.mmu.read(NR50)).toBe(0x00);
    expect(core.mmu.read(NR51)).toBe(0x00);
  });

  it('ignores writes to most registers while powered off', () => {
    core.mmu.write(NR52, 0x00);
    core.mmu.write(0xff12, 0xf0); // NR12 envelope
    expect(core.mmu.read(0xff12)).toBe(0x00);
  });

  it('KEEPS WAVE RAM across a power cycle, unlike every other register', () => {
    core.mmu.write(0xff30, 0xa5);
    core.mmu.write(NR52, 0x00);
    core.mmu.write(NR52, 0x80);
    expect(core.mmu.read(0xff30)).toBe(0xa5);
  });

  it('reads the unused bits of NR52 as 1', () => {
    expect(core.mmu.read(NR52) & 0x70).toBe(0x70);
  });
});

describe('DAC control', () => {
  it('disables a channel the moment its DAC is powered down', () => {
    core.mmu.write(0xff12, 0xf0); // NR12: volume 15, DAC on
    core.mmu.write(0xff14, 0x80); // trigger
    expect(core.mmu.read(NR52) & 0x01).toBe(0x01);

    core.mmu.write(0xff12, 0x00); // upper 5 bits zero -> DAC off
    expect(core.mmu.read(NR52) & 0x01).toBe(0);
  });

  it('refuses to enable a channel triggered with its DAC off', () => {
    core.mmu.write(0xff12, 0x00);
    core.mmu.write(0xff14, 0x80);
    expect(core.mmu.read(NR52) & 0x01).toBe(0);
  });

  it('uses NR30 bit 7 as the wave channel DAC, not an envelope', () => {
    core.mmu.write(0xff1a, 0x80); // DAC on
    core.mmu.write(0xff1e, 0x80); // trigger
    expect(core.mmu.read(NR52) & 0x04).toBe(0x04);

    core.mmu.write(0xff1a, 0x00);
    expect(core.mmu.read(NR52) & 0x04).toBe(0);
  });
});

describe('register read masks', () => {
  it.each([
    [0xff10, 0x80],
    [0xff11, 0x3f],
    [0xff14, 0xbf],
    [0xff1a, 0x7f],
    [0xff1c, 0x9f],
    [0xff1e, 0xbf],
    [0xff23, 0xbf],
  ])('sets the unused bits of 0x%s', (address, mask) => {
    core.mmu.write(address, 0x00);
    expect(core.mmu.read(address) & mask).toBe(mask);
  });

  it.each([0xff13, 0xff18, 0xff1b, 0xff1d, 0xff20])(
    'reads write-only register 0x%s as 0xFF',
    (address) => {
      core.mmu.write(address, 0x12);
      expect(core.mmu.read(address)).toBe(0xff);
    },
  );
});

describe('frame sequencer', () => {
  it('is clocked from a DIV bit, so writing DIV can step it early', () => {
    // Enable a channel with a short length so a length clock is observable.
    core.mmu.write(0xff12, 0xf0);
    core.mmu.write(0xff11, 0x3f); // length = 1
    core.mmu.write(0xff14, 0xc0); // trigger + length enable
    expect(core.mmu.read(NR52) & 0x01).toBe(0x01);

    // Run long enough for the sequencer to clock length several times.
    for (let i = 0; i < 40000; i++) core.cpu.tickT(1);
    expect(core.mmu.read(NR52) & 0x01).toBe(0);
  });

  it('silences a channel when its length counter expires', () => {
    core.mmu.write(0xff12, 0xf0);
    core.mmu.write(0xff11, 0x3e); // length = 2
    core.mmu.write(0xff14, 0xc0);
    expect(core.mmu.read(NR52) & 0x01).toBe(0x01);
    for (let i = 0; i < 80000; i++) core.cpu.tickT(1);
    expect(core.mmu.read(NR52) & 0x01).toBe(0);
  });

  it('keeps a channel alive indefinitely when length is disabled', () => {
    core.mmu.write(0xff12, 0xf0);
    core.mmu.write(0xff11, 0x3f);
    core.mmu.write(0xff14, 0x80); // trigger, length NOT enabled
    for (let i = 0; i < 200000; i++) core.cpu.tickT(1);
    expect(core.mmu.read(NR52) & 0x01).toBe(0x01);
  });
});

describe('sample output', () => {
  it('emits samples at the requested host rate', () => {
    let count = 0;
    core.apu.setOutputRate(48000, () => count++);
    core.mmu.write(0xff12, 0xf0);
    core.mmu.write(0xff14, 0x87);

    // One emulated second of T-cycles.
    for (let i = 0; i < 4194304; i++) core.cpu.tickT(1);
    // Within 1% of the requested rate.
    expect(count).toBeGreaterThan(47000);
    expect(count).toBeLessThan(49000);
  });

  it('produces silence with every channel off', () => {
    const samples: number[] = [];
    core.apu.setOutputRate(48000, (left) => samples.push(left));
    core.mmu.write(NR52, 0x00); // power down
    core.mmu.write(NR52, 0x80);
    for (let i = 0; i < 100000; i++) core.cpu.tickT(1);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s === 0)).toBe(true);
  });

  it('produces a non-silent, bounded signal from a triggered pulse channel', () => {
    const samples: number[] = [];
    core.apu.setOutputRate(48000, (left) => samples.push(left));
    core.mmu.write(NR50, 0x77); // full volume both sides
    core.mmu.write(NR51, 0xff); // everything panned to both
    core.mmu.write(0xff12, 0xf0);
    core.mmu.write(0xff13, 0x00);
    core.mmu.write(0xff14, 0x86); // trigger, mid frequency

    for (let i = 0; i < 200000; i++) core.cpu.tickT(1);
    expect(samples.some((s) => s !== 0)).toBe(true);
    expect(samples.every((s) => s >= -1 && s <= 1)).toBe(true);
  });

  it('respects NR51 panning', () => {
    const left: number[] = [];
    const right: number[] = [];
    core.apu.setOutputRate(48000, (l, r) => {
      left.push(l);
      right.push(r);
    });
    core.mmu.write(NR50, 0x77);
    core.mmu.write(NR51, 0x10); // channel 1 to LEFT only
    core.mmu.write(0xff12, 0xf0);
    core.mmu.write(0xff14, 0x86);

    for (let i = 0; i < 200000; i++) core.cpu.tickT(1);
    expect(left.some((s) => s !== 0)).toBe(true);
    expect(right.every((s) => s === 0)).toBe(true);
  });
});
