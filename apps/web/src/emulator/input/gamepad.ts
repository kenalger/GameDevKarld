import { ALL_BUTTONS, buttonBit, type GameBoyButton } from '@webboy/emulator';
import { bindKey, clearKey } from './bindings.js';

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
export const DEFAULT_STANDARD_MAPPING: PadMapping = {
  b0: 'a', // south
  b1: 'b', // east
  b2: 'b', // west — a second B is friendlier than leaving it dead
  b3: 'a', // north
  b8: 'select',
  b9: 'start',
  b12: 'up',
  b13: 'down',
  b14: 'left',
  b15: 'right',
  'a0-': 'left',
  'a0+': 'right',
  'a1-': 'up',
  'a1+': 'down',
};

/** Sticks drift; anything under this is not a deliberate push. */
export const DEADZONE = 0.5;

/** Upper bounds for the resolved lookup tables. Anything beyond is ignored. */
const MAX_PAD_BUTTONS = 24;
const MAX_PAD_AXES = 8;

const STORAGE_KEY = 'webboy.gamepad.v1';

const BUTTON_TOKEN = /^b(\d{1,2})$/;
const AXIS_TOKEN = /^a(\d{1,2})[-+]$/;

/** Whether a string is a token this module understands and can resolve. */
export function isPadInput(token: string): boolean {
  const button = BUTTON_TOKEN.exec(token);
  if (button) return Number(button[1]) < MAX_PAD_BUTTONS;
  const axis = AXIS_TOKEN.exec(token);
  return axis !== null && Number(axis[1]) < MAX_PAD_AXES;
}

export const buttonToken = (index: number): string => `b${index}`;
export const axisToken = (index: number, positive: boolean): string =>
  `a${index}${positive ? '+' : '-'}`;

/** Standard-layout names, used only when the browser says the layout IS standard. */
const STANDARD_BUTTON_LABELS: readonly string[] = [
  'Bottom face',
  'Right face',
  'Left face',
  'Top face',
  'Left bumper',
  'Right bumper',
  'Left trigger',
  'Right trigger',
  'Back / Select',
  'Start',
  'Left stick press',
  'Right stick press',
  'D-pad up',
  'D-pad down',
  'D-pad left',
  'D-pad right',
  'Guide',
];

const STANDARD_AXIS_LABELS: readonly string[] = [
  'Left stick',
  'Left stick',
  'Right stick',
  'Right stick',
];

/**
 * A human-readable name for a token.
 *
 * Only a pad the browser calls standard gets friendly names — on any other pad "Button 3"
 * is the honest label, because we genuinely do not know what it is.
 */
export function describePadInput(token: string, standard: boolean): string {
  const button = BUTTON_TOKEN.exec(token);
  if (button) {
    const index = Number(button[1]);
    const label = standard ? STANDARD_BUTTON_LABELS[index] : undefined;
    return label === undefined ? `Button ${index}` : `${label} (${index})`;
  }
  const axis = AXIS_TOKEN.exec(token);
  if (axis) {
    const index = Number(axis[1]);
    const positive = token.endsWith('+');
    const label = standard ? STANDARD_AXIS_LABELS[index] : undefined;
    if (label === undefined) return `Axis ${index} ${positive ? '+' : '−'}`;
    const direction = index % 2 === 0 ? (positive ? 'right' : 'left') : positive ? 'down' : 'up';
    return `${label} ${direction}`;
  }
  return token;
}

/** The tokens bound to a button, in binding order. Mirrors `keysFor`. */
export function padInputsFor(mapping: PadMapping, button: GameBoyButton): string[] {
  return Object.keys(mapping).filter((token) => mapping[token] === button);
}

/**
 * Binds `token` to `button`, taking it from whatever held it before.
 *
 * Delegates to the keyboard's `bindKey` — same steal semantics, one implementation. That
 * means rebinding a direction also drops its stick binding, which is the honest reading of
 * "this is now the input for Up"; Restore defaults brings the stick back.
 */
export function bindPadInput(
  mapping: PadMapping,
  button: GameBoyButton,
  token: string,
): { next: PadMapping; stolenFrom: GameBoyButton | null } {
  return bindKey(mapping, button, token);
}

/** Removes every token bound to a button, leaving it deliberately unbound. */
export function clearPadInput(mapping: PadMapping, button: GameBoyButton): PadMapping {
  return clearKey(mapping, button);
}

/* --------------------------------- persistence --------------------------------- */

/**
 * Reads the stored mappings. FAILS CLOSED, the same way `settings.ts` does: anything that
 * is not recognisably a mapping — missing, blocked storage, half a JSON blob from a future
 * version, a button name we do not have — is dropped, and a pad with nothing valid left
 * falls back to its default rather than to a half-applied table.
 */
