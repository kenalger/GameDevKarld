import { useEffect, useRef, useState } from 'react';
import { ALL_BUTTONS, buttonBit, type GameBoyButton } from '@webboy/emulator';
import { session } from '../emulator/EmulatorSession.js';
import {
  BINDABLE_KEYS,
  DEFAULT_BINDINGS,
  RESERVED_CODES,
  bindKey,
  clearKey,
  describeKey,
  keysFor,
  type Bindings,
} from '../emulator/input/bindings.js';

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

/** How long a "press a key" capture waits before giving up. */
const CAPTURE_MS = 8000;

/**
 * Keyboard bindings — view and change.
 *
 * The `<select>` is the PRIMARY control and "Detect" is the enhancement, not the other way
 * round. Press-a-key capture cannot work for a screen-reader user: in NVDA's and JAWS'
 * browse mode single letters are navigation commands, intercepted before the browser sees
 * them, so our keydown never fires. A native listbox works there, works with voice
 * control, and works on a phone.
 *
 * The live pressed indicator stays on the rAF + data-attribute pattern — a held key must
 * never re-render React during emulation.
 */
export function ControlsPanel(): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [bindings, setBindings] = useState<Bindings>(() => session.getBindings());
  const [capturing, setCapturing] = useState<GameBoyButton | null>(null);
  const [status, setStatus] = useState('');

  const apply = (next: Bindings): void => {
    session.setBindings(next);
    setBindings(next);
  };

  useEffect(() => {
    let raf = 0;
    const update = (): void => {
      raf = requestAnimationFrame(update);
      const root = listRef.current;
      if (!root) return;
      const held = session.input.peek();
      for (const button of ALL_BUTTONS) {
        const element = root.querySelector<HTMLElement>(`[data-button="${button}"]`);
        if (element) element.dataset['pressed'] = String((held & buttonBit(button)) !== 0);
      }
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Capture: listen for the next key, but ignore anything already down when we started —
  // otherwise activating this button with Enter or Space instantly binds that key, and
  // Enter is the default Start binding.
  useEffect(() => {
    if (capturing === null) return;

    const heldAtStart = new Set<string>();
    let settled = false;

    const finish = (message: string): void => {
      settled = true;
      setCapturing(null);
      setStatus(message);
      session.setInputSuppressed(false);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (settled) return;
      if (event.code === 'Escape') {
        event.preventDefault();
        finish(`Cancelled. ${LABEL[capturing]} is unchanged.`);
        return;
      }
      // Tab is deliberately NOT prevented: it is the guaranteed way out of a keyboard trap.
      if (event.code === 'Tab') {
        finish(`Cancelled. ${LABEL[capturing]} is unchanged.`);
        return;
      }
      event.preventDefault();
      if (event.repeat || heldAtStart.has(event.code)) return;
      if (RESERVED_CODES.has(event.code)) {
        setStatus(`${describeKey(event.code)} cannot be bound. Press another key.`);
        return;
      }

      const { next, stolenFrom } = bindKey(bindings, capturing, event.code);
      apply(next);
      finish(
        stolenFrom
          ? `${LABEL[capturing]} is now ${describeKey(event.code)}. It was ${LABEL[stolenFrom]}, which is now unbound.`
          : `${LABEL[capturing]} is now ${describeKey(event.code)}.`,
      );
    };

    // Anything down right now belongs to the click that started this.
    const onKeyUp = (event: KeyboardEvent): void => {
      heldAtStart.delete(event.code);
    };
    for (const code of ['Enter', 'Space', 'NumpadEnter']) heldAtStart.add(code);

    session.setInputSuppressed(true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    const timer = window.setTimeout(
      () => finish(`Timed out. ${LABEL[capturing]} is unchanged.`),
      CAPTURE_MS,
    );

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.clearTimeout(timer);
      session.setInputSuppressed(false);
    };
  }, [capturing, bindings]);

  return (
    <section className="panel">
      <h3 className="panel-title">Controls</h3>

      <div className="bindings" ref={listRef}>
        {ROWS.map((button) => {
          const current = keysFor(bindings, button)[0] ?? '';
          const isCapturing = capturing === button;
          return (
            <div key={button} data-button={button} data-pressed="false">
              <dt>{LABEL[button]}</dt>
              <dd>
                {isCapturing ? (
                  <span className="capturing">Press a key… Esc cancels</span>
                ) : (
                  <select
                    aria-label={`Key for ${LABEL[button]}`}
                    value={current}
                    onChange={(event) => {
                      const code = event.target.value;
                      if (code === '') {
                        apply(clearKey(bindings, button));
                        setStatus(`${LABEL[button]} is unbound.`);
                        return;
                      }
                      const { next, stolenFrom } = bindKey(bindings, button, code);
                      apply(next);
                      setStatus(
                        stolenFrom
                          ? `${LABEL[button]} is now ${describeKey(code)}. ${LABEL[stolenFrom]} is now unbound.`
                          : `${LABEL[button]} is now ${describeKey(code)}.`,
                      );
                    }}
                  >
                    <option value="">unbound</option>
                    {BINDABLE_KEYS.map(({ group, codes }) => (
                      <optgroup key={group} label={group}>
                        {codes.map((code) => (
                          <option key={code} value={code}>
                            {describeKey(code)}
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
            apply(DEFAULT_BINDINGS);
            setStatus('All keys restored to defaults.');
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
        Keys are matched by physical position, so the mapping holds on any keyboard layout. Choose
        from the list, or press Detect and then the key you want.
      </p>
    </section>
  );
}
