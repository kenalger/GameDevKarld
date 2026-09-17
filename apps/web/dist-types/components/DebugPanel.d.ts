/**
 * Developer-mode debugger.
 *
 * Mounted only when the panel is open, and it reads state through the core's read-only
 * inspection interface — it never mutates emulator internals. The live view refreshes on a
 * throttled interval rather than per frame, so watching registers does not itself cost
 * frames.
 */
export declare function DebugPanel(): React.JSX.Element;
//# sourceMappingURL=DebugPanel.d.ts.map