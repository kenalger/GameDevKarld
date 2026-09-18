import { ALL_BUTTONS, type GameBoyButton } from '@webboy/emulator';

/**
 * Keyboard bindings, keyed by `KeyboardEvent.code`.
 *
 * `code` describes the PHYSICAL key and is layout-independent. `key` is not: on an AZERTY
 * layout `key` reports different letters, and holding Shift changes `key` entirely — which
 * would silently break the Select binding and every letter mapping alongside it.
 */
export type Bindings = Readonly<Record<string, GameBoyButton>>;

export const DEFAULT_BINDINGS: Bindings = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyZ: 'a',
  KeyX: 'b',
  Enter: 'start',
  ShiftRight: 'select',
  ShiftLeft: 'select',
};

const STORAGE_KEY = 'webboy.bindings.v1';

/** Human-readable name for a key code, for the controls panel. */
const KEY_LABELS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  Backspace: 'Backspace',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

export function describeKey(code: string): string {
  const named = KEY_LABELS[code];
  if (named !== undefined) return named;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return `${code.slice(5)} Arrow`;
  if (code === 'ShiftLeft') return 'Left Shift';
  if (code === 'ShiftRight') return 'Right Shift';
  return code;
}

/** The key codes currently bound to a button, in binding order. */
export function keysFor(bindings: Bindings, button: GameBoyButton): string[] {
  return Object.keys(bindings).filter((code) => bindings[code] === button);
}

export function loadBindings(): Bindings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_BINDINGS;
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_BINDINGS;

    const valid: Record<string, GameBoyButton> = {};
    for (const [code, button] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof button === 'string' && (ALL_BUTTONS as readonly string[]).includes(button)) {
        valid[code] = button as GameBoyButton;
      }
    }
    return Object.keys(valid).length > 0 ? valid : DEFAULT_BINDINGS;
  } catch {
    // Private browsing, blocked storage, or corrupt JSON — defaults still work.
    return DEFAULT_BINDINGS;
  }
}

export function saveBindings(bindings: Bindings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // A remembered binding is a convenience, never a requirement.
  }
}

/**
 * Keys offered in the binding picker, grouped for `<optgroup>`.
 *
 * A curated list rather than "any key": the picker is the PRIMARY control, not a fallback,
 * because press-a-key capture cannot work for a screen-reader user — in browse mode single
 * letters are navigation commands and never reach the page. So this list has to be good
 * enough to bind everything without ever pressing a key.
 */
export const BINDABLE_KEYS: readonly {
  readonly group: string;
  readonly codes: readonly string[];
}[] = [
  { group: 'Arrows', codes: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] },
  {
    group: 'Letters',
    codes: Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  },
  { group: 'Numbers', codes: Array.from({ length: 10 }, (_, i) => `Digit${i}`) },
  {
    group: 'Other',
    codes: [
      'Space',
      'Enter',
      'Backspace',
      'ShiftLeft',
      'ShiftRight',
      'Comma',
      'Period',
      'Slash',
      'Semicolon',
      'Quote',
      'BracketLeft',
      'BracketRight',
      'Minus',
      'Equal',
      'Backquote',
    ],
  },
];

/**
 * Keys that may never be bound.
 *
 * Escape is the cancel key and is not reliably preventable — it is also the fullscreen
 * exit. Tab is the only guaranteed way out of a keyboard trap (WCAG 2.1.2), so binding it
 * would build one. Control, Alt and Meta are capturable but structurally unusable: the
 * play handler discards any modified keydown, so such a binding would take and then never
 * fire once.
 */
export const RESERVED_CODES: ReadonlySet<string> = new Set([
  'Escape',
  'Tab',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'AltGraph',
  'CapsLock',
  'ContextMenu',
  'PrintScreen',
]);

/**
 * Binds `code` to `button`, taking it from whatever held it before.
 *
 * Bindings are keyed by code, so one key maps to at most one button — a duplicate is
 * structurally impossible and this is a STEAL, not a swap. Swapping would mean inventing a
 * key for the victim, which is a guess; rejecting would leave the player wondering where
 * the key already lives. So it steals, and returns the victim so the UI can say so.
 */
export function bindKey(
  bindings: Bindings,
  button: GameBoyButton,
  code: string,
): { next: Bindings; stolenFrom: GameBoyButton | null } {
  const stolenFrom = bindings[code] ?? null;
  const next: Record<string, GameBoyButton> = {};
  for (const [existingCode, existingButton] of Object.entries(bindings)) {
    // Drop this button's old keys and any previous owner of the incoming code.
    if (existingButton === button || existingCode === code) continue;
    next[existingCode] = existingButton;
  }
  next[code] = button;
  return { next, stolenFrom: stolenFrom === button ? null : stolenFrom };
}

/** Removes every key bound to a button, leaving it deliberately unbound. */
export function clearKey(bindings: Bindings, button: GameBoyButton): Bindings {
  const next: Record<string, GameBoyButton> = {};
  for (const [code, boundButton] of Object.entries(bindings)) {
    if (boundButton !== button) next[code] = boundButton;
  }
  return next;
}
