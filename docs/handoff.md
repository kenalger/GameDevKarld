# Handoff

Current state, open decisions, and what to pick up next. Updated 2026-09-19.

`docs/plan/` says what to build and in what order. This file says **where things actually are right
now** — including the things that are wrong.

---

## State

| | |
|---|---|
| Branch | `main`, working tree clean |
| Pushed | **yes** — the local `origin/main` ref is at the tip, 0 commits ahead. Not re-fetched, so this is the last known remote position. History kept unsquashed, see below. |
| Licence | **MIT** — `LICENSE` and all three `package.json` files |
| Deployed | **no.** The build is ready and `docs/deploy.md` is written; nobody has run it. |
| Source | **15,484** lines of non-test `.ts`/`.tsx` under `packages/emulator/src` + `apps/web/src`; 23,072 including tests, harness and scripts |
| Tests | **1140 passing, 1 skipped**, 32 files |
| Build | 11 files (`apps/web/dist`); JS **416 KB**, **125 KB gzipped**, CSS 17 KB |
| Save-state format | **version 3.** States written by earlier builds are refused, not misread |
| Performance | ~20x realtime, p99 well under budget |

Everything green, all re-run 2026-09-19: `npm test`, `typecheck`, `lint` (0 errors, 30 pre-existing
`no-console` warnings in scripts), `prettier --check`, `build`.

> The earlier figure of "16,364 lines excluding tests" is superseded rather than contradicted — it
> counted a wider set of files. The two numbers above each name their own scope.

### Accuracy corpus — `npm run compat`

Last re-run and confirmed 2026-09-18 — **not** re-run on 2026-09-19, and no core code has
changed since. These are measurements, not recollections.

| Suite | Result |
|---|---|
| SingleStepTests/sm83 | **500,000 / 500,000** (100%) across 500 opcodes |
| Blargg cpu_instrs + timing | 18 / 19 — `halt_bug` times out |
| Blargg sound (DMG + CGB) | 19 / 24 |
| Mooneye acceptance | **60 / 66 applicable** (9 skipped: they target DMG0/MGB/SGB) |
| dmg-acid2, cgb-acid2 | **pixel-exact** |
| cgb-acid-hell | 2 / 23040 pixels differ (x=80, y=68–69) |
| Mealybug Tearoom | **0 / 24** — reported, not gated |
| jsmolka gba-tests | **10 / 10** — `shades`, `stripes` and `bios` now pass |

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
- ~~The GB core's APU save state has the same per-channel gap~~ — **fixed**, and it was the
  **third** sighting of one bug class: state held in a subsystem's own objects, never reaching
  the array the container serializes. CGB registers, then the GBA PSG channels, then these. Each
  time, the round-trip tests passed because they restored into the same moment they saved. **When
  adding any `saveState`, enumerate the class's fields and diff them against what is written —
  and make the test overwrite the state between save and load**, or it passes against the bug.
