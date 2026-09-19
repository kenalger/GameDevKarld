/**
 * Gamepad bindings — view and change.
 *
 * Three things here are not cosmetic:
 *
 *  - **A non-standard pad shows no assignments until it is mapped.** The standard index
 *    table is only meaningful when the browser reports `mapping: "standard"`; applying it
 *    to a pad reported as `""` puts buttons on the wrong actions, which is exactly the
 *    "my controller does random things" complaint. So the panel says so and asks.
 *  - **Nothing here re-renders during emulation.** The drawer pauses the game, and the
 *    live pressed indicator is rAF writing a data attribute — the same pattern as
 *    `ControlsPanel`, never React state.
 *  - **The `<select>` is the primary control and Detect is the enhancement.** "Press a
 *    button to detect" cannot work for someone who is not holding a pad, or who cannot
 *    see which row is armed; the listbox always can.
 */
export declare function GamepadPanel(): React.JSX.Element;
//# sourceMappingURL=GamepadPanel.d.ts.map