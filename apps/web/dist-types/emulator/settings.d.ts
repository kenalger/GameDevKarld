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
export declare const PERFORMANCE_KEY = "webboy.performance.v1";
/** Reveal the debugger section in settings. */
export declare const DEVELOPER_KEY = "webboy.developer.v1";
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
/** Reads a stored flag. Absent, unreadable or unrecognised all mean `false`. */
export declare function loadFlag(key: string, storage?: FlagStorage | null): boolean;
/** Writes a flag. A storage that refuses the write (private mode, quota) is not an error. */
export declare function saveFlag(key: string, value: boolean, storage?: FlagStorage | null): void;
//# sourceMappingURL=settings.d.ts.map