# Phase 14 — GBA: Video

**Owner:** `gb-ppu-engineer` · **Gate:** `emu-accuracy-tester`
**Depends on:** 13 · **Roadmap:** §30 GBA Graphics
**Status:** ✅ Gate met — 2026-09-17. **All six video modes, sprites, affine backgrounds and sprites, windows, mosaic and colour special effects.** 42 tests; no regressions across GB, GBC or GBA CPU/memory.

| Built | |
|---|---|
| Modes 0, 1, 2 | text + **affine** backgrounds, wraparound vs transparent |
| Modes 3, 4, 5 | bitmap, incl. page flipping |
| Sprites | all sizes, 1D/2D mapping, flip, priority, **OBJ window**, **semi-transparent**, **affine + double-size** |
| Windows | win0, win1, OBJ window, WININ/WINOUT per-layer gating |
| Effects | alpha blend, brightness increase/decrease, per-layer targets |
| Mosaic | BG and OBJ, horizontal and vertical, incl. affine backgrounds |

> **Affine reference points latch at VBlank and advance by PB/PD each scanline** — and a write *outside* VBlank repositions the **current** scanline rather than waiting for the next frame. That asymmetry is what makes a rotating layer reposition correctly mid-screen, and it is tested.
>
> The compositor became two layers deep so alpha blending can reach what sits *under* the top pixel. Layer numbering matches BLDCNT target bits exactly, so a blend check is one shift.
>
> **Mosaic quantises in SCREEN space, not layer space.** Tonc describes it as dividing "your sprite or background" into blocks, which reads as layer-local — but GBATEK's two notes settle it: you re-centre a background's blocks by *scrolling* it, and a sprite's by *moving* it. Neither would change anything if the grid travelled with the layer. So every quantisation is on the screen coordinate, and a test pins that down by scrolling a mosaiced background and checking the block boundaries stay put.
>
> **Vertical mosaic on an affine layer cannot quantise a coordinate** the way a text layer can — the transform makes every scanline start somewhere different, so there is no map coordinate to round. The whole internal reference point is frozen for the block instead.
>
> **Affine sprites reuse attr1 bits 9-13 for the parameter group**, the same bits that mean "flip X / flip Y" on a normal sprite. Group 24 has the flip-both bit pattern, so a decoder that misses this silently applies the wrong transform; that exact case is a test.
>
> **Six negative controls back this section.** Dropping PA, PB, PC, PD, the parameter group, the double-size box, or either mosaic axis each makes a named test fail — checked by sabotaging the renderer and re-running. The first attempt at these tests passed a sabotaged PA and PC, because they only probed the vertical axis; the mirror and shear tests exist because of that.
>
> **Not built:** nothing from the phase list remains.
>
> **Still no reference-screenshot comparison.** The new tests compute expected pixel values from the GBATEK blend formulas — stronger than the earlier structural assertions, but not the pixel-exact PNG diff the DMG/CGB phases have.

## Goal

240×160 output across all modes. Roadmap §30: **do not implement every feature simultaneously —
start with the simplest mode and build upward.**

## Order — deliberately incremental

1. [x] **Mode 0** (four tiled backgrounds) and **Mode 4** (8-bit bitmap + page flip). Most coverage
       for least complexity; get a picture on screen here.
2. [x] **Sprites/OBJ** — object attributes, sizes, tile mapping (1D/2D), priority.
3. [x] **Modes 1 and 2** — affine backgrounds. Internal reference-point registers **latch at VBlank
       and increment per scanline**; writing `BGxX`/`BGxY` mid-frame does not behave the naive way.
4. [x] **Modes 3 and 5** — remaining bitmap modes.
5. [x] **Windows** — win0, win1 and the OBJ window, with per-layer enable bits.
6. [x] **Color special effects** — alpha blend, brightness increase/decrease, with their per-layer
       target bits. Then **mosaic**, then **affine OBJ**.

**Render per scanline.** A frame-at-a-time GBA renderer cannot express the raster effects games use
constantly. Reuse the Phase 04 framebuffer → `ImageData` → canvas path at 240×160.

## Exit gate — `emu-accuracy-tester`

- [ ] jsmolka/gba-tests video suites pass.
- [ ] A screenshot-diff reference set exists for each mode, committed, in CI.
- [ ] Standard GBA demo ROMs render correctly across all six modes.
- [ ] All prior gates green.

## Fetch before implementing

https://problemkaputt.de/gbatek.htm — LCD I/O Registers, BG Modes, OBJ, Windows, Color Special
Effects, Rotation/Scaling · https://gbadev.net/tonc/ for how games actually drive the hardware.
