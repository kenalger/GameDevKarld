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
export declare function RomPicker({ onLoad, onError, children }: Props): React.JSX.Element;
export {};
//# sourceMappingURL=RomPicker.d.ts.map