import { session } from '../emulator/EmulatorSession.js';
import { describeKey, keysFor } from '../emulator/input/bindings.js';

/**
 * The keys, printed under the device like a legend silkscreened on a panel.
 *
 * This exists because of a real support moment: a player loaded a game, reached the first
 * text box, and reported the emulator as frozen. It was running at a perfect 60fps —
 * waiting for A, which is bound to Z, which nothing on screen said. On desktop the
 * on-screen pad is hidden, so the keyboard is the ONLY way in and the app never mentioned
 * it. Burying that in a tab below the fold is not discoverability.
 *
 * Reads the live bindings rather than hard-coding them, so it stays true after a remap.
 */

/** Display order, which is the order a player thinks in — not the hardware bit order. */
const SHOWN = [
  { button: 'a', label: 'A' },
  { button: 'b', label: 'B' },
  { button: 'start', label: 'Start' },
  { button: 'select', label: 'Select' },
] as const;

export function KeyLegend(): React.JSX.Element {
  // Bindings change only on a deliberate remap, never during emulation, so reading once
  // per render costs nothing and this component re-renders only when App does.
  const bindings = session.getBindings();

  const keyFor = (button: (typeof SHOWN)[number]['button']): string => {
    const [first] = keysFor(bindings, button);
    return first ? describeKey(first) : '—';
  };

  return (
    <dl className="keylegend" aria-label="Keyboard controls">
      <div>
        <dt>Move</dt>
        <dd aria-label="Arrow keys">↑ ↓ ← →</dd>
      </div>
      {SHOWN.map(({ button, label }) => (
        <div key={button}>
          <dt>{label}</dt>
          <dd>{keyFor(button)}</dd>
        </div>
      ))}
    </dl>
  );
}
