# Phase 05 — Input → 🏁 FIRST PLAYABLE (M3)

**Owner:** `gb-audio-io-engineer` · **Supporting:** `webboy-frontend-engineer` (transport UI) · **Gate:** `emu-accuracy-tester` + `webboy-app-qa`
**Depends on:** 04 · **Roadmap:** §13 Input, §23 First Milestone
**Status:** ✅ Gate met (with one caveat) — 2026-09-15. Joypad register, input latch, keyboard layer and transport are in. 6 end-to-end tests against the `tellinglys` homebrew cover render, input response, determinism, reset and pause/resume. All Phase 01–04 gates green.

> **Caveat — the one gate item not verified:** "playable start to finish by a human in Chrome". The Claude in Chrome extension is not connected in this environment, so no real browser drove the app. Everything else is verified headlessly and the built bundle was served and audited. **A human should play it once before this milestone is considered signed off.**

## Goal

**The project's first definition of success.** A legal homebrew/test ROM loads from the user's device
and is *played* in a browser: renders, responds, keeps time, resets, pauses.

Per roadmap §23 this milestone is deliberately **not Pokémon**. Commercial compatibility is not
evaluated until after this gate.

## Tasks

**Hardware side** — `gb-audio-io-engineer`
- [ ] Joypad register `FF00`: **inverted and multiplexed** — select the direction or action row via
      bits 4/5, read bits 0–3 where **0 = pressed**. Unselected rows read 1s.
- [ ] Joypad interrupt on a high-to-low transition of a selected line.
- [ ] **Input latch.** DOM events write to a latch; the emulator samples it at a defined point.
      Never mutate emulator state from an event handler — events are async to emulated time, so a
      fast tap between frames is otherwise lost or double-counted.

**Browser side** — `gb-audio-io-engineer`
- [ ] Keyboard: Arrows, `Z`=A, `X`=B, `Enter`=Start, `Shift`=Select. **Use `event.code`, not
      `event.key`** — `key` shifts with layout and modifiers, which silently breaks the Shift mapping.
- [ ] `preventDefault()` on **mapped keys only**, so browser and assistive-tech shortcuts survive.
- [ ] Release all buttons on `blur` and `visibilitychange`, or the player returns to a held d-pad.
- [ ] Mapping layer separate from the event source, so touch and gamepad can OR in during 09.

**Transport** — `webboy-frontend-engineer`
- [ ] Load ROM / Pause / Resume / Reset wired to `EmulatorManager`, with honest status display.
- [ ] Pause halts emulation *and* the rAF loop; reset restores post-boot state deterministically.

## Exit gate — `emu-accuracy-tester` + `webboy-app-qa`

- [ ] A legal homebrew ROM is **playable start to finish by a human** in Chrome.
- [ ] All Phase 01–04 gates still green (no regressions introduced by the input path).
- [ ] Reset produces a byte-identical state to a fresh load; pause/resume loses no time.
- [ ] Buttons do not stick after focus loss, tab switch, or fullscreen toggle.
- [ ] Zero network requests during a full play session (`webboy-app-qa`, network log).
- [ ] **🏁 M3. Tag the release.** Commercial ROM testing may begin *after* this.

## Fetch before implementing

https://gbdev.io/pandocs/ Joypad Input · MDN KeyboardEvent.code.

## Out of scope

Touch controls and gamepad (09). Audio (07) — silence is expected and fine here.
