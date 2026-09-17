# WebBoy — Project Charter

A browser-based Game Boy / Game Boy Color / Game Boy Advance emulator. React + TypeScript + Vite
frontend, TypeScript emulator core, no backend, no database, no accounts.

- **`GameDevKarld(1).md`** — the roadmap. *What* to build. Read it before planning any phase.
- **`docs/plan/`** — the executable breakdown. 16 phases, each with an owner, a task list, a hard
  exit gate, the reference sections to fetch, and the known traps. Start at `docs/plan/README.md`.

## The team

Seven project-scoped specialists live in `.claude/agents/` — five who build, two who verify.
Route work to the owner:

| Agent | Owns |
|---|---|
| `gb-cpu-engineer` | SM83 + ARM7TDMI cores, decoder, ALU/flags, interrupts, timers, cycle scheduler |
| `gb-memory-engineer` | Memory bus, cartridges/MBCs, header parsing, DMA, IndexedDB saves, save-state format |
| `gb-ppu-engineer` | PPU, tile/sprite/window rendering, LCD timing, palettes, GBA video, framebuffer→canvas |
| `gb-audio-io-engineer` | APU, Web Audio output, A/V sync, joypad register, keyboard/touch/gamepad input |
| `webboy-frontend-engineer` | React app, display, mobile controls, settings, debugger UI, Web Worker, performance |
| `emu-accuracy-tester` | Test-ROM harness and corpus, pass/fail scoreboard, trace-log diffing, failure bisection |
| `webboy-app-qa` | Privacy audit, cross-browser and mobile behavior, save-data integrity, perf regressions, a11y |

Shared boundaries that are easy to get wrong:

- **Bus access restrictions during PPU modes** — the PPU engineer defines the state machine, the memory engineer enforces the read/write behavior. Neither invents it alone.
- **Input** — the audio/IO engineer owns the joypad register, the input latch, and browser event handling. The frontend engineer owns how the on-screen controls *look* and where they sit.
- **Save states** — the memory engineer owns the container format and versioning. Every other subsystem supplies `serialize()` / `deserialize()` for its own state.
- **Frame pacing** — exactly one component owns the clock. Audio-driven or rAF-driven, decided once, written down here.
- **GBA Direct Sound** spans CPU (timers), memory (DMA), and audio (FIFO). Those three coordinate before anyone implements.

The two verifiers are independent of the five builders and do not fix core code — they diagnose and
hand off. `emu-accuracy-tester` owns "is the hardware right?" and may write harness and test code.
`webboy-app-qa` owns "is the product right?", is read-only, and drives the real browser. When a bug
could be either, `webboy-app-qa` triages it to `emu-accuracy-tester`. Neither may mark something as
passing without having run it.

## Law

1. **Never implement hardware behavior from memory.** Fetch the source — Pan Docs, GBATEK, Gekkio's
   technical reference — before writing a register, flag rule, timing value, or priority rule.
   Cite the section in the commit or report. Recall is unreliable at exactly the precision that matters.
2. **Test ROMs are the definition of done**, not "the game boots." Every subsystem owner runs their
   own suite (SingleStepTests/sm83, Blargg, Mooneye, dmg-acid2/cgb-acid2, Mealybug, jsmolka/gba-tests)
   and reports pass/fail counts; `emu-accuracy-tester` owns the harness, the corpus, and the
   scoreboard, and has the final say on whether a milestone is done. Never report a suite as passing
   without running it. Test ROMs come from https://github.com/c-sp/game-boy-test-roms — fetched by
   script, pinned to a tag, gitignored, never committed. A previously-passing test that fails is a
   build-breaking regression; re-baselining a failure requires an explicit recorded decision.
3. **The ROM never leaves the device.** No upload, no fetch carrying ROM bytes, no analytics or error
   reporter that could capture ROM contents or names, no service worker caching ROM data. Any code
   path that could violate this is escalated, not quietly patched. `webboy-app-qa` verifies this
   empirically against the running app every release — a network log, not a code read.
4. **No commercial ROMs or copyrighted game assets in this repository** — not in `roms/`, not as a
   test fixture, not base64'd into a test, not as branding. No Nintendo/Game Boy/Pokémon trade dress.
   The disclaimer ships in the UI, not just the README.
5. **Cycle-accurate from the start.** Tick subsystems per memory access, not once per instruction.
   A "run the instruction, then add its cycles" core cannot be fixed later without a rewrite.
6. **The core knows nothing about the browser.** CPU, memory, PPU, and APU import no React, no DOM,
   no canvas, no Web Audio. Browser APIs live in an adapter layer behind a narrow interface.
7. **No allocation in hot paths.** Typed arrays, integer math, preallocated buffers. GC pauses in the
   fetch-decode-execute or per-sample path surface as audio crackle and dropped frames.
8. **React never re-renders during emulation.** Refs and throttled subscriptions, not per-frame state.
9. **Profile before optimizing.** The order is: stop React re-renders → remove allocations → move to a
   Web Worker → optimize core hot loops → consider WebAssembly. Do not skip ahead.
10. **Small, focused commits** (`feat: implement mbc1 banking`), one hardware subsystem at a time,
    tests written alongside — not postponed to the end.
11. **Third-party emulator code is license-reviewed before use.** Reading another emulator to
    understand hardware is fine; copying its code without checking the license is not.

## Milestones

The first definition of success is **not** Pokémon. It is **M3, at the end of Phase 05**: a legal
homebrew/test ROM runs correctly in the browser — loads, executes, renders, accepts input, keeps
time, resets, pauses. Commercial-game compatibility is evaluated only after that, with legally
supplied ROMs, and only ever as a compatibility target.

| | | |
|---|---|---|
| M1 | end of Phase 03 | The CPU is real — instructions and cycles verified |
| M2 | end of Phase 04 | The picture is real — dmg-acid2 exact |
| **M3** | **end of Phase 05** | **🏁 First Playable** |
| M4 | end of Phase 08 | Sessions persist — saves and save states |
| M5 | end of Phase 10 | v1.0 DMG — shippable |
| M6 | end of Phase 11 | v1.1 Game Boy Color |
| M7 | end of Phase 15 | v2.0 Game Boy Advance |

Phases 00→05 are a **strict chain**. Phases 06–10 parallelize across four agents once 05 lands.
A phase whose gate is red is not done; there is no "fix it later" in an emulator, because a deferred
accuracy bug becomes ten mystery bugs in the phases above it.
