import { InputLatch } from './input/InputLatch.js';
import { type Bindings } from './input/bindings.js';
import { AudioOutput } from '../audio/AudioOutput.js';
import { type StateSlot } from '../storage/StateStore.js';
import { type StoredCheat } from '../storage/CheatStore.js';
export type SessionStatus = 'empty' | 'running' | 'paused';
export interface SessionSnapshot {
    readonly status: SessionStatus;
    readonly romName: string | null;
    readonly savesRestored: boolean;
    /** Whether the quick slot holds a state, so the Load button can disable itself. */
    readonly hasQuickState: boolean;
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
    private readonly gamepad;
    private detachKeyboard;
    private readonly saves;
    readonly audio: AudioOutput;
    private snapshot;
    private rafId;
    /** True when the tab-hide handler paused us, so returning may resume automatically. */
    private autoPaused;
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
    setMuted(muted: boolean): void;
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
    getBindings(): Bindings;
    setBindings(bindings: Bindings): void;
    pause(): void;
    resume(): void;
    reset(): void;
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