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
export function describeKey(code: string): string {
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
