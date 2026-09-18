/** One code as the player entered it, plus whether it is on. */
export interface StoredCheat {
    readonly id: string;
    readonly label: string;
    /** Exactly what was typed, normalised. Decoding happens at load time, never here. */
    readonly code: string;
    readonly enabled: boolean;
    readonly createdAt: number;
}
/** Every code for one cartridge. Read and written whole — the list is tens of items. */
export interface CheatRecord {
    readonly key: string;
    readonly cartridge: string;
    readonly version: 1;
    readonly cheats: readonly StoredCheat[];
    readonly updatedAt: number;
}
/**
 * Cheat codes in IndexedDB, keyed by cartridge identity.
 *
 * Its own database, for the same reason save states have one: a corrupt or full cheat
 * store must never take battery saves down with it.
 *
 * **Nothing here touches the network.** WebBoy ships no cheat database and looks nothing
 * up — a remote lookup would have to send an identifier derived from the player's ROM,
 * which is exactly the kind of quiet exfiltration the privacy rule exists to prevent.
 * Codes are typed in by the player and stay on this device.
 */
export declare class CheatStore {
    private db;
    private open;
    private run;
    list(key: string): Promise<readonly StoredCheat[]>;
    save(key: string, cartridge: string, cheats: readonly StoredCheat[]): Promise<void>;
}
export declare const cheatStore: CheatStore;
//# sourceMappingURL=CheatStore.d.ts.map