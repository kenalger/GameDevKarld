import type { MemoryBus } from '../../shared/types/bus.js';

/**
 * CGB VRAM DMA (0xFF51-0xFF55).
 *
 * Two modes:
 *  - **General purpose** (HDMA5 bit 7 clear): copies the whole block at once and halts the
 *    CPU for the duration.
 *  - **HBlank** (bit 7 set): copies 16 bytes per HBlank, stealing cycles as it goes.
 *
 * The HBlank mode is what games use for mid-frame effects. Modelling it as an instant copy
 * visibly breaks graphics, which is why it is paced here rather than done in one shot.
 */
export class Hdma {
  private source = 0;
  private destination = 0;
  private remaining = 0;
  private hblankMode = false;
  private active = false;
  /** Set for the line already serviced, so one HBlank transfers exactly one block. */
  private servedThisLine = false;

  constructor(
    private readonly bus: MemoryBus,
    private readonly writeVram: (offset: number, value: number) => void,
  ) {}

  reset(): void {
    this.source = 0;
    this.destination = 0;
    this.remaining = 0;
    this.hblankMode = false;
    this.active = false;
    this.servedThisLine = false;
  }

  get isActive(): boolean {
    return this.active;
  }

  read(address: number): number {
    // HDMA1-4 are write-only; HDMA5 reports remaining length and bit 7 = not active.
    if (address !== 0xff55) return 0xff;
    if (!this.active) return 0xff;
    return ((this.remaining >> 4) - 1) & 0x7f;
  }

  write(address: number, value: number): void {
    const byte = value & 0xff;
    switch (address) {
      case 0xff51:
        this.source = (this.source & 0x00f0) | (byte << 8);
        break;
      case 0xff52:
        this.source = (this.source & 0xff00) | (byte & 0xf0);
        break;
      case 0xff53:
        this.destination = (this.destination & 0x00f0) | ((byte & 0x1f) << 8);
        break;
      case 0xff54:
        this.destination = (this.destination & 0xff00) | (byte & 0xf0);
        break;
      case 0xff55: {
        if (this.active && (byte & 0x80) === 0) {
          // Writing bit 7 = 0 during an HBlank transfer CANCELS it.
          this.active = false;
          return;
        }
        this.remaining = ((byte & 0x7f) + 1) * 16;
        this.hblankMode = (byte & 0x80) !== 0;
        this.active = true;
        this.servedThisLine = false;
        if (!this.hblankMode) this.runAll();
        break;
      }
      default:
        break;
    }
  }

  /** Called by the PPU when HBlank begins. Transfers one 16-byte block. */
  onHBlank(): void {
    if (!this.active || !this.hblankMode || this.servedThisLine) return;
    this.servedThisLine = true;
    this.copyBlock();
  }

  /** Called when the PPU leaves HBlank, so the next one can serve again. */
  onLineChange(): void {
    this.servedThisLine = false;
  }

  private runAll(): void {
    while (this.active) this.copyBlock();
  }

  private copyBlock(): void {
    for (let i = 0; i < 16 && this.remaining > 0; i++) {
      this.writeVram(this.destination & 0x1fff, this.bus.read(this.source & 0xffff));
      this.source = (this.source + 1) & 0xffff;
      this.destination = (this.destination + 1) & 0xffff;
      this.remaining--;
    }
    if (this.remaining <= 0) this.active = false;
  }
}
