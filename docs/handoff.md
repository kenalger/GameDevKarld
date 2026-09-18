# Handoff

Current state, open decisions, and what to pick up next. Updated 2026-09-18.

`docs/plan/` says what to build and in what order. This file says **where things actually are right
now** — including the things that are wrong.

---

## State

| | |
|---|---|
| Branch | `main`, working tree clean |
| Pushed | **yes** — `origin/main` is at the tip. History kept unsquashed, see below. |
| Licence | **MIT** — `LICENSE` and all three `package.json` files |
| Deployed | **no.** The build is ready and `docs/deploy.md` is written; nobody has run it. |
| Source | 16,364 lines of `.ts`/`.tsx`, excluding tests |
| Tests | 992 passing, 1 skipped |
| Build | 11 files, 496 KB (`apps/web/dist`); JS 397 KB, 120 KB gzipped |
| Performance | ~20x realtime, p99 well under budget |

Everything green: `npm test`, `typecheck`, `lint` (0 errors, 30 pre-existing `no-console`
warnings in scripts), `prettier --check`, `build`.

### Accuracy corpus — `npm run compat`

Re-run and confirmed 2026-09-18. These are measurements, not recollections.

| Suite | Result |
|---|---|
| SingleStepTests/sm83 | **500,000 / 500,000** (100%) across 500 opcodes |
| Blargg cpu_instrs + timing | 18 / 19 — `halt_bug` times out |
| Blargg sound (DMG + CGB) | 19 / 24 |
| Mooneye acceptance | **60 / 66 applicable** (9 skipped: they target DMG0/MGB/SGB) |
| dmg-acid2, cgb-acid2 | **pixel-exact** |
| cgb-acid-hell | 2 / 23040 pixels differ (x=80, y=68–69) |
| Mealybug Tearoom | **0 / 24** — reported, not gated |
| jsmolka gba-tests | **7 / 7** |

---

## The one decision still waiting on the owner

### The A/B keyboard defaults are inverted

On hardware **B is the left face button and A is the right one**. We map `KeyZ → a`, `KeyX → b`,
so the left-hand key drives the right-hand button.

Verified from source: mGBA, SameBoy and RetroArch all use `X → A, Z → B`. EmulatorJS matches us.
The native convention preserves the physical relationship and generalises to the GBA diamond in
Phase 12–15, so keeping `Z → A` means migrating users twice.

Proposed migration, if changed: if the stored bindings exactly equal the old defaults the user
never customised, so upgrade silently; otherwise keep their mapping and show a dismissible note.
This is muscle memory, so it is the owner's call.

### Settled, for the record

- **Licence — MIT**, decided 2026-09-18. MIT is **inbound-compatible with MIT only**: SameBoy (MIT)
  may be borrowed from with attribution; mGBA is MPL-2.0, whose files cannot be copied into an MIT
  tree without carrying MPL on those files; Gambatte and VBA-M are GPL-2.0, which would force the
  whole project to GPL. So this *decided* GBA cheats rather than unblocking them — see below.
- **Git history — kept unsquashed.** It is a retrospective import, so intermediate commits are not
  individually buildable and `git bisect` will not work across them. Squashing was considered and
  rejected: the commit messages carry most of the reasoning behind the build, and that is worth
  more than bisectability nobody uses on a solo repo. Reversible by force-push while there are no
  forks.

---

## Known bugs and gaps

Ordered by how likely they are to bite.

- **Mealybug 0/24 — mid-scanline register effects.** Register writes landing *during* mode 3
  (LCDC, BGP, the window). Two hypotheses are **disproved and recorded** in
  `docs/plan/phase-04-ppu.md`. **Eliminated:** mode 3's length (now exactly 172 dots, verified);
  a constant lag between the FIFO pop and the palette lookup (delaying BGP by 0-4 dots makes it
  monotonically worse). **Not eliminated, despite an earlier note here saying so:** the CPU write
  phase. That note was reasoned from Mealybug's pass/fail count rather than its pixel diff, and
  the diff does move — 2218 at `ACCESS_T_OFFSET` 0 versus 5084 at 1-3. Offset 0 is still clearly
  best. When sweeping anything against Mealybug, measure the pixel diff, never the verdict.
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
  two 256-byte translation tables published nowhere except inside mGBA (MPL-2.0). Now that WebBoy
  is MIT this is decided rather than open: those tables **may not be copied**, so the reseed has to
  be derived from GBATEK or the feature ships without `DEADFACE` support.

### Process defects worth fixing

- `docs/testing.md` and `tests/scoreboard.md` both tell you to run `npm run screenshots`.
  **That script is not defined in `package.json`** — confirmed again 2026-09-18. The file
  `scripts/run-screenshots.ts` does exist, so the fix is either a one-line `scripts` entry or a
  correction to both docs. Until then: `npx vite-node scripts/run-screenshots.ts`.
- `scripts/generate-scoreboard.ts` always exits 0, so the scoreboard is a human-reviewed diff,
  not a gate. CI runs only `lint`, `typecheck`, `test`, `build` and the `no-roms` job, so the
  only automated regression gate a PR hits is `npm test`. Corpus tests must live in `tests/unit/`
  to be enforced.

---

## Blocked

