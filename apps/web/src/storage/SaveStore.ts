const DB_NAME = 'webboy';
const DB_VERSION = 1;
const STORE = 'saves';

export type StorageFailure = 'unavailable' | 'quota-exceeded' | 'blocked' | 'unknown';

export class SaveStoreError extends Error {
  constructor(
    readonly reason: StorageFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SaveStoreError';
  }
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
export class SaveStore {
  private db: IDBDatabase | null = null;
  private openFailed: SaveStoreError | null = null;

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (this.openFailed) throw this.openFailed;

    if (typeof indexedDB === 'undefined') {
      this.openFailed = new SaveStoreError(
        'unavailable',
        'This browser has no IndexedDB, so game saves cannot be stored.',
      );
      throw this.openFailed;
    }

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (cause) {
        reject(
          new SaveStoreError('blocked', `Storage is blocked by this browser: ${describe(cause)}`),
        );
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new SaveStoreError(
            'blocked',
            'Could not open save storage. Private browsing or site-data settings may be blocking it.',
          ),
        );
      // Another tab holding an older version open.
      request.onblocked = () =>
        reject(
          new SaveStoreError(
            'blocked',
            'Save storage is locked by another WebBoy tab. Close it and reload.',
          ),
        );
    }).catch((cause: unknown) => {
      this.openFailed =
        cause instanceof SaveStoreError ? cause : new SaveStoreError('unknown', describe(cause));
      throw this.openFailed;
    });

    return this.db;
  }

  async load(key: string): Promise<Uint8Array | null> {
    const db = await this.open();
    return this.run(db, 'readonly', (store) => store.get(key)).then((result) => {
      const record = result as SaveRecord | undefined;
      if (!record) return null;
      // Stored as a plain array or a typed array depending on the browser's clone.
      return record.data instanceof Uint8Array ? record.data : new Uint8Array(record.data);
    });
  }

  async save(key: string, title: string, data: Uint8Array): Promise<void> {
    const db = await this.open();
    const record: SaveRecord = { key, title, data, updatedAt: Date.now() };
    await this.run(db, 'readwrite', (store) => store.put(record));
  }

  async remove(key: string): Promise<void> {
    const db = await this.open();
    await this.run(db, 'readwrite', (store) => store.delete(key));
  }

  async list(): Promise<SaveRecord[]> {
    const db = await this.open();
    const result = await this.run(db, 'readonly', (store) => store.getAll());
    return (result as SaveRecord[]) ?? [];
  }

  private run(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(STORE, mode);
      } catch (cause) {
        reject(new SaveStoreError('unknown', describe(cause)));
        return;
      }

      const request = operation(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        const error = request.error;
        // Quota deserves its own message: the user can act on it.
        const reason: StorageFailure =
          error?.name === 'QuotaExceededError' ? 'quota-exceeded' : 'unknown';
        reject(
          new SaveStoreError(
            reason,
            reason === 'quota-exceeded'
              ? 'Storage is full, so this save could not be written. Free up browser storage and try again.'
              : `Save storage failed: ${error?.message ?? 'unknown error'}`,
          ),
        );
      };
    });
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const saveStore = new SaveStore();
