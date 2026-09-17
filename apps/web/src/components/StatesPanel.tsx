import { useCallback, useEffect, useRef, useState } from 'react';
import { session } from '../emulator/EmulatorSession.js';
import { SLOT_COUNT, type StateSlot } from '../storage/StateStore.js';

/**
 * Save-state slots.
 *
 * A thumbnail is captured at save time, because "slot 3" tells you nothing a month later
 * and a picture of where you were tells you everything.
 */
export function StatesPanel(): React.JSX.Element {
  const [slots, setSlots] = useState<(StateSlot | null)[]>(() => new Array(SLOT_COUNT).fill(null));
  const importRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    void session.listStateSlots().then(setSlots);
  }, []);

  useEffect(refresh, [refresh]);

  const handleSave = async (slot: number): Promise<void> => {
    await session.saveStateToSlot(slot);
    refresh();
  };

  const handleExport = (): void => {
    const state = session.exportState();
    if (!state) return;
    const bytes = new Uint8Array(state.data.length);
    bytes.set(state.data);
    const url = URL.createObjectURL(
      new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = state.filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="panel">
      <h2 className="panel-title">Save states</h2>
      <ul className="slots">
        {slots.map((slot, index) => (
          <li key={index}>
            {slot?.thumbnail ? (
              <img src={slot.thumbnail} alt={`Slot ${index + 1} preview`} className="slot-thumb" />
            ) : (
              <div className="slot-thumb slot-thumb--empty" aria-hidden="true" />
            )}
            <span className="slot-label">
              Slot {index + 1}
              <small>{slot ? new Date(slot.savedAt).toLocaleString() : 'empty'}</small>
            </span>
            <span className="slot-actions">
              <button type="button" onClick={() => void handleSave(index)}>
                Save
              </button>
              <button
                type="button"
                disabled={!slot}
                onClick={() => void session.loadStateFromSlot(index)}
              >
                Load
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="transport" style={{ marginTop: 'var(--gap)' }}>
        <button type="button" onClick={handleExport}>
          Export .state
        </button>
        <button type="button" onClick={() => importRef.current?.click()}>
          Import .state…
        </button>
        <input
          ref={importRef}
          type="file"
          className="visually-hidden"
          accept=".state,application/octet-stream"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void file.arrayBuffer().then((b) => session.importState(new Uint8Array(b)));
          }}
        />
      </div>
    </section>
  );
}
