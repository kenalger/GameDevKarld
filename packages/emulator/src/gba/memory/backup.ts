import type { StateReader, StateWriter } from '../../gb/state/StateBuffer.js';

/**
 * GBA cartridge backup media.
 *
 * Unlike the Game Boy, the GBA gives no header field for the save type — the accepted
 * technique (used by every emulator) is to scan the ROM for an identifying ASCII string
 * that the SDK's save library leaves behind.
 */
export type BackupType = 'none' | 'sram' | 'flash64' | 'flash128' | 'eeprom';

const SIGNATURES: readonly { readonly marker: string; readonly type: BackupType }[] = [
  { marker: 'EEPROM_V', type: 'eeprom' },
  { marker: 'SRAM_V', type: 'sram' },
  { marker: 'SRAM_F_V', type: 'sram' },
  { marker: 'FLASH1M_V', type: 'flash128' },
  { marker: 'FLASH512_V', type: 'flash64' },
  { marker: 'FLASH_V', type: 'flash64' },
];

/** Scans a ROM for the SDK's save-library signature. */
export function detectBackupType(rom: Uint8Array): BackupType {
  // Signatures are word-aligned, so stepping by 4 is both correct and much faster.
  for (let offset = 0; offset + 16 < rom.length; offset += 4) {
    for (const { marker, type } of SIGNATURES) {
      let matched = true;
      for (let i = 0; i < marker.length; i++) {
        if (rom[offset + i] !== marker.charCodeAt(i)) {
          matched = false;
          break;
        }
      }
      // FLASH_V would also match the front of FLASH1M_V / FLASH512_V, so the longer
      // markers are listed first and the first hit wins.
      if (matched) return type;
    }
  }
  return 'none';
}

/** Stable numeric ids for the save format. APPEND ONLY — never reorder. */
const BACKUP_TYPE_IDS: readonly BackupType[] = ['none', 'sram', 'flash64', 'flash128', 'eeprom'];

/* ------------------------------- EEPROM ------------------------------------ */

/**
 * EEPROM phases. The chip is a bit-serial state machine, not memory: every halfword
 * written to its window carries one command bit in bit 0, and every halfword read
 * returns one reply bit in bit 0. GBATEK, "GBA Cart Backup EEPROM".
 */
const EE_COMMAND = 0; // collecting the 2 command bits
const EE_ADDRESS = 1; // collecting 6 or 14 address bits
const EE_READ_END = 2; // the single "0" that closes a read request
const EE_WRITE_DATA = 3; // collecting 64 data bits
const EE_WRITE_END = 4; // the single "0" that closes a write request
const EE_SEND = 5; // shifting out 4 ignored bits + 64 data bits
const EE_READY = 6; // write finished; reads report ready

/** GBATEK: 2 bits "11" (Read Request), 2 bits "10" (Write Request). */
const EE_CMD_READ = 0b11;
const EE_CMD_WRITE = 0b10;

/** GBATEK: "Read a stream of 68 bits" — 4 bits to ignore, then 64 bits of data. */
const EE_READ_STREAM_BITS = 68;
const EE_IGNORED_BITS = 4;

/**
 * Request-stream lengths, in halfwords, for each address width.
 *
 * GBATEK, "Set Address (For Reading)": 2 command bits + n address bits + 1 zero bit.
 * GBATEK, "Write Data to Address":     2 command bits + n address bits + 64 data + 1 zero.
 */
const EE_READ_REQUEST_6 = 2 + 6 + 1; // 9
const EE_READ_REQUEST_14 = 2 + 14 + 1; // 17
const EE_WRITE_REQUEST_6 = 2 + 6 + 64 + 1; // 73
const EE_WRITE_REQUEST_14 = 2 + 14 + 64 + 1; // 81

/**
 * Serial EEPROM — the 9853 (512 bytes, 4Kbit) and 9854 (8 KBytes, 64Kbit) parts.
 *
 * GBATEK, "GBA Cart Backup EEPROM". This is emphatically **not** byte-addressable memory,
 * which is why it does not share the SRAM path:
 *
 *  - It hangs off **bit 0 of the data bus** and one address line, so a transfer is a
 *    stream of halfwords carrying one bit each.
 *  - It is addressed in **units of 64 bits (8 bytes)**: 0-0x3F on the 512 byte part
 *    (6-bit bus), 0-0x3FF on the 8 KByte part (14-bit bus, of which only the low 10 bits
 *    are used and the upper 4 should be zero).
 *  - Transfers must go through **DMA3 in 16-bit mode** — GBATEK, "Using DMA": manual
 *    LDRH/STRH will not do it because they do not hold /CS low across the transfer. That
 *    restriction is not enforced here: enforcing it would break the ready-poll, which
 *    GBATEK explicitly *does* perform with a plain LDRH.
 */
