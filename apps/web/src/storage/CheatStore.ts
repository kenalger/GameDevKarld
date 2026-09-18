import { SaveStoreError } from './SaveStore.js';

const DB_NAME = 'webboy-cheats';
const DB_VERSION = 1;
const STORE = 'cheats';

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
export class CheatStore {
  private db: IDBDatabase | null = null;

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (typeof indexedDB === 'undefined') {
      throw new SaveStoreError(
        'unavailable',
        'This browser has no IndexedDB, so cheats cannot be stored.',
      );
    }

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new SaveStoreError('unavailable', 'Could not open the cheat store.'));
    });
    return this.db;
  }

  private async run<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new SaveStoreError('unknown', 'The cheat store rejected the operation.'));
    });
  }

  async list(key: string): Promise<readonly StoredCheat[]> {
    const record = await this.run<CheatRecord | undefined>('readonly', (store) => store.get(key));
    return record?.cheats ?? [];
  }

  async save(key: string, cartridge: string, cheats: readonly StoredCheat[]): Promise<void> {
    const record: CheatRecord = {
      key,
      cartridge,
      version: 1,
      cheats,
      updatedAt: Date.now(),
    };
    await this.run('readwrite', (store) => store.put(record));
  }
}

export const cheatStore = new CheatStore();
