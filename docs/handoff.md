# Handoff

Current state, open decisions, and what to pick up next. Updated 2026-09-18.

`docs/plan/` says what to build and in what order. This file says **where things actually are
right now** — including the things that are wrong.

---

## State

| | |
|---|---|
| Branch | `main`, working tree clean |
| Tip | `f70fc4c` |
| **Unpushed** | **17 commits. `origin/main` is still at `Plan`.** |
| Source | ~14,200 lines, excluding tests |
| Tests | 940 passing, 1 skipped |
| Performance | 20.7x realtime, p99 frame time 0.92ms (5.5% of budget) |

Everything green: `npm test`, `typecheck`, `lint` (0 errors, 30 pre-existing `no-console`
warnings in scripts), `prettier --check`, `build`.

### Accuracy corpus — `npm run compat`

| Suite | Result |
|---|---|
| SingleStepTests/sm83 | **500,000 / 500,000** (100%) |
| Blargg cpu_instrs + timing | 18 / 19 — `halt_bug` times out |
| Blargg sound (DMG + CGB) | 19 / 24 |
| Mooneye acceptance | **60 / 66 applicable** (9 skipped: they target DMG0/MGB/SGB) |
| dmg-acid2, cgb-acid2 | **pixel-exact** |
| cgb-acid-hell | 2 / 23040 pixels differ (x=80, y=68–69) |
| Mealybug Tearoom | **0 / 24** — reported, not gated |
| jsmolka gba-tests | **7 / 7** |

---

## Decisions waiting on the owner

These block work that is otherwise ready to start.

### 1. The licence — blocking

There is **no `LICENSE` file and no `license` field in `package.json`**, so the project is "all
rights reserved" by default, and it has a GitHub remote. Until this is set, "may we incorporate
X" is unanswerable.

Relevant for the cheat work: SameBoy is MIT (the only reference we could borrow from), mGBA is
MPL-2.0 (file-level copyleft), Gambatte and VBA-M are GPL-2.0 (would force WebBoy to GPL). We can
implement everything from Pan Docs and GBATEK without touching any of them — that is the clean
path regardless — but the repo should still declare a licence.

### 2. The A/B keyboard defaults are inverted

On hardware **B is the left face button and A is the right one**. We map `KeyZ → a`, `KeyX → b`,
so the left-hand key drives the right-hand button.

Verified from source: mGBA, SameBoy and RetroArch all use `X → A, Z → B`. EmulatorJS matches us.
The native convention preserves the physical relationship and generalises to the GBA diamond in
Phase 12–15, so keeping `Z → A` means migrating users twice.

Proposed migration, if changed: if the stored bindings exactly equal the old defaults the user
never customised, so upgrade silently; otherwise keep their mapping and show a dismissible note.
This is muscle memory, so it is the owner's call.

### 3. Order of work — cheats or keyboard first

Both are researched and ready. Recommendation is keyboard first: smaller, fixes a WCAG Level A
gap, and the storage layer already exists.

---

## Known bugs and gaps

Ordered by how likely they are to bite.

- **Mealybug 0/24 — mid-scanline register effects.** Register writes landing *during* mode 3
  (LCDC, BGP, the window). Two hypotheses are already **disproved and recorded** in
  `docs/plan/phase-04-ppu.md`: it is not mode 3's length (now exactly 172 dots, verified) and it
  is not the CPU write phase (`ACCESS_T_OFFSET` re-swept: 60/59/59/59, Mealybug unmoved at every
  setting). Do not re-test either. What is missing is the per-dot effect of a write on a fetch
  already in flight.
- **Five Mooneye `ppu/*` tests** — `hblank_ly_scx_timing`, `intr_2_mode0_timing_sprites`,
  `lcdon_timing`, `lcdon_write_timing`, `vblank_stat_intr`. Same gap as above, seen from the
  other side.
- **Blargg sound 19/24 — wave RAM.** Recorded debt after five attempts; see
  `docs/plan/phase-07-audio.md`. The gap is *phase*, not window width, and needs per-cycle
  wave-unit modelling rather than more tuning.
