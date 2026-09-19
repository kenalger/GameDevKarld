import { InputLatch } from './input/InputLatch.js';
import { GamepadInput } from './input/GamepadInput.js';
import { type Bindings } from './input/bindings.js';
import { type PadMapping, type PadMappings } from './input/gamepad.js';
import { AudioOutput } from '../audio/AudioOutput.js';
import { type StateSlot } from '../storage/StateStore.js';
import { type StoredCheat } from '../storage/CheatStore.js';
/**
 * Which system to run. 'auto' reads the cartridge header, which is right almost always.
 *
 * The override exists for the one case that genuinely needs it: a CGB-compatible cartridge
 * can also run on original Game Boy hardware, and looks entirely different doing so.
 */
export type SystemPreference = 'auto' | 'GB' | 'GBA';
export type SessionStatus = 'empty' | 'running' | 'paused';
export interface SessionSnapshot {
    readonly status: SessionStatus;
    readonly romName: string | null;
    readonly savesRestored: boolean;
    /** Whether the quick slot holds a state, so the Load button can disable itself. */
    readonly hasQuickState: boolean;
    /**
     * Bumped whenever a slot is written. The states panel re-reads its list on a change.
     *
     * A counter rather than a boolean because two saves to the same slot must still be two
     * events, and rather than refreshing on every notify because listing reads every slot's
     * full bytes out of IndexedDB — pause and resume should not pay for that.
     */
    readonly statesRevision: number;
    /** Emulation speed multiplier. 1 is real time. */
    readonly speed: number;
    /**
     * Whether sound output is muted.
     *
     * In the snapshot rather than in a component's `useState` because it is a property of
     * the session, like `speed`: it was local to App, so `setMuted` could change the gain
     * node while nothing else in the app could read the result or restore it.
     */
    readonly muted: boolean;
    /** Show the fps / frames / target readout under the device. Opt-in, like RetroArch's. */
    readonly showPerformance: boolean;
    /** Reveal the debugger. Off by default; the debugger is not a player-facing feature. */
    readonly developerMode: boolean;
    /** Which system the player asked for. 'auto' trusts the cartridge header. */
    readonly systemPreference: SystemPreference;
    /** Which core is actually running, once a cartridge is in. */
    readonly activeSystem: string | null;
    readonly error: string | null;
}
/**
 * Owns the emulator and the frame loop, OUTSIDE React.
 *
 * Two rules from the charter are enforced here:
 *  - The loop starts once and is never driven by a re-runnable effect.
 *  - React never re-renders during emulation: per-frame work touches only the canvas,
 *    and subscribers are notified solely on status transitions.
 */
