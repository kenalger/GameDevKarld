# Legal & Distribution

## What this project is

WebBoy is an independent emulator. The **emulator** is the software being developed; **users supply
their own ROMs** from their own devices.

WebBoy is not affiliated with, endorsed by, or sponsored by Nintendo or The Pokémon Company. Game
Boy, Game Boy Color, Game Boy Advance and Pokémon are trademarks of their respective owners.

## Hard rules

This repository does **not**, and must never:

- Bundle, host, mirror, or link to commercial game ROMs.
- Commit ROM data in any form — including as a test fixture, a base64 blob, or a binary in git
  history. `.gitignore` blocks `*.gb`/`*.gbc`/`*.gba`/`*.sav`/`*.state`, and the `no-roms` CI job
  fails the build if any is tracked.
- Bundle copyrighted game sprites, music, maps, logos, or characters, or use them as branding.
- Present itself as an official Nintendo, Game Boy, or Pokémon product.

Instead: the user selects a ROM from their own device, it is processed locally in the browser, and it
is never uploaded. Development and testing use freely redistributable homebrew test ROMs (see
`docs/testing.md`).

## Privacy

**Your ROM stays on your device.** No upload, no account, no backend, no analytics, no third-party
SDK. `webboy-app-qa` verifies this empirically against the running app — a network log, not a code
read — every release.

## Third-party code

Reading another emulator's source to understand hardware behavior is fine and normal. **Copying its
code without reviewing the license is not.** Every dependency and any borrowed implementation must
have its license checked and recorded before use.

## Compatibility targets

The games named in `GameDevKarld(1).md` §45 are **compatibility targets** — a statement of what the
emulator should eventually be technically capable of running, with ROMs the user legally supplies.
They are not files to distribute, and nothing about them is bundled here.
