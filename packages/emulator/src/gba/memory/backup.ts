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
 */
export class GbaBackup {
  private data = new Uint8Array(0);
  private state = FLASH_IDLE;
  private identifying = false;
  private bank = 0;
  private dirty = false;

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
      case 'eeprom':
        this.data = new Uint8Array(0x2000); // 8 KB
        break;
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
  }

  getType(): BackupType {
    return this.type;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  getSaveData(): Uint8Array | null {
    return this.data.length > 0 ? this.data : null;
  }

  loadSaveData(bytes: Uint8Array): void {
    if (this.data.length === 0) return;
    this.data.set(bytes.subarray(0, this.data.length));
    this.dirty = false;
  }

  /**
   * Save-state.
   *
   * The flash command state machine is included: a state taken between the unlock pair and
   * the command byte must resume mid-sequence, or the next write is misread as a command.
   */
  saveState(w: StateWriter): void {
    w.u8(BACKUP_TYPE_IDS.indexOf(this.type));
    w.bytesOf(this.data);
    w.u8(this.state);
    w.bool(this.identifying);
    w.u8(this.bank);
    w.bool(this.dirty);
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
