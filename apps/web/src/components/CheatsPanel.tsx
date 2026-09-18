import { useEffect, useState } from 'react';
import { decodeCheat } from '@webboy/emulator';
import { session } from '../emulator/EmulatorSession.js';
import type { StoredCheat } from '../storage/CheatStore.js';

/** The detected format, shown live beside the field as confirmation the parse worked. */
function detectFormat(code: string): string {
  if (code.trim() === '') return '—';
  try {
    return decodeCheat(code).format === 'game-genie' ? 'Game Genie' : 'GameShark';
  } catch {
    return '—';
  }
}

/**
 * Cheat codes, typed in by the player.
 *
 * WebBoy ships no cheat database and looks nothing up. A remote lookup would have to send
 * an identifier derived from the loaded ROM, which is exactly the kind of quiet
 * exfiltration the privacy rule exists to prevent — so the only way a code gets here is
 * that someone typed it.
 *
 * Format detection is automatic because on Game Boy the shapes are disjoint: 9 or 6
 * characters means Game Genie, 8 means GameShark. There is no decision to delegate.
 */
export function CheatsPanel(): React.JSX.Element {
  const [cheats, setCheats] = useState<readonly StoredCheat[]>(() => session.listCheats());
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Codes are restored asynchronously when a cartridge loads, so pick them up on mount.
  useEffect(() => {
    setCheats(session.listCheats());
  }, []);

  const refresh = (): void => setCheats([...session.listCheats()]);

  const handleAdd = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const message = await session.addCheat(code, label);
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    setCode('');
    setLabel('');
    refresh();
  };

  return (
    <section className="panel">
      <h3 className="panel-title">Cheats</h3>

      {cheats.length === 0 ? (
        <p className="empty-state">
          <strong>No codes for this cartridge</strong>
          Type a Game Genie or GameShark code below. Codes are saved with this game and stay on your
          device.
        </p>
      ) : (
        <ul className="slots">
          {cheats.map((cheat) => (
            <li key={cheat.id}>
              <input
                type="checkbox"
                id={`cheat-${cheat.id}`}
                checked={cheat.enabled}
                onChange={(event) => {
                  void session.setCheatEnabled(cheat.id, event.target.checked).then(refresh);
                }}
              />
              <span className="slot-label">
                <label htmlFor={`cheat-${cheat.id}`}>{cheat.label}</label>
                <small>
                  {detectFormat(cheat.code)} · {cheat.code}
                </small>
              </span>
              <span className="slot-actions">
                <button
                  type="button"
                  aria-label={`Delete ${cheat.label}`}
                  onClick={() => void session.removeCheat(cheat.id).then(refresh)}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={(event) => void handleAdd(event)} noValidate>
        <h4 className="panel-title" style={{ marginTop: 'var(--gap)' }}>
          Add a code
        </h4>

        <div className="cheat-form">
          <label htmlFor="cheat-code">Code</label>
          <input
            id="cheat-code"
            type="text"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              setError(null);
            }}
            placeholder="ABC-DEF-GHI"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            aria-describedby="cheat-code-format"
            aria-invalid={error !== null}
          />
          <span id="cheat-code-format" className="hint">
            Format <strong>{detectFormat(code)}</strong>
          </span>

          <label htmlFor="cheat-label">Name</label>
          <input
            id="cheat-label"
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Infinite HP"
            autoComplete="off"
          />

          <button type="submit" className="primary">
            Add code
          </button>
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>

      <p className="hint">
        Game Genie codes look like <code>ABC-DEF-GHI</code> or <code>ABC-DEF</code>; GameShark codes
        are 8 hex characters. WebBoy does not supply cheat codes and never looks any up online.
      </p>
    </section>
  );
}
