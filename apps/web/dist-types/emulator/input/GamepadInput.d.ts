import { type InputLatch } from './InputLatch.js';
import { type PadMapping, type PadMappings } from './gamepad.js';
/** What the settings panel needs to say about a pad. */
export interface PadInfo {
    readonly index: number;
    readonly id: string;
    /** As reported by the browser: `"standard"`, `""`, or a vendor string. */
    readonly mapping: string;
    readonly standard: boolean;
    /** True when this pad has a stored mapping of its own. */
    readonly customised: boolean;
    /** False when the pad is non-standard and has no mapping — it does nothing yet. */
    readonly mapped: boolean;
    readonly buttonCount: number;
    readonly axisCount: number;
}
/**
 * Gamepad support.
 *
 * The Gamepad API is **poll-based, not event-based** — there is no "button pressed" event,
 * so this is read once per frame from inside the emulator loop rather than from a listener.
 * The only events it has are connect and disconnect, which this does listen for.
 *
 * Two rules shape the whole class:
 *
 *  1. **`pad.mapping` is not decoration.** The standard index table (0-3 right cluster,
 *     8/9 centre, 12-15 d-pad, axes 0/1 left stick) is only guaranteed when the browser
 *     reports `mapping === "standard"`. On any other pad those indices mean nothing, so no
 *     default is applied at all and the pad waits for a user mapping. Guessing is what
 *     produces "my controller does random things".
 *  2. **`poll()` may not allocate.** It runs every animation frame. Everything it touches
 *     is preallocated: integer masks per slot, typed-array lookup tables compiled once per
 *     pad, index loops instead of `forEach`, no destructuring of `pad.axes`.
 */
export declare class GamepadInput {
    private readonly latch;
    constructor(latch: InputLatch);
    /** Stored per-pad mappings, keyed by `Gamepad.id`. Owned by the session. */
    private mappings;
    /** Which pad id each slot last held, so a compiled table is rebuilt only on change. */
    private readonly slotId;
    private readonly slotResolved;
    /** True once a slot has been compiled, so "no mapping" is not recompiled every frame. */
    private readonly slotCompiled;
    /** Per-slot pressed mask. Their OR is what the latch sees. */
    private readonly slotMask;
    /** Shadow of what we have told the latch, so only edges are sent. */
    private held;
    private readonly listeners;
    /**
     * Diagnostics. `polls` counts frames; `tablesCompiled` counts the only allocating step in
     * the poll path, so a test can assert that a steady-state frame compiles nothing — the
     * same trick as `GbCheatEngine.checksPerformed`.
     */
    polls: number;
    tablesCompiled: number;
    /**
     * Starts listening for connect and disconnect. Returns a teardown function.
     *
     * Both matter. `gamepadconnected` is the only way a pad that was already plugged in when
     * the page loaded becomes visible — Firefox and Safari expose nothing from
     * `getGamepads()` until then. And a pad unplugged mid-press must release immediately:
     * the frame loop is stopped while the game is paused, so nothing else would reconcile it.
     */
    attach(target?: Window): () => void;
    /** Notified when a pad connects, disconnects, or its mapping changes. Never per frame. */
    subscribe: (listener: () => void) => (() => void);
    private notify;
    private readonly onConnected;
    private readonly onDisconnected;
    private forgetSlot;
    setMappings(mappings: PadMappings): void;
    getMappings(): PadMappings;
    /** The mapping in force for a pad: its own if stored, else the standard default. */
    mappingFor(padId: string, standard: boolean): PadMapping;
    /** Call once per frame, before sampling the latch. Allocates nothing. */
    poll(): void;
    /**
     * The compiled table for a slot, rebuilt only when the pad in it changes.
     *
     * `null` means "connected, but nothing is mapped" — a non-standard pad the player has
     * not configured. It is deliberately inert rather than wrong.
     */
    private tableFor;
    /** Sends only the edges between the union of the slots and what the latch already has. */
    private reconcile;
    /**
     * Drops every held button.
     *
     * The shadow is cleared too, so a button still physically held is PRESSED AGAIN on the
     * next poll. That is deliberate: without it, a button held across a pause reads as
     * still-down afterwards, no edge is ever emitted, and it stays dead until the player
     * lets go.
     */
    releaseAll(): void;
    get connected(): boolean;
    /** Every connected pad. UI path — called on render and on connect, never per frame. */
    pads(): PadInfo[];
    /** The raw pad object for a slot, for the settings panel's picker. */
    padAt(index: number): Gamepad | null;
    /**
     * The Game Boy buttons a single pad is pressing right now, without touching the latch.
     *
     * The settings drawer pauses emulation, so the frame loop — and `poll()` with it — is
     * stopped while the panel is open. The panel therefore reads the pad itself, from its own
     * rAF loop, exactly as the keyboard panel reads the latch.
     */
    liveMask(index: number): number;
    /** Fills `out` with the tokens a pad is holding, for "press a button" capture. */
    readTokens(index: number, out: string[]): void;
}
//# sourceMappingURL=GamepadInput.d.ts.map