**Phases 09 and 10 cannot be signed off.** They need a real browser: cross-browser behaviour, a
phone, the 10-minute audio underrun run. The Chrome extension is not connected in this environment,
and this sandbox cannot reach a localhost server either — so the design adoption (`93c65cb`) is
**verified structurally but nobody has looked at the rendered page**. That is stated in the commit
message and in `mock/README.md` rather than being quietly assumed.

This is now the binding constraint on the whole project, and it is no longer a tooling problem: the
build deploys, so **the path to unblocking it is to put it on a URL and open it.** Every "done"
claim in this repository rests on tests and typecheck. The distance between *passes its tests* and
*works when a person opens it* has never been measured even once.

---

## Recently landed

- **Save states corrupted Game Boy Color graphics.** Reported from play as the game
  turning into "graphic horror" after a load. None of the CGB register state was in the
  save: both 64-byte colour palette RAMs, the VRAM bank, the WRAM bank, the double-speed
  register and any HBlank HDMA in flight. All of them are intercepted in `Mmu.read`/`write`
  and kept in dedicated fields rather than in the `io` array, so `w.bytesOf(this.io)` saved
  none of them — a load restored a CGB game with whatever 128 bytes of colour the previous
  moment left behind. **Save-state format is now version 3; states written before this are
  refused, not misread.**

  Twelve round-trip tests passed against this the whole time, for two reasons worth
  remembering: every one built a **DMG** cartridge, and they saved and restored at the
  **same moment in the same core**, where an unsaved field still held the right value in
  memory. The six new tests each overwrite the state between the save and the load, and all
  six were confirmed to fail without the fix.
- **`67dd096` — the audio worklet could be served stale after a deploy.** Everything under
  `/assets/` is content-hashed; the AudioWorklet is not, and the `/*` fallback set no
  `Cache-Control`. A cached worklet would run the previous deploy's audio processor against new
  main-thread code, and the symptom — crackle or silence — looks like an emulator bug.
- **`33b9662` — the project is MIT.** Plus the first push: 27 commits, a clean fast-forward from
  the initial `Plan` commit, so nothing on the remote was overwritten.
- **`c2d08a9` — deployable to a static host.** `.nvmrc` (Pages otherwise defaults to a Node too
  old for Vite, the likeliest cause of a first build failing), `_headers`, `docs/deploy.md`.
  CSP and COOP/COEP deliberately left off, with the reasons recorded in `_headers` itself.
- **Phase 16** (`b202ff8`, `a642f61`, `9bfb0e1`, `2c857a7`) — Game Genie and GameShark for GB/GBC,
  the Cheats panel, user-editable keyboard bindings, quick save/load on the transport row, speed
  control and a system picker. Reasoning in `docs/plan/phase-16-cheats-controls.md`.
- **`f70fc4c` — four silent input bugs.** Bound keys stolen from every text field; one source's
  release clearing a button another source held; macOS leaving a key stuck whenever Command was
  tapped; a pad button held across a pause staying dead. None threw, so none were visible.
- **`db9ab59` — the game was dead after a tab switch.** Hiding the tab suspended the AudioContext
  with nothing to resume it, and paused the emulator with nothing to un-pause it. Returning now
  resumes automatically, but only if *we* paused — a manual pause is left alone.
- **`64ed1ff` — mode 3 is 172 dots, not 175.** Two independent causes; Mooneye 57 → 60.
- **`93c65cb` — the instrument UI direction**, adopted from `mock/`.

### A pattern worth carrying forward

Two phase-16 bugs were the same shape: **a working feature nobody could find.** Both were reported
as "it's broken" and both were diagnosed, twice, as a crash that was not happening — the emulator
was running at 60fps the whole time. A screenshot settled in seconds what an hour of reading state
machines did not. When a live report says *broken*, ask what is on screen before reading code.

---

## Research done, not yet built

**Gamepad remapping.** The pad map is still a hardcoded standard-layout index table, which is a
latent bug for any controller the browser does not report as `mapping: "standard"` — indices mean
nothing there and buttons land on the wrong actions. Hot-plug listeners are also missing, so an
already-connected pad is invisible in Safari and Firefox until a button is pressed. The
`InputSource` shape is designed to absorb this without churn.

**Multi-line cheat entry**, and a "did this code actually match?" indicator. BGB shows whether a
Game Genie compare hit, which is the best diagnostic in any cheat UI — without it a code for the
wrong ROM revision silently does nothing and the emulator looks broken.

**Touch-control customisation.** Deferred deliberately: nobody has run this on a real phone, and
making an unvalidated layout configurable ships the problem to the player instead of fixing it.

---

## Suggested next steps

1. **Deploy it and open it.** `docs/deploy.md` has the exact Pages settings; the account has to be
   created by the owner. This is first not because it is easiest but because everything below is
   built on top of an app nobody has watched run. Check the console, and confirm in the Network
   tab that every request is same-origin — that is law 3, and it is meant to be verified
   empirically rather than trusted.
2. **Settle the A/B default** — the last open decision, and it shapes work that is ready to start.
3. **Mid-scanline PPU effects** — the largest remaining accuracy gap (Mealybug 0/24 plus five
   Mooneye `ppu/*`), and the one with the most diagnosis already banked. Two wrong hypotheses are
   eliminated and the method for testing a third is written down.
4. **Gamepad remapping**, the last obviously-missing input feature, and a latent correctness bug
   rather than only a gap.
5. **GBA cheats** — unblocked in principle now the licence is MIT, but the `DEADFACE` tables must
   be reimplemented from GBATEK rather than copied from mGBA.
