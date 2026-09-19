import { ALL_BUTTONS, buttonBit, type GameBoyButton } from '@webboy/emulator';
import { SOURCE, type InputLatch } from './InputLatch.js';
import {
  DEFAULT_STANDARD_MAPPING,
  padMask,
  readPadTokens,
  resolveMapping,
  type PadMapping,
  type PadMappings,
  type ResolvedMapping,
} from './gamepad.js';

/**
 * How many pad slots are tracked. Browsers expose four; a fifth pad is ignored rather than
 * silently sharing a slot with another one.
 */
const MAX_PADS = 8;

/** Bit per Game Boy button, in `ALL_BUTTONS` order. Built once, read every frame. */
const BUTTON_BITS: readonly number[] = ALL_BUTTONS.map(buttonBit);

/** Shared empty mapping, so "this pad is unmapped" costs no allocation to answer. */
const NO_MAPPING: PadMapping = {};

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
export class GamepadInput {
  constructor(private readonly latch: InputLatch) {}

  /** Stored per-pad mappings, keyed by `Gamepad.id`. Owned by the session. */
  private mappings: PadMappings = {};

  /** Which pad id each slot last held, so a compiled table is rebuilt only on change. */
  private readonly slotId: (string | undefined)[] = new Array<string | undefined>(MAX_PADS).fill(
    undefined,
  );
  private readonly slotResolved: (ResolvedMapping | null)[] = new Array<ResolvedMapping | null>(
    MAX_PADS,
  ).fill(null);
  /** True once a slot has been compiled, so "no mapping" is not recompiled every frame. */
  private readonly slotCompiled = new Uint8Array(MAX_PADS);
  /** Per-slot pressed mask. Their OR is what the latch sees. */
  private readonly slotMask = new Int32Array(MAX_PADS);

  /** Shadow of what we have told the latch, so only edges are sent. */
  private held = 0;

  private readonly listeners = new Set<() => void>();

  /**
   * Diagnostics. `polls` counts frames; `tablesCompiled` counts the only allocating step in
   * the poll path, so a test can assert that a steady-state frame compiles nothing — the
   * same trick as `GbCheatEngine.checksPerformed`.
   */
  polls = 0;
  tablesCompiled = 0;

  /* --------------------------------- lifecycle --------------------------------- */

  /**
   * Starts listening for connect and disconnect. Returns a teardown function.
   *
   * Both matter. `gamepadconnected` is the only way a pad that was already plugged in when
   * the page loaded becomes visible — Firefox and Safari expose nothing from
   * `getGamepads()` until then. And a pad unplugged mid-press must release immediately:
   * the frame loop is stopped while the game is paused, so nothing else would reconcile it.
   */
  attach(target: Window = window): () => void {
    target.addEventListener('gamepadconnected', this.onConnected);
    target.addEventListener('gamepaddisconnected', this.onDisconnected);
    return () => {
      target.removeEventListener('gamepadconnected', this.onConnected);
      target.removeEventListener('gamepaddisconnected', this.onDisconnected);
    };
  }

  /** Notified when a pad connects, disconnects, or its mapping changes. Never per frame. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private readonly onConnected = (event: Event): void => {
    const index = (event as GamepadEvent).gamepad?.index ?? -1;
    this.forgetSlot(index);
    this.notify();
  };

  private readonly onDisconnected = (event: Event): void => {
    const index = (event as GamepadEvent).gamepad?.index ?? -1;
    this.forgetSlot(index);
    // Release NOW rather than waiting for a poll that may never come: unplugging while
    // paused, or while the tab is hidden, would otherwise leave the button held forever.
    this.reconcile();
    this.notify();
  };

  private forgetSlot(index: number): void {
    if (index < 0 || index >= MAX_PADS) {
      // An index we do not track: drop every compiled table instead of guessing which.
      this.slotId.fill(undefined);
      this.slotCompiled.fill(0);
      this.slotMask.fill(0);
      return;
    }
    this.slotId[index] = undefined;
    this.slotResolved[index] = null;
    this.slotCompiled[index] = 0;
    this.slotMask[index] = 0;
  }

  /* ---------------------------------- mappings ---------------------------------- */

  setMappings(mappings: PadMappings): void {
    this.mappings = mappings;
    // Every compiled table is now stale.
    this.slotId.fill(undefined);
    this.slotCompiled.fill(0);
    // A rebind must not leave the old input stuck down. Only OUR source.
    this.releaseAll();
    this.notify();
  }

  getMappings(): PadMappings {
    return this.mappings;
  }

  /** The mapping in force for a pad: its own if stored, else the standard default. */
  mappingFor(padId: string, standard: boolean): PadMapping {
    return this.mappings[padId] ?? (standard ? DEFAULT_STANDARD_MAPPING : NO_MAPPING);
  }

  /* ------------------------------ the frame loop ------------------------------ */

  /** Call once per frame, before sampling the latch. Allocates nothing. */
  poll(): void {
    this.polls++;
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;

    const pads = navigator.getGamepads();
    const count = pads.length < MAX_PADS ? pads.length : MAX_PADS;

    for (let i = 0; i < count; i++) {
      const pad = pads[i];
      if (!pad) {
        this.slotMask[i] = 0;
        this.slotId[i] = undefined;
        this.slotCompiled[i] = 0;
        continue;
      }
      const resolved = this.tableFor(i, pad);
      this.slotMask[i] = resolved === null ? 0 : padMask(pad, resolved);
    }
    // A browser that shrinks the array must not leave a stale slot pressed.
    for (let i = count; i < MAX_PADS; i++) this.slotMask[i] = 0;

    this.reconcile();
  }

  /**
   * The compiled table for a slot, rebuilt only when the pad in it changes.
   *
   * `null` means "connected, but nothing is mapped" — a non-standard pad the player has
   * not configured. It is deliberately inert rather than wrong.
   */
  private tableFor(slot: number, pad: Gamepad): ResolvedMapping | null {
    if (this.slotCompiled[slot] === 1 && this.slotId[slot] === pad.id) {
      return this.slotResolved[slot] ?? null;
    }

    const standard = pad.mapping === 'standard';
    const mapping = this.mappingFor(pad.id, standard);
    const empty = Object.keys(mapping).length === 0;

    this.slotId[slot] = pad.id;
    this.slotResolved[slot] = empty ? null : resolveMapping(mapping);
    this.slotCompiled[slot] = 1;
    this.tablesCompiled++;
    return this.slotResolved[slot] ?? null;
  }

  /** Sends only the edges between the union of the slots and what the latch already has. */
  private reconcile(): void {
    let union = 0;
    for (let i = 0; i < MAX_PADS; i++) union |= this.slotMask[i] ?? 0;
    if (union === this.held) return;

    for (let i = 0; i < BUTTON_BITS.length; i++) {
      const bit = BUTTON_BITS[i] ?? 0;
      const isDown = (union & bit) !== 0;
      const wasDown = (this.held & bit) !== 0;
      if (isDown === wasDown) continue;
      const button = ALL_BUTTONS[i] as GameBoyButton;
      if (isDown) this.latch.press(button, SOURCE.gamepad);
      else this.latch.release(button, SOURCE.gamepad);
    }
    this.held = union;
  }

  /**
   * Drops every held button.
   *
   * The shadow is cleared too, so a button still physically held is PRESSED AGAIN on the
   * next poll. That is deliberate: without it, a button held across a pause reads as
   * still-down afterwards, no edge is ever emitted, and it stays dead until the player
   * lets go.
   */
  releaseAll(): void {
    for (let i = 0; i < BUTTON_BITS.length; i++) {
      if ((this.held & (BUTTON_BITS[i] ?? 0)) === 0) continue;
      this.latch.release(ALL_BUTTONS[i] as GameBoyButton, SOURCE.gamepad);
    }
    this.held = 0;
    this.slotMask.fill(0);
  }

  /* ------------------------------- the UI's view ------------------------------- */

  get connected(): boolean {
    return this.pads().length > 0;
  }

  /** Every connected pad. UI path — called on render and on connect, never per frame. */
  pads(): PadInfo[] {
    const result: PadInfo[] = [];
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return result;

    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      const standard = pad.mapping === 'standard';
      const stored = this.mappings[pad.id];
      result.push({
        index: pad.index,
        id: pad.id,
        mapping: pad.mapping,
        standard,
        customised: stored !== undefined,
        mapped: Object.keys(this.mappingFor(pad.id, standard)).length > 0,
        buttonCount: pad.buttons.length,
        axisCount: pad.axes.length,
      });
    }
    return result;
  }

  /** The raw pad object for a slot, for the settings panel's picker. */
  padAt(index: number): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    for (const pad of navigator.getGamepads()) {
      if (pad && pad.index === index) return pad;
    }
    return null;
  }

  /**
   * The Game Boy buttons a single pad is pressing right now, without touching the latch.
   *
   * The settings drawer pauses emulation, so the frame loop — and `poll()` with it — is
   * stopped while the panel is open. The panel therefore reads the pad itself, from its own
   * rAF loop, exactly as the keyboard panel reads the latch.
   */
  liveMask(index: number): number {
    if (index < 0 || index >= MAX_PADS) return 0;
    const pad = this.padAt(index);
    if (!pad) return 0;
    // Through the same compiled-table cache the frame loop uses, so a rAF loop reading this
    // sixty times a second does not rebuild a lookup table sixty times a second.
    const resolved = this.tableFor(index, pad);
    return resolved === null ? 0 : padMask(pad, resolved);
  }

  /** Fills `out` with the tokens a pad is holding, for "press a button" capture. */
  readTokens(index: number, out: string[]): void {
    out.length = 0;
    const pad = this.padAt(index);
    if (pad) readPadTokens(pad, out);
  }
}
