/**
 * Required in the UI, not only the README — see CLAUDE.md law #4 and docs/legal.md.
 */
export function Disclaimer(): React.JSX.Element {
  return (
    <footer className="disclaimer">
      <p>
        WebBoy is an independent project and is not affiliated with, endorsed by, or sponsored by
        Nintendo or The Pokémon Company. Game Boy, Game Boy Color and Game Boy Advance are
        trademarks of Nintendo.
      </p>
      <p>
        WebBoy does not supply, host or link to game ROMs. You must provide software you are legally
        entitled to use. Your ROM is read in your browser and stays on your device — it is never
        uploaded.
      </p>
    </footer>
  );
}
