import type { SystemKind } from './system.js';

/**
 * Parsed cartridge header. Populated in Phase 02 by the header parser.
 * Field offsets are defined by Pan Docs "The Cartridge Header" — verify against the
 * source before changing anything here.
 */
export interface CartridgeInfo {
  readonly title: string;
  readonly cartridgeType: number;
  readonly romSize: number;
  readonly ramSize: number;
  readonly isColorCapable: boolean;
  readonly system: SystemKind;
  /** Stable identity for save lookup. Derived from title + checksum + size — never the filename. */
  readonly saveKey: string;
  readonly headerChecksumValid: boolean;
}

/** A cartridge owns its own banking. It knows nothing about the CPU. */
export interface Cartridge {
  read(address: number): number;
  write(address: number, value: number): void;
  load(data: Uint8Array): void;
  /** Battery-backed RAM, or null for a cartridge without one. */
  getSaveRam(): Uint8Array | null;
  loadSaveRam(data: Uint8Array): void;
  /** True when save RAM changed since the flag was last cleared. Drives debounced persistence. */
  readonly saveRamDirty: boolean;
  clearSaveRamDirty(): void;
}
