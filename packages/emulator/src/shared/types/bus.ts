/**
 * The CPU's only view of the machine. Reads and writes are BEHAVIOR, not storage:
 * implementations enforce PPU-mode lockout, unmapped-bit reads, echo folding and
 * I/O register side effects.
 *
 * Hot path — implementations must not allocate here.
 */
export interface MemoryBus {
  read(address: number): number;
  write(address: number, value: number): void;
}
