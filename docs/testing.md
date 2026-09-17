# Testing Strategy

Accuracy is the product. This document is how we prove it.

## The rule

**Test ROMs are the definition of done, not "the game boots."** A phase gate in `docs/plan/` is a
test result, not an opinion. `unavailable` is not a pass, and a previously-passing test that fails is
a build-breaking regression — never re-baselined without a written reason.

## Layers

| Layer | What | Run |
|---|---|---|
| Unit | Per-subsystem logic, flags, cycle counts | `npm test` |
| Per-opcode | SingleStepTests/sm83 JSON, all 512 opcodes with per-cycle bus activity | Phase 01 |
| Integration | Test ROMs via the headless harness | `npm run scoreboard` |
| Screenshot | Framebuffer vs committed reference PNG, pixel-exact | Phase 04 |

## The harness — `tests/harness/`

`runTest()` loads a ROM, runs frames, and asks a `StopCondition` for a verdict after each one. No
canvas, no React, no DOM.

Four stop conditions:

- **`mooneyeCondition()`** — Gekkio convention. The ROM runs `LD B,B` when finished; PASS on the
  Fibonacci register signature `B=3 C=5 D=8 E=13 H=21 L=34`, FAIL when every register is `0x42`.
- **`blarggCondition()`** — reads the serial port (`FF01`/`FF02`), which reports *which sub-test*
  failed, plus the `0xA000` memory protocol behind the `0xDE 0xB0 0x61` signature.
- **`screenshotCondition()`** — compares the framebuffer to a reference and reports a differing-pixel
  **count and bounding box**. A 4-pixel diff in the sprite row and a full-screen diff are different
  bugs; the report must let you tell them apart without opening an image.
- **timeout** — a frame budget. **A hang is a failure, not a suspended run.**

### Honesty

A condition whose hardware hooks do not exist yet returns **`unavailable`**, never `pass`. Today
every integration test reports `unavailable` because there is no CPU — that is the correct output.
A false green in Phase 00 would poison every gate above it.

## The SM83 per-opcode gate — Phase 01

```bash
npm run fetch-cpu-tests   # SingleStepTests/sm83 into gitignored tests/sm83/
npm run sm83              # run all 500,000 cases (~1s)
npm run sm83 -- 27 'cb 46'   # run specific opcodes while debugging
```

500 opcode files x 1000 cases. Each case carries an initial state, a final state, **and the
per-M-cycle bus activity** — `r-m` read, `-wm` write, `---` internal. The harness asserts all
three: registers, memory, and the exact sequence of bus accesses.

This is a unit-level gate and runs before any ROM boots. It catches flag and cycle errors the
moment they are introduced. It cannot, however, see across instruction boundaries — one case is
one instruction — so interaction behavior (the `EI` delay, the HALT bug, interrupt dispatch) needs
the dedicated tests in `tests/unit/cpu.test.ts`.

## The ROM corpus

```bash
npm run fetch-test-roms   # pinned tag, checksum-verified, into gitignored tests/roms/
```

Pulls `c-sp/game-boy-test-roms` **v7.0** (sha256 `b9a9d7a1…`) — 4,510 ROMs bundling Blargg, Mooneye,
Mealybug, Gambatte, acid2 and more. The tag and digest are pinned in `scripts/fetch-test-roms.sh`;
an unpinned corpus makes yesterday's scoreboard meaningless. **ROM data is never committed.**

## Gate order — do not skip ahead

Defined in `tests/harness/corpus.ts` and enforced by the plan. 176 tests across the gate suites:

| Suite | Tests | Gate for |
|---|---|---|
| `blargg/cpu_instrs` | 11 | Phase 02 |
| `blargg/instr_timing` | 1 | Phase 03 |
| `blargg/mem_timing` | 3 | Phase 03 |
| `mooneye/acceptance` | 75 | Phase 03 |
| `dmg-acid2` | 1 | Phase 04 |
| `mooneye/emulator-only` | 28 | Phase 06 |
| `blargg/dmg_sound` | 12 | Phase 07 |
| `cgb-acid2` / `blargg/cgb_sound` | 1 / 12 | Phase 11 |
| `mealybug` | 32 | Phase 04 (or expected-fail) |

Chasing Mealybug before `cpu_instrs` passes wastes days.

## The scoreboard

```bash
npm run scoreboard   # writes tests/scoreboard.md and tests/scoreboard.json
```

Committed on purpose: **a diff of this file is the most informative thing in any core PR.**
Outcomes are `pass` / `fail` / `timeout` / `unavailable` / `expected-fail`, and an `expected-fail`
must carry a subsystem and a written reason.

## Diagnosing a failure

Anyone can report "test 07 fails." Useful reports say why:

1. **Trace-log differential** — the most powerful technique in emulator debugging. Emit a
   fixed-width per-instruction trace (`PC`, opcode, `AFBCDEHL`, `SP`, cycles) and `diff` it against
   **SameBoy** (which passes all of Mooneye and Blargg) on the same ROM. The first divergent line is
   the bug, exactly.
2. **Bisect by subsystem** — a failing timer test with passing `cpu_instrs` points at the timer.
3. **Bisect by commit** — the harness exits non-zero on failure, so a single test works as a
   `git bisect run` predicate.
4. **Minimal repro** — mapper, frame number, subsystem state at divergence. Never file "game X hangs."

## Running one test

```bash
npx vitest run tests/unit/harness.test.ts        # harness's own tests
npx vitest run -t 'reports a hang as a timeout'  # one case
```
