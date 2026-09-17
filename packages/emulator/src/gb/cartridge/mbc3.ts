import { BaseCartridge } from './BaseCartridge.js';
import { advanceRtc, createRtcState, type RtcState } from './rtc.js';

const RTC_SECONDS = 0x08;
const RTC_DAYS_HIGH = 0x0c;

/**
 * MBC3, with the real-time clock.
 *
 * The RTC maps into the cartridge-RAM window: selecting 0x08-0x0C at 0x4000-0x5FFF swaps
 * the RAM bank for a clock register. Software takes a consistent reading by writing 0 then
 * 1 to 0x6000-0x7FFF, which **latches** all five registers at once — without that, a read
 * spanning a second boundary could see 00:59:60.
 */
export class Mbc3Cartridge extends BaseCartridge {
  private ramEnabled = false;
  private romBank = 1;
  /** 0x00-0x03 selects a RAM bank; 0x08-0x0C selects an RTC register. */
  private bankSelect = 0;
  private romBankMask = 0x7f;
  private lastLatchWrite = 0xff;

  readonly rtc: RtcState = createRtcState();
  private latched: RtcState = createRtcState();

  override load(data: Uint8Array): void {
    super.load(data);
    const banks = Math.max(2, Math.floor(data.length / 0x4000));
    this.romBankMask = banks - 1;
    this.ramEnabled = false;
    this.romBank = 1;
    this.bankSelect = 0;
    this.lastLatchWrite = 0xff;
  }

  /** Brings the clock up to date with real elapsed time. */
  tickRtc(nowMs?: number): void {
    advanceRtc(this.rtc, nowMs);
  }

  getRtcState(): RtcState {
    return this.rtc;
  }

  loadRtcState(state: RtcState): void {
    Object.assign(this.rtc, state);
    // Catch up on however long the game was closed.
    advanceRtc(this.rtc);
    this.latched = { ...this.rtc };
  }

  private get rtcSelected(): boolean {
    return this.bankSelect >= RTC_SECONDS && this.bankSelect <= RTC_DAYS_HIGH;
  }

  read(address: number): number {
    if (address < 0x4000) return this.rom[address] ?? 0xff;
    if (address < 0x8000) {
      const bank = this.romBank & this.romBankMask;
      return this.rom[bank * 0x4000 + (address - 0x4000)] ?? 0xff;
    }
    if (address >= 0xa000 && address < 0xc000) {
      if (!this.ramEnabled) return 0xff;
      if (this.rtcSelected) return this.readRtcRegister();
      if (this.ram.length === 0) return 0xff;
      return this.ram[this.ramOffset(address)] ?? 0xff;
    }
    return 0xff;
  }

  write(address: number, value: number): void {
    const byte = value & 0xff;

    if (address < 0x2000) {
      this.ramEnabled = (byte & 0x0f) === 0x0a;
    } else if (address < 0x4000) {
      const bank = byte & 0x7f;
      this.romBank = bank === 0 ? 1 : bank;
    } else if (address < 0x6000) {
      this.bankSelect = byte;
    } else if (address < 0x8000) {
      // 0 followed by 1 takes a coherent snapshot of all five registers.
      if (this.lastLatchWrite === 0x00 && byte === 0x01) {
        this.tickRtc();
        this.latched = { ...this.rtc };
      }
      this.lastLatchWrite = byte;
    } else if (address >= 0xa000 && address < 0xc000) {
      if (!this.ramEnabled) return;
      if (this.rtcSelected) {
        this.writeRtcRegister(byte);
        this.dirty = true;
        return;
      }
      if (this.ram.length === 0) return;
      this.ram[this.ramOffset(address)] = byte;
      this.dirty = true;
    }
  }

  private ramOffset(address: number): number {
    return ((this.bankSelect & 0x03) * 0x2000 + (address - 0xa000)) % this.ram.length;
  }

  private readRtcRegister(): number {
    const clock = this.latched;
    switch (this.bankSelect) {
      case 0x08:
        return clock.seconds & 0x3f;
      case 0x09:
        return clock.minutes & 0x3f;
      case 0x0a:
        return clock.hours & 0x1f;
      case 0x0b:
        return clock.days & 0xff;
      case 0x0c:
        return ((clock.days >> 8) & 0x01) | (clock.halted ? 0x40 : 0) | (clock.dayCarry ? 0x80 : 0);
      default:
        return 0xff;
    }
  }

  private writeRtcRegister(byte: number): void {
    // Writing any register first brings the clock up to date, so the write is not
    // immediately overwritten by elapsed time.
    this.tickRtc();
    switch (this.bankSelect) {
      case 0x08:
        this.rtc.seconds = byte & 0x3f;
        break;
      case 0x09:
        this.rtc.minutes = byte & 0x3f;
        break;
      case 0x0a:
        this.rtc.hours = byte & 0x1f;
        break;
      case 0x0b:
        this.rtc.days = (this.rtc.days & 0x100) | byte;
        break;
      case 0x0c:
        this.rtc.days = (this.rtc.days & 0xff) | ((byte & 0x01) << 8);
        this.rtc.halted = (byte & 0x40) !== 0;
        this.rtc.dayCarry = (byte & 0x80) !== 0 ? 1 : 0;
        break;
      default:
        break;
    }
    this.latched = { ...this.rtc };
  }
}
