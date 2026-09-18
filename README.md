# WebBoy

A privacy-first Game Boy / Game Boy Color / Game Boy Advance emulator for the browser.

**Your ROM stays on your device.** No upload, no account, no backend, no analytics.

**All three systems run.** Game Boy and Game Boy Color are the most complete; Game Boy Advance has
CPU, bus, DMA, timers, all six video modes with sprites/affine/windows/blending, and audio.

New here? **[What WebBoy is and what it does](docs/features.md)** ·
**[How it works](docs/how-it-works.md)** ·
**[Development plan](docs/software-development-plan.md)**

## Status

**Phases 00–16 have landed. Two gates are amber and one thing has never been done.**

The emulator plays games, saves them, snapshots them, takes cheat codes and rebinds its keys, and
its accuracy is measured against the standard hardware test corpus. What has *not* happened is that
**nobody has opened it in a browser** — the app has never been deployed, so every "done" here rests
on tests, typecheck and build. Closing that gap is the top item in the plan.

| Milestone | | |
|---|---|---|
| M1 | The CPU is real | ✅ |
| M2 | The picture is real — dmg-acid2 exact | ✅ |
| **M3** | **🏁 First Playable** | ✅ |
| M4 | Sessions persist — saves and save states | ✅ |
| M5 | v1.0 DMG — shippable | ⚠️ **blocked on real-device verification** |
| M6 | v1.1 Game Boy Color | ✅ |
| M7 | v2.0 Game Boy Advance | ✅ on the test corpus |

### Accuracy, measured

Re-run 2026-09-18 with `npm run compat`. These are measurements, not recollections.

| Suite | Result |
|---|---|
| SingleStepTests/sm83 — per opcode, per M-cycle bus activity | **500,000 / 500,000 (100%)** |
| Blargg `cpu_instrs` + `instr_timing` + `mem_timing` | 18 / 19 — `halt_bug` times out |
| Mooneye acceptance | **60 / 66 applicable** (9 target DMG0/MGB/SGB) |
| Mooneye mappers, incl. MBC1 multicart | **all pass** |
| **dmg-acid2** and **cgb-acid2** | **pixel-exact** |
| cgb-acid-hell | 2 / 23040 pixels differ |
| jsmolka gba-tests — arm, thumb, memory | **7 / 7** |
| GBA video: all modes, affine, windows, blending | 26 tests |
| GBA audio: Direct Sound + PSG | 23 tests |
| Blargg sound, DMG + CGB | 19 / 24 ⚠️ wave RAM |
| **Mealybug Tearoom** — mid-scanline register effects | **0 / 24** ⚠️ |
| Save-state round-trip | **1000-frame identical** |
| Core performance | **~20× realtime**, p99 well under frame budget |

Unit + harness suite: **980 passing, 1 skipped** (`npm test`). Production build: 397 KB JS,
**120 KB gzipped**.

### Known gaps

- **Nothing has been verified in a real browser, on a real phone, or against a real network log.**
  Phases 09 and 10 cannot be signed off until it has been.
- **Mid-scanline PPU register effects** — Mealybug 0/24 plus five Mooneye `ppu/*` failures are the
  same bug from two sides. Two hypotheses are disproved and recorded in
  [`docs/plan/phase-04-ppu.md`](docs/plan/phase-04-ppu.md).
- **Blargg sound 19/24** — wave RAM; the gap is phase, not window width. See
  [`docs/plan/phase-07-audio.md`](docs/plan/phase-07-audio.md).
- **Gamepad remapping** — non-standard controllers map to the wrong buttons.
- **GBA cheats** and **EEPROM backup** are not implemented; both have recorded reasons.
- No commercial-game compatibility sweep has been run, on any system.

Full breakdown: [`tests/scoreboard.md`](tests/scoreboard.md) · known-not-applicable tests and their
reasons: `tests/expected-failures.ts` · live state including what is broken:
[`docs/handoff.md`](docs/handoff.md).

## Playing

Load a ROM you are legally entitled to use, then:

| | |
|---|---|
| **Arrows** | D-pad |
| **Z** | A |
| **X** | B |
| **Enter** | Start |
| **Shift** | Select |

