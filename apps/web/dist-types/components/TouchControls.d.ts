/**
 * On-screen controls for touch devices.
 *
 * Hit-testing goes through `elementFromPoint` rather than stored rectangles, which is what
 * makes sliding a thumb across the d-pad work: the control under the finger is resolved
 * fresh on every move, so Left → Up happens without lifting.
 *
 * `touch-action: none` on the surface stops the browser scrolling, zooming or rubber-banding
 * the page mid-game. `preventDefault` is scoped to this surface ONLY — the rest of the page
 * still scrolls normally.
 */
export declare function TouchControls(): React.JSX.Element;
//# sourceMappingURL=TouchControls.d.ts.map