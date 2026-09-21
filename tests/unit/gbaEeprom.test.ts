/**
 * GBA serial EEPROM.
 *
 * **There is no EEPROM test ROM in the corpus.** jsmolka/gba-tests ships `none`, `sram`,
 * `flash64` and `flash128` and nothing for EEPROM, so none of this is verified against
 * hardware — it is verified against the protocol as GBATEK specifies it. Every assertion
 * below names the GBATEK paragraph it comes from ("GBA Cart Backup EEPROM"), so a future
 * disagreement with a real cartridge can be traced to a specific claim.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { GbaMmu } from '../../packages/emulator/src/gba/memory/GbaMmu.js';
import { GameBoyAdvanceCore } from '../../packages/emulator/src/gba/GameBoyAdvanceCore.js';
import { detectBackupType } from '../../packages/emulator/src/gba/memory/backup.js';

/** GBATEK: "the eeprom can be then addressed at DFFFF00h..DFFFFFFh". */
const EEPROM = 0x0d000000;
const EEPROM_TOP = 0x0dffff00;
const BUFFER = 0x02000000;

/* ------------------------------ synthetic ROM ------------------------------ */

/**
 * A minimal GBA image carrying the SDK's EEPROM signature.
 *
 * No commercial ROM is involved: this is 1 KB of zeroes with the three header bytes the
 * detector looks at and the ASCII marker the save library leaves behind.
 */
function eepromRom(size = 0x400): Uint8Array {
  const rom = new Uint8Array(size);
  rom[0x03] = 0xea; // the entry-point branch opcode
  rom[0xb2] = 0x96; // the fixed byte in the GBA header
  const marker = 'EEPROM_V124';
  for (let i = 0; i < marker.length; i++) rom[0x200 + i] = marker.charCodeAt(i);
  return rom;
}

function mmuWithEeprom(romSize = 0x400): GbaMmu {
  const mmu = new GbaMmu();
  mmu.reset();
  mmu.loadRom(eepromRom(romSize));
  return mmu;
}

/* ------------------------------ DMA plumbing ------------------------------- */

/**
 * Programs DMA3 and runs it.
 *
 * GBATEK, "Using DMA": *"The buffer must be transfered as a whole to/from EEPROM by using
 * DMA3 ... use 16bit transfer mode, both source and destination address incrementing (ie.
 * DMA3CNT=80000000h+length)."* 0x8000 in the high halfword is exactly that control word.
 */
function dma3(mmu: GbaMmu, source: number, destination: number, units: number): void {
  mmu.write16(0x040000d4, source & 0xffff);
  mmu.write16(0x040000d6, (source >>> 16) & 0xffff);
  mmu.write16(0x040000d8, destination & 0xffff);
  mmu.write16(0x040000da, (destination >>> 16) & 0xffff);
  mmu.write16(0x040000dc, units);
  mmu.write16(0x040000de, 0x8000);
  mmu.dma.run();
}

/** GBATEK: "one halfword for each bit ... only bit0 is used". */
function sendBits(mmu: GbaMmu, bits: readonly number[], at = EEPROM): void {
  for (let i = 0; i < bits.length; i++) mmu.write16(BUFFER + i * 2, bits[i]!);
  dma3(mmu, BUFFER, at, bits.length);
}

/** GBATEK, "Set Address (For Reading)": 2 bits "11", n address bits MSB first, 1 bit "0". */
function readRequest(address: number, addressBits: number): number[] {
  const bits = [1, 1];
  for (let i = addressBits - 1; i >= 0; i--) bits.push((address >>> i) & 1);
  bits.push(0);
  return bits;
}

/**
 * GBATEK, "Write Data to Address": 2 bits "10", n address bits, 64 data bits, 1 bit "0".
 */
function writeRequest(address: number, addressBits: number, data: Uint8Array): number[] {
  const bits = [1, 0];
  for (let i = addressBits - 1; i >= 0; i--) bits.push((address >>> i) & 1);
  for (let byte = 0; byte < 8; byte++) {
    for (let i = 7; i >= 0; i--) bits.push((data[byte]! >>> i) & 1);
  }
  bits.push(0);
  return bits;
}

