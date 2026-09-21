/**
 * The narrow memory view the BIOS routines need.
 *
 * `Arm7` satisfies it structurally, so a BIOS routine's memory traffic is charged
 * waitstates exactly like the code it stands in for — the BIOS is not free.
 */
export interface BiosMemory {
  read8(address: number): number;
  read16(address: number): number;
  read32(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
}

/** Sign-extends a 16-bit value read off the bus. */
export function s16(value: number): number {
  return (value << 16) >> 16;
}
