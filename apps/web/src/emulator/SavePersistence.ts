import type { EmulatorCore } from '@webboy/emulator';
import { SaveStoreError, saveStore } from '../storage/SaveStore.js';

/** How long SRAM must be quiet before a write. Games write in bursts. */
const DEBOUNCE_MS = 1000;

/**
 * Keeps a cartridge's battery save in IndexedDB.
 *
 * Writes are debounced, because games touch SRAM in bursts and a write per frame would be
 * wasteful. But a debounce alone loses the last second of play whenever the tab goes away,
 * so persistence is also flushed on `visibilitychange` and `pagehide`.
 *
 * **Not `beforeunload`**: mobile Safari frequently backgrounds a tab without ever firing
 * it, which is exactly the case where a player expects their save to survive.
 */
export class SavePersistence {
  private key: string | null = null;
  private title = '';
  private timer: number | null = null;
  private flushing = false;
  private pendingWhileFlushing = false;

  constructor(private readonly onError: (message: string) => void) {}

  /** Loads any stored save into the core. Returns true if one was applied. */
  async attach(core: EmulatorCore, key: string, title: string): Promise<boolean> {
    this.cancelTimer();
    this.key = core.hasBatterySave() ? key : null;
    this.title = title;
    if (!this.key) return false;

    try {
      const stored = await saveStore.load(this.key);
      if (!stored) return false;
      core.loadSaveData(stored);
      return true;
    } catch (cause) {
      this.report(cause, 'Could not read your saved game');
      return false;
    }
  }

  detach(): void {
    this.cancelTimer();
    this.key = null;
  }

  /** Call once per frame. Schedules a write when SRAM has changed. */
  poll(core: EmulatorCore): void {
    if (!this.key) return;
    if (!core.consumeSaveRamDirty()) return;

    this.cancelTimer();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush(core);
    }, DEBOUNCE_MS);
  }

  /** Writes immediately. Called on tab-hide, pause and ROM change. */
  async flush(core: EmulatorCore): Promise<void> {
    if (!this.key) return;
    this.cancelTimer();

    if (this.flushing) {
      this.pendingWhileFlushing = true;
      return;
    }

    const data = core.getSaveData();
    if (!data) return;

    this.flushing = true;
    try {
      // Copy: the core keeps mutating its SRAM while the write is in flight.
      await saveStore.save(this.key, this.title, new Uint8Array(data));
    } catch (cause) {
      this.report(cause, 'Could not save your game');
    } finally {
      this.flushing = false;
      if (this.pendingWhileFlushing) {
        this.pendingWhileFlushing = false;
        void this.flush(core);
      }
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private report(cause: unknown, prefix: string): void {
    const message =
      cause instanceof SaveStoreError
        ? `${prefix}: ${cause.message}`
        : `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`;
    this.onError(message);
  }
}
