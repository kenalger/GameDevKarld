# Phase 08 — Save States — 🏳️ M4

**Owner:** `gb-memory-engineer` · **Supporting:** every subsystem owner supplies its own serializer · **Gate:** `webboy-app-qa`
**Depends on:** 06, 07 · **Roadmap:** §22 Save States
**Status:** ✅ Gate met — 2026-09-15. **Round-trip determinism verified: serialize → deserialize → 1000 frames produces a byte-identical framebuffer and CPU state to an uninterrupted run.** Versioned binary container (magic + format version + cartridge fingerprint), 12 tests covering the container's refusal paths, 4 save slots with thumbnails, `.state` export/import.

> **Refusal over misparse, everywhere:** a wrong magic, a future format version, a state from a different game, and a truncated file each throw a specific error rather than loading something plausible-but-wrong. A state that appears to load and then corrupts the save is worse than one that will not load.
>
> **Not verified:** the IndexedDB slot storage has not been exercised in a real browser (no Chrome extension here), and no state written by a genuinely older build exists to test migration against — only a synthetically bumped version byte.

## Goal

Complete machine state captured, restored exactly, and versioned so next month's build can still
load today's state.

## Tasks

**Format** — `gb-memory-engineer` owns the container
- [ ] **Versioned binary, not JSON.** Prototype with JSON if it unblocks you; ship a single
      `ArrayBuffer` with a magic number, format version, and a per-subsystem section table.
- [ ] Every subsystem exposes `serialize(): ArrayBuffer` / `deserialize(buf)`. Memory owns the
      container and the **migration path**. A state that next month's build cannot load is worse
      than no state at all.
- [ ] Bump the version on any layout change, with a migration or an explicit refusal — never a
      silent misparse.

**State coverage** (roadmap §22) — each owner supplies theirs
- [ ] CPU registers, flags, PC, SP, IME/IE/IF, HALT state, scheduler cycle counters — `gb-cpu-engineer`
- [ ] WRAM, VRAM, OAM, HRAM, I/O, cartridge banking state, external RAM — `gb-memory-engineer`
- [ ] PPU mode, dot counter, LY, window internal line counter, FIFO state, palettes — `gb-ppu-engineer`
- [ ] APU channel state, frame sequencer step, wave RAM; input latch — `gb-audio-io-engineer`

**UI** — `webboy-frontend-engineer`
- [ ] Multiple slots, save/load, `.state` export/import, and **thumbnails** captured from the
      framebuffer at save time.

## Exit gate — `webboy-app-qa`

- [ ] **Round-trip determinism**: serialize → deserialize → run 1000 frames → framebuffer *and*
      register state byte-identical to an uninterrupted run. Automated, in CI.
- [ ] Round-trip through file export and re-import.
- [ ] A state from the previous build loads, or is refused with a clear message. Never misparsed.
- [ ] A `.state` from a different game is rejected cleanly.
- [ ] Save states never leave the device. (network log)
- [ ] **🏁 M4 — sessions persist.**

## Traps

- Anything non-deterministic in the core (wall-clock, `Math.random`, floats) breaks round-trip
  testing and is itself a bug — report it rather than loosening the test.
- MBC3's RTC needs its real-time base included, or loading a state rewinds the clock.