export class Eeprom {
  /**
   * Always the larger part's worth of storage, so the array is never reallocated when the
   * address width is inferred. `size` decides how much of it the chip actually answers to.
   */
  private readonly storage = new Uint8Array(0x2000);

  /** 6 for the 512 byte part, 14 for the 8 KByte part. */
  private addressBits = 6;

  private phase = EE_COMMAND;
  private bitIndex = 0;
  private command = 0;
  private address = 0;

  /** The 64-bit page in flight, MSB first. Preallocated: no allocation per transfer. */
  private readonly page = new Uint8Array(8);

  private dirty = false;

  get isDirty(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  /** 0x200 on the 6-bit part, 0x2000 on the 14-bit part. */
  get size(): number {
    return this.addressBits === 6 ? 0x200 : 0x2000;
  }

  get addressWidth(): number {
    return this.addressBits;
  }

  reset(): void {
    // Unprogrammed EEPROM reads as 0xFF, like every other backup medium.
    this.storage.fill(0xff);
    this.page.fill(0);
    this.addressBits = 6;
    this.phase = EE_COMMAND;
    this.bitIndex = 0;
    this.command = 0;
    this.address = 0;
    this.dirty = false;
  }

  /** Only the portion the chip answers to is a save; the rest of the array is padding. */
  getSaveData(): Uint8Array {
    return this.storage.subarray(0, this.size);
  }

  /**
   * A loaded save is itself evidence of the address width.
   *
   * GBATEK says the width cannot be discovered from the chip, so an existing .sav of
   * exactly 512 or 8192 bytes is the best hint available before the game runs a single
   * DMA. A later request stream of a recognised length still wins over this.
   */
  loadSaveData(bytes: Uint8Array): void {
    if (bytes.length === 0x200) this.addressBits = 6;
    else if (bytes.length >= 0x2000) this.addressBits = 14;
    this.storage.fill(0xff);
    this.storage.set(bytes.subarray(0, Math.min(bytes.length, this.storage.length)));
    this.dirty = false;
  }

  /**
   * Infers the address width from the length of a DMA3 request stream.
   *
   * GBATEK, "Notes": *"There seems to be no autodection mechanism, so that a hardcoded bus
   * width must be used."* The chip cannot be asked, the cartridge header has no field for
   * it, and the `EEPROM_V` signature is identical on both parts. What is observable is how
   * many halfwords the game's DMA3 pushes at the chip, and that length is fixed by the
   * protocol:
   *
   *   9 = read request,  6-bit bus   |  17 = read request,  14-bit bus
   *  73 = write request, 6-bit bus   |  81 = write request, 14-bit bus
   *
   * Any other length is ignored rather than guessed at — a wrong guess would shift every
   * subsequent address and corrupt the save, so doing nothing is strictly safer.
   */
  inferAddressBits(units: number): void {
    if (units === EE_READ_REQUEST_6 || units === EE_WRITE_REQUEST_6) this.addressBits = 6;
    else if (units === EE_READ_REQUEST_14 || units === EE_WRITE_REQUEST_14) this.addressBits = 14;
  }

  /**
   * One halfword written to the EEPROM window. Only bit 0 is wired to the chip.
   *
   * GBATEK, "Using DMA": *"one halfword for each bit, bit1-15 of the halfwords are don't
   * care, only bit0 is used."*
   */
  write(value: number): void {
    const bit = value & 1;

    // A bit arriving while a reply is still being shifted out, or after a completed write,
    // starts a fresh request.
    if (this.phase === EE_SEND || this.phase === EE_READY) this.beginRequest();

    switch (this.phase) {
      case EE_COMMAND:
        this.command = ((this.command << 1) | bit) & 3;
        if (++this.bitIndex < 2) return;
        // GBATEK gives meanings only for "11" and "10"; anything else is not a request.
        if (this.command !== EE_CMD_READ && this.command !== EE_CMD_WRITE) {
          this.beginRequest();
          return;
        }
        this.phase = EE_ADDRESS;
        this.bitIndex = 0;
        this.address = 0;
        return;

      case EE_ADDRESS:
        // MSB first. GBATEK: "n bits eeprom address (MSB first, 6 or 14 bits)".
        this.address = ((this.address << 1) | bit) & 0x3fff;
        if (++this.bitIndex < this.addressBits) return;
        this.bitIndex = 0;
        if (this.command === EE_CMD_READ) {
          this.phase = EE_READ_END;
        } else {
          this.phase = EE_WRITE_DATA;
          this.page.fill(0);
        }
        return;

      // The trailing "0" of a read request. The reply is armed here, not earlier: on
      // hardware the chip only latches once the whole request has clocked in.
      case EE_READ_END:
        this.loadPage();
        this.phase = EE_SEND;
        this.bitIndex = 0;
        return;

      case EE_WRITE_DATA: {
        // 64 data bits, MSB first, filling the 8-byte page.
        const index = this.bitIndex;
        const byte = index >>> 3;
        this.page[byte] = this.page[byte]! | (bit << (7 - (index & 7)));
        if (++this.bitIndex < 64) return;
        this.phase = EE_WRITE_END;
        this.bitIndex = 0;
        return;
      }

      // The trailing "0" of a write request commits the page.
      case EE_WRITE_END:
        this.storePage();
        this.phase = EE_READY;
        this.bitIndex = 0;
        return;

      default:
        this.beginRequest();
        return;
    }
  }

  /**
   * One halfword read from the EEPROM window. The chip answers in bit 0.
   *
   * While a read reply is in flight this returns, in order, 4 bits the game is told to
   * ignore and then 64 data bits MSB first. At every other time it returns 1.
   *
   * GBATEK, "Write Data to Address", describes the programming delay: *"it'll take ca.
   * 108368 clock cycles (ca. 6.5ms) until the old data is erased and new data is
   * programmed"*, and the game polls until bit 0 reads back "1" (Ready). **Judgement
   * call:** the write here is instantaneous, so the chip reports ready immediately rather
   * than counting out 108368 cycles. Every documented access pattern polls for ready in a
   * loop with a timeout, so an immediate "ready" is a legal — just fast — chip. Modelling
   * the real delay would need the backup to be cycle-ticked, which nothing does today.
   */
  read(): number {
    if (this.phase !== EE_SEND) return 1;

    const index = this.bitIndex++;
    if (this.bitIndex >= EE_READ_STREAM_BITS) {
      this.phase = EE_READY;
      this.bitIndex = 0;
    }

    // GBATEK: "4 bits - ignore these", then "64 bits - data (conventionally MSB first)".
    if (index < EE_IGNORED_BITS) return 0;
    const dataBit = index - EE_IGNORED_BITS;
    return (this.page[dataBit >>> 3]! >>> (7 - (dataBit & 7))) & 1;
  }

  private beginRequest(): void {
    this.phase = EE_COMMAND;
    this.bitIndex = 0;
    this.command = 0;
  }

  /** Addressing is in 64-bit units, so the byte offset is the address times eight. */
  private get byteOffset(): number {
    return (this.address & (this.size / 8 - 1)) * 8;
  }

  private loadPage(): void {
    const base = this.byteOffset;
    for (let i = 0; i < 8; i++) this.page[i] = this.storage[base + i]!;
  }

  private storePage(): void {
    const base = this.byteOffset;
    for (let i = 0; i < 8; i++) this.storage[base + i] = this.page[i]!;
    this.dirty = true;
  }

  /**
   * Save-state.
   *
   * The whole state machine goes in, not just the bytes — for the same reason flash's
   * command state does. A state taken between the request DMA and the reply DMA (which is
   * an ordinary place for it to land, since the two are separate transfers) must resume
   * mid-stream, or the reply is 68 bits of nonsense and the game reads a corrupt save.
   */
  saveState(w: StateWriter): void {
    w.u8(this.addressBits);
    w.u8(this.phase);
    w.u8(this.bitIndex);
    w.u8(this.command);
    w.u16(this.address);
    w.bytesOf(this.page);
    w.bytesOf(this.storage);
    w.bool(this.dirty);
  }

  loadState(r: StateReader): void {
    this.addressBits = r.u8() === 14 ? 14 : 6;
    this.phase = r.u8();
    this.bitIndex = r.u8();
    this.command = r.u8();
    this.address = r.u16();
    const page = r.bytesOf();
    if (page.length === this.page.length) this.page.set(page);
    const storage = r.bytesOf();
    if (storage.length === this.storage.length) this.storage.set(storage);
    this.dirty = r.bool();
  }
}

/** Flash command state, driven by the write sequences the chip expects. */
const FLASH_IDLE = 0;
const FLASH_CMD_1 = 1;
const FLASH_CMD_2 = 2;
const FLASH_ERASE_1 = 3;
const FLASH_ERASE_2 = 4;
const FLASH_WRITE_BYTE = 5;
const FLASH_SELECT_BANK = 6;
const FLASH_ERASE_TARGET = 7;

/** Device IDs games check to size the chip. Macronix parts are the common ones. */
const FLASH_ID_64K = [0xc2, 0x1c] as const;
const FLASH_ID_128K = [0xc2, 0x09] as const;

/**
 * Backup storage.
 *
 * SRAM is plain memory. Flash adds a command protocol — an unlock sequence, then erase,
 * write, bank-select or identify — which is why it cannot be modelled as a byte array.
 * EEPROM is further still from memory: a bit-serial device in its own window, delegated
 * to {@link Eeprom}.
 */
export class GbaBackup {
  private data = new Uint8Array(0);
  private state = FLASH_IDLE;
  private identifying = false;
  private bank = 0;
  private dirty = false;

