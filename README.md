# WebBoy

A privacy-first Game Boy / Game Boy Color / Game Boy Advance emulator for the browser.

**All three systems run.** Game Boy and Game Boy Color are the most complete; Game Boy Advance
has CPU, bus, DMA, timers, all six video modes with sprites/affine/windows/blending, and audio.

**Your ROM stays on your device.** No upload, no account, no backend, no analytics.

## Status

## 🏁 M3 — First Playable

**A legal homebrew ROM loads from your device, renders, and responds to the keyboard.** This is the
roadmap's first definition of success, and deliberately not Pokémon.

Load a ROM, then: **Arrows** to move · **Z** = A · **X** = B · **Enter** = Start · **Shift** = Select.

**Phase 05 complete.** The CPU, memory bus, cartridge, timer, cycle-stepped OAM DMA, pixel-FIFO PPU
and joypad are all in place and test-verified.

| Gate | Result |
|---|---|
| SingleStepTests/sm83 (Phase 01) | **500,000 / 500,000 (100%)** |
| Blargg `cpu_instrs` (Phase 02) | **11 / 11** |
| Blargg `instr_timing`, `mem_timing`, `mem_timing-2` (Phase 03) | **7 / 7** |
| Mooneye `timer/*`, `interrupts/*`, `halt_ime*`, `ei_*` (Phase 03) | **20 / 20** |
| Mooneye MBC1 incl. multicart | **13 / 13** |
| **dmg-acid2** (Phase 04) | **pixel-exact** |
| **cgb-acid2** (Phase 11) | **pixel-exact** |
| **jsmolka gba-tests arm + thumb + memory** (Phases 12/13) | **all pass** |
| GBA video: all modes, affine, windows, blending (Phase 14) | 26 tests |
| GBA audio: Direct Sound + PSG (Phase 15) | 23 tests |
| Blargg sound, DMG + CGB (Phases 07/11) | 19 / 24 ⚠️ |
| Save-state round-trip (Phase 08) | **1000-frame identical** |
| Core performance (Phase 10) | **21.6x realtime**, p99 = 5.3% of frame budget |
| Mooneye acceptance, overall | 38 / 75 |

The PPU is a **pixel FIFO**, not a scanline renderer — see `docs/graphics.md` for that decision.
Every common mapper works (MBC1/2/3+RTC/5), battery saves and save states persist, and audio is
implemented but **three Blargg wave-RAM tests still fail** — see `docs/plan/phase-07-audio.md`.

Full breakdown: `tests/scoreboard.md`; known-not-applicable tests and their reasons:
`tests/expected-failures.ts`.

Roadmap: `GameDevKarld(1).md` · Executable plan: [`docs/plan/`](docs/plan/README.md)

## Quick start

```bash
npm install
npm run dev              # http://localhost:5173

npm test                 # unit + harness tests
npm run typecheck
npm run lint
npm run build

npm run fetch-test-roms  # pinned, checksum-verified ROM corpus into gitignored tests/roms/
npm run fetch-cpu-tests  # SingleStepTests/sm83 into gitignored tests/sm83/
npm run fetch-gba-tests  # jsmolka/gba-tests into gitignored tests/roms/gba-tests/
npm run gba-cpu          # the Phase 12/13 gate: ARM + Thumb + memory suites
npm run compat           # the whole corpus, all three systems, one table
npm run sm83             # the Phase 01 gate: 500,000 per-opcode cases
npm run blargg           # the Phase 02 gate: cpu_instrs via serial + memory protocol
npm run mooneye          # the Phase 03 gate: acceptance suite
npm run scoreboard       # regenerate tests/scoreboard.md
```

## Layout

```text
apps/web/            React + TypeScript + Vite frontend
packages/emulator/   Emulator core — no React, no DOM, no canvas
  gb/cpu/            SM83: registers, ALU, decoder, interrupts
  gb/memory/         Bus, address decoding, OAM DMA
  gb/cartridge/      Header parsing, ROM-only + MBC1
  gb/timer/ serial/ ppu/   DIV/TIMA, serial, LCD timing
tests/harness/       Headless test-ROM runner, stop conditions, scoreboard
scripts/             Test-ROM fetch, scoreboard generation
docs/plan/           16 phases, each with an owner and a hard exit gate
.claude/agents/      Seven project specialists — five who build, two who verify
```

## Docs

- [Phase plan](docs/plan/README.md) — what to build, in what order, and how a phase is judged done
- [Architecture](docs/architecture.md) — the app/core boundary and frame-loop ownership
- [Testing](docs/testing.md) — the harness, the corpus, the gate order, how to bisect a failure
- [Legal](docs/legal.md) — distribution rules and the privacy guarantee
- [CLAUDE.md](CLAUDE.md) — project charter and the rules every contributor follows

## Legal

WebBoy is an independent project, not affiliated with Nintendo or The Pokémon Company. It does not
supply, host or link to game ROMs — you must provide software you are legally entitled to use. See
[docs/legal.md](docs/legal.md).

## Licence

[MIT](LICENSE), covering WebBoy's own source code. The project contains no Nintendo code, no BIOS
and no game assets. Archivo and IBM Plex Mono are bundled under the SIL Open Font License 1.1; their
licence texts sit beside the font files in `apps/web/public/fonts/`.
