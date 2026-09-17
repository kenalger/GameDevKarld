# Graphics

## The architecture decision (Phase 04)

**WebBoy uses a pixel FIFO, not a scanline renderer.**

| | Scanline | Pixel FIFO |
|---|---|---|
| Effort | Lower | Substantially higher |
| Passes dmg-acid2 | Yes, with care | **Yes** |
| Mid-scanline register writes / Mealybug | **No** | Yes |
| Retrofit cost later | **Full PPU rewrite** | — |

**Rationale.** A scanline renderer composes each line at HBlank and therefore cannot express a
write to `SCX`, `LCDC` or a palette register that lands *during* mode 3 — the raster effects real
games use constantly. Since retrofitting the FIFO later means rewriting the PPU, it is built this
way from the start. The decision was taken deliberately rather than by default, as
`docs/plan/phase-04-ppu.md` requires.

## How it works

The PPU models the hardware's two fetchers and FIFOs, pushing one pixel per dot:

```text
        VRAM
          │
   background fetcher ──▶ BG FIFO (8) ──┐
   (tile → low → high → push,           ├──▶ mix ──▶ framebuffer
    2 dots per step)                    │
   sprite fetcher ──────▶ sprite FIFO ──┘
```

Consequences that fall out of the model rather than being hard-coded:

- **Mode 3's length is emergent.** It stretches with `SCX % 8`, with window activation, and with
  every sprite fetched. Measured baseline is 175 dots against a legal range of 172–289.
- **The first tile fetch of each line is discarded.** Six dots that are otherwise unexplained, and
  without them mode 3 is illegally short (167 dots).
- **The BG fetcher pushes only into an empty FIFO.** Pushing while the previous tile's pixels
  remain leaves a stale pixel at every tile boundary.
- **A sprite is fetched before the pixel at its X is emitted**, and only once the BG FIFO is
  non-empty. Getting this order wrong drops the leftmost column of every sprite — which is exactly
  how dmg-acid2 failed at 147 pixels before it was fixed.

## Palettes

The DMG's four shades are not greys; the panel is green. `PALETTE_DMG_GREEN` is the default,
with `PALETTE_GREY` and `PALETTE_POCKET` available. The palette is a **display choice, not
emulation state** — screenshot tests therefore compare in `PALETTE_GREY`, which is what the
reference PNGs are rendered in (255/170/85/0).

## Output path

`Uint8ClampedArray` → `ImageData` → `putImageData` → canvas, allocated once and mutated. No WebGL
until profiling demands it. The backing canvas is native 160×144 and CSS scales it with
`image-rendering: pixelated`; a blurry emulator screen is the most common amateur tell.

The PPU imports no DOM API. It fills a buffer; the frontend displays it.

## Known gaps

- Mooneye `ppu/intr_2_*`, `lcdon_*`, `stat_lyc_onoff` and `vblank_stat_intr` need dot-exact mode
  transitions that the current implementation does not yet reach.
- Mealybug Tearoom is not yet attempted; the FIFO makes it reachable, which was the point.
- CGB colour, the second VRAM bank and HDMA arrive in Phase 11.
