# WebBoy — Phase Plan

The roadmap in `GameDevKarld(1).md` says *what* to build. This directory says *in what order*, *who
owns it*, and *how we know it is done*. One file per phase.

Every phase has a **hard exit gate** — a test result, not an opinion. `emu-accuracy-tester` or
`webboy-app-qa` calls the gate. A phase is not done because its author says so.

## Phase map

| # | Phase | Owner | Exit gate |
|---|---|---|---|
| 00 | [Foundation](phase-00-foundation.md) | `webboy-frontend-engineer` | ✅ **Done** — builds, harness runs, CI green |
| 01 | [SM83 CPU](phase-01-cpu.md) | `gb-cpu-engineer` | ✅ **Done** — sm83 500,000/500,000 (100%) |
| 02 | [Memory & Cartridge](phase-02-memory-cartridge.md) | `gb-memory-engineer` | ✅ **Done** — `cpu_instrs` 11/11, MBC1 13/13 |
| 03 | [Timing & Interrupts](phase-03-timing-interrupts.md) | `gb-cpu-engineer` | ✅ **Done** — timer 13/13; Mooneye 57/66 applicable |
| 04 | [PPU & Display](phase-04-ppu.md) | `gb-ppu-engineer` | ✅ **Done** — dmg-acid2 pixel-exact; OAM DMA + STAT latch exact |
| 05 | [Input → First Playable](phase-05-input-first-playable.md) | `gb-audio-io-engineer` | ✅ **🏁 M3** — homebrew runs + responds to input |
| 06 | [Mappers & Persistence](phase-06-persistence-mappers.md) | `gb-memory-engineer` | ✅ **Done** — every Mooneye mapper test passes |
| 07 | [Audio](phase-07-audio.md) | `gb-audio-io-engineer` | ⚠️ **Not met** — `dmg_sound` 9/12 (wave-RAM window) |
| 08 | [Save States](phase-08-save-states.md) | `gb-memory-engineer` | ✅ **🏁 M4** — round-trip 1000-frame identical |
| 09 | [UX & Mobile](phase-09-ux.md) | `webboy-frontend-engineer` | ⚠️ **Built** — needs a real phone + 3 browsers |
| 10 | [Debugger, Worker & Perf](phase-10-debugger-performance.md) | `webboy-frontend-engineer` | ⚠️ **Debugger+perf done** — 21.6x realtime; Worker deferred (no bottleneck) |
| 11 | [Game Boy Color](phase-11-gbc.md) | all five builders | ✅ **🏁 M6** — cgb-acid2 pixel-exact (double-speed stubbed) |
| 12 | [GBA — ARM7TDMI](phase-12-gba-cpu.md) | `gb-cpu-engineer` | ✅ **Done** — jsmolka arm + thumb all pass |
| 13 | [GBA — Memory & DMA](phase-13-gba-memory-dma.md) | `gb-memory-engineer` | ✅ **Done** — memory/arm/thumb pass on the real bus |
| 14 | [GBA — Video](phase-14-gba-video.md) | `gb-ppu-engineer` | ✅ **Done** — all modes, affine BG + OBJ, windows, mosaic, blending |
| 15 | [GBA — Audio & Compatibility](phase-15-gba-audio-compat.md) | `gb-audio-io-engineer` | ⚠️ **Audio + saves done, sweep in place** — no commercial-ROM testing |

## Milestones

- **M1 — "The CPU is real"** (end of 03). Instructions and cycles verified. Nothing is drawn yet.
- **M2 — "The picture is real"** (end of 04). dmg-acid2 exact. Still not playable.
- **M3 — 🏁 First Playable** (end of 05). **This is the project's first definition of success** — a
  legal homebrew ROM loads, runs, renders, accepts input, keeps time, resets and pauses. Per the
  roadmap, this milestone is *not* Pokémon and commercial compatibility is not evaluated before it.
- **M4 — "Sessions persist"** (end of 08). Battery saves and save states, exportable.
- **M5 — v1.0 DMG** (end of 10). Shippable Game Boy emulator: mobile, audio, debugger, worker.
- **M6 — v1.1 CGB** (end of 11).
- **M7 — v2.0 GBA** (end of 15).

## Dependency graph

```text
00 Foundation
 └─> 01 CPU ──> 02 Memory ──> 03 Timing ──> 04 PPU ──> 05 Input ══> 🏁 M3 FIRST PLAYABLE
                                                                      │
                     ┌────────────────┬───────────────┬───────────────┤
                     ▼                ▼               ▼               ▼
                06 Mappers        07 Audio      09 UX/Mobile   10 Debugger/Worker
                     └────────> 08 Save States <──┘                   │
                                      └───────────────────────────────┤
                                                                      ▼
                                                                  11 GBC
                                                                      │
                                    12 GBA CPU ──> 13 GBA Mem/DMA ────┤
                                                        └──> 14 Video ─┴─> 15 Audio/Compat
```

Phases 06–10 are **parallelizable** once 05 lands — four different agents, four different files.
Everything before 05 is a strict chain; do not start the PPU because the CPU is boring.

## How to run a phase

1. Read the phase file. Read the sections of `GameDevKarld(1).md` it cites.
2. Delegate to the phase owner agent. It will fetch its own hardware references — that is its job,
   and it is required not to work from memory.
3. Owner implements + unit tests. Supporting agents handle their named slices.
4. `emu-accuracy-tester` runs the gate and reports the scoreboard delta.
5. **Gate fails → phase is not done.** No moving on with a "we'll fix it later" test. In an emulator,
   a deferred accuracy bug becomes ten mystery bugs in the phases above it.
6. Update the Status line in the phase file and the table above.

## Rules that apply to every phase

Full text in `/CLAUDE.md`. The ones that get broken most:

- Fetch the hardware reference before implementing. Never work from memory.
- Tick subsystems per memory access, not per instruction. This cannot be retrofitted.
- No commercial ROMs committed, ever. No ROM data leaves the device, ever.
- Small commits, one subsystem at a time, tests alongside.
