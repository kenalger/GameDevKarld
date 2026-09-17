/**
 * Battery-save controls.
 *
 * Saves are written automatically; these are for moving them between emulators and
 * machines. The `.sav` layout is the common one (raw SRAM, plus a 48-byte RTC tail for
 * clock cartridges), so files interoperate rather than being WebBoy-only.
 */
export declare function SavesPanel({ restored }: {
    restored: boolean;
}): React.JSX.Element;
//# sourceMappingURL=SavesPanel.d.ts.map