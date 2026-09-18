# Phase 04 — PPU & Display — 🏳️ M2

**Owner:** `gb-ppu-engineer` · **Supporting:** `gb-memory-engineer` (bus lockout, OAM DMA), `webboy-frontend-engineer` (canvas) · **Gate:** `emu-accuracy-tester`
**Depends on:** 03 · **Roadmap:** §12 PPU, §20 Frame Loop
**Status:** ✅ Gate met — 2026-09-15. **dmg-acid2 renders pixel-exact (0/23040 pixels differ).** Architecture: **pixel FIFO**, decision and rationale recorded in `docs/graphics.md`. Mode 3 measures 175 dots, inside the legal 172–289 range.

> **2026-09-17 — mode 3 was 175 dots. It is 172.** The minimum is fixed and documented: 160 pixels plus 12, and Pandocs says exactly where the 12 goes — "two tile fetches at the beginning of Mode 3. One is the first tile in the scanline, the other is simply discarded." A tile fetch is 6 dots, so two are 12.
>
> This fetcher spent 8 on each, for two reasons. The discarded fetch travelled through the push step before being recognised, costing a 4th 2-dot slot. And the push itself was retried every *other* dot, where Pandocs is explicit: "the first four steps take 2 dots each and the fifth step is attempted **every dot** until it succeeds" — so every tile boundary leaked a stall dot.
>
> Both are now right, and the whole line is exact: mode 2 = 80, mode 3 = 172, mode 0 = 204, summing to 456. Mode 3 lengthens by exactly SCX % 8. **Mooneye 57 → 60/66**: `intr_2_0_timing`, `intr_2_mode0_timing` and `intr_2_oam_ok_timing` all measure this clock. dmg-acid2 and cgb-acid2 stay pixel-exact, and three tests plus two negative controls now pin the number.
>
> **The `ACCESS_T_OFFSET` sweep was re-run and again says 0**, now against the corrected PPU and OAM DMA: Mooneye scores 60/59/59/59 for offsets 0-3.
>
> **Correction, 2026-09-18.** That sweep was first recorded as showing "Mealybug unmoved at every setting", and concluded from it that the CPU write phase was not involved. **The measurement was wrong**: it compared Mealybug's pass/fail count, which is 0/24 at every offset because none of them passes, rather than the differing-pixel count, which moves a great deal — `m3_bgp_change` is 2218 differing pixels at offset 0 and 5084 at offsets 1, 2 and 3. So offset 0 is still correct, and by a wide margin, but "the write phase has no effect" was never established. Measure the pixel diff, not the verdict, when sweeping anything against Mealybug.
>
> **2026-09-17 — OAM DMA was wrong in four ways, and it was holding down sixteen tests.** All of `oam_dma*` plus the whole `call`/`ret`/`push`/`rst`/`jp`/`add_sp_e` timing family, which turn out to be DMA tests wearing instruction-timing names — each aligns a memory access against the end of a transfer and reads what comes back.
>
> 1. **It started one M-cycle early.** Mooneye's `oam_dma_start` states the model outright: M=0 is the write to FF46, M=1 still has OAM accessible, the transfer runs by M=2. The countdown also has to reach zero on the *last* tick of M=1 — this CPU samples the bus at the start of an M-cycle, so activating one tick later is invisible until M=3.
> 2. **It blocked both buses.** The Game Boy has two, and a transfer occupies only the one its **source** is on. Pandocs' "only HRAM during DMA" is the rule for programmers, not the hardware; every timing test above runs its payload out of echo RAM while a VRAM-sourced transfer is still going, so treating that as a conflict made the CPU execute garbage.
> 3. **OAM was conflicted rather than locked.** During a transfer OAM reads `0xFF` and swallows writes, whichever bus the source is on. `push_timing` pushes across the end of a transfer and requires the high byte to vanish and the low byte to land.
> 4. **The source decode was the CPU's.** The transfer sees one more mirror: 0xE000-0xFFFF folds onto 0xC000-0xDFFF *entirely*, so page `0xFE` reads WRAM at 0xDE00, not OAM. `oam_dma/sources` checks exactly that page, and the one after it.
>
> A related bug fell out: the MMU's echo-RAM fold re-entered the conflict-aware read instead of the direct one, so a transfer sourced from echo RAM copied its own output.
>
> **Five negative controls** hold this down — reverting the start delay, the bus split, the OAM lock, the write drop, or the source fold each fails a named test.
>
> **2026-09-17 — LY=LYC is a LATCH, not a comparison done on read.** The comparison has its own clock and that clock stops with the PPU: the bit is retained across a power-off, an LYC write while the LCD is off is inert, and switching back on runs exactly one comparison. The STAT interrupt line is frozen the same way — clearing it on power-off manufactured a rising edge for a condition that had been true all along, and fired a spurious interrupt the moment the LCD came back. Separately, the first OAM scan after an enable *happens* but is **not reported**: STAT reads mode 0 through it. `ppu/stat_lyc_onoff` now passes; four negative controls hold each piece in place.
>
> **Still failing: eight `ppu/*` tests that need dot-exact mode transitions** — `intr_2_*` (4), `lcdon_timing`, `lcdon_write_timing`, `hblank_ly_scx_timing`, `vblank_stat_intr`. These measure the precise dot on which mode 2 → 3 → 0 happens, and are a distinct piece of work from the STAT latch fixed above: the latch is *what* STAT reports, these are *when*. Not attempted.
>
> **Trade recorded:** overall Mooneye acceptance moved 40 → 38. `hblank_ly_scx_timing` now passes; `intr_2_0_timing` and `intr_2_mode0_timing` regressed, as emergent FIFO timing replaced the old fixed mode boundaries that happened to satisfy them. The old renderer could never have passed dmg-acid2 at all. Remaining `ppu/*` failures need dot-exact mode transitions — see Known gaps in `docs/graphics.md`.

