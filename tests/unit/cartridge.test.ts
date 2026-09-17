import { describe, expect, it } from 'vitest';
import {
  parseHeader,
  detectSystem,
  isGbaRom,
  computeHeaderChecksum,
  CartridgeHeaderError,
  HEADER,
} from '../../packages/emulator/src/gb/cartridge/header.js';
import {
  createCartridge,
  Mbc1Cartridge,
  RomOnlyCartridge,
  UnsupportedMapperError,
} from '../../packages/emulator/src/gb/cartridge/cartridges.js';
import { buildRom } from '../harness/rom.js';

describe('header parsing', () => {
  it('reads title, type and sizes', () => {
    const info = parseHeader(
      buildRom({ title: 'ZELDA', cartridgeType: 0x03, romBanks: 8, ramSizeCode: 0x02 }),
    );
    expect(info.title).toBe('ZELDA');
    expect(info.cartridgeType).toBe(0x03);
    expect(info.romSize).toBe(8 * 0x4000);
    expect(info.ramSize).toBe(8192);
    expect(info.system).toBe('GB');
    expect(info.headerChecksumValid).toBe(true);
  });

  it('reports a bad header checksum without throwing', () => {
    const info = parseHeader(buildRom({ badChecksum: true }));
    expect(info.headerChecksumValid).toBe(false);
  });

  it('computes the header checksum as x = x - byte - 1 over 0x134..0x14C', () => {
    const rom = buildRom({ title: 'ABC' });
    expect(computeHeaderChecksum(rom)).toBe(rom[HEADER.HEADER_CHECKSUM]);
  });

  it.each([
    [0x80, 'GBC', true],
    [0xc0, 'GBC', true],
    [0x00, 'GB', false],
  ])('maps CGB flag 0x%s to %s', (flag, system, colorCapable) => {
    const info = parseHeader(buildRom({ cgbFlag: flag }));
    expect(info.system).toBe(system);
    expect(info.isColorCapable).toBe(colorCapable);
  });

  it('rejects a ROM too short to hold a header, with a clear message', () => {
    expect(() => parseHeader(new Uint8Array(64))).toThrow(CartridgeHeaderError);
    expect(() => parseHeader(new Uint8Array(64))).toThrow(/too short/);
  });

  it('derives a save key from content, not filename, so two dumps share a save', () => {
    const a = parseHeader(buildRom({ title: 'POKEMON' }));
    const b = parseHeader(buildRom({ title: 'POKEMON' }));
    const other = parseHeader(buildRom({ title: 'TETRIS' }));
    expect(a.saveKey).toBe(b.saveKey);
    expect(a.saveKey).not.toBe(other.saveKey);
  });

  it('detects a GBA ROM from its own header, never a filename', () => {
    const gba = new Uint8Array(0x200);
    gba[0x03] = 0xea;
    gba[0xb2] = 0x96;
    expect(isGbaRom(gba)).toBe(true);
    expect(detectSystem(gba)).toBe('GBA');
    expect(isGbaRom(buildRom())).toBe(false);
  });
});

describe('mapper selection', () => {
  it('builds a ROM-only cartridge for type 0x00', () => {
    expect(createCartridge(buildRom({ cartridgeType: 0x00 })).cartridge).toBeInstanceOf(
      RomOnlyCartridge,
    );
  });

  it.each([0x01, 0x02, 0x03])('builds MBC1 for type 0x%s', (type) => {
    expect(
      createCartridge(buildRom({ cartridgeType: type, romBanks: 4 })).cartridge,
    ).toBeInstanceOf(Mbc1Cartridge);
  });

  it.each([
    [0x05, 'MBC2'],
    [0x13, 'MBC3'],
    [0x1b, 'MBC5'],
  ])('builds a working cartridge for type 0x%s (%s)', (type, _name) => {
    // These were "unsupported" until Phase 06. Mapper-specific behaviour is covered in
    // mappers.test.ts; here we only assert the factory no longer refuses them.
    expect(() => createCartridge(buildRom({ cartridgeType: type, romBanks: 4 }))).not.toThrow();
  });

  it('still reports a genuinely unknown cartridge type rather than misbehaving', () => {
    expect(() => createCartridge(buildRom({ cartridgeType: 0xfe, romBanks: 4 }))).toThrow(
      UnsupportedMapperError,
    );
  });
});

describe('MBC1 banking', () => {
  const build = (banks: number) =>
    createCartridge(buildRom({ cartridgeType: 0x03, romBanks: banks, ramSizeCode: 0x03 }))
      .cartridge;

  it('maps bank 1 into 0x4000 by default', () => {
    expect(build(4).read(0x4000)).toBe(1);
  });

  it('switches ROM banks through 0x2000-0x3FFF', () => {
    const cart = build(8);
    cart.write(0x2000, 3);
    expect(cart.read(0x4000)).toBe(3);
    cart.write(0x2000, 5);
    expect(cart.read(0x4000)).toBe(5);
  });

  it('THE QUIRK: writing bank 0 selects bank 1', () => {
    const cart = build(4);
    cart.write(0x2000, 0);
    expect(cart.read(0x4000)).toBe(1);
  });

  it('THE QUIRK: bank 0x20 is unreachable and reads as 0x21', () => {
    const cart = build(64); // 1MB, 64 banks — needs the upper register
    cart.write(0x6000, 0); // ROM banking mode
    cart.write(0x4000, 1); // upper bits = 1  -> bank 0x20
    cart.write(0x2000, 0); // low bits = 0 -> corrected to 1
    expect(cart.read(0x4000)).toBe(0x21);
  });

  it('keeps bank 0 fixed at 0x0000 in mode 0, and banks it in mode 1', () => {
    const cart = build(64);
    cart.write(0x4000, 1);
    cart.write(0x6000, 0);
    expect(cart.read(0x0000)).toBe(0);
    cart.write(0x6000, 1);
    expect(cart.read(0x0000)).toBe(0x20);
  });

  it('wraps bank numbers within the cartridge size', () => {
    const cart = build(4);
    cart.write(0x2000, 7); // only 4 banks exist
    expect(cart.read(0x4000)).toBe(3);
  });

  it('gates cartridge RAM behind the enable register', () => {
    const cart = build(4);
    cart.write(0xa000, 0x42);
    expect(cart.read(0xa000)).toBe(0xff); // disabled

    cart.write(0x0000, 0x0a);
    cart.write(0xa000, 0x42);
    expect(cart.read(0xa000)).toBe(0x42);

    cart.write(0x0000, 0x00);
    expect(cart.read(0xa000)).toBe(0xff);
  });

  it('marks save RAM dirty only when it is actually written', () => {
    const cart = build(4);
    expect(cart.saveRamDirty).toBe(false);
    cart.write(0x0000, 0x0a);
    cart.write(0xa000, 0x01);
    expect(cart.saveRamDirty).toBe(true);
    cart.clearSaveRamDirty();
    expect(cart.saveRamDirty).toBe(false);
  });
});
