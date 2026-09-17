import { describe, expect, it } from 'vitest';
import {
  createCartridge,
  Mbc2Cartridge,
  Mbc3Cartridge,
  Mbc5Cartridge,
  hasBattery,
  hasRtc,
  packSave,
  unpackSave,
} from '../../packages/emulator/src/gb/cartridge/cartridges.js';
import {
  advanceRtc,
  createRtcState,
  serializeRtc,
  deserializeRtc,
} from '../../packages/emulator/src/gb/cartridge/rtc.js';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import { buildRom } from '../harness/rom.js';

const build = (type: number, banks = 4, ramSizeCode = 0x03) =>
  createCartridge(buildRom({ cartridgeType: type, romBanks: banks, ramSizeCode })).cartridge;

describe('mapper selection', () => {
  it.each([
    [0x05, Mbc2Cartridge],
    [0x06, Mbc2Cartridge],
    [0x11, Mbc3Cartridge],
    [0x13, Mbc3Cartridge],
    [0x19, Mbc5Cartridge],
    [0x1b, Mbc5Cartridge],
  ])('builds the right mapper for type 0x%s', (type, expected) => {
    expect(build(type)).toBeInstanceOf(expected);
  });

  it('still rejects genuinely unknown types', () => {
    expect(() => build(0xfe)).toThrow(/not supported/);
  });

  it('knows which cartridges carry a battery and a clock', () => {
    expect(hasBattery(0x03)).toBe(true);
    expect(hasBattery(0x01)).toBe(false);
    expect(hasRtc(0x0f)).toBe(true);
    expect(hasRtc(0x13)).toBe(false);
  });
});

describe('MBC2', () => {
  it('creates its built-in RAM even though the header declares none', () => {
    const cart = createCartridge(
      buildRom({ cartridgeType: 0x06, romBanks: 4, ramSizeCode: 0x00 }),
    ).cartridge;
    cart.write(0x0000, 0x0a);
    cart.write(0xa000, 0x0c);
    expect(cart.read(0xa000) & 0x0f).toBe(0x0c);
  });

  it('IS 4-BIT: the upper nibble does not exist and reads as ones', () => {
    const cart = build(0x06);
    cart.write(0x0000, 0x0a);
    cart.write(0xa000, 0xff);
    expect(cart.read(0xa000)).toBe(0xff);
    cart.write(0xa001, 0x03);
    expect(cart.read(0xa001)).toBe(0xf3); // upper nibble forced high
  });

  it('mirrors its 512 cells through the whole RAM window', () => {
    const cart = build(0x06);
    cart.write(0x0000, 0x0a);
    cart.write(0xa000, 0x07);
    expect(cart.read(0xa200) & 0x0f).toBe(0x07); // 0xA200 mirrors 0xA000
    expect(cart.read(0xbe00) & 0x0f).toBe(0x07);
  });

  it('SELECTS REGISTERS BY ADDRESS BIT 8, not by address range', () => {
    const cart = build(0x06, 8);
    cart.write(0x2100, 0x03); // bit 8 set -> ROM bank
    expect(cart.read(0x4000)).toBe(3);
    cart.write(0x2000, 0x00); // bit 8 clear -> RAM enable, NOT bank 0
    expect(cart.read(0x4000)).toBe(3); // bank unchanged
  });

  it('applies the zero-to-one correction to the bank register', () => {
    const cart = build(0x06, 8);
    cart.write(0x2100, 0x00);
    expect(cart.read(0x4000)).toBe(1);
  });
});

describe('MBC5', () => {
  it('ALLOWS BANK 0 in the switchable slot, unlike MBC1', () => {
    const cart = build(0x1b, 8);
    cart.write(0x2000, 0x00);
    expect(cart.read(0x4000)).toBe(0);
  });

  it('assembles a 9-bit bank number from two registers', () => {
    const cart = build(0x1b, 512);
    cart.write(0x2000, 0x05); // low bits
    cart.write(0x3000, 0x01); // bit 8
    expect(cart.read(0x4000)).toBe(0x105 & 0xff);
  });

  it('banks cartridge RAM with a 4-bit register', () => {
    const cart = build(0x1b, 4, 0x03); // 32KB RAM = 4 banks
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x00);
    cart.write(0xa000, 0x11);
    cart.write(0x4000, 0x01);
    cart.write(0xa000, 0x22);
    cart.write(0x4000, 0x00);
    expect(cart.read(0xa000)).toBe(0x11);
    cart.write(0x4000, 0x01);
    expect(cart.read(0xa000)).toBe(0x22);
  });
});

