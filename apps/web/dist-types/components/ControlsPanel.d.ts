/**
 * Keyboard bindings — view and change.
 *
 * The `<select>` is the PRIMARY control and "Detect" is the enhancement, not the other way
 * round. Press-a-key capture cannot work for a screen-reader user: in NVDA's and JAWS'
 * browse mode single letters are navigation commands, intercepted before the browser sees
 * them, so our keydown never fires. A native listbox works there, works with voice
 * control, and works on a phone.
 *
 * The live pressed indicator stays on the rAF + data-attribute pattern — a held key must
 * never re-render React during emulation.
 */
export declare function ControlsPanel(): React.JSX.Element;
//# sourceMappingURL=ControlsPanel.d.ts.map