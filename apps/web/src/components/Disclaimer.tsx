/**
 * Required in the UI, not only the README — see CLAUDE.md law #4 and docs/legal.md.
 *
 * One paragraph, not two. Every claim law #4 asks for is still here — no affiliation, the
 * trademarks, no ROMs supplied, you must own what you play, nothing is uploaded — but the
 * page below the device is meant to be nearly empty, and a footer is still part of the page.
 */
export function Disclaimer(): React.JSX.Element {
  return (
    <footer className="disclaimer">
      <p>
        WebBoy is an independent project, not affiliated with or endorsed by Nintendo. Game Boy,
        Game Boy Color and Game Boy Advance are trademarks of Nintendo. WebBoy supplies no ROMs —
        play only what you are legally entitled to. Your ROM is read in your browser and never
        leaves your device.
      </p>
    </footer>
  );
}