All rebindable. Touch controls appear on phones and tablets; standard gamepads work too. Speed runs
0.25×–8×, save states have four slots plus quick save/load, and battery saves import and export as
ordinary `.sav` files. [Everything the app does, in detail](docs/features.md).

## Quick start

```bash
npm install
npm run dev              # http://localhost:5173

npm test                 # unit + harness tests — the enforced gate
npm run typecheck
npm run lint
npm run build            # → apps/web/dist, a static bundle

npm run fetch-test-roms  # pinned, checksum-verified ROM corpus into gitignored tests/roms/
npm run fetch-cpu-tests  # SingleStepTests/sm83 into gitignored tests/sm83/
npm run fetch-gba-tests  # jsmolka/gba-tests into gitignored tests/roms/gba-tests/

npm run sm83             # the Phase 01 gate: 500,000 per-opcode cases
npm run blargg           # the Phase 02 gate: cpu_instrs via serial + memory protocol
npm run mooneye          # the Phase 03 gate: acceptance suite
npm run gba-cpu          # the Phase 12/13 gate: ARM + Thumb + memory suites
npm run sound            # the Blargg sound suites
npm run compat           # the whole corpus, all three systems, one table
npm run scoreboard       # regenerate tests/scoreboard.md
npm run bench            # core throughput against realtime
```

Node `^20.19.0 || >=22.12.0`, pinned in `.nvmrc`.

> Screenshot verdicts are `npx vite-node scripts/run-screenshots.ts` — there is no `npm run
> screenshots` script yet, despite two docs saying otherwise.

## Layout

```text
apps/web/            React + TypeScript + Vite frontend
  src/emulator/      EmulatorSession (owns the frame loop), FramePacer, input, persistence
  src/audio/         AudioWorklet output and ring buffer
  src/storage/       IndexedDB: saves, states, cheats
  src/components/    Display, ROM picker, panels, touch controls, debugger UI
packages/emulator/   Emulator core — no React, no DOM, no canvas
  src/core/          EmulatorCore contract, EmulatorManager
  src/gb/            SM83 CPU · bus + MBCs · pixel-FIFO PPU · APU · timer · serial ·
                     joypad · save states · debugger · cheats
  src/gba/           ARM7TDMI · bus + DMA + backup · video · audio · timers · keypad
tests/harness/       Headless test-ROM runner, stop conditions, scoreboard
tests/unit/          Per-subsystem tests — the gate CI enforces
scripts/             Corpus fetch, gate runners, scoreboard, benchmark
docs/plan/           16 phases, each with an owner and a hard exit gate
.claude/agents/      Seven project specialists — five who build, two who verify
```

## Docs

| | |
|---|---|
| [Features](docs/features.md) | What the app does, feature by feature, including what is deliberately absent |
| [How it works](docs/how-it-works.md) | The wiring — modules, walkthroughs, feature interactions, invariants |
| [Development plan](docs/software-development-plan.md) | The product, the process, the quality bar, the status, what is next |
| [Handoff](docs/handoff.md) | Where things actually are **right now**, including what is broken |
| [Phase plan](docs/plan/README.md) | 16 phases — order, owners, exit gates |
| [Architecture](docs/architecture.md) | The app/core boundary and frame-loop ownership |
| [Graphics](docs/graphics.md) | Why the PPU is a pixel FIFO |
| [Testing](docs/testing.md) | The harness, the corpus, the gate order, how to bisect a failure |
| [Deploy](docs/deploy.md) | Putting the static build on a URL |
| [Legal](docs/legal.md) | Distribution rules and the privacy guarantee |
| [CLAUDE.md](CLAUDE.md) | Project charter and the rules every contributor follows |

When the plan and the handoff disagree, the handoff is the state and the plan is the intent.

## Legal

WebBoy is an independent project, not affiliated with Nintendo or The Pokémon Company. It does not
supply, host or link to game ROMs — you must provide software you are legally entitled to use. See
[docs/legal.md](docs/legal.md).

## Licence

[MIT](LICENSE), covering WebBoy's own source code. The project contains no Nintendo code, no BIOS
and no game assets. Archivo and IBM Plex Mono are bundled under the SIL Open Font License 1.1; their
licence texts sit beside the font files in `apps/web/public/fonts/`.
