# Phase 09 — UX, Mobile & Settings

**Owner:** `webboy-frontend-engineer` · **Supporting:** `gb-audio-io-engineer` (touch/gamepad input) · **Gate:** `webboy-app-qa`
**Depends on:** 05 · **Roadmap:** §14 Mobile Controls, §36 Frontend UX, §37 Privacy
**Status:** ⚠️ **Built, gate unverifiable here** — 2026-09-15. Everything in the task list is implemented: the roadmap §36 shell with tabbed panels, multi-touch on-screen controls, Gamepad API polling, fullscreen, mute, the cartridge info panel and an error boundary that offers a state export before anything resets. 8 unit tests cover the touch mapping.

> **The gate is "QA pass on phone + 3 browsers", and no browser has run this.** The Chrome extension is not connected in this environment, so nothing below has been confirmed against a real device:
> - multitouch and d-pad sliding on an actual touchscreen
> - Safari and Firefox behaviour, and every feature-detected fallback
> - no scroll/zoom/bounce during play; address-bar show/hide not resizing the canvas
> - computed contrast ratios and keyboard-only navigation
>
> What IS verified, statically against the built bundle: the privacy audit is clean (0 `XMLHttpRequest`/`sendBeacon`/`WebSocket`/analytics; the single `fetch(` is Vite's modulepreload polyfill), `pointer:coarse` gating, `touch-action`, 48px minimum touch targets, `prefers-color-scheme`, 14 `aria-label`s and a live region are all present.
>
> **A human needs to open this on a phone before the phase is signed off.**

## Goal

The app stops looking like a dev harness. Per roadmap §36 it should read as a **professional
developer/productivity application, not a childish game page** — and it must be genuinely usable on
a phone, which is a first-class target, not an afterthought.

## Tasks

**Layout & theme** — `webboy-frontend-engineer`
- [ ] Roadmap §36 shell: header + settings · display centered and dominant · transport row · tabbed
      panel (Controls / Saves / Debug / Performance), collapsible, Debug behind a developer toggle.
- [ ] Restrained dark + light themes via semantic CSS custom properties — no scattered hex codes.
      Real type scale, tabular figures on every updating number.
- [ ] Integer scaling (2×/3×/4×) + fit-to-window; 10:9 aspect preserved by default with a stretch
      option. Fullscreen API, controls overlaid in fullscreen on touch.
- [ ] ROM info panel from the Phase 02 header parser — doubles as a user-facing diagnostic.
- [ ] **The disclaimer visible in the UI** (independent project, not affiliated with Nintendo or
      The Pokémon Company, bring your own legally obtained ROMs).

**Touch** — `gb-audio-io-engineer` (behavior) + `webboy-frontend-engineer` (appearance)
- [ ] Roadmap §14 layout; **Pointer Events**, `touch-action: none` on the control surface, pointers
      tracked by `pointerId` so **multitouch works** — hold a direction *and* press A.
- [ ] Sliding between d-pad directions without lifting. Visible pressed state. Landscape layout.
- [ ] `preventDefault` on the control surface **only**, so the rest of the page still scrolls.

**Gamepad & bindings** — `gb-audio-io-engineer`
- [ ] Gamepad API is **poll-based** — read `navigator.getGamepads()` once per frame inside the loop.
      Connect/disconnect handling, axis-vs-dpad deadzone.
- [ ] Remappable bindings in LocalStorage. Three sources (keyboard/touch/gamepad) OR into one state.

**States** — `webboy-frontend-engineer`
- [ ] Every error and empty state designed: no ROM loaded (explain the file stays on-device),
      non-ROM file, corrupt/truncated ROM, bad checksum, unsupported mapper, oversized ROM,
      `.state` from another game, wrong-size `.sav`, quota exceeded, audio blocked pending gesture.
- [ ] Error boundary around the emulator surface offering Reset and a state export. **Never a blank
      screen, never a raw exception, never a silent no-op.**
- [ ] Accessibility: keyboard-only reach, visible focus, `aria-label`s, live-region status, WCAG AA
      contrast (**computed, not eyeballed**), OS font scaling, canvas text alternative.

## Exit gate — `webboy-app-qa`

- [ ] Playable on a real phone, both orientations: no scroll/zoom/bounce/text-select during play;
      multitouch confirmed; controls reachable in fullscreen; address-bar show/hide does not resize
      the canvas mid-frame.
- [ ] Chrome, Firefox **and Safari** verified, including every feature-detected fallback path
      actually exercised — not merely present.
- [ ] Every listed error state produces a specific human message. Console clean on all paths.
- [ ] Accessibility checks pass; contrast ratios computed.
- [ ] Privacy audit clean.

## Out of scope

Debugger internals and the worker (10). Scaling filters live in the display layer, never the PPU.
