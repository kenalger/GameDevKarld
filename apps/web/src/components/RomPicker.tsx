import { useCallback, useRef, useState } from 'react';

const MAX_ROM_BYTES = 32 * 1024 * 1024; // Comfortably above any GBA cartridge.

interface Props {
  onLoad: (name: string, data: Uint8Array) => void;
  onError: (message: string) => void;
  children: React.ReactNode;
}

/**
 * Reads a ROM from the user's own device into memory.
 *
 * The bytes go File -> ArrayBuffer -> Uint8Array -> emulator and stop there. There is no
 * fetch, no upload and no third-party SDK anywhere in this path, by design and by charter.
 */
export function RomPicker({ onLoad, onError, children }: Props): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const accept = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (file.size === 0) {
        onError(`"${file.name}" is empty.`);
        return;
      }
      if (file.size > MAX_ROM_BYTES) {
        onError(
          `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB, larger than any cartridge this emulator supports.`,
        );
        return;
      }
      try {
        const buffer = await file.arrayBuffer();
        onLoad(file.name, new Uint8Array(buffer));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        onError(`Could not read "${file.name}": ${message}`);
      }
    },
    [onLoad, onError],
  );

  return (
    <div
      className="dropzone"
      data-dragging={dragging}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void accept(e.dataTransfer.files[0]);
      }}
    >
      {children}
      <input
        ref={inputRef}
        type="file"
        className="visually-hidden"
        accept=".gb,.gbc,.gba,application/octet-stream"
        onChange={(e) => {
          void accept(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        className="primary"
        onClick={() => inputRef.current?.click()}
        style={{ marginTop: 'var(--gap)' }}
      >
        Load ROM…
      </button>
    </div>
  );
}