describe('MBC3 real-time clock', () => {
  it('maps clock registers into the RAM window when selected', () => {
    const cart = build(0x10) as Mbc3Cartridge;
    cart.write(0x0000, 0x0a);
    cart.write(0x4000, 0x08); // select seconds
    cart.write(0xa000, 30);
    cart.write(0x6000, 0x00);
    cart.write(0x6000, 0x01); // latch
    expect(cart.read(0xa000)).toBe(30);
  });

  it('LATCHES all registers together, so a read cannot straddle a tick', () => {
    const cart = build(0x10) as Mbc3Cartridge;
    cart.write(0x0000, 0x0a);
    cart.write(0x6000, 0x00);
    cart.write(0x6000, 0x01);
    cart.write(0x4000, 0x08);
    const latched = cart.read(0xa000);

    // Advance real time without re-latching: the visible value must not move.
    cart.tickRtc(Date.now() + 5000);
    expect(cart.read(0xa000)).toBe(latched);

    cart.write(0x6000, 0x00);
    cart.write(0x6000, 0x01);
    expect(cart.read(0xa000)).not.toBe(latched);
  });

  it('honours the halt bit', () => {
    const state = createRtcState(0);
    state.halted = true;
    advanceRtc(state, 60_000);
    expect(state.seconds).toBe(0);
    expect(state.minutes).toBe(0);
  });

  it('advances by real elapsed time', () => {
    const state = createRtcState(0);
    advanceRtc(state, 3_661_000); // 1h 1m 1s
    expect(state.hours).toBe(1);
    expect(state.minutes).toBe(1);
    expect(state.seconds).toBe(1);
  });

  it('round-trips through the 48-byte .sav tail', () => {
    const state = createRtcState(1_700_000_000_000);
    state.seconds = 12;
    state.minutes = 34;
    state.hours = 5;
    state.days = 300;
    state.dayCarry = 1;
    const restored = deserializeRtc(serializeRtc(state));
    expect(restored).not.toBeNull();
    expect(restored!.seconds).toBe(12);
    expect(restored!.minutes).toBe(34);
    expect(restored!.hours).toBe(5);
    expect(restored!.days).toBe(300);
    expect(restored!.dayCarry).toBe(1);
  });

  it('KEEPS RUNNING WHILE CLOSED: the clock advances across a reload', () => {
    const state = createRtcState(0);
    const tail = serializeRtc(state);

    // Two real hours pass with the game shut.
    const restored = deserializeRtc(tail)!;
    advanceRtc(restored, 2 * 3_600_000);
    expect(restored.hours).toBe(2);
  });
});

describe('save payload', () => {
  it('packs and unpacks SRAM with no RTC', () => {
    const sram = new Uint8Array([1, 2, 3, 4]);
    const packed = packSave({ sram, rtc: null });
    expect(packed).toHaveLength(4);
    expect(unpackSave(packed, 4).rtc).toBeNull();
  });

  it('appends the RTC tail after SRAM, as other emulators expect', () => {
    const sram = new Uint8Array(8).fill(0xaa);
    const rtc = serializeRtc(createRtcState(0));
    const packed = packSave({ sram, rtc });
    expect(packed).toHaveLength(8 + 48);

    const unpacked = unpackSave(packed, 8);
    expect([...unpacked.sram]).toEqual([...sram]);
    expect(unpacked.rtc).toHaveLength(48);
  });
});

describe('battery saves through the core', () => {
  const romFor = (type: number) =>
    buildRom({ cartridgeType: type, romBanks: 4, ramSizeCode: 0x02 });

  it('reports no battery for a cartridge without one', () => {
    const core = new GameBoyCore();
    core.loadRom(romFor(0x01)); // MBC1, no battery
    expect(core.hasBatterySave()).toBe(false);
    expect(core.getSaveData()).toBeNull();
  });

  it('ROUND-TRIPS save RAM through export and import', () => {
    const core = new GameBoyCore();
    core.loadRom(romFor(0x03)); // MBC1+RAM+BATTERY

    core.mmu.write(0x0000, 0x0a); // enable RAM
    for (let i = 0; i < 16; i++) core.mmu.write(0xa000 + i, i * 3);

    const exported = core.getSaveData();
    expect(exported).not.toBeNull();

    const fresh = new GameBoyCore();
    fresh.loadRom(romFor(0x03));
    fresh.loadSaveData(exported!);
    fresh.mmu.write(0x0000, 0x0a);
    for (let i = 0; i < 16; i++) expect(fresh.mmu.read(0xa000 + i)).toBe(i * 3);
  });

  it('flags save RAM as dirty only when it is written, and clears on read', () => {
    const core = new GameBoyCore();
    core.loadRom(romFor(0x03));
    core.consumeSaveRamDirty();
    expect(core.consumeSaveRamDirty()).toBe(false);

    core.mmu.write(0x0000, 0x0a);
    core.mmu.write(0xa000, 0x99);
    expect(core.consumeSaveRamDirty()).toBe(true);
    expect(core.consumeSaveRamDirty()).toBe(false);
  });

  it('derives the same save key for the same game from a different file', () => {
    const a = new GameBoyCore();
    const b = new GameBoyCore();
    a.loadRom(romFor(0x03));
    b.loadRom(romFor(0x03));
    expect(a.getCartridgeInfo()!.saveKey).toBe(b.getCartridgeInfo()!.saveKey);

    const other = new GameBoyCore();
    other.loadRom(
      buildRom({ title: 'OTHER', cartridgeType: 0x03, romBanks: 4, ramSizeCode: 0x02 }),
    );
    expect(other.getCartridgeInfo()!.saveKey).not.toBe(a.getCartridgeInfo()!.saveKey);
  });

  it('tolerates a .sav that is the wrong size rather than corrupting memory', () => {
    const core = new GameBoyCore();
    core.loadRom(romFor(0x03));
    expect(() => core.loadSaveData(new Uint8Array(4))).not.toThrow();
    expect(() => core.loadSaveData(new Uint8Array(100_000))).not.toThrow();
  });
});
