/**
 * T-cycles between the write to 0xFF46 and the transfer becoming visible.
 *
 * Mooneye's oam_dma_start states the model exactly: M=0 is the write, M=1 still has OAM
 * accessible, and the DMA is running by M=2. That is two M-cycles, and the countdown below
 * must reach zero on the LAST tick of M=1 — the CPU takes its bus sample at the start of an
 * M-cycle, so an activation one tick later would not be seen until M=3.
 */
export const DMA_START_DELAY_T = 8;

const OAM_BYTES = 0xa0;
const T_PER_BYTE = 4;

/**
 * OAM DMA (0xFF46).
 *
 * Runs concurrently with the CPU for 160 M-cycles, one byte per M-cycle, and locks the bus:
 * while it runs, the CPU can only reliably reach HRAM. That is precisely why every game's
 * DMA routine is copied into HRAM and executed from there.
 *
 * Modelling it as an instant copy makes `oam_dma_start`, `oam_dma_restart` and
 * `oam_dma_timing` unpassable, and hides the bus conflict real games rely on.
 */
export class OamDma {
  private active = false;
  private index = 0;
  private page = 0;
  private pendingPage = 0;
  /** T-cycles remaining before a requested transfer starts; 0 when none is pending. */
  private startCountdown = 0;
  private subCycle = 0;
  /** The byte currently on the bus — what a conflicting CPU read observes. */
  private busValue = 0xff;

  constructor(
    private readonly readByte: (address: number) => number,
    private readonly writeOam: (index: number, value: number) => void,
  ) {}

  reset(): void {
    this.active = false;
    this.index = 0;
    this.startCountdown = 0;
    this.subCycle = 0;
    this.busValue = 0xff;
  }

  /** Writing 0xFF46 starts (or restarts) a transfer. */
  request(page: number): void {
    this.pendingPage = page & 0xff;
    this.startCountdown = DMA_START_DELAY_T;
  }

  get isActive(): boolean {
    return this.active;
  }

  get conflictValue(): number {
    return this.busValue;
  }

  /**
   * Whether a CPU access to `address` collides with this transfer.
   *
   * The Game Boy has two buses, and the DMA only occupies the one its SOURCE is on: a
   * transfer out of VRAM leaves ROM, SRAM and WRAM readable, and vice versa. Pandocs'
   * "only HRAM during DMA" is the safe rule for programmers, not what the hardware does —
   * and every Mooneye `*_timing` test relies on the difference, because each one executes
   * its payload out of echo RAM while a VRAM-sourced transfer is still running.
   */
  conflictsWith(address: number): boolean {
    if (!this.active) return false;
    const addr = address & 0xffff;
    // HRAM, the I/O block and IE are internal to the CPU: never on either bus.
    if (addr >= 0xff00) return false;
    // OAM is handled separately — it is locked, not conflicted.
    if (addr >= 0xfe00) return false;

    const videoSource = this.page >= 0x80 && this.page < 0xa0;
    const videoAccess = addr >= 0x8000 && addr < 0xa000;
    return videoSource === videoAccess;
  }

  /**
   * The transfer's own source decode.
   *
   * It sees one more mirror than the CPU does: the whole of 0xE000-0xFFFF folds back to
   * 0xC000-0xDFFF, so a page of 0xFE reads WRAM at 0xDE00 rather than OAM, and 0xFF reads
   * 0xDF00 rather than the I/O block. Mooneye's oam_dma/sources checks those two pages
   * specifically, and they are the reason this is not just (page << 8) + index.
   */
  private sourceAddress(index: number): number {
    const address = ((this.page << 8) + index) & 0xffff;
    return address >= 0xe000 ? address - 0x2000 : address;
  }

  tickT(): void {
    if (this.startCountdown > 0) {
      this.startCountdown--;
      if (this.startCountdown === 0) {
        // A restart takes over from any transfer already running.
        this.active = true;
        this.index = 0;
        this.subCycle = 0;
        this.page = this.pendingPage;
      }
    }

    if (!this.active) return;

    this.subCycle++;
    if (this.subCycle < T_PER_BYTE) return;
    this.subCycle = 0;

    this.busValue = this.readByte(this.sourceAddress(this.index));
    this.writeOam(this.index, this.busValue);
    this.index++;
    if (this.index >= OAM_BYTES) {
      this.active = false;
      this.index = 0;
    }
  }
}
