import { describe, expect, it } from 'vitest';
import {
  DEVELOPER_KEY,
  PERFORMANCE_KEY,
  loadFlag,
  saveFlag,
  type FlagStorage,
} from './settings.js';

/** A localStorage stand-in. Values are strings, exactly as the real one stores them. */
function fakeStorage(initial: Record<string, string> = {}): FlagStorage & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

describe('settings flags', () => {
  it('round-trips a flag through storage', () => {
    const storage = fakeStorage();
    saveFlag(PERFORMANCE_KEY, true, storage);
    expect(storage.map.get(PERFORMANCE_KEY)).toBe('on');
    expect(loadFlag(PERFORMANCE_KEY, storage)).toBe(true);

    saveFlag(PERFORMANCE_KEY, false, storage);
    expect(storage.map.get(PERFORMANCE_KEY)).toBe('off');
    expect(loadFlag(PERFORMANCE_KEY, storage)).toBe(false);
  });

  it('DEFAULTS TO OFF when nothing was ever written', () => {
    expect(loadFlag(PERFORMANCE_KEY, fakeStorage())).toBe(false);
    expect(loadFlag(DEVELOPER_KEY, fakeStorage())).toBe(false);
  });

  it('DEFAULTS TO OFF when there is no storage at all', () => {
    // Private-mode Safari, a sandboxed iframe, or a non-browser test runner.
    expect(loadFlag(DEVELOPER_KEY, null)).toBe(false);
    expect(() => saveFlag(DEVELOPER_KEY, true, null)).not.toThrow();
  });

  it('FAILS CLOSED on a corrupt value rather than treating it as truthy', () => {
    for (const junk of ['true', '1', 'yes', 'ON', '{"showPerformance":true}', '']) {
      expect(loadFlag(DEVELOPER_KEY, fakeStorage({ [DEVELOPER_KEY]: junk }))).toBe(false);
    }
  });

  it('survives a storage that throws on read or write', () => {
    const hostile: FlagStorage = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    expect(loadFlag(PERFORMANCE_KEY, hostile)).toBe(false);
    expect(() => saveFlag(PERFORMANCE_KEY, true, hostile)).not.toThrow();
  });

  it('keeps the two flags on separate versioned keys', () => {
    const storage = fakeStorage();
    saveFlag(PERFORMANCE_KEY, true, storage);
    expect(loadFlag(DEVELOPER_KEY, storage)).toBe(false);
    expect(PERFORMANCE_KEY).toMatch(/^webboy\..+\.v\d+$/);
    expect(DEVELOPER_KEY).toMatch(/^webboy\..+\.v\d+$/);
  });
});
