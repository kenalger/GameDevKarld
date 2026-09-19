import { useEffect, useRef, useState } from 'react';
import { buttonBit, type GameBoyButton } from '@webboy/emulator';
import { session } from '../emulator/EmulatorSession.js';
import type { PadInfo } from '../emulator/input/GamepadInput.js';
import {
  bindPadInput,
  bindablePadInputs,
  clearPadInput,
  describePadInput,
  padInputsFor,
  type PadMapping,
} from '../emulator/input/gamepad.js';

const LABEL: Record<GameBoyButton, string> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  a: 'A',
  b: 'B',
  start: 'Start',
  select: 'Select',
};

/** Display order a player thinks in, not the hardware bit order `ALL_BUTTONS` uses. */
const ROWS: readonly GameBoyButton[] = ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select'];

/** How long a "press a button" capture waits before giving up. Same as the keyboard's. */
const CAPTURE_MS = 8000;

/** Counts pads without building a list, for the connect check in the rAF loop. */
function countPads(): number {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return 0;
  let count = 0;
  for (const pad of navigator.getGamepads()) if (pad) count++;
  return count;
}

/**
 * Gamepad bindings — view and change.
 *
 * Three things here are not cosmetic:
 *
 *  - **A non-standard pad shows no assignments until it is mapped.** The standard index
 *    table is only meaningful when the browser reports `mapping: "standard"`; applying it
 *    to a pad reported as `""` puts buttons on the wrong actions, which is exactly the
 *    "my controller does random things" complaint. So the panel says so and asks.
 *  - **Nothing here re-renders during emulation.** The drawer pauses the game, and the
 *    live pressed indicator is rAF writing a data attribute — the same pattern as
 *    `ControlsPanel`, never React state.
 *  - **The `<select>` is the primary control and Detect is the enhancement.** "Press a
 *    button to detect" cannot work for someone who is not holding a pad, or who cannot
 *    see which row is armed; the listbox always can.
 */
