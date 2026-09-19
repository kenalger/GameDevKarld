import { type GameBoyButton } from '@webboy/emulator';
/**
 * Gamepad bindings, keyed by an INPUT TOKEN rather than by a raw button index.
 *
 * A token is one of:
 *  - `b<n>` — button index `n` (`b0`, `b12`)
 *  - `a<n>-` / `a<n>+` — axis `n` pushed negative or positive (`a0-` is the left stick left)
 *
 * Axes are in the same namespace as buttons because on many pads the d-pad IS an axis, and
 * a player who has to bind one had better be able to bind the other.
 *
 * Same shape as `Bindings` — `Record<string, GameBoyButton>` — deliberately, so the
 * steal-on-rebind semantics are literally the same function and cannot drift apart.
 */
export type PadMapping = Readonly<Record<string, GameBoyButton>>;
/** Stored mappings, keyed by `Gamepad.id`. */
export type PadMappings = Readonly<Record<string, PadMapping>>;
/**
 * The default, applied ONLY to a pad the browser reports as `mapping: "standard"`.
 *
 * The Gamepad specification fixes those indices — right cluster 0-3 (bottom, right, left,
 * top), centre cluster 8/9, left cluster 12-15 (up, down, left, right), axes 0/1 as the
 * left stick. For any other `mapping` value ("" per the spec, "vendor" in some older
 * browsers) the indices mean NOTHING, so there is no default at all: guessing is what
 * produces "my controller does random things".
 *
 * Face buttons follow the current KEYBOARD default (`Z→A`, `X→B`), which is inverted with
 * respect to hardware and to mGBA/SameBoy/RetroArch. That inversion is an open owner-level
 * decision in `docs/handoff.md`; this table is deliberately consistent with the keyboard
 * rather than half-native, and flips with it if the owner flips that decision.
 *
 * @see https://w3c.github.io/gamepad/#remapping
 */
export declare const DEFAULT_STANDARD_MAPPING: PadMapping;
/** Sticks drift; anything under this is not a deliberate push. */
export declare const DEADZONE = 0.5;
/** Whether a string is a token this module understands and can resolve. */
export declare function isPadInput(token: string): boolean;
export declare const buttonToken: (index: number) => string;
export declare const axisToken: (index: number, positive: boolean) => string;
/**
 * A human-readable name for a token.
 *
 * Only a pad the browser calls standard gets friendly names — on any other pad "Button 3"
 * is the honest label, because we genuinely do not know what it is.
 */
export declare function describePadInput(token: string, standard: boolean): string;
/** The tokens bound to a button, in binding order. Mirrors `keysFor`. */
export declare function padInputsFor(mapping: PadMapping, button: GameBoyButton): string[];
/**
 * Binds `token` to `button`, taking it from whatever held it before.
 *
 * Delegates to the keyboard's `bindKey` — same steal semantics, one implementation. That
 * means rebinding a direction also drops its stick binding, which is the honest reading of
 * "this is now the input for Up"; Restore defaults brings the stick back.
 */
export declare function bindPadInput(mapping: PadMapping, button: GameBoyButton, token: string): {
    next: PadMapping;
    stolenFrom: GameBoyButton | null;
};
/** Removes every token bound to a button, leaving it deliberately unbound. */
export declare function clearPadInput(mapping: PadMapping, button: GameBoyButton): PadMapping;
/**
 * Reads the stored mappings. FAILS CLOSED, the same way `settings.ts` does: anything that
 * is not recognisably a mapping — missing, blocked storage, half a JSON blob from a future
 * version, a button name we do not have — is dropped, and a pad with nothing valid left
 * falls back to its default rather than to a half-applied table.
 */
export declare function loadPadMappings(): PadMappings;
export declare function savePadMappings(mappings: PadMappings): void;
/**
 * A mapping compiled into flat integer tables.
 *
 * `poll()` runs once per animation frame and may not allocate (charter law 7), so the
 * string tokens are resolved ONCE — on connect or on a remap — into typed arrays that hold
 * the Game Boy button bitmask for each pad input.
 */
export interface ResolvedMapping {
    /** Button index → Game Boy button bitmask. 0 means unbound. */
    readonly buttons: Int32Array;
    /** Axis index → bitmask when pushed past the deadzone negative / positive. */
    readonly axisNegative: Int32Array;
    readonly axisPositive: Int32Array;
}
export declare function resolveMapping(mapping: PadMapping): ResolvedMapping;
/**
 * The Game Boy buttons a pad is currently pressing, as a bitmask.
 *
 * Allocation-free by construction: index loops, no destructuring (`const [x, y] = pad.axes`
 * runs the array iterator, which allocates), no closures, no `forEach`. Both lengths are
 * bounds-checked against the pad's OWN reported counts — `pad.axes` may be empty on a pad
 * with no sticks at all, and reading `[0]`/`[1]` blind is how that becomes a phantom press.
 */
export declare function padMask(pad: Gamepad, resolved: ResolvedMapping): number;
/**
 * Every token a pad is holding right now, for the "press a button" capture.
 *
 * UI path, not the frame loop: it fills a caller-owned array so repeated polling from a
 * rAF loop still allocates nothing per frame.
 */
export declare function readPadTokens(pad: Gamepad, out: string[]): void;
/**
 * The tokens offered in the binding picker, grouped for `<optgroup>`.
 *
 * Built from the pad's OWN button and axis counts rather than from a fixed list, so the
 * picker never offers an input the hardware does not have. The picker is the primary
 * control and the capture is the enhancement, for the same reason as the keyboard panel:
 * a screen-reader user cannot rely on "press a button to detect".
 */
export declare function bindablePadInputs(pad: {
    buttons: {
        length: number;
    };
    axes: {
        length: number;
    };
}): readonly {
    readonly group: string;
    readonly tokens: readonly string[];
}[];
//# sourceMappingURL=gamepad.d.ts.map