/**
 * GBATEK, "Read Data": read 68 bits, of which the first 4 are ignored and the remaining
 * 64 are the data, MSB first.
 */
function receivePage(mmu: GbaMmu, at = EEPROM): { ignored: number[]; data: Uint8Array } {
  dma3(mmu, at, BUFFER, 68);
  const ignored: number[] = [];
  for (let i = 0; i < 4; i++) ignored.push(mmu.read16(BUFFER + i * 2) & 1);
  const data = new Uint8Array(8);
  for (let k = 0; k < 64; k++) {
    const bit = mmu.read16(BUFFER + (4 + k) * 2) & 1;
    data[k >>> 3] = data[k >>> 3]! | (bit << (7 - (k & 7)));
  }
  return { ignored, data };
}

const PAGE = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);

/* --------------------------------- tests ----------------------------------- */

describe('EEPROM detection and region decoding', () => {
  it('detects the EEPROM_V signature', () => {
    expect(detectBackupType(eepromRom())).toBe('eeprom');
  });

  it('DOES NOT fall through to the byte-addressed SRAM path', () => {
    const mmu = mmuWithEeprom();
    // GBATEK maps EEPROM in its own window at 0x0D; nothing answers at the SRAM window.
    mmu.write8(0x0e000000, 0x5a);
    expect(mmu.read8(0x0e000000)).toBe(0xff);
  });

  it('answers across the whole of 0x0D on a cart of 16MB or less', () => {
    // GBATEK: "On carts with 16MB or smaller ROM, eeprom can be alternately accessed
    // anywhere at D000000h-DFFFFFFh."
    const mmu = mmuWithEeprom();
    sendBits(mmu, writeRequest(0x07, 6, PAGE), EEPROM);
    sendBits(mmu, readRequest(0x07, 6), EEPROM_TOP);
    expect([...receivePage(mmu, EEPROM_TOP).data]).toEqual([...PAGE]);
  });

  it('RESTRICTS ITSELF TO THE TOP 256 BYTES on a cart larger than 16MB', () => {
    // GBATEK: "the eeprom can be then addressed at DFFFF00h..DFFFFFFh. Respectively, with
    // eeprom, ROM is restricted to 8000000h-9FFFeFFh" — the rest of 0x0D is real ROM.
    const mmu = new GbaMmu();
    mmu.reset();
    mmu.backup.setType('eeprom');
    const big = new Uint8Array(0x01000000 + 4);
    big[0x00fffff0] = 0x77;
    mmu.rom = big;

    // 0x0D000000 mirrors ROM offset 0x01000000 on a big cart, so it is NOT the chip.
    expect(mmu.read8(0x0d000000)).toBe(big[0x01000000]);
    expect(mmu.read8(0x0cfffff0)).toBe(0x77);

    // The top 256 bytes still are.
    sendBits(mmu, writeRequest(0x02, 6, PAGE), EEPROM_TOP);
    sendBits(mmu, readRequest(0x02, 6), EEPROM_TOP);
    expect([...receivePage(mmu, EEPROM_TOP).data]).toEqual([...PAGE]);
  });

  it('leaves region 0x0D to the cartridge bus when there is no EEPROM', () => {
    // 0x0D is the top half of the third ROM mirror. Without an EEPROM nothing answers
    // there on a small cart, so the read is open bus — NOT the chip's "ready" bit.
    const plain = new GbaMmu();
    plain.reset();
    const rom = new Uint8Array(0x400);
    rom[0x03] = 0xea;
    rom[0xb2] = 0x96;
    plain.loadRom(rom);
    expect(plain.backup.getType()).toBe('none');
    expect(plain.read16(0x0d000000)).toBe(0);

    // The same address on an EEPROM cart reports ready.
    expect(mmuWithEeprom().read16(0x0d000000) & 1).toBe(1);
  });
});

describe('the EEPROM request protocol', () => {
  let mmu: GbaMmu;

  beforeEach(() => {
    mmu = mmuWithEeprom();
  });

  it('round-trips a 64-bit page on the 512 byte part', () => {
    sendBits(mmu, writeRequest(0x05, 6, PAGE));
    sendBits(mmu, readRequest(0x05, 6));
    const { data } = receivePage(mmu);
    expect([...data]).toEqual([...PAGE]);
  });

  it('round-trips a 64-bit page on the 8 KByte part', () => {
    sendBits(mmu, writeRequest(0x123, 14, PAGE));
    expect(mmu.backup.eeprom.addressWidth).toBe(14);
    sendBits(mmu, readRequest(0x123, 14));
    expect([...receivePage(mmu).data]).toEqual([...PAGE]);
  });

  it('PRECEDES THE DATA WITH 4 IGNORED BITS', () => {
    // GBATEK, "Read Data": "4 bits - ignore these / 64 bits - data".
    sendBits(mmu, writeRequest(0x00, 6, PAGE));
    sendBits(mmu, readRequest(0x00, 6));
    expect(receivePage(mmu).ignored).toEqual([0, 0, 0, 0]);
  });

  it('STORES THE DATA MSB FIRST, in 8-byte units', () => {
    // GBATEK: "64 bits - data (conventionally MSB first)" and "Addressing works in units
    // of 64bits" — so address 3 is byte offset 24, and the first bit sent is bit 7 of it.
    const marked = Uint8Array.from([0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);
    sendBits(mmu, writeRequest(0x03, 6, marked));
    const save = mmu.backup.getSaveData()!;
    expect(save[24]).toBe(0x80);
    expect(save[31]).toBe(0x01);
    // Neighbouring pages are untouched.
    expect(save[23]).toBe(0xff);
    expect(save[32]).toBe(0xff);
  });

  it('USES ONLY THE LOW 10 ADDRESS BITS of a 14-bit request', () => {
    // GBATEK: "a range of 0-3FFh, 14bit bus width (only the lower 10 address bits are
    // used, upper 4 bits should be zero)".
    sendBits(mmu, writeRequest(0x0123, 14, PAGE));
    sendBits(mmu, readRequest(0x1123, 14)); // same page, junk in the upper 4 bits
    expect([...receivePage(mmu).data]).toEqual([...PAGE]);
  });

  it('REPORTS READY after a write, the way a polling game expects', () => {
    // GBATEK: "keep reading from the chip, by normal LDRH [DFFFF00h], until Bit 0 of the
    // returned data becomes 1 (Ready)."
    sendBits(mmu, writeRequest(0x01, 6, PAGE));
    expect(mmu.read16(EEPROM_TOP) & 1).toBe(1);
  });

  it('returns one bit per halfword and reports ready once the reply is spent', () => {
    sendBits(mmu, writeRequest(0x02, 6, Uint8Array.from([0xff, 0, 0, 0, 0, 0, 0, 0])));
    sendBits(mmu, readRequest(0x02, 6));

    // 4 ignored bits, then the first data byte is 0xFF: eight 1 bits.
    for (let i = 0; i < 4; i++) expect(mmu.read16(EEPROM) & 1).toBe(0);
    for (let i = 0; i < 8; i++) expect(mmu.read16(EEPROM) & 1).toBe(1);
    // Drain the remaining 56 bits of the 68-bit stream.
    for (let i = 0; i < 56; i++) mmu.read16(EEPROM);
    expect(mmu.read16(EEPROM) & 1).toBe(1); // idle: ready
  });

  it('IGNORES A COMMAND THAT IS NEITHER "11" NOR "10"', () => {
    // GBATEK documents exactly two requests, "11" and "10", and says nothing about the
    // other two encodings. Treating them as "not a request, start over" is an inference,
    // not a documented rule — but the alternative, letting "01" fall through into the
    // write path, would let a stray DMA corrupt the save.
    sendBits(mmu, writeRequest(0x04, 6, PAGE));
    sendBits(mmu, [0, 1]);
    sendBits(mmu, readRequest(0x04, 6));
    expect([...receivePage(mmu).data]).toEqual([...PAGE]);
  });

  it('starts a fresh request if one arrives mid-reply', () => {
    sendBits(mmu, writeRequest(0x06, 6, PAGE));
    sendBits(mmu, readRequest(0x06, 6));
    mmu.read16(EEPROM); // consume one reply bit, then abandon the stream
    sendBits(mmu, readRequest(0x06, 6));
    expect([...receivePage(mmu).data]).toEqual([...PAGE]);
  });
});

describe('address width inference', () => {
  /**
   * GBATEK, "Notes": "There seems to be no autodection mechanism, so that a hardcoded bus
   * width must be used." The request-stream length is the only evidence available.
   */
  it.each([
    [9, 6], // 2 + 6 + 1, read request
    [17, 14], // 2 + 14 + 1, read request
    [73, 6], // 2 + 6 + 64 + 1, write request
    [81, 14], // 2 + 14 + 64 + 1, write request
  ])('a DMA3 stream of %i halfwords means a %i-bit bus', (units, bits) => {
    const mmu = mmuWithEeprom();
    sendBits(mmu, new Array<number>(units).fill(0));
    expect(mmu.backup.eeprom.addressWidth).toBe(bits);
  });

  it('LEAVES THE WIDTH ALONE for a length the protocol does not produce', () => {
    const mmu = mmuWithEeprom();
    sendBits(mmu, writeRequest(0x00, 14, PAGE)); // 81 halfwords: 14-bit
    expect(mmu.backup.eeprom.addressWidth).toBe(14);
    sendBits(mmu, new Array<number>(40).fill(0)); // meaningless length
    expect(mmu.backup.eeprom.addressWidth).toBe(14);
  });

  it('is not confused by the 68-halfword reply, which says nothing about width', () => {
    const mmu = mmuWithEeprom();
    sendBits(mmu, writeRequest(0x00, 14, PAGE));
    receivePage(mmu);
    expect(mmu.backup.eeprom.addressWidth).toBe(14);
  });

  it('IGNORES A 32-BIT DMA3 and a transfer on another channel', () => {
    // GBATEK, "Using DMA": EEPROM needs DMA3 in 16-bit mode. Neither of these is one.
    const mmu = mmuWithEeprom();
    expect(mmu.backup.eeprom.addressWidth).toBe(6);

    // DMA3, 17 units, but 32-bit transfers (bit 10 set).
    mmu.write16(0x040000d4, BUFFER & 0xffff);
    mmu.write16(0x040000d6, BUFFER >>> 16);
    mmu.write16(0x040000d8, EEPROM & 0xffff);
    mmu.write16(0x040000da, EEPROM >>> 16);
    mmu.write16(0x040000dc, 17);
    mmu.write16(0x040000de, 0x8400);
    mmu.dma.run();
    expect(mmu.backup.eeprom.addressWidth).toBe(6);

    // DMA0, 17 units, 16-bit. GBATEK: "DMA0-2 can't access external memory".
    mmu.write16(0x040000b0, BUFFER & 0xffff);
    mmu.write16(0x040000b2, BUFFER >>> 16);
    mmu.write16(0x040000b4, EEPROM & 0xffff);
    mmu.write16(0x040000b6, EEPROM >>> 16);
    mmu.write16(0x040000b8, 17);
    mmu.write16(0x040000ba, 0x8000);
    mmu.dma.run();
    expect(mmu.backup.eeprom.addressWidth).toBe(6);
  });
});

describe('EEPROM persistence', () => {
  function core(): GameBoyAdvanceCore {
    const c = new GameBoyAdvanceCore();
    c.loadRom(eepromRom());
    return c;
  }

  it('reports a battery and hands back 512 bytes for the small part', () => {
    const c = core();
    expect(c.hasBatterySave()).toBe(true);
    expect(c.getSaveData()!.length).toBe(0x200);
  });

  it('hands back 8192 bytes once a 14-bit request has been seen', () => {
    const c = core();
    sendBits(c.mmu, writeRequest(0x300, 14, PAGE));
    expect(c.getSaveData()!.length).toBe(0x2000);
  });

  it('MARKS THE SAVE DIRTY on a write and not on a read', () => {
    const c = core();
    expect(c.consumeSaveRamDirty()).toBe(false);
    sendBits(c.mmu, readRequest(0x00, 6));
    receivePage(c.mmu);
    expect(c.consumeSaveRamDirty()).toBe(false);
    sendBits(c.mmu, writeRequest(0x00, 6, PAGE));
    expect(c.consumeSaveRamDirty()).toBe(true);
    expect(c.consumeSaveRamDirty()).toBe(false);
  });

  it.each([
    [0x200, 6, 0x05],
    [0x2000, 14, 0x321],
  ])('round-trips a %i byte save through the SRAM path', (size, bits, address) => {
    const c = core();
    sendBits(c.mmu, writeRequest(address, bits, PAGE));
    const saved = new Uint8Array(c.getSaveData()!);
    expect(saved.length).toBe(size);

    // A fresh machine, as if the browser had been closed and reopened.
    const revived = core();
    revived.loadSaveData(saved);
    sendBits(revived.mmu, readRequest(address, bits));
    expect([...receivePage(revived.mmu).data]).toEqual([...PAGE]);
  });

  it('INFERS THE WIDTH FROM A LOADED SAVE, before the game runs any DMA', () => {
    // The chip cannot be asked and the header does not say, so an 8192-byte .sav is the
    // only hint available at load time.
    const c = core();
    expect(c.mmu.backup.eeprom.addressWidth).toBe(6);
    c.loadSaveData(new Uint8Array(0x2000).fill(0xff));
    expect(c.mmu.backup.eeprom.addressWidth).toBe(14);
    c.loadSaveData(new Uint8Array(0x200).fill(0xff));
    expect(c.mmu.backup.eeprom.addressWidth).toBe(6);
  });

  it('survives a console reset: the cartridge is not the console', () => {
    const c = core();
    sendBits(c.mmu, writeRequest(0x09, 6, PAGE));
    c.reset();
    sendBits(c.mmu, readRequest(0x09, 6));
    expect([...receivePage(c.mmu).data]).toEqual([...PAGE]);
  });
});

describe('EEPROM in a save state', () => {
  function core(): GameBoyAdvanceCore {
    const c = new GameBoyAdvanceCore();
    c.loadRom(eepromRom());
    return c;
  }

  it('carries the stored pages across a round trip', () => {
    const c = core();
    sendBits(c.mmu, writeRequest(0x11, 14, PAGE));
    const state = c.serialize();

    const restored = core();
    restored.deserialize(state);
    expect(restored.mmu.backup.eeprom.addressWidth).toBe(14);
    sendBits(restored.mmu, readRequest(0x11, 14));
    expect([...receivePage(restored.mmu).data]).toEqual([...PAGE]);
  });

  it('CARRIES THE STATE MACHINE, not just the bytes', () => {
    // The request and the reply are two separate DMA transfers, so a state genuinely can
    // land between them. If only the stored bytes were saved, the restored chip would be
    // idle and reply with 68 ready bits — 0xFF eight times over.
    const c = core();
    sendBits(c.mmu, writeRequest(0x0a, 6, PAGE));
    sendBits(c.mmu, readRequest(0x0a, 6)); // armed, reply not yet collected
    const state = c.serialize();

    const restored = core();
    restored.deserialize(state);
    expect([...receivePage(restored.mmu).data]).toEqual([...PAGE]);
  });

  it('carries a HALF-CLOCKED REQUEST: the bits already shifted in', () => {
    const c = core();
    sendBits(c.mmu, writeRequest(0x0c, 6, PAGE));

    // Clock in the first half of a read request by hand, then snapshot mid-stream.
    const bits = readRequest(0x0c, 6);
    for (const bit of bits.slice(0, 5)) c.mmu.write16(EEPROM, bit);
    const state = c.serialize();

    const restored = core();
    restored.deserialize(state);
    for (const bit of bits.slice(5)) restored.mmu.write16(EEPROM, bit);
    expect([...receivePage(restored.mmu).data]).toEqual([...PAGE]);
  });
});
