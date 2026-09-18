/**
 * Cheat codes, typed in by the player.
 *
 * WebBoy ships no cheat database and looks nothing up. A remote lookup would have to send
 * an identifier derived from the loaded ROM, which is exactly the kind of quiet
 * exfiltration the privacy rule exists to prevent — so the only way a code gets here is
 * that someone typed it.
 *
 * Format detection is automatic because on Game Boy the shapes are disjoint: 9 or 6
 * characters means Game Genie, 8 means GameShark. There is no decision to delegate.
 */
export declare function CheatsPanel(): React.JSX.Element;
//# sourceMappingURL=CheatsPanel.d.ts.map