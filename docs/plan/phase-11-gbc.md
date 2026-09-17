# Phase 11 — Game Boy Color — 🏳️ M6

**Owner:** all five builders · **Gate:** `emu-accuracy-tester`
**Depends on:** 10 · **Roadmap:** §26 GBC Phase
**Status:** ✅ Gate met — 2026-09-16. **cgb-acid2 renders pixel-exact (0/23040 pixels differ)**, and **every DMG gate is still green** — dmg-acid2 pixel-exact, sm83 500,000/500,000, all Blargg CPU/timing suites unchanged.

Built by **extending the DMG core in place**, as this phase requires — CGB mode is a flag on the existing PPU, MMU and APU, driven by the cartridge header. No forked core, so a bug is still fixed once.

| | |
|---|---|
| **cgb-acid2** | **pixel-exact** ← the gate |
| cgb-acid-hell | 2 / 23040 pixels differ |
| Blargg `cgb_sound` | 10 / 12 |
| DMG regressions | none |

> **The CGB sprite-priority rule was the whole gate.** cgb-acid2 sat at 12 differing pixels until priority was resolved by **OAM index alone** rather than by fetch order. On DMG the first-fetched sprite (smallest X) keeps a pixel; on CGB a lower-indexed sprite fetched *later* must still win, so the merge now tracks which OAM index owns each FIFO slot.
>
> **A second DMG/CGB inversion:** powering the APU off **preserves** the length counters on DMG but **clears** them on CGB. Blargg's `08` and `11` assert opposite behaviour per machine, so it cannot be one rule. Worth +2 tests.
>
> **Not done:** **double-speed mode is stubbed** — `KEY1` (0xFF4D) reads and writes correctly, but `STOP` does not perform the actual speed switch, so the CPU and timer never run at 2x. Games that rely on it will run at half speed. This needs the Phase 03 scheduler to express the switch.
>
> **Remaining gaps:** cgb-acid-hell is 2 pixels off (one column, vertically swapped — needs dot-exact work), and the 2 remaining `cgb_sound` failures are the same DMG wave-RAM window issue tracked in Phase 07.

## Goal

Color, without duplicating the Game Boy. Roadmap §26 is explicit: **reuse the architecture where
hardware behavior is shared; do not copy the entire GB implementation.**

```text
GameBoyCore  →  shared GB behavior  →  GameBoyColorCore
                                        ├── GBC Memory
                                        ├── GBC PPU
                                        └── Speed Controller
```

If Phases 01–10 kept subsystems behind interfaces, this is composition. If they did not, fix the
seams here rather than forking the core — a forked core means every future bug is fixed twice.

## Tasks

**Memory** — `gb-memory-engineer`
- [ ] VRAM bank select `FF4F`; WRAM bank select `FF70` (**bank 0 aliases to 1**).
- [ ] **HDMA `FF51-FF55`** — general-purpose *and* HBlank-paced modes. HBlank HDMA moves 16 bytes per
      HBlank and **steals cycles**; games use it for mid-frame effects. Modeling it as an instant
      copy will visibly break graphics.
- [ ] MBC5 correctness matters most here (Phase 06).

**PPU** — `gb-ppu-engineer`
- [ ] Second VRAM bank; BG tile attributes in bank 1 (palette, bank, X/Y flip, priority).
- [ ] 8 BG + 8 OBJ palettes × 4 colors in CRAM, via index/data register pairs with auto-increment.
- [ ] **CGB sprite priority is by OAM index only** (not smallest-X as on DMG), and `LCDC` bit 0
      changes meaning to BG/window *priority*. Both interact with the attribute priority bit.
- [ ] **5-bit → 8-bit color expansion is `c << 3 | c >> 2`, not `c * 8`.** Add an optional color
      correction curve — raw CGB colors are oversaturated on a modern sRGB display.

**CPU / scheduler** — `gb-cpu-engineer`
- [ ] Double speed via `KEY1`/`FF4D` and the `STOP` switch sequence. **CPU and timer double; the PPU
      does not.** The Phase 03 scheduler should already express this.

**Audio** — `gb-audio-io-engineer`
- [ ] Frame sequencer clocks from **DIV bit 5** in double speed. CGB wave-RAM and length-counter
      behavior differs from DMG.

**App** — `webboy-frontend-engineer`
- [ ] CGB flag (`0x0143`: `0x80` enhanced, `0xC0` CGB-only) routes core selection; DMG palette
      selection for DMG games running in CGB mode.

## Exit gate — `emu-accuracy-tester`

- [ ] **cgb-acid2 — zero differing pixels.** Then **cgb-acid-hell**.
- [ ] Blargg **`cgb_sound`** 12/12.
- [ ] Mooneye CGB-specific acceptance tests, including double-speed timing.
- [ ] **Every DMG gate from 01–10 still green.** Adding color must not regress the Game Boy.
- [ ] 🏁 M6 — v1.1. Tag it.

## Fetch before implementing

https://gbdev.io/pandocs/ CGB Registers, Palettes, VRAM banking, HDMA.