declare class EmulatorSession {
    private readonly manager;
    private readonly pacer;
    private readonly listeners;
    readonly input: InputLatch;
    private readonly keyboard;
    /** Public so the settings panel can read pad identity and live state without a copy. */
    readonly gamepad: GamepadInput;
    private detachKeyboard;
    private detachGamepad;
    private readonly saves;
    readonly audio: AudioOutput;
    private snapshot;
    private rafId;
    /** True when the tab-hide handler paused us, so returning may resume automatically. */
    private autoPaused;
    /** True when the settings drawer paused us, so closing it may resume. */
    private pausedByMenu;
    /** Set when audio could not be woken without a gesture; the next input wakes it. */
    private audioNeedsGesture;
    private ctx;
    private image;
    private frameCount;
    private lastFpsSample;
    private framesSinceSample;
    private measuredFps;
    subscribe: (listener: () => void) => (() => void);
    getSnapshot: () => SessionSnapshot;
    getMeasuredFps: () => number;
    getFrameCount: () => number;
    getCartridgeInfo: () => import("@webboy/emulator").CartridgeInfo | null;
    /**
     * Attach the display. The ImageData is allocated ONCE here and its buffer is mutated
     * every frame — never reallocated, never copied.
     */
    attachCanvas(canvas: HTMLCanvasElement | null): void;
    loadRom(name: string, data: Uint8Array): void;
    /**
     * Restores the battery save, keyed by CARTRIDGE IDENTITY rather than filename, so the
     * same game from a different dump resolves to the same save and two different games
     * never collide.
     */
    private restoreSave;
    getInspector(): import("@webboy/emulator").CoreInspector | null;
    stepInstruction(): void;
    stepFrame(): void;
    toggleBreakpoint(address: number): void;
    listBreakpoints(): number[];
    private readonly breakpoints;
    /** Enters or leaves fullscreen on the given element. */
    toggleFullscreen(element: HTMLElement): Promise<void>;
    /** Captures a small PNG of the current screen, for the slot list. */
    private captureThumbnail;
    saveStateToSlot(slot: number): Promise<void>;
    loadStateFromSlot(slot: number): Promise<void>;
    /**
     * The quick slot is slot 0 — the same one the States panel shows first.
     *
     * Save states existed for a while with no way to reach them except a tab below the
     * fold, which is how a player concludes the feature is missing. Quick save and load
     * belong next to Pause, where the hand already is; the panel keeps the full set with
     * thumbnails for when you want to choose.
     */
    quickSave(): Promise<void>;
    quickLoad(): Promise<void>;
    /** Cheap: one indexed read, and only on load/save, never per frame. */
    refreshQuickState(): Promise<void>;
    private cheats;
    listCheats(): readonly StoredCheat[];
    /**
     * Parses a code and adds it, enabled.
     *
     * Returns the error message rather than throwing: this is driven by a text field, and
     * "that is not a code" is an ordinary outcome of typing, not an exceptional one.
     */
    addCheat(code: string, label: string): Promise<string | null>;
    setCheatEnabled(id: string, enabled: boolean): Promise<void>;
    removeCheat(id: string): Promise<void>;
    /**
     * Pushes the whole active set to the core in ONE call.
     *
     * Deliberately not add/remove: when the core moves to a Web Worker this becomes a single
     * message with no ordering to get wrong.
     */
    private applyCheats;
    private persistCheats;
    private restoreCheats;
    listStateSlots(): Promise<(StateSlot | null)[]>;
    /** The current state as a downloadable `.state` payload. */
    exportState(): {
        data: Uint8Array;
        filename: string;
    } | null;
    importState(data: Uint8Array): void;
    /**
     * Wakes a suspended AudioContext.
     *
     * Hiding the tab suspends it, and a suspended context can only be resumed by a USER
     * GESTURE. When this runs from a click that is satisfied; when it runs from the
     * visibility handler it is not, so a failure is recorded rather than reported and the
     * next key or tap wakes it. Raising an error banner on every tab switch would be noise.
     */
    private wakeAudio;
    /** Called from the first input after a gesture-less resume. Cheap and idempotent. */
    private wakeAudioOnGesture;
    private startAudio;
    /**
     * Runs the game faster or slower than real time.
     *
     * The audio output rate is rescaled by the same factor. Without that, running at 2x
     * produces samples twice as fast as the device drains them, the ring buffer overflows
     * and pushes are dropped — audible as constant crackle. Rescaling keeps the buffer
     * balanced and shifts the pitch instead, which is what fast-forward has always sounded
     * like and is the honest signal that the game is not running at normal speed.
     */
    setSpeed(multiplier: number): void;
    setSystemPreference(preference: SystemPreference): void;
    setMuted(muted: boolean): void;
    /**
     * The performance readout and the debugger, both off by default.
     *
     * They live here rather than in component state for the same reason the speed does:
     * they are session-wide, they persist across a reload, and the settings drawer that
     * changes them is not the only thing that reads them.
     */
    setShowPerformance(showPerformance: boolean): void;
    setDeveloperMode(developerMode: boolean): void;
    getAudioStats(): import("../audio/AudioOutput.js").AudioStats;
    /** Surface a user-facing problem (bad file, unreadable ROM) without touching emulation. */
    reportError(message: string): void;
    /** Writes the battery save immediately. Safe to call at any time. */
    flushSave(): void;
    /** The current save as a `.sav` payload, or null when the cartridge has no battery. */
    exportSave(): {
        data: Uint8Array;
        filename: string;
    } | null;
    /** Replaces the battery save from an imported `.sav`, then persists it. */
    importSave(data: Uint8Array): void;
    /** Starts listening for keyboard input. Returns a teardown function. */
    attachInput(): () => void;
    /**
     * Stops player input reaching the game, for the duration of a binding capture.
     *
     * Every source, not just the keyboard: a rebind should not be interrupted by a thumb on
     * the on-screen pad or a resting gamepad stick.
     */
    setInputSuppressed(suppressed: boolean): void;
    getBindings(): Bindings;
    setBindings(bindings: Bindings): void;
    /** Every stored pad mapping. Pads without one run the standard default, or nothing. */
    getPadMappings(): PadMappings;
    /** Replaces one pad's mapping and persists it. Mirrors `setBindings`. */
    setPadMapping(padId: string, mapping: PadMapping): void;
    /** Drops a pad's stored mapping, so it falls back to the default for its layout. */
    resetPadMapping(padId: string): void;
    pause(): void;
    resume(): void;
    reset(): void;
    /**
     * Pause while the settings drawer is open, and resume on close.
     *
     * Every emulator this was checked against pauses when its menu opens — RetroArch's
     * Quick Menu, Delta's pause menu, mGBA. Without it the game runs on behind the drawer,
     * and the arrow keys used to read the menu also drive the character.
     *
     * Kept out of the component because "resume only if WE paused" is a rule with a state
     * machine behind it, and the same rule already exists for tab switching below.
     */
    menuOpened(): void;
    /** A game already paused before the drawer opened stays paused after it closes. */
    menuClosed(): void;
    /** Pause on hide; on return, drop accumulated time rather than running a catch-up burst. */
    handleVisibilityChange(hidden: boolean): void;
    private start;
    private stop;
    private readonly tick;
    private paint;
    private notify;
    private update;
}
/** One session per page. Module-level so no React lifecycle can create a second loop. */
export declare const session: EmulatorSession;
export {};
//# sourceMappingURL=EmulatorSession.d.ts.map