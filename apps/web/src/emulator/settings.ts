/**
 * Small on/off preferences, persisted the same way `webboy.system.v1` is: one versioned
 * key per setting, written through a try/catch because a remembered preference is a
 * convenience and never a requirement.
 *
 * Both of these default to OFF and FAIL CLOSED — anything in storage that is not exactly
 * `'on'` (missing, `'true'`, `'1'`, half a JSON blob from a future version) reads as off.
 * That is the safe direction for both: RetroArch ships `DEFAULT_FPS_SHOW false`, and a
 * debugger that appears because a corrupt string happened to be truthy would be worse
 * than one that stays hidden.
 */

/** Show the fps / frames / target readout under the device. */
export const PERFORMANCE_KEY = 'webboy.performance.v1';

/** Reveal the debugger section in settings. */
export const DEVELOPER_KEY = 'webboy.developer.v1';

/**
 * The two methods of `localStorage` this file uses.
 *
 * Narrowed to an interface so the load/save logic is testable without a DOM, and so a
 * caller can pass a stub in an environment that has no storage at all.
 */
export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * `localStorage`, or null where it does not exist.
 *
 * Reading the global is itself inside a try/catch: in a sandboxed iframe or with
 * third-party storage blocked, merely touching `localStorage` throws a SecurityError
 * rather than returning undefined.
 */
function browserStorage(): FlagStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reads a stored flag. Absent, unreadable or unrecognised all mean `false`. */
export function loadFlag(key: string, storage: FlagStorage | null = browserStorage()): boolean {
  try {
    return storage?.getItem(key) === 'on';
  } catch {
    return false;
  }
}

/** Writes a flag. A storage that refuses the write (private mode, quota) is not an error. */
export function saveFlag(
  key: string,
  value: boolean,
  storage: FlagStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(key, value ? 'on' : 'off');
  } catch {
    // Same contract as the system preference: the setting still applies to this session,
    // it just will not survive a reload.
  }
}