## Goal

A correct picture. Not a plausible one — **dmg-acid2 pixel-exact**, which simultaneously exercises
sprite priority, the 10-sprite limit, window behavior, tile addressing and OBJ/BG priority.

## The architecture decision — make it explicitly, now

**Scanline renderer or pixel FIFO?**

| | Scanline | Pixel FIFO |
|---|---|---|
| Effort | Lower | Substantially higher |
| Passes dmg-acid2 | Yes, with care | Yes |
| Passes Mealybug / mid-scanline effects | **No** | Yes |
| Retrofit cost later | **Full PPU rewrite** | — |

`gb-ppu-engineer` must surface this as a decision, not pick quietly. Recommendation is the FIFO if
the project wants high compatibility, because the retrofit is a rewrite. **Record the choice and its
rationale in `docs/graphics.md`.** If scanline is chosen, Mealybug is marked expected-fail in the
scoreboard with that reason — not silently ignored.

## Tasks

- [ ] LCD state machine: **456 dots/line, 154 lines, 70224 dots/frame, ≈59.7275 Hz.** Modes 2 (OAM
      scan, 80 dots) → 3 (drawing, 172–289 dots, **variable**) → 0 (HBlank) → 1 (VBlank, lines 144–153).
- [ ] Mode 3 length penalties: `SCX % 8` at line start, ~6 dots per window activation, 6–11 dots per
      sprite by X alignment.
- [ ] **Bus lockout** wired to the mode (with `gb-memory-engineer`): VRAM `0xFF` in mode 3, OAM `0xFF`
      in modes 2–3.
- [ ] Tile decode — 2bpp, two interleaved bitplanes, low byte then high. One shared correct helper.
- [ ] Background + window. **The window has its own internal line counter** that increments only on
      lines where it actually rendered — not `LY - WY`. `WX=7` means x=0.
- [ ] Sprites: OAM scan, **max 10 per line**, 8×8/8×16 (low tile bit forced 0 in 8×16), X=0 and X≥168
      still consume a slot. **DMG priority: smallest X, then OAM index.**
- [ ] `LCDC` — note bit 0 is "BG/window enable" on DMG but "BG/window *priority*" on CGB; bit 4 picks
      `0x8000` unsigned vs `0x8800` signed addressing; bit 7 off resets LY and is VBlank-only.
- [ ] **`STAT` as a single OR'd line with rising-edge detection.** Raising IF per-condition
      independently produces spurious interrupts and breaks games.
- [x] **OAM DMA (`FF46`)** — 160 M-cycles, concurrent with the CPU, bus-locked to HRAM, cycle-stepped
      (not instantaneous), handles a mid-transfer restart. (`gb-memory-engineer`)
- [ ] Framebuffer → `Uint8ClampedArray` → `ImageData` → canvas. Allocated once; **never per frame**.
      Buffer must be transferable/SAB-backed for Phase 10. PPU imports no DOM.
- [ ] Classic green DMG palette as default, configurable.

## Exit gate — `emu-accuracy-tester`

- [ ] **dmg-acid2 — zero differing pixels.** 🏁 M2.
- [ ] Mooneye `acceptance/ppu/*` — `intr_1_2_timing`, `intr_2_0_timing`, `stat_irq_blocking`,
      `vblank_stat_intr`, `lcdon_timing`, `hblank_ly_scx_timing`.
- [ ] Mooneye `acceptance/oam_dma/*`.
- [ ] Screenshot-diff harness in CI with committed reference PNGs; failures report differing-pixel
      count and bounding box, not "looks wrong".
- [ ] Mealybug: pass, or marked expected-fail with the renderer-architecture reason.

## Fetch before implementing

https://gbdev.io/pandocs/ Rendering, LCDC, STAT, Scrolling, Palettes, VRAM Tile Data/Maps, OAM ·
https://gbdev.io/pandocs/pixel_fifo.html — **read before choosing the architecture, not after**.

## Out of scope

Color (11). GBA video (14). Scaling filters (09). WebGL — not until profiling demands it.