- **`GbaApu.readPsg` maps byte offsets to the wrong half of the halfword.** `SOUND1CNT_X`
  returns NR14 where NR13 belongs, the envelope byte is dropped from three registers, and
  `SOUND4CNT_L` matches no branch so NR44 reads back 0 — a game polling a length-enable bit
  gets garbage. Fixing it needs the per-register GBA read masks from GBATEK (unused GBA I/O
  bits read 0, not the DMG's 1s), which is a research task rather than a bounds check.
- ~~GBA wave RAM unimplemented~~ and ~~8-bit sound writes dropped~~ — both **fixed**. The wave-RAM
  diagnosis in the first report was wrong in its mechanism, which is worth remembering: the
  unbounded `psgTarget` fall-through is real but *latent*, since both callers are already gated on
  `0x60-0x7F`. The visible bug was one level up — `GbaApu.write`/`read` had no case for
  `0x04000090-0x9F` at all, so the access was dropped rather than misrouted.
- **An undefined instruction still branches to vector 0x04**, which holds no code. Equally broken
  before the BIOS work; no test ROM reaches it.
- **GBA cheats** need TEA decryption plus a CPU breakpoint hook. The `DEADFACE` reseed depends on
  two 256-byte translation tables published nowhere except inside mGBA (MPL-2.0). Now that WebBoy
  is MIT this is decided rather than open: those tables **may not be copied**, so the reseed has to
  be derived from GBATEK or the feature ships without `DEADFACE` support.

### Process defects worth fixing

- `docs/testing.md` and `tests/scoreboard.md` both tell you to run `npm run screenshots`.
  **That script is still not defined in `package.json`** — confirmed again 2026-09-19. The file
  `scripts/run-screenshots.ts` does exist, so the fix is either a one-line `scripts` entry or a
  correction to both docs. Until then: `npx vite-node scripts/run-screenshots.ts`.
- **`docs/graphics.md` still says mode 3's measured baseline is 175 dots.** It has been exactly
  172 since `64ed1ff`, which this file already records. One stale number in the document whose
  whole job is to explain the PPU's timing model.
- **The UI docs drift fastest, because the UI is what keeps changing.** `docs/features.md`,
  `docs/how-it-works.md` and `docs/software-development-plan.md` were written on 2026-09-18 and
  were already wrong two commits later (slot count, quick-slot numbering, the tab strip that is
  now a drawer). Corrected on 2026-09-19. Anything that changes the control bar, the drawer or
  the slot model should update those three in the same commit.
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

**The unverified surface is growing, which makes this worse rather than merely unchanged.** Three
of the last five commits changed what the app looks like — the settings drawer, the fullscreen and
responsive-layout rewrite, the eight-slot states panel — and every one of them says, in its own
commit message, that it was not seen in a browser. `d98fdee` in particular worked its arithmetic
through in comments *precisely so it could be checked against a real window*; nobody has checked
it. The layout maths, the drawer at 375px, the scrim, the sheet inside fullscreen, the 44px touch
targets and the safe-area insets are all reasoned, all plausible, and all unobserved.

---

## Recently landed

- **The save states were there; three separate things hid them** (`bf57ee5`). Reported as "why
  can't I see my save states?". Only one of the three causes was the slot count. There were four
  slots and the transport row's Save State button silently overwrote the quick one, so a player
  using that button had three real slots and no hint the two were related — now **eight**, which
  is what mGBA, RetroArch and SameBoy offer, with slot 1 tagged "quick" and a line saying what
  writes to it. A quick-save also left no trace in an open States panel, because the list was read
  once on mount; it now re-reads on a `statesRevision` counter rather than on every notify, since
  listing reads every slot's full bytes out of IndexedDB and pause/resume should not pay for that
  — which matters twice as much with eight slots. And the version-3 bump below had left pre-fix
  states listed as loadable, thumbnail and all, failing only on click; `readStateHeader` reads the
  six-byte container header without parsing the state, so they now say "older format — cannot be
  loaded" up front.
- **The layout had one axis, and fullscreen had none** (`d98fdee`). One root cause behind three
  bugs: `.screen` is `width: 100%` with an `aspect-ratio`, which bounds the picture on one axis,
  and every window wider than 10:9 — every laptop — runs out of height first. Fullscreen showed
  the ordinary page on a black background (a 620px device floating on a 12" MacBook, tab strip and
  disclaimer still underneath); the device was taller than a laptop window, so picture and controls
  could not be on screen together at any zoom; and there was no mobile layout at all — the only
  breakpoints in 1,012 lines of CSS were dark mode and `pointer: coarse`. Adds a phone breakpoint,
  44px minimum touch targets on coarse pointers (WCAG 2.5.5 — 9px of padding on an 11px label is a
  31px target), and safe-area insets, which `viewport-fit=cover` in `index.html` had needed all
  along.
- **The project documented itself** (swept into `d98fdee`). Three new documents, written against
  the code and a re-run of the suite rather than from the existing docs:
  `docs/software-development-plan.md` (the product, the process, the quality bar, measured status,
  a forward plan where every item carries an exit condition), `docs/features.md` (the feature
  catalogue, including a "deliberately absent" section so decisions are not mistaken for a
  backlog) and `docs/how-it-works.md` (module responsibilities, ten traced walkthroughs, a feature
  interaction map naming the trap in each pairing, and ten invariants that fail silently). The
  README was rewritten: its Status section still claimed M3/First Playable while phases 06–16 had
  landed, and its Layout tree predated the GBA, audio, cheat and persistence code.

  All three were **already stale two commits later** and were corrected on 2026-09-19 — see the
  process defect above.
- **The settings were scattered across the page; now they are behind one door.** Six tabs —
  Cartridge, Controls, Saves, States, Cheats, Debug — sat expanded under the device while you
  played, with no Settings entry point anywhere. Two agents were used: one read the menu
  structure of **eight emulators at source level**, the other inventoried every control in the
  app so nothing was lost in the move. The finding was unanimous: **none of the eight puts
  configuration in the window during play** (RetroArch even ships `DEFAULT_FPS_SHOW false`),
  and **none shows a debugger to players** — ares calls its panel "Developer", Mesen isolates
  it in its own top-level menu, RetroArch/EmulatorJS/Delta ship none.

  The control bar is now Pause/Resume · Save State · Load State · Speed · Fullscreen ·
  Settings; everything else is in a right-hand drawer (a drawer, not a modal, per NN/g: the
  settings change the picture you are looking at, so it has to stay visible). Debug is behind
  a Developer-mode switch and the fps readout behind a Show-performance switch, both off by
  default and persisted. The drawer pauses the game while open, as RetroArch, Delta and mGBA
  all do — otherwise the arrow keys used to read the menu also drive the character.

  Three latent bugs fixed on the way: the **system picker was unreachable** once a cartridge
  loaded (`setSystemPreference` had one call site, inside the `!loaded` branch); **`muted`
  lived in a component's `useState`** while every other control was in the session snapshot;
  and the `.state`/`.sav` **download code existed in three near-identical copies**.

  **Not verified in a browser.** The rendering of the drawer, the scrim, the nav at 375px and
  the sheet inside fullscreen have not been seen by anyone.
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

   It has been first on this list for several sessions, and the cost of it staying first is
   compounding: the last five commits added a drawer, a responsive layout, a fullscreen mode and
   an eight-slot panel on top of an app nobody has seen. **The list of things to check on that
   first open is now specific**, which at least makes the session short: the drawer and scrim at
   375px, the sheet inside fullscreen, the `d98fdee` layout arithmetic against a real window
   (~420px device at 1152x720; a 693x624 picture in fullscreen), the 44px touch targets, the
   safe-area insets on a notched phone, and a ten-minute run listening for audio underruns.
2. **Settle the A/B default** — the last open decision, and it shapes work that is ready to start.
3. **Mid-scanline PPU effects** — the largest remaining accuracy gap (Mealybug 0/24 plus five
   Mooneye `ppu/*`), and the one with the most diagnosis already banked. Two wrong hypotheses are
   eliminated and the method for testing a third is written down.
4. **Gamepad remapping**, the last obviously-missing input feature, and a latent correctness bug
   rather than only a gap.
5. **GBA cheats** — unblocked in principle now the licence is MIT, but the `DEADFACE` tables must
   be reimplemented from GBATEK rather than copied from mGBA.