- **`halt_bug`** times out at 2500 frames.
- **`cgb-acid-hell`** off by 2 pixels.
- **EEPROM backup** detected but unimplemented — no test ROM in the corpus covers it.
- **GBA cheats** need TEA decryption plus a CPU breakpoint hook. The `DEADFACE` reseed depends on
  translation tables published nowhere except inside mGBA, so it is a licensing decision.

### Process defects worth fixing

- `docs/testing.md` and `tests/scoreboard.md` both tell you to run `npm run screenshots`.
  **That script does not exist** — use `npx vite-node scripts/run-screenshots.ts`.
- `scripts/generate-scoreboard.ts` always exits 0, so the scoreboard is a human-reviewed diff,
  not a gate. CI runs only `lint`, `typecheck`, `test`, `build` and the `no-roms` job, so the
  only automated regression gate a PR hits is `npm test`. Corpus tests must live in `tests/unit/`
  to be enforced.

---

## Blocked

**Phases 09 and 10 cannot be signed off.** They need a real browser: cross-browser behaviour, a
phone, the 10-minute audio underrun run. The Chrome extension is not connected in this
environment, and this sandbox cannot reach a localhost server either — so the design adoption
(`93c65cb`) is **verified structurally but nobody has looked at the rendered page**. That is
stated in the commit message and in `mock/README.md` rather than being quietly assumed.

---

## Recently landed

- **`f70fc4c` — four silent input bugs.** Bound keys stolen from every text field; one source's
  release clearing a button another source held; macOS leaving a key stuck whenever Command was
  tapped; a pad button held across a pause staying dead. None threw, so none were visible.
- **`db9ab59` — the game was dead after a tab switch.** Hiding the tab suspended the AudioContext
  with nothing to resume it, and paused the emulator with nothing to un-pause it. Returning now
  resumes automatically, but only if *we* paused — a manual pause is left alone.
- **`64ed1ff` — mode 3 is 172 dots, not 175.** Two independent causes; Mooneye 57 → 60.
- **`93c65cb` — the instrument UI direction**, adopted from `mock/`.

---

## Research done, not yet built

Five specialist reports are complete. Their conclusions, condensed — the detail is in the
transcript, not in this repo.

**Cheats.** Ship GB/GBC only: Game Genie (9- and 6-char) and GameShark types `01`/`9b`, typed in
by the user, auto-detected by shape, **patched on read — never by mutating the ROM image**.

> That last point is load-bearing. `saveKey` is `title:globalChecksum:romLength` and the checksum
> sums every ROM byte; it is the IndexedDB key for both battery saves and every save-state slot,
> and `BaseCartridge.load` keeps the caller's array **by reference**. Patching the ROM in place
> would change the save key and the player's save would appear to vanish.

Hook goes in `Mmu.readDirect()` — shared by OAM DMA and HDMA, so a DMA sourcing from ROM sees
patched bytes, which is what the hardware does. Benchmarked design: one integer guard, then a 4 KB
bitset, then a short scan on a hit — **+0.06 ns/read with no cheats active**. A linear scan was
the worst option measured, and `Map.get` 35% worse than the bitset.

Performance guard should be an **exact counter** (zero comparisons when empty), not a timing
assertion — the noise floor of an A/B wall-clock test was measured at ±10% per pair.

Never build a remote cheat lookup: it would send a fingerprint of the user's ROM.

**Controller settings.** Rewrite `ControlsPanel` in place — it already owns the Controls tab, no
new tab needed. The primary control must be a native `<select>`, with "Detect" as an enhancement:
under a screen reader in browse mode, single letters are navigation commands and never reach our
handler, so press-any-key capture *cannot* work for those users. Watch the activating-key trap —
capture starts on Enter or Space, and Enter is the default Start binding.

---

## Suggested next steps

1. **Push.** 17 commits exist only on this machine. Note the history is a retrospective import —
   intermediate commits are not individually buildable, only the tip is. Squashing before the
   first public push is easier now than later.
2. **Settle the licence and the A/B default** — both block or shape work that is otherwise ready.
3. **Keyboard remapping**, in this order: `InputLatch` is already done; then `bindings.ts` v2 with
   the migration (highest risk to user data, so it lands with tests before any UI), then the
   capture flow, then the panel.
4. **Cheats**, once the licence is settled.
5. **Mid-scanline PPU effects** — the largest remaining accuracy gap, and the one with the most
   diagnosis already banked.
