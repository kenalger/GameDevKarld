import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { readStateHeader, STATE_VERSION } from '@webboy/emulator';
import { session } from '../emulator/EmulatorSession.js';
import { downloadBytes } from '../util/download.js';
import { SLOT_COUNT, type StateSlot } from '../storage/StateStore.js';

/** The slot the transport row's Save State / Load State buttons use. */
const QUICK_SLOT = 0;

/**
 * True when a stored state cannot be loaded by this build.
 *
 * Checked when the list is drawn rather than when Load is clicked, so a state written by
 * an older format says so in place instead of looking available and then failing. The
 * check reads six bytes of header; it does not parse the state.
 */
function isStale(slot: StateSlot): boolean {
  const header = readStateHeader(slot.data);
  return header === null || header.version !== STATE_VERSION;
}

/**
 * Save-state slots.
 *
 * A thumbnail is captured at save time, because "slot 3" tells you nothing a month later
 * and a picture of where you were tells you everything.
 */
export function StatesPanel(): React.JSX.Element {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [slots, setSlots] = useState<(StateSlot | null)[]>(() => new Array(SLOT_COUNT).fill(null));
  const importRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    void session.listStateSlots().then(setSlots);
  }, []);

  // Also on statesRevision, so a save made from the transport row while this panel is
  // open appears immediately. Before, the list was read once on mount and a quick-save
  // left no visible trace until the tab was switched away and back.
  useEffect(refresh, [refresh, snapshot.statesRevision]);

  const handleSave = async (slot: number): Promise<void> => {
    await session.saveStateToSlot(slot);
    refresh();
  };

  const handleExport = (): void => {
    const state = session.exportState();
    if (state) downloadBytes(state.data, state.filename);
  };

  const staleCount = slots.filter((slot) => slot !== null && isStale(slot)).length;

  return (
    <section className="panel">
      <h3 className="panel-title">Save states</h3>

      <p className="hint">
        {SLOT_COUNT} slots, kept on this device and tied to this cartridge. <strong>Slot 1</strong>{' '}
        is the quick slot — the Save State and Load State buttons on the control bar write and read
        it.
      </p>

      {staleCount > 0 && (
        <p className="hint" role="status">
          {staleCount === 1 ? 'One slot was' : `${staleCount} slots were`} written by an earlier
          version of WebBoy and cannot be loaded. Saving over {staleCount === 1 ? 'it' : 'them'}{' '}
          clears the warning.
        </p>
      )}

      <ul className="slots">
        {slots.map((slot, index) => {
          const stale = slot !== null && isStale(slot);
          return (
            <li key={index}>
              {slot?.thumbnail ? (
                <img
                  src={slot.thumbnail}
                  alt={`Slot ${index + 1} preview`}
                  className="slot-thumb"
                />
              ) : (
                <div className="slot-thumb slot-thumb--empty" aria-hidden="true" />
              )}
              <span className="slot-label">
                Slot {index + 1}
                {index === QUICK_SLOT && <span className="slot-tag">quick</span>}
                <small>
                  {stale
                    ? 'older format — cannot be loaded'
                    : slot
                      ? new Date(slot.savedAt).toLocaleString()
                      : 'empty'}
                </small>
              </span>
              <span className="slot-actions">
                <button type="button" onClick={() => void handleSave(index)}>
                  Save
                </button>
                <button
                  type="button"
                  disabled={!slot || stale}
                  title={stale ? 'Written by an earlier version of WebBoy' : undefined}
                  onClick={() => void session.loadStateFromSlot(index)}
                >
                  Load
                </button>
              </span>
            </li>
          );
        })}
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