  /** The serial EEPROM device. Live only when the type is 'eeprom'. */
  readonly eeprom = new Eeprom();

  /** Cached so the bus can decode region 0x0D without a string compare per access. */
  private eepromMapped = false;

  constructor(private type: BackupType = 'none') {
    this.setType(type);
  }

  setType(type: BackupType): void {
    this.type = type;
    switch (type) {
      case 'sram':
        this.data = new Uint8Array(0x8000); // 32 KB
        break;
      case 'flash64':
        this.data = new Uint8Array(0x10000); // 64 KB
        break;
      case 'flash128':
        this.data = new Uint8Array(0x20000); // 128 KB, two banks
        break;
      // EEPROM owns its own storage: it is bit-serial and lives in a different window, so
      // it must never fall through to the byte-addressed path below.
      default:
        this.data = new Uint8Array(0);
        break;
    }
    // ALL backup media read 0xFF when uninitialised, not zero — that is how a game (and
    // jsmolka's test 001) tells an empty save from a real one.
    this.data.fill(0xff);
    this.state = FLASH_IDLE;
    this.identifying = false;
    this.bank = 0;
    this.dirty = false;
    this.eepromMapped = type === 'eeprom';
    this.eeprom.reset();
  }

  /** True when the cartridge carries EEPROM, which decodes at 0x0D000000-0x0DFFFFFF. */
  get isEeprom(): boolean {
    return this.eepromMapped;
  }

