import type { InterruptController } from '../cpu/interrupts.js';
import { INT_SERIAL } from '../cpu/interrupts.js';

/**
 * Serial port (0xFF01 data, 0xFF02 control).
 *
 * No link cable is emulated. What matters here is that every test ROM in the Blargg suite
 * reports results through this port — "cpu_instrs failed" is useless next to
 * "06-ld r,r failed", and that string arrives one byte at a time right here.
 */
export class Serial {
  private data = 0;
  private control = 0;
  private output = '';

  constructor(private readonly interrupts: InterruptController) {}

  reset(): void {
    this.data = 0;
    this.control = 0;
    this.output = '';
  }

  /** Everything the ROM has printed so far. */
  get text(): string {
    return this.output;
  }

  clear(): void {
    this.output = '';
  }

  read(address: number): number {
    if (address === 0xff01) return this.data;
    if (address === 0xff02) return this.control | 0x7e;
    return 0xff;
  }

  write(address: number, value: number): void {
    const byte = value & 0xff;
    if (address === 0xff01) {
      this.data = byte;
      return;
    }
    if (address !== 0xff02) return;

    this.control = byte;
    // Bit 7 starts a transfer; bit 0 selects the internal clock. With no cable attached the
    // transfer completes immediately and shifts in 0xFF.
    if ((byte & 0x81) === 0x81) {
      this.output += String.fromCharCode(this.data);
      this.data = 0xff;
      this.control &= ~0x80;
      this.interrupts.request(INT_SERIAL);
    }
  }
}
