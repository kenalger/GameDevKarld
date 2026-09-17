export type StorageFailure = 'unavailable' | 'quota-exceeded' | 'blocked' | 'unknown';
export declare class SaveStoreError extends Error {
    readonly reason: StorageFailure;
    constructor(reason: StorageFailure, message: string);
}
export interface SaveRecord {
    /** Content-derived cartridge identity. Never a filename. */
    readonly key: string;
    readonly title: string;
    readonly data: Uint8Array;
    readonly updatedAt: number;
}
/**
 * Battery saves in IndexedDB.
 *
 * Every method can fail, and every failure is reported rather than swallowed. Storage is
 * genuinely unavailable in private browsing on some browsers, can be blocked by policy,
 * can be cleared mid-session, and can hit quota. **Silent data loss is worse than a
 * crash** — a player who loses hours of progress does not come back — so callers are given
 * a typed reason they can surface.
 */
export declare class SaveStore {
    private db;
    private openFailed;
    private open;
    load(key: string): Promise<Uint8Array | null>;
    save(key: string, title: string, data: Uint8Array): Promise<void>;
    remove(key: string): Promise<void>;
    list(): Promise<SaveRecord[]>;
    private run;
}
export declare const saveStore: SaveStore;
//# sourceMappingURL=SaveStore.d.ts.map