  getType(): BackupType {
    return this.type;
  }

  get isDirty(): boolean {
    return this.eepromMapped ? this.eeprom.isDirty : this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
    this.eeprom.clearDirty();
  }

  /** EEPROM saves travel the same path as SRAM and flash — just a different owner. */
  getSaveData(): Uint8Array | null {
    if (this.eepromMapped) return this.eeprom.getSaveData();
    return this.data.length > 0 ? this.data : null;
  }

  loadSaveData(bytes: Uint8Array): void {
    if (this.eepromMapped) {
      this.eeprom.loadSaveData(bytes);
      return;
    }
    if (this.data.length === 0) return;
    this.data.set(bytes.subarray(0, this.data.length));
    this.dirty = false;
  }

  /**
   * Save-state.
   *
   * The flash command state machine is included: a state taken between the unlock pair and
   * the command byte must resume mid-sequence, or the next write is misread as a command.
   * The EEPROM state machine is included for exactly the same reason — see Eeprom.
   */
  saveState(w: StateWriter): void {
    w.u8(BACKUP_TYPE_IDS.indexOf(this.type));
    w.bytesOf(this.data);
    w.u8(this.state);
    w.bool(this.identifying);
    w.u8(this.bank);
    w.bool(this.dirty);
    this.eeprom.saveState(w);
  }

