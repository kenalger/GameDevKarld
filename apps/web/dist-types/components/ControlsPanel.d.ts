/**
 * Keyboard reference, with a live pressed indicator.
 *
 * The indicator is driven by a 60Hz rAF loop writing `data-` attributes directly. It is
 * deliberately NOT React state — a held button would otherwise re-render the tree every
 * frame, which is exactly the regression the charter forbids.
 */
export declare function ControlsPanel(): React.JSX.Element;
//# sourceMappingURL=ControlsPanel.d.ts.map