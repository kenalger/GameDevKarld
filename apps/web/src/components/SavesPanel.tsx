import { useRef, useState } from 'react';
import { session } from '../emulator/EmulatorSession.js';

/**
 * Battery-save controls.
 *
 * Saves are written automatically; these are for moving them between emulators and
 * machines. The `.sav` layout is the common one (raw SRAM, plus a 48-byte RTC tail for
 * clock cartridges), so files interoperate rather than being WebBoy-only.
 */
export function SavesPanel({ restored }: { restored: boolean }): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  const handleExport = (): void => {
    const save = session.exportSave();
    if (!save) {
      setNote('This cartridge has no battery, so there is nothing to export.');
      return;
    }
    // Copy into a plain ArrayBuffer: the emulator's view may be backed by a shared buffer
    // once the core moves to a Web Worker in Phase 10.
    const bytes = new Uint8Array(save.data.length);
    bytes.set(save.data);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = save.filename;
    link.click();
    URL.revokeObjectURL(url);
    setNote(`Exported ${save.filename} (${save.data.length} bytes).`);
  };

  const handleImport = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      session.importSave(new Uint8Array(buffer));
      setNote(`Imported ${file.name}. Reset the game to load it.`);
    } catch (cause) {
      setNote(
        `Could not read ${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  return (
    <section className="panel">
      <h2 className="panel-title">Saves</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        {restored
          ? 'Your saved game was restored. Progress is written automatically.'
          : 'Progress is written automatically for cartridges with a battery.'}
      </p>
      <div className="transport">
        <button type="button" onClick={() => session.flushSave()}>
          Save now
        </button>
        <button type="button" onClick={handleExport}>
          Export .sav
        </button>
        <button type="button" onClick={() => inputRef.current?.click()}>
          Import .sav…
        </button>
        <input
          ref={inputRef}
          type="file"
          className="visually-hidden"
          accept=".sav,application/octet-stream"
          onChange={(e) => {
            void handleImport(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {note && (
        <p className="hint" aria-live="polite">
          {note}
        </p>
      )}
    </section>
  );
}