  loadState(r: StateReader): void {
    const type = BACKUP_TYPE_IDS[r.u8()] ?? 'none';
    if (type !== this.type) this.setType(type);
    const data = r.bytesOf();
    if (data.length === this.data.length) this.data.set(data);
    this.state = r.u8();
    this.identifying = r.bool();
    this.bank = r.u8();
    this.dirty = r.bool();
    this.eeprom.loadState(r);
  }

  private get isFlash(): boolean {
    return this.type === 'flash64' || this.type === 'flash128';
  }

  read(address: number): number {
    const offset = address & 0xffff;

    if (this.isFlash) {
      // While the identify command is active the first two bytes report the device ID.
      if (this.identifying && offset < 2) {
        const id = this.type === 'flash128' ? FLASH_ID_128K : FLASH_ID_64K;
        return id[offset]!;
      }
      return this.data[this.bank * 0x10000 + offset]!;
    }

    if (this.data.length === 0) return 0xff;
    return this.data[offset % this.data.length]!;
  }

  write(address: number, value: number): void {
    const offset = address & 0xffff;
    const byte = value & 0xff;

    if (!this.isFlash) {
      if (this.data.length === 0) return;
      this.data[offset % this.data.length] = byte;
      this.dirty = true;
      return;
    }

    this.writeFlash(offset, byte);
  }

  /**
   * The flash command protocol.
   *
   * Every command starts with 0xAA to 0x5555 then 0x55 to 0x2AAA; the third write selects
   * what actually happens. A single byte write and a bank switch each consume one further
   * write, which is why the state machine has a tail.
   */
  private writeFlash(offset: number, byte: number): void {
    switch (this.state) {
      case FLASH_WRITE_BYTE:
        this.data[this.bank * 0x10000 + offset] = byte;
        this.dirty = true;
        this.state = FLASH_IDLE;
        return;

      case FLASH_SELECT_BANK:
        // Only the 128 KB part has a second bank.
        if (this.type === 'flash128') this.bank = byte & 1;
        this.state = FLASH_IDLE;
        return;

      case FLASH_IDLE:
        if (offset === 0x5555 && byte === 0xaa) this.state = FLASH_CMD_1;
        return;

      case FLASH_CMD_1:
        if (offset === 0x2aaa && byte === 0x55) this.state = FLASH_CMD_2;
        else this.state = FLASH_IDLE;
        return;

      case FLASH_CMD_2:
        this.state = FLASH_IDLE;
        if (offset !== 0x5555) return;
        switch (byte) {
          case 0x90:
            this.identifying = true;
            return; // enter identify
          case 0xf0:
            this.identifying = false;
            return; // exit identify
          case 0x80:
            this.state = FLASH_ERASE_1;
            return; // erase prologue
          case 0xa0:
            this.state = FLASH_WRITE_BYTE;
            return; // write one byte next
          case 0xb0:
            this.state = FLASH_SELECT_BANK;
            return; // bank switch next
          default:
            return;
        }

      // An erase needs a SECOND unlock pair after the 0x80 prologue, then its target.
      case FLASH_ERASE_1:
        this.state = offset === 0x5555 && byte === 0xaa ? FLASH_ERASE_2 : FLASH_IDLE;
        return;

      case FLASH_ERASE_2:
        this.state = offset === 0x2aaa && byte === 0x55 ? FLASH_ERASE_TARGET : FLASH_IDLE;
        return;

      default:
        this.state = FLASH_IDLE;
        // 0x10 erases the whole chip; 0x30 erases the 4 KB sector it is addressed to.
        if (byte === 0x10 && offset === 0x5555) this.eraseChip();
        else if (byte === 0x30) this.eraseSector((offset >>> 12) & 0xf);
        return;
    }
  }

  /** Erased flash reads as 0xFF, which is how a game spots an empty save. */
  eraseChip(): void {
    this.data.fill(0xff);
    this.dirty = true;
  }

  eraseSector(sector: number): void {
    const base = this.bank * 0x10000 + sector * 0x1000;
    this.data.fill(0xff, base, Math.min(base + 0x1000, this.data.length));
    this.dirty = true;
  }
}
