# Phase 15 — GBA: Audio & Compatibility — 🏳️ M7

**Owner:** `gb-audio-io-engineer` · **Supporting:** `gb-cpu-engineer` (timers), `gb-memory-engineer` (DMA) · **Gate:** `emu-accuracy-tester` + `webboy-app-qa`
**Depends on:** 14 · **Roadmap:** §33 GBA Audio, §44–45
**Status:** ⚠️ **Audio built and sweep in place; commercial compatibility NOT measured** — 2026-09-17.

**GBA audio.** Both Direct Sound FIFOs and all four PSG channels, mixed. 23 tests. `npm run compat` runs the whole corpus across all three systems in one table.

**GBA cartridge backup.** SRAM, Flash 64K and Flash 128K, detected from the ROM signature and wired to the existing save-persistence layer. `sram.gba`, `flash64.gba` and `flash128.gba` now pass, taking the GBA corpus to **7/7**.

**GBA save states.** Full machine state — banked ARM registers and the prefetch pipeline, all five memories, DMA latches, timers, the PPU register file *including* the affine internal reference points, the Direct Sound FIFOs and the backup medium. Own container magic, so a Game Boy state and a GBA state refuse each other by name instead of misparsing. 9 tests, two of them negative controls.

| | |
|---|---|
| Direct Sound | 32-byte FIFO, timer-driven pop, DMA refill at ≤16 bytes, per-side routing, 50%/100% volume |
| PSG | the four DMG channels **reused, not copied** — same classes, GBA register map and mixer |
| Mixing | PSG ratio (25/50/100%) + both FIFOs, clamped to ±1 |
| Wiring | timer overflow → APU pop → DMA refill, closed in `GameBoyAdvanceCore` |

> **The timer → APU → DMA loop spans three subsystems**, exactly as the plan warned. A timer overflow pops one byte; the FIFO asks for a refill at half empty; DMA 1/2 delivers 16 more. Modelling it as an averaged sample rate would have made the DMA interaction inexpressible.
>
> **A test caught a real behaviour I had not thought about:** both FIFOs default to timer 0, so an *empty* FIFO B legitimately requests a refill on every overflow. That is correct hardware behaviour — the test was wrong, not the code.
>
> **The backup bug was not in the backup code at all.** `sram.gba` failed at test 6 with the medium itself working: `Arm7.write16`/`write32` were masking the low address bits off *before* the bus saw them. That is right for every 16-bit region and wrong for exactly one device — SRAM is an **8-bit** chip, so `A0`/`A1` select which single byte of the value lands. `STRH 0xAABB` to an even address stores `0xBB`; to an odd address it stores `0xAA`; the other byte is never written at all. Alignment now belongs to the bus, where hardware puts it, and the harness bus had to learn the same rule.
>
> A deliberate sabotage (dropping the byte-select) was run against the suite and correctly produced `Failed test 006`, so the pass is real rather than a blind harness — the Phase 12 lesson, applied again.

## What is NOT done

- **No commercial-game compatibility testing.** Roadmap §45's Pokémon titles are compatibility *targets*; measuring against them needs legally-supplied ROMs the user provides, and none are present. The sweep measures the homebrew accuracy corpus instead, which is the honest thing this project can measure.
- **No GBA audio test ROM** exists in the corpus, so the audio evidence is unit tests only — not a Blargg-style hardware verdict.
- **EEPROM backup** is detected but not implemented — its serial protocol over DMA is a separate job from SRAM/Flash, and no test ROM in the corpus covers it.

## Goal

Sound, then a compatibility sweep that closes out the project's technical goal.

## Audio — the three-owner subsystem

Direct Sound spans CPU (timers), memory (DMA) and audio (FIFO). **Those three coordinate on the
interface before anyone implements.**

- [ ] Four legacy PSG channels (same shape as Phase 07, with `SOUNDCNT_H` volume options).
- [ ] **Two Direct Sound FIFO channels** — fed by DMA 1/2, paced by timer 0 or 1. A timer overflow
      pops a byte from the 32-bit FIFO; at half-empty, DMA refills it. **Model the FIFO and the
      timer-driven pop rate** — not an averaged sample rate. This is the system real games use.
- [ ] Reuse the Phase 07 AudioWorklet ring-buffer output path unchanged.

## Compatibility sweep

- [ ] Run the full corpus across GB, GBC and GBA. Publish the scoreboard.
- [ ] Compatibility testing with **legally supplied** ROMs only, per roadmap §45. The Pokémon titles
      listed there are **compatibility targets, not ROMs to distribute** — nothing is bundled,
      hosted, linked, or committed.
- [ ] For each failure: minimal repro — mapper, frame number, subsystem state at divergence, and
      where possible a handwritten test case. Never file "game X hangs".
- [ ] Trace-log diff against mGBA to localize divergences.

## Exit gate

- [ ] jsmolka/gba-tests audio suites pass. (`emu-accuracy-tester`)
- [ ] Zero underruns over a sustained run; clean in Chrome, Firefox and Safari. (`webboy-app-qa`)
- [ ] Full scoreboard published across all three systems; every expected-fail carries a recorded reason.
- [ ] Final privacy audit clean; no ROM or save data leaves the device on any path.
- [ ] No commercial ROM anywhere in the repo **or its git history**.
- [ ] **🏁 M7 — v2.0. Tag it.**

## Fetch before implementing

https://problemkaputt.de/gbatek.htm — GBA Sound Controller, Sound Channels 1-4, DMA Sound.

## After this

Roadmap §39 future features: gamepad polish, scaling filters, screenshot capture, recording/replay,
CPU profiler, local game-library metadata, PWA/offline. §40 stays out of scope — no multiplayer,
accounts, cloud ROM storage, ROM sharing, or leaderboards.
