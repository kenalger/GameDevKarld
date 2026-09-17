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
/** Human-readable name for a key code, for the controls panel. */
export declare function describeKey(code: string): string;
/** The key codes currently bound to a button, in binding order. */
export declare function keysFor(bindings: Bindings, button: GameBoyButton): string[];
export declare function loadBindings(): Bindings;
export declare function saveBindings(bindings: Bindings): void;
//# sourceMappingURL=bindings.d.ts.map