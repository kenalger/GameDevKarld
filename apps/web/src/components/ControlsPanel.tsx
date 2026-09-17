import { useEffect, useRef } from 'react';
import { ALL_BUTTONS, buttonBit, type GameBoyButton } from '@webboy/emulator';
import { session } from '../emulator/EmulatorSession.js';
import { describeKey, keysFor } from '../emulator/input/bindings.js';

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

/**
 * Keyboard reference, with a live pressed indicator.
 *
 * The indicator is driven by a 60Hz rAF loop writing `data-` attributes directly. It is
 * deliberately NOT React state — a held button would otherwise re-render the tree every
 * frame, which is exactly the regression the charter forbids.
 */
export function ControlsPanel(): React.JSX.Element {
  const listRef = useRef<HTMLDListElement>(null);
  const bindings = session.getBindings();

  useEffect(() => {
    let raf = 0;
    const update = (): void => {
      raf = requestAnimationFrame(update);
      const root = listRef.current;
      if (!root) return;
      const held = session.input.peek();
      for (const button of ALL_BUTTONS) {
        const el = root.querySelector<HTMLElement>(`[data-button="${button}"]`);
        if (el) el.dataset['pressed'] = String((held & buttonBit(button)) !== 0);
      }
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <section className="panel">
      <h2 className="panel-title">Controls</h2>
      <dl className="bindings" ref={listRef}>
        {ALL_BUTTONS.map((button) => {
          const keys = keysFor(bindings, button);
          return (
            <div key={button} data-button={button} data-pressed="false">
              <dt>{LABEL[button]}</dt>
              <dd>{keys.map(describeKey).join(' / ') || 'unbound'}</dd>
            </div>
          );
        })}
      </dl>
      <p className="hint">
        Keys are matched by physical position, so the mapping holds on any keyboard layout.
      </p>
    </section>
  );
}
