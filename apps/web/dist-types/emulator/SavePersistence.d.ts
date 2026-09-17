import type { EmulatorCore } from '@webboy/emulator';
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
export declare class SavePersistence {
    private readonly onError;
    private key;
    private title;
    private timer;
    private flushing;
    private pendingWhileFlushing;
    constructor(onError: (message: string) => void);
    /** Loads any stored save into the core. Returns true if one was applied. */
    attach(core: EmulatorCore, key: string, title: string): Promise<boolean>;
    detach(): void;
    /** Call once per frame. Schedules a write when SRAM has changed. */
    poll(core: EmulatorCore): void;
    /** Writes immediately. Called on tab-hide, pause and ROM change. */
    flush(core: EmulatorCore): Promise<void>;
    private cancelTimer;
    private report;
}
//# sourceMappingURL=SavePersistence.d.ts.map