export function loadPadMappings(): PadMappings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return {};
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const result: Record<string, PadMapping> = {};
    for (const [padId, mapping] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) continue;
      const valid: Record<string, GameBoyButton> = {};
      for (const [token, button] of Object.entries(mapping as Record<string, unknown>)) {
        if (!isPadInput(token)) continue;
        if (typeof button !== 'string') continue;
        if (!(ALL_BUTTONS as readonly string[]).includes(button)) continue;
        valid[token] = button as GameBoyButton;
      }
      if (Object.keys(valid).length > 0) result[padId] = valid;
    }
    return result;
  } catch {
    // Private browsing, blocked storage, or corrupt JSON — defaults still work.
    return {};
  }
}

export function savePadMappings(mappings: PadMappings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings));
  } catch {
    // A remembered binding is a convenience, never a requirement.
  }
}

/* ----------------------------- the hot-path lookup ----------------------------- */

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

export function resolveMapping(mapping: PadMapping): ResolvedMapping {
  const buttons = new Int32Array(MAX_PAD_BUTTONS);
  const axisNegative = new Int32Array(MAX_PAD_AXES);
  const axisPositive = new Int32Array(MAX_PAD_AXES);

  for (const [token, button] of Object.entries(mapping)) {
    const bit = buttonBit(button);
    const asButton = BUTTON_TOKEN.exec(token);
    if (asButton) {
      const index = Number(asButton[1]);
      if (index < MAX_PAD_BUTTONS) buttons[index] = (buttons[index] ?? 0) | bit;
      continue;
    }
    const asAxis = AXIS_TOKEN.exec(token);
    if (asAxis) {
      const index = Number(asAxis[1]);
      if (index >= MAX_PAD_AXES) continue;
      if (token.endsWith('+')) axisPositive[index] = (axisPositive[index] ?? 0) | bit;
      else axisNegative[index] = (axisNegative[index] ?? 0) | bit;
    }
  }

  return { buttons, axisNegative, axisPositive };
}

/**
 * The Game Boy buttons a pad is currently pressing, as a bitmask.
 *
 * Allocation-free by construction: index loops, no destructuring (`const [x, y] = pad.axes`
 * runs the array iterator, which allocates), no closures, no `forEach`. Both lengths are
 * bounds-checked against the pad's OWN reported counts — `pad.axes` may be empty on a pad
 * with no sticks at all, and reading `[0]`/`[1]` blind is how that becomes a phantom press.
 */
export function padMask(pad: Gamepad, resolved: ResolvedMapping): number {
  let mask = 0;

  const buttons = pad.buttons;
  const buttonCount = buttons.length < MAX_PAD_BUTTONS ? buttons.length : MAX_PAD_BUTTONS;
  for (let i = 0; i < buttonCount; i++) {
    const bit = resolved.buttons[i] ?? 0;
    if (bit === 0) continue;
    if (buttons[i]?.pressed === true) mask |= bit;
  }

  const axes = pad.axes;
  const axisCount = axes.length < MAX_PAD_AXES ? axes.length : MAX_PAD_AXES;
  for (let i = 0; i < axisCount; i++) {
    const value = axes[i] ?? 0;
    if (value <= -DEADZONE) mask |= resolved.axisNegative[i] ?? 0;
    else if (value >= DEADZONE) mask |= resolved.axisPositive[i] ?? 0;
  }

  return mask;
}

/**
 * Every token a pad is holding right now, for the "press a button" capture.
 *
 * UI path, not the frame loop: it fills a caller-owned array so repeated polling from a
 * rAF loop still allocates nothing per frame.
 */
export function readPadTokens(pad: Gamepad, out: string[]): void {
  out.length = 0;

  const buttons = pad.buttons;
  for (let i = 0; i < buttons.length && i < MAX_PAD_BUTTONS; i++) {
    if (buttons[i]?.pressed === true) out.push(buttonToken(i));
  }

  const axes = pad.axes;
  for (let i = 0; i < axes.length && i < MAX_PAD_AXES; i++) {
    const value = axes[i] ?? 0;
    if (value <= -DEADZONE) out.push(axisToken(i, false));
    else if (value >= DEADZONE) out.push(axisToken(i, true));
  }
}

/**
 * The tokens offered in the binding picker, grouped for `<optgroup>`.
 *
 * Built from the pad's OWN button and axis counts rather than from a fixed list, so the
 * picker never offers an input the hardware does not have. The picker is the primary
 * control and the capture is the enhancement, for the same reason as the keyboard panel:
 * a screen-reader user cannot rely on "press a button to detect".
 */
export function bindablePadInputs(pad: {
  buttons: { length: number };
  axes: { length: number };
}): readonly { readonly group: string; readonly tokens: readonly string[] }[] {
  const buttons: string[] = [];
  const count = Math.min(pad.buttons.length, MAX_PAD_BUTTONS);
  for (let i = 0; i < count; i++) buttons.push(buttonToken(i));

  const axes: string[] = [];
  const axisCount = Math.min(pad.axes.length, MAX_PAD_AXES);
  for (let i = 0; i < axisCount; i++) {
    axes.push(axisToken(i, false));
    axes.push(axisToken(i, true));
  }

  const groups: { group: string; tokens: readonly string[] }[] = [];
  if (buttons.length > 0) groups.push({ group: 'Buttons', tokens: buttons });
  if (axes.length > 0) groups.push({ group: 'Axes', tokens: axes });
  return groups;
}
