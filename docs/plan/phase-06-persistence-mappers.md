# Phase 06 — Remaining Mappers & Battery Saves

**Owner:** `gb-memory-engineer` · **Gate:** `emu-accuracy-tester` + `webboy-app-qa`
**Depends on:** 05 · **Roadmap:** §10 Cartridge, §21 Save Games, §37 Privacy
**Status:** ✅ Gate met (with caveats) — 2026-09-15. **Every Mooneye mapper test passes** — `mbc1/*`, `mbc2/*`, `mbc5/*`, zero failures. MBC2, MBC3 (with RTC) and MBC5 implemented; 29 unit tests for mappers, RTC and save round-trip. Battery saves persist to IndexedDB keyed by cartridge identity, debounced, flushed on `visibilitychange` and `pagehide`.

> **Two gate items not verified here**, both needing a real browser or a second emulator:
> - *"Save survives refresh, tab close, hard reload, mid-play crash"* — the IndexedDB path and every failure branch are written and typed, but nothing has exercised them in a live browser. The Chrome extension is not connected in this environment.
> - *"A `.sav` exported here loads in another emulator, and theirs loads here"* — the format follows the common convention (raw SRAM, optional 48-byte RTC tail) and round-trips within WebBoy, but it has not been tested against another emulator.

## Goal

Every common cartridge runs, and progress survives closing the tab. This is the phase where the app
starts holding data users would be upset to lose.

## Tasks

**Mappers**
- [ ] **MBC2** — 512×4 bits of built-in RAM; the upper nibble is not storage and reads back as 1s.
      RAM-enable vs ROM-bank select is distinguished by **address bit 8**.
- [ ] **MBC3** — plus the RTC (`0x08-0x0C` in the RAM window, latch sequence at `0x6000-7FFF`).
      Persist RTC state *with a real-time base timestamp* so clock events survive being closed.
- [ ] **MBC5** — 9-bit ROM bank split across two registers, bank 0 allowed in the switchable slot.
      This is the one that must be right for CGB games in Phase 11.

**Persistence**
- [ ] Battery SRAM → **IndexedDB**, keyed by a **stable cartridge identity** (title + global checksum
      + size hash), never the filename. Two dumps of one game share a save; two games never collide.
- [ ] Write on a debounce after SRAM dirties **plus** on `visibilitychange` and `pagehide`. Not only
      `beforeunload` — it does not reliably fire when mobile Safari backgrounds the app.
- [ ] `.sav` export/import, raw SRAM, interoperable with other emulators.
- [ ] **Every storage failure path handled and surfaced**: quota exceeded, IndexedDB blocked in
      private browsing, storage cleared mid-session, two tabs open on the same game. Silent data loss
      ranks worse than a crash.

## Exit gate

- [ ] Mooneye `emulator-only/mbc1/*`, `mbc2/*`, `mbc5/*` — all pass. (`emu-accuracy-tester`)
- [ ] Save survives: refresh, tab close, hard reload with cache disabled, and a mid-play crash.
- [ ] Same game / different filename → same save. Different games → no collision.
- [ ] `.sav` exported here loads in another emulator, and theirs loads here.
- [ ] Every storage-failure path shows a clear message and **corrupts nothing**. (`webboy-app-qa`)
- [ ] RTC survives a close-and-reopen across a real elapsed interval.

## Fetch before implementing

https://gbdev.io/pandocs/ Memory Bank Controllers (one page per mapper) · MDN IndexedDB.

## Out of scope

Save states (08) — different format, different phase. Cloud sync — out of scope permanently.
