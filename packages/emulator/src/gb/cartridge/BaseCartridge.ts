import type { Cartridge } from '../../shared/types/cartridge.js';
import { parseHeader } from './header.js';

/**
 * Shared cartridge plumbing: the ROM image, save RAM, and the dirty flag that drives
 * debounced persistence.
 *
 * Every mapper subclasses this and implements only its own banking.
 */
export abstract class BaseCartridge implements Cartridge {
  protected rom: Uint8Array<ArrayBufferLike> = new Uint8Array(0x8000);
  protected ram: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  protected dirty = false;

  get saveRamDirty(): boolean {
    return this.dirty;
  }

  clearSaveRamDirty(): void {
    this.dirty = false;
  }

  getSaveRam(): Uint8Array | null {
    return this.ram.length > 0 ? this.ram : null;
  }

  loadSaveRam(data: Uint8Array): void {
    if (this.ram.length === 0) return;
    this.ram.set(data.subarray(0, this.ram.length));
    this.dirty = false;
  }

  load(data: Uint8Array): void {
    this.rom = data;
    const info = parseHeader(data);
    this.ram = new Uint8Array(info.ramSize);
  }

  abstract read(address: number): number;
  abstract write(address: number, value: number): void;
}
