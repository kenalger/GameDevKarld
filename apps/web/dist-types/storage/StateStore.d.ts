export declare const SLOT_COUNT = 4;
export interface StateSlot {
    readonly key: string;
    readonly cartridge: string;
    readonly slot: number;
    readonly data: Uint8Array;
    /** Small PNG data URL captured from the framebuffer at save time. */
    readonly thumbnail: string | null;
    readonly savedAt: number;
}
/**
 * Save-state slots in IndexedDB, separate from battery saves.
 *
 * Kept in its own database so a corrupt or full state store can never take battery saves
 * down with it — losing a quick-save is an annoyance, losing hours of in-game progress is
 * not.
 */
export declare class StateStore {
    private db;
    private open;
    private key;
    save(cartridge: string, slot: number, data: Uint8Array, thumbnail: string | null): Promise<void>;
    load(cartridge: string, slot: number): Promise<StateSlot | null>;
    list(cartridge: string): Promise<(StateSlot | null)[]>;
    private run;
}
export declare const stateStore: StateStore;
//# sourceMappingURL=StateStore.d.ts.map