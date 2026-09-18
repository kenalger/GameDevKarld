import { type GameBoyButton } from '@webboy/emulator';
/**
 * Keyboard bindings, keyed by `KeyboardEvent.code`.
 *
 * `code` describes the PHYSICAL key and is layout-independent. `key` is not: on an AZERTY
 * layout `key` reports different letters, and holding Shift changes `key` entirely — which
 * would silently break the Select binding and every letter mapping alongside it.
 */
export type Bindings = Readonly<Record<string, GameBoyButton>>;
export declare const DEFAULT_BINDINGS: Bindings;
export declare function describeKey(code: string): string;
/** The key codes currently bound to a button, in binding order. */
export declare function keysFor(bindings: Bindings, button: GameBoyButton): string[];
export declare function loadBindings(): Bindings;
export declare function saveBindings(bindings: Bindings): void;
/**
 * Keys offered in the binding picker, grouped for `<optgroup>`.
 *
 * A curated list rather than "any key": the picker is the PRIMARY control, not a fallback,
 * because press-a-key capture cannot work for a screen-reader user — in browse mode single
 * letters are navigation commands and never reach the page. So this list has to be good
 * enough to bind everything without ever pressing a key.
 */
export declare const BINDABLE_KEYS: readonly {
    readonly group: string;
    readonly codes: readonly string[];
}[];
/**
 * Keys that may never be bound.
 *
 * Escape is the cancel key and is not reliably preventable — it is also the fullscreen
 * exit. Tab is the only guaranteed way out of a keyboard trap (WCAG 2.1.2), so binding it
 * would build one. Control, Alt and Meta are capturable but structurally unusable: the
 * play handler discards any modified keydown, so such a binding would take and then never
 * fire once.
 */
export declare const RESERVED_CODES: ReadonlySet<string>;
/**
 * Binds `code` to `button`, taking it from whatever held it before.
 *
 * Bindings are keyed by code, so one key maps to at most one button — a duplicate is
 * structurally impossible and this is a STEAL, not a swap. Swapping would mean inventing a
 * key for the victim, which is a guess; rejecting would leave the player wondering where
 * the key already lives. So it steals, and returns the victim so the UI can say so.
 */
export declare function bindKey(bindings: Bindings, button: GameBoyButton, code: string): {
    next: Bindings;
    stolenFrom: GameBoyButton | null;
};
/** Removes every key bound to a button, leaving it deliberately unbound. */
export declare function clearKey(bindings: Bindings, button: GameBoyButton): Bindings;
//# sourceMappingURL=bindings.d.ts.map