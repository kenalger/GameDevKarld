import { SaveStoreError } from './SaveStore.js';

const DB_NAME = 'webboy-states';
const DB_VERSION = 1;
const STORE = 'states';

export const SLOT_COUNT = 4;

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
export class StateStore {
  private db: IDBDatabase | null = null;

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (typeof indexedDB === 'undefined') {
      throw new SaveStoreError(
        'unavailable',
        'This browser has no IndexedDB, so save states cannot be stored.',
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
        reject(new SaveStoreError('blocked', 'Could not open save-state storage.'));
    });
    return this.db;
  }

  private key(cartridge: string, slot: number): string {
    return `${cartridge}#${slot}`;
  }

  async save(
    cartridge: string,
    slot: number,
    data: Uint8Array,
    thumbnail: string | null,
  ): Promise<void> {
    const db = await this.open();
    const record: StateSlot = {
      key: this.key(cartridge, slot),
      cartridge,
      slot,
      data,
      thumbnail,
      savedAt: Date.now(),
    };
    await this.run(db, 'readwrite', (store) => store.put(record));
  }

  async load(cartridge: string, slot: number): Promise<StateSlot | null> {
    const db = await this.open();
    const result = await this.run(db, 'readonly', (store) => store.get(this.key(cartridge, slot)));
    return (result as StateSlot | undefined) ?? null;
  }

  async list(cartridge: string): Promise<(StateSlot | null)[]> {
    const slots: (StateSlot | null)[] = [];
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      slots.push(await this.load(cartridge, slot).catch(() => null));
    }
    return slots;
  }

  private run(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = operation(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        const error = request.error;
        reject(
          new SaveStoreError(
            error?.name === 'QuotaExceededError' ? 'quota-exceeded' : 'unknown',
            error?.name === 'QuotaExceededError'
              ? 'Storage is full, so this save state could not be written.'
              : `Save-state storage failed: ${error?.message ?? 'unknown error'}`,
          ),
        );
      };
    });
  }
}

export const stateStore = new StateStore();