export function GamepadPanel(): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [pads, setPads] = useState<PadInfo[]>(() => session.gamepad.pads());
  const [selected, setSelected] = useState(0);
  const [capturing, setCapturing] = useState<GameBoyButton | null>(null);
  const [status, setStatus] = useState('');
  /** Bumped on every mapping change, so the rows re-read what the session now holds. */
  const [revision, setRevision] = useState(0);
  /** How many pads the rendered list was built from. A ref, so the rAF loop below cannot
      re-render itself in a loop by re-reading the list it just caused. */
  const padCount = useRef(session.gamepad.pads().length);

  const pad = pads.find((entry) => entry.index === selected) ?? pads[0] ?? null;

  // Connect and disconnect are the only events the Gamepad API has, and a pad plugged in
  // while this panel is open must appear. The rAF loop below also re-checks the count,
  // because a browser that has not yet "seen" a pad fires nothing at all.
  useEffect(
    () =>
      session.gamepad.subscribe(() => {
        const list = session.gamepad.pads();
        padCount.current = list.length;
        setPads(list);
      }),
    [],
  );

  // Live pressed state. The frame loop is stopped while the drawer is open, so this reads
  // the pad directly rather than the latch — but it still only ever writes an attribute.
  useEffect(() => {
    let raf = 0;
    const update = (): void => {
      raf = requestAnimationFrame(update);

      const count = countPads();
      if (count !== padCount.current) {
        padCount.current = count;
        setPads(session.gamepad.pads());
      }

      const root = listRef.current;
      if (!root || pad === null) return;
      const held = session.gamepad.liveMask(pad.index);
      for (const button of ROWS) {
        const element = root.querySelector<HTMLElement>(`[data-button="${button}"]`);
        if (element) element.dataset['pressed'] = String((held & buttonBit(button)) !== 0);
      }
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [pad]);

  const mapping: PadMapping = pad === null ? {} : session.gamepad.mappingFor(pad.id, pad.standard);

  const apply = (next: PadMapping): void => {
    if (pad === null) return;
    session.setPadMapping(pad.id, next);
    setRevision((value) => value + 1);
  };

  // Capture. Poll-based, because the Gamepad API is: there is no "button pressed" event to
  // listen for. Anything already held when capture starts is ignored, so arming a row with
  // a thumb resting on the stick does not instantly bind that direction.
  useEffect(() => {
    if (capturing === null || pad === null) return;

    const heldAtStart = new Set<string>();
    const tokens: string[] = [];
    let primed = false;
    let raf = 0;
    let settled = false;

    const finish = (message: string): void => {
      if (settled) return;
      settled = true;
      setCapturing(null);
      setStatus(message);
    };

    const scan = (): void => {
      raf = requestAnimationFrame(scan);
      session.gamepad.readTokens(pad.index, tokens);

      if (!primed) {
        for (const token of tokens) heldAtStart.add(token);
        primed = true;
        return;
      }
      // Anything held at the start is only forgotten once it is actually released.
      for (const token of heldAtStart) {
        if (!tokens.includes(token)) heldAtStart.delete(token);
      }

      for (const token of tokens) {
        if (heldAtStart.has(token)) continue;
        const { next, stolenFrom } = bindPadInput(mapping, capturing, token);
        apply(next);
        finish(
          stolenFrom
            ? `${LABEL[capturing]} is now ${describePadInput(token, pad.standard)}. It was ${LABEL[stolenFrom]}, which is now unbound.`
            : `${LABEL[capturing]} is now ${describePadInput(token, pad.standard)}.`,
        );
        return;
      }
    };

    // Escape cancels, as it does in the keyboard capture. preventDefault so the drawer
    // does not also close.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finish(`Cancelled. ${LABEL[capturing]} is unchanged.`);
    };

    session.setInputSuppressed(true);
    window.addEventListener('keydown', onKeyDown, true);
    raf = requestAnimationFrame(scan);
    const timer = window.setTimeout(
      () => finish(`Timed out. ${LABEL[capturing]} is unchanged.`),
      CAPTURE_MS,
    );

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown, true);
      session.setInputSuppressed(false);
    };
    // `revision` is in here so a bind made through the picker mid-capture is not overwritten
    // by a stale `mapping` closure.
  }, [capturing, pad, revision]);

  if (pad === null) {
    return (
      <section className="panel">
        <h3 className="panel-title">Gamepad</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          No gamepad is connected. Plug one in and press a button — browsers do not report a
          controller until it is used, so nothing appears here before that first press.
        </p>
      </section>
    );
  }

  const choices = bindablePadInputs(
    session.gamepad.padAt(pad.index) ?? { buttons: { length: 0 }, axes: { length: 0 } },
  );

  return (
    <section className="panel">
      <h3 className="panel-title">Gamepad</h3>

      {pads.length > 1 && (
        <p className="hint" style={{ marginTop: 0 }}>
          <label htmlFor="pad-choice">Configuring </label>
          <select
            id="pad-choice"
            value={pad.index}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {pads.map((entry) => (
              <option key={entry.index} value={entry.index}>
                {entry.index + 1}. {entry.id}
              </option>
            ))}
          </select>
        </p>
      )}

      <p className="hint" style={{ marginTop: 0 }} role="status">
        Connected: <b>{pad.id}</b> — layout reported as{' '}
        <b>{pad.mapping === '' ? 'unknown' : pad.mapping}</b>, {pad.buttonCount} buttons,{' '}
        {pad.axisCount} axes.
        {pad.customised ? ' Using your own mapping.' : ''}
      </p>

      {!pad.standard && !pad.mapped && (
        <p className="hint" style={{ marginTop: 0 }}>
          This controller does not report the standard layout, so its button numbers mean nothing to
          us and nothing has been assumed — it will not do anything until you map it below. Applying
          the standard table anyway is how buttons end up on the wrong actions.
        </p>
      )}

      <div className="bindings" ref={listRef}>
        {ROWS.map((button) => {
          const current = padInputsFor(mapping, button)[0] ?? '';
          const isCapturing = capturing === button;
          return (
            <div key={button} data-button={button} data-pressed="false">
              <dt>{LABEL[button]}</dt>
              <dd>
                {isCapturing ? (
                  <span className="capturing">Press a button… Esc cancels</span>
                ) : (
                  <select
                    aria-label={`Gamepad input for ${LABEL[button]}`}
                    value={current}
                    onChange={(event) => {
                      const token = event.target.value;
                      if (token === '') {
                        apply(clearPadInput(mapping, button));
                        setStatus(`${LABEL[button]} is unbound.`);
                        return;
                      }
                      const { next, stolenFrom } = bindPadInput(mapping, button, token);
                      apply(next);
                      setStatus(
                        stolenFrom
                          ? `${LABEL[button]} is now ${describePadInput(token, pad.standard)}. ${LABEL[stolenFrom]} is now unbound.`
                          : `${LABEL[button]} is now ${describePadInput(token, pad.standard)}.`,
                      );
                    }}
                  >
                    <option value="">unbound</option>
                    {choices.map(({ group, tokens }) => (
                      <optgroup key={group} label={group}>
                        {tokens.map((token) => (
                          <option key={token} value={token}>
                            {describePadInput(token, pad.standard)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="detect"
                  aria-pressed={isCapturing}
                  onClick={() => setCapturing(isCapturing ? null : button)}
                >
                  {isCapturing ? 'Cancel' : 'Detect'}
                </button>
              </dd>
            </div>
          );
        })}
      </div>

      <div className="transport" style={{ justifyContent: 'flex-start', marginTop: 'var(--gap)' }}>
        <button
          type="button"
          onClick={() => {
            session.resetPadMapping(pad.id);
            setRevision((value) => value + 1);
            setStatus(
              pad.standard
                ? 'Restored the standard layout defaults.'
                : 'Cleared. This controller has no default, so it is unmapped again.',
            );
          }}
        >
          Restore defaults
        </button>
      </div>

      {/* Present from first render: a live region inserted at the same moment its content
          appears is not reliably announced. */}
      <p className="hint" role="status">
        {status}
      </p>

      <p className="hint">
        Choose an input from the list, or press Detect and then the button you want. Mappings are
        remembered per controller on this device. The left stick doubles as a d-pad on a standard
        controller; rebinding a direction replaces that, and Restore defaults brings it back.
      </p>
    </section>
  );
}
