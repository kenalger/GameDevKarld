import type { StateReader, StateWriter } from '../../gb/state/StateBuffer.js';
import { IRQ_HBLANK, IRQ_VBLANK, IRQ_VCOUNT } from '../memory/GbaMmu.js';

export const GBA_WIDTH = 240;
export const GBA_HEIGHT = 160;

/** 308 dots per scanline, 228 lines per frame — 160 visible, 68 of VBlank. */
export const DOTS_PER_LINE = 308;
export const VISIBLE_DOTS = 240;
export const LINES_PER_FRAME = 228;

export interface PpuHost {
  readonly vram: Uint8Array;
  readonly palette: Uint8Array;
  readonly oam: Uint8Array;
  readIo16(address: number): number;
  requestInterrupt(mask: number): void;
  onHBlank(): void;
  onVBlank(): void;
}

/**
 * Layer numbering, chosen to match BLDCNT's target bits exactly — a blend check is then a
 * single shift rather than a lookup.
 */
const LAYER_OBJ = 4;
const LAYER_BACKDROP = 5;

/** Background control register fields. */
interface BgConfig {
  priority: number;
  charBase: number;
  mosaic: boolean;
  /** True for 8bpp (256 colours), false for 4bpp (16 palettes of 16). */
  fullColour: boolean;
  screenBase: number;
  /** 0-3: 256x256, 512x256, 256x512, 512x512. */
  size: number;
  wrap: boolean;
}

/**
 * The GBA PPU.
 *
 * Renders per scanline, not per frame: games change scroll registers and palettes mid-frame
 * constantly, and a frame-at-a-time renderer cannot express that.
 *
 * Modes implemented in the order the plan prescribes — tiled mode 0 and bitmap mode 4 first,
 * because between them they cover the most ground for the least complexity, then the
 * remaining bitmap modes, then sprites.
 */
export class GbaPpu {
  /** RGBA output at native resolution. Allocated once; never reallocated. */
  readonly frameBuffer = new Uint8ClampedArray(GBA_WIDTH * GBA_HEIGHT * 4);

  dispcnt = 0x0080;
  dispstat = 0;
  vcount = 0;

  private dot = 0;

  /** Per-background scroll, control and the composited scanline. */
  private readonly bgControl = new Uint16Array(4);
  private readonly bgHofs = new Uint16Array(4);
  private readonly bgVofs = new Uint16Array(4);

  /**
   * Affine parameters for BG2 and BG3 (index 0 = BG2).
   *
   * PA-PD are 8.8 fixed point; X/Y are 19.8. The `internal` copies are what actually
   * renders: they are reloaded from X/Y at VBlank and advanced by PB/PD every scanline.
   */
  private readonly bgPA = new Int16Array(2);
  private readonly bgPB = new Int16Array(2);
  private readonly bgPC = new Int16Array(2);
  private readonly bgPD = new Int16Array(2);
  private readonly bgRefX = new Int32Array(2);
  private readonly bgRefY = new Int32Array(2);
  private readonly bgInternalX = new Int32Array(2);
  private readonly bgInternalY = new Int32Array(2);
  /** The internal reference frozen at the top of the current vertical mosaic block. */
  private readonly mosaicAffineX = new Int32Array(2);
  private readonly mosaicAffineY = new Int32Array(2);

  /** Window rectangles, WININ/WINOUT layer gates, and the blend registers. */
  private readonly winH = new Uint16Array(2);
  private readonly winV = new Uint16Array(2);
  /** MOSAIC (0x400004C): BG H/V in the low byte, OBJ H/V in the high byte, each minus 1. */
  private mosaic = 0;
  private winIn = 0;
  private winOut = 0;
  private bldcnt = 0;
  private bldalpha = 0;
  private bldy = 0;

  /**
   * One scanline of composited output.
   *
   * Two layers deep, because alpha blending needs whatever sits *under* the top pixel.
   * `layer` is 0-3 for backgrounds, 4 for sprites, 5 for the backdrop — the same numbering
   * BLDCNT uses for its target bits, so a blend check is a single shift.
   */
  private readonly lineColour = new Uint16Array(GBA_WIDTH);
  private readonly linePriority = new Uint8Array(GBA_WIDTH);
  private readonly lineIsSprite = new Uint8Array(GBA_WIDTH);
  private readonly lineLayer = new Uint8Array(GBA_WIDTH);
  private readonly belowColour = new Uint16Array(GBA_WIDTH);
  private readonly belowLayer = new Uint8Array(GBA_WIDTH);
  /** Set where a sprite asked for alpha blending regardless of BLDCNT's mode. */
  private readonly lineObjBlend = new Uint8Array(GBA_WIDTH);
  /** Set where the OBJ window's mask sprite covers this pixel. */
  private readonly lineObjWindow = new Uint8Array(GBA_WIDTH);

  constructor(private readonly host: PpuHost) {
    this.frameBuffer.fill(0xff);
  }

  /**
   * Save-state.
   *
   * VRAM, palette and OAM belong to the MMU and are written there. What lives here is the
   * register file plus the affine *internal* reference points — those advance every
   * scanline and are NOT recoverable from BGxX/BGxY, so a state restored without them
   * would jump a rotating background back to its frame-start position.
   */
  saveState(w: StateWriter): void {
    w.u16(this.dispcnt);
    w.u16(this.dispstat);
    w.u16(this.vcount);
    w.u32(this.dot);
    for (let i = 0; i < 4; i++) w.u16(this.bgControl[i]!);
    for (let i = 0; i < 4; i++) w.u16(this.bgHofs[i]!);
    for (let i = 0; i < 4; i++) w.u16(this.bgVofs[i]!);
    for (let i = 0; i < 2; i++) w.u16(this.bgPA[i]! & 0xffff);
    for (let i = 0; i < 2; i++) w.u16(this.bgPB[i]! & 0xffff);
    for (let i = 0; i < 2; i++) w.u16(this.bgPC[i]! & 0xffff);
    for (let i = 0; i < 2; i++) w.u16(this.bgPD[i]! & 0xffff);
    for (let i = 0; i < 2; i++) w.u32(this.bgRefX[i]! >>> 0);
    for (let i = 0; i < 2; i++) w.u32(this.bgRefY[i]! >>> 0);
    for (let i = 0; i < 2; i++) w.u32(this.bgInternalX[i]! >>> 0);
    for (let i = 0; i < 2; i++) w.u32(this.bgInternalY[i]! >>> 0);
    for (let i = 0; i < 2; i++) w.u32(this.mosaicAffineX[i]! >>> 0);
    for (let i = 0; i < 2; i++) w.u32(this.mosaicAffineY[i]! >>> 0);
    for (let i = 0; i < 2; i++) w.u16(this.winH[i]!);
    for (let i = 0; i < 2; i++) w.u16(this.winV[i]!);
    w.u16(this.mosaic);
    w.u16(this.winIn);
    w.u16(this.winOut);
    w.u16(this.bldcnt);
    w.u16(this.bldalpha);
    w.u16(this.bldy);
  }

  loadState(r: StateReader): void {
    this.dispcnt = r.u16();
    this.dispstat = r.u16();
    this.vcount = r.u16();
    this.dot = r.u32();
    for (let i = 0; i < 4; i++) this.bgControl[i] = r.u16();
    for (let i = 0; i < 4; i++) this.bgHofs[i] = r.u16();
    for (let i = 0; i < 4; i++) this.bgVofs[i] = r.u16();
    for (let i = 0; i < 2; i++) this.bgPA[i] = r.u16();
    for (let i = 0; i < 2; i++) this.bgPB[i] = r.u16();
    for (let i = 0; i < 2; i++) this.bgPC[i] = r.u16();
    for (let i = 0; i < 2; i++) this.bgPD[i] = r.u16();
    for (let i = 0; i < 2; i++) this.bgRefX[i] = r.u32() | 0;
    for (let i = 0; i < 2; i++) this.bgRefY[i] = r.u32() | 0;
    for (let i = 0; i < 2; i++) this.bgInternalX[i] = r.u32() | 0;
    for (let i = 0; i < 2; i++) this.bgInternalY[i] = r.u32() | 0;
    for (let i = 0; i < 2; i++) this.mosaicAffineX[i] = r.u32() | 0;
    for (let i = 0; i < 2; i++) this.mosaicAffineY[i] = r.u32() | 0;
    for (let i = 0; i < 2; i++) this.winH[i] = r.u16();
    for (let i = 0; i < 2; i++) this.winV[i] = r.u16();
    this.mosaic = r.u16();
    this.winIn = r.u16();
    this.winOut = r.u16();
    this.bldcnt = r.u16();
    this.bldalpha = r.u16();
    this.bldy = r.u16();
  }

  reset(): void {
    this.dispcnt = 0x0080;
    this.dispstat = 0;
    this.vcount = 0;
    this.dot = 0;
    this.bgControl.fill(0);
    this.bgHofs.fill(0);
    this.bgVofs.fill(0);
    // Identity transform: PA and PD of 1.0 in 8.8 fixed point.
    this.bgPA.fill(0x0100);
    this.bgPB.fill(0);
    this.bgPC.fill(0);
    this.bgPD.fill(0x0100);
    this.bgRefX.fill(0);
    this.bgRefY.fill(0);
    this.bgInternalX.fill(0);
    this.bgInternalY.fill(0);
    this.mosaicAffineX.fill(0);
    this.mosaicAffineY.fill(0);
    this.winH.fill(0);
    this.winV.fill(0);
    this.mosaic = 0;
    this.winIn = 0;
    this.winOut = 0;
    this.bldcnt = 0;
    this.bldalpha = 0;
    this.bldy = 0;
    this.frameBuffer.fill(0xff);
  }

  get mode(): number {
    return this.dispcnt & 7;
  }

  /** DISPCNT bit 7 forces a blank white screen regardless of everything else. */
  get forcedBlank(): boolean {
    return (this.dispcnt & 0x0080) !== 0;
  }

  /** Advances one dot. Returns true on the dot VBlank begins. */
  tick(): boolean {
    let frameComplete = false;
    this.dot++;

    if (this.dot === VISIBLE_DOTS) {
      // Entering HBlank. Visible lines render here, one line at a time.
      if (this.vcount < GBA_HEIGHT) this.renderScanline(this.vcount);
      this.dispstat |= 0x0002;
      if ((this.dispstat & 0x0010) !== 0) this.host.requestInterrupt(IRQ_HBLANK);
      this.host.onHBlank();
    }

    if (this.dot >= DOTS_PER_LINE) {
      this.dot = 0;
      this.dispstat &= ~0x0002;
      this.vcount++;

      if (this.vcount === GBA_HEIGHT) {
        this.dispstat |= 0x0001;
        // The internal affine reference points are reloaded once per frame, here.
        this.reloadAffine();
        if ((this.dispstat & 0x0008) !== 0) this.host.requestInterrupt(IRQ_VBLANK);
        this.host.onVBlank();
        frameComplete = true;
      } else if (this.vcount >= LINES_PER_FRAME) {
        this.vcount = 0;
        this.dispstat &= ~0x0001;
      }

      // VCOUNT match is checked per line and has its own interrupt.
      const target = (this.dispstat >>> 8) & 0xff;
      if (this.vcount === target) {
        this.dispstat |= 0x0004;
        if ((this.dispstat & 0x0020) !== 0) this.host.requestInterrupt(IRQ_VCOUNT);
      } else {
        this.dispstat &= ~0x0004;
      }
    }

    return frameComplete;
  }

  /* --------------------------------- rendering -------------------------------- */

  private renderScanline(line: number): void {
    if (this.forcedBlank) {
      this.fillLine(line, 0xffffff);
      return;
    }

    // A vertical mosaic block repeats its first line, so the affine reference is frozen
    // here and every line in the block renders from the same origin.
    if (line % this.bgMosaicY === 0) {
      for (let i = 0; i < 2; i++) {
        this.mosaicAffineX[i] = this.bgInternalX[i]!;
        this.mosaicAffineY[i] = this.bgInternalY[i]!;
      }
    }

    // Backdrop: palette entry 0 shows wherever nothing else draws. It is layer 5, so
    // BLDCNT's backdrop target bit works without a special case.
    const backdrop = this.paletteColour(0);
    this.lineColour.fill(backdrop);
    this.belowColour.fill(backdrop);
    this.linePriority.fill(4);
    this.lineIsSprite.fill(0);
    this.lineLayer.fill(LAYER_BACKDROP);
    this.belowLayer.fill(LAYER_BACKDROP);
    this.lineObjBlend.fill(0);
    this.lineObjWindow.fill(0);

    // The OBJ window's mask must be known before any background is gated by it.
    if (this.objWindowEnabled) this.renderSprites(line, true);

    switch (this.mode) {
      case 0:
        this.renderTiledMode(line, 4);
        break;
      case 1:
        // Mode 1: BG0/BG1 are text layers, BG2 is affine.
        this.renderTiledMode(line, 2);
        this.renderAffineBackground(line, 2);
        break;
      case 2:
        // Mode 2: BG2 and BG3 are both affine; there are no text layers.
        this.renderAffineBackground(line, 2);
        this.renderAffineBackground(line, 3);
        break;
      case 3:
        this.renderBitmapMode3(line);
        break;
      case 4:
        this.renderBitmapMode4(line);
        break;
      default:
        this.renderBitmapMode5(line);
        break;
    }

    if ((this.dispcnt & 0x1000) !== 0) this.renderSprites(line, false);

    this.blitLine(line);
    this.advanceAffine();
  }

  /** Applies colour effects and writes the finished line into the framebuffer. */
  private blitLine(line: number): void {
    const mode = (this.bldcnt >>> 6) & 3;
    const firstTargets = this.bldcnt & 0x3f;
    const secondTargets = (this.bldcnt >>> 8) & 0x3f;
    const eva = Math.min(16, this.bldalpha & 0x1f);
    const evb = Math.min(16, (this.bldalpha >>> 8) & 0x1f);
    const evy = Math.min(16, this.bldy & 0x1f);

    let offset = line * GBA_WIDTH * 4;
    for (let x = 0; x < GBA_WIDTH; x++) {
      let colour = this.lineColour[x]!;
      const layerBit = 1 << this.lineLayer[x]!;

      // A window may switch colour effects off for the pixels it covers.
      if (this.effectsAllowedAt(x, line)) {
        // A semi-transparent sprite blends even when BLDCNT selects another mode.
        const forcedAlpha = this.lineObjBlend[x] === 1;
        if ((forcedAlpha || mode === 1) && (forcedAlpha || (firstTargets & layerBit) !== 0)) {
          const belowBit = 1 << this.belowLayer[x]!;
          if ((secondTargets & belowBit) !== 0) {
            colour = alphaBlend(colour, this.belowColour[x]!, eva, evb);
          }
        } else if (mode === 2 && (firstTargets & layerBit) !== 0) {
          colour = brighten(colour, evy);
        } else if (mode === 3 && (firstTargets & layerBit) !== 0) {
          colour = darken(colour, evy);
        }
      }

      this.frameBuffer[offset] = expand5(colour & 0x1f);
      this.frameBuffer[offset + 1] = expand5((colour >>> 5) & 0x1f);
      this.frameBuffer[offset + 2] = expand5((colour >>> 10) & 0x1f);
      this.frameBuffer[offset + 3] = 0xff;
      offset += 4;
    }
  }

  /**
   * Writes one pixel, keeping the displaced colour for alpha blending.
   *
   * Layers are drawn back to front, so an incoming pixel always wins — what it replaces
   * becomes the "below" colour that a blend can mix with.
   */
  private plot(x: number, colour: number, layer: number, priority: number): void {
    this.belowColour[x] = this.lineColour[x]!;
    this.belowLayer[x] = this.lineLayer[x]!;
    this.lineColour[x] = colour;
    this.lineLayer[x] = layer;
    this.linePriority[x] = priority;
  }

  /* --------------------------------- windows ---------------------------------- */

  private get win0Enabled(): boolean {
    return (this.dispcnt & 0x2000) !== 0;
  }

  private get win1Enabled(): boolean {
    return (this.dispcnt & 0x4000) !== 0;
  }

  private get objWindowEnabled(): boolean {
    return (this.dispcnt & 0x8000) !== 0;
  }

  private get anyWindowEnabled(): boolean {
    return this.win0Enabled || this.win1Enabled || this.objWindowEnabled;
  }

  /** True when (x, line) falls inside window `index`. */
  private insideWindow(index: number, x: number, line: number): boolean {
    const h = this.winH[index]!;
    const v = this.winV[index]!;
    const x1 = (h >>> 8) & 0xff;
    let x2 = h & 0xff;
    const y1 = (v >>> 8) & 0xff;
    let y2 = v & 0xff;

    // GBATEK: X2 > 240 or X1 > X2 is read as X2 = 240; likewise Y2 > 160 for rows.
    if (x2 > GBA_WIDTH || x1 > x2) x2 = GBA_WIDTH;
    if (y2 > GBA_HEIGHT || y1 > y2) y2 = GBA_HEIGHT;

    return x >= x1 && x < x2 && line >= y1 && line < y2;
  }

  /** The WININ/WINOUT gate byte that applies at this pixel. */
  private windowGate(x: number, line: number): number {
    if (this.win0Enabled && this.insideWindow(0, x, line)) return this.winIn & 0x3f;
    if (this.win1Enabled && this.insideWindow(1, x, line)) return (this.winIn >>> 8) & 0x3f;
    if (this.objWindowEnabled && this.lineObjWindow[x] === 1) return (this.winOut >>> 8) & 0x3f;
    return this.winOut & 0x3f;
  }

  /** Whether `layer` may draw at this pixel. Layer 4 is OBJ. */
  private layerVisibleAt(layer: number, x: number, line: number): boolean {
    if (!this.anyWindowEnabled) return true;
    return (this.windowGate(x, line) & (1 << layer)) !== 0;
  }

  /** Whether colour special effects apply at this pixel (WININ/WINOUT bit 5). */
  private effectsAllowedAt(x: number, line: number): boolean {
    if (!this.anyWindowEnabled) return true;
    return (this.windowGate(x, line) & 0x20) !== 0;
  }

  /** Renders the text backgrounds enabled in DISPCNT, back to front by priority. */
  private renderTiledMode(line: number, backgroundCount: number): void {
    // Draw lowest priority first so higher-priority layers overwrite.
    for (let priority = 3; priority >= 0; priority--) {
      for (let bg = backgroundCount - 1; bg >= 0; bg--) {
        if ((this.dispcnt & (0x0100 << bg)) === 0) continue;
        const config = this.decodeBg(bg);
        if (config.priority !== priority) continue;
        this.renderTextBackground(line, bg, config);
      }
    }
  }

  private decodeBg(index: number): BgConfig {
    const control = this.bgControl[index]!;
    return {
      priority: control & 3,
      charBase: ((control >>> 2) & 3) * 0x4000,
      mosaic: (control & 0x0040) !== 0,
      fullColour: (control & 0x0080) !== 0,
      screenBase: ((control >>> 8) & 0x1f) * 0x800,
      size: (control >>> 14) & 3,
      wrap: true,
    };
  }

  /**
   * One text-mode background.
   *
   * A screen block is 32x32 tiles; sizes wider or taller than that use additional blocks,
   * which is why the map offset is not a simple multiply.
   */
  private renderTextBackground(line: number, index: number, config: BgConfig): void {
    const vram = this.host.vram;
    const widthTiles = config.size === 1 || config.size === 3 ? 64 : 32;
    const heightTiles = config.size >= 2 ? 64 : 32;

    const scrollY = this.bgVofs[index]!;
    const scrollX = this.bgHofs[index]!;
    // Mosaic quantises the screen coordinate, so the scroll offset moves the artwork under
    // a grid that stays put — which is exactly how GBATEK says to re-centre the blocks.
    const mosaicX = config.mosaic ? this.bgMosaicX : 1;
    const sourceLine = config.mosaic ? line - (line % this.bgMosaicY) : line;
    const y = (sourceLine + scrollY) & (heightTiles * 8 - 1);
    const tileY = (y >> 3) & 31;
    const rowInTile = y & 7;

    for (let screenX = 0; screenX < GBA_WIDTH; screenX++) {
      const sourceX = mosaicX === 1 ? screenX : screenX - (screenX % mosaicX);
      const x = (sourceX + scrollX) & (widthTiles * 8 - 1);
      const tileX = (x >> 3) & 31;

      // Screen block selection for 512-wide / 512-tall maps.
      let block = 0;
      if (widthTiles === 64 && (x & 0x100) !== 0) block += 1;
      if (heightTiles === 64 && (y & 0x100) !== 0) block += widthTiles === 64 ? 2 : 1;

      const entryOffset = config.screenBase + block * 0x800 + (tileY * 32 + tileX) * 2;
      const entry = vram[entryOffset]! | (vram[entryOffset + 1]! << 8);

      const tile = entry & 0x3ff;
      const flipX = (entry & 0x0400) !== 0;
      const flipY = (entry & 0x0800) !== 0;
      const paletteBank = (entry >>> 12) & 0xf;

      const row = flipY ? 7 - rowInTile : rowInTile;
      const column = flipX ? 7 - (x & 7) : x & 7;

      if (!this.layerVisibleAt(index, screenX, line)) continue;

      let colourIndex: number;
      let colour: number;
      if (config.fullColour) {
        colourIndex = vram[config.charBase + tile * 64 + row * 8 + column]!;
        if (colourIndex === 0) continue; // transparent
        colour = this.paletteColour(colourIndex);
      } else {
        const byte = vram[config.charBase + tile * 32 + row * 4 + (column >> 1)]!;
        colourIndex = (column & 1) === 0 ? byte & 0xf : byte >>> 4;
        if (colourIndex === 0) continue;
        colour = this.paletteColour(paletteBank * 16 + colourIndex);
      }
      this.plot(screenX, colour, index, config.priority);
    }
  }

  /* ---------------------------- affine backgrounds ---------------------------- */

  /**
   * Advances the internal reference points by PB/PD, once per scanline.
   *
   * This is why a rotating background shears correctly rather than sliding: each line
   * starts from the previous line's origin plus one step down the transform.
   */
  private advanceAffine(): void {
    for (let i = 0; i < 2; i++) {
      this.bgInternalX[i] = (this.bgInternalX[i]! + this.bgPB[i]!) | 0;
      this.bgInternalY[i] = (this.bgInternalY[i]! + this.bgPD[i]!) | 0;
    }
  }

  /** Reloads the internal reference points from the visible registers. Called at VBlank. */
  private reloadAffine(): void {
    for (let i = 0; i < 2; i++) {
      this.bgInternalX[i] = this.bgRefX[i]!;
      this.bgInternalY[i] = this.bgRefY[i]!;
      this.mosaicAffineX[i] = this.bgRefX[i]!;
      this.mosaicAffineY[i] = this.bgRefY[i]!;
    }
  }

  /**
   * One rotation/scaling background.
   *
   * Affine maps are one byte per tile with no attributes, and the tile data is always
   * 8bpp. Sizes run 128x128 up to 1024x1024 pixels.
   */
  private renderAffineBackground(line: number, bg: number): void {
    if ((this.dispcnt & (0x0100 << bg)) === 0) return;

    const slot = bg - 2;
    const control = this.bgControl[bg]!;
    const priority = control & 3;
    const charBase = ((control >>> 2) & 3) * 0x4000;
    const screenBase = ((control >>> 8) & 0x1f) * 0x800;
    const wrap = (control & 0x2000) !== 0;
    // Size 0-3 selects 16, 32, 64 or 128 tiles square.
    const tiles = 16 << ((control >>> 14) & 3);
    const pixels = tiles * 8;

    const vram = this.host.vram;
    const pa = this.bgPA[slot]!;
    const pc = this.bgPC[slot]!;
    // Vertical mosaic on an affine layer cannot quantise a map coordinate — the transform
    // makes every scanline start somewhere different. It has to freeze the whole reference
    // point for the block instead, which is what mosaicAffine holds.
    const mosaic = (control & 0x0040) !== 0;
    const mosaicX = mosaic ? this.bgMosaicX : 1;
    let x = mosaic ? this.mosaicAffineX[slot]! : this.bgInternalX[slot]!;
    let y = mosaic ? this.mosaicAffineY[slot]! : this.bgInternalY[slot]!;
    let heldX = x >> 8;
    let heldY = y >> 8;

    for (let screenX = 0; screenX < GBA_WIDTH; screenX++) {
      // The internal registers are 8-bit fractional, so the integer pixel is >> 8.
      if (screenX % mosaicX === 0) {
        heldX = x >> 8;
        heldY = y >> 8;
      }
      let px = heldX;
      let py = heldY;
      x = (x + pa) | 0;
      y = (y + pc) | 0;

      if (px < 0 || px >= pixels || py < 0 || py >= pixels) {
        // Outside the map: BGxCNT bit 13 chooses wrapping or transparency.
        if (!wrap) continue;
        px = ((px % pixels) + pixels) % pixels;
        py = ((py % pixels) + pixels) % pixels;
      }

      if (!this.layerVisibleAt(bg, screenX, line)) continue;

      const tile = vram[screenBase + (py >> 3) * tiles + (px >> 3)]!;
      const colourIndex = vram[charBase + tile * 64 + (py & 7) * 8 + (px & 7)]!;
      if (colourIndex === 0) continue;

      this.plot(screenX, this.paletteColour(colourIndex), bg, priority);
    }
  }

  /** Mode 3: a single 240x160 15-bit bitmap filling all of VRAM's first 75KB. */
  private renderBitmapMode3(line: number): void {
    const vram = this.host.vram;
    const base = line * GBA_WIDTH * 2;
    for (let x = 0; x < GBA_WIDTH; x++) {
      if (!this.layerVisibleAt(2, x, line)) continue;
      const offset = base + x * 2;
      this.plot(x, vram[offset]! | (vram[offset + 1]! << 8), 2, 3);
    }
  }

  /** Mode 4: 8-bit palette indices, with two swappable frames. */
  private renderBitmapMode4(line: number): void {
    const vram = this.host.vram;
    // DISPCNT bit 4 selects the second frame at 0xA000.
    const frame = (this.dispcnt & 0x0010) !== 0 ? 0xa000 : 0;
    const base = frame + line * GBA_WIDTH;
    for (let x = 0; x < GBA_WIDTH; x++) {
      if (!this.layerVisibleAt(2, x, line)) continue;
      const index = vram[base + x]!;
      if (index === 0) continue;
      this.plot(x, this.paletteColour(index), 2, 3);
    }
  }

  /** Mode 5: a smaller 160x128 15-bit bitmap, also double-buffered. */
  private renderBitmapMode5(line: number): void {
    if (line >= 128) return;
    const vram = this.host.vram;
    const frame = (this.dispcnt & 0x0010) !== 0 ? 0xa000 : 0;
    const base = frame + line * 160 * 2;
    for (let x = 0; x < 160; x++) {
      if (!this.layerVisibleAt(2, x, line)) continue;
      const offset = base + x * 2;
      this.plot(x, vram[offset]! | (vram[offset + 1]! << 8), 2, 3);
    }
  }

  /**
   * Sprites for this scanline.
   *
   * OAM holds 128 entries of 8 bytes (6 used, 2 for affine data interleaved). Lower OAM
   * index wins at equal priority, so entries are walked backwards and allowed to overwrite.
   */
  /**
   * Sprites for this scanline.
   *
   * Run twice per line when the OBJ window is on: once with `maskPass` to record where the
   * window-mode sprites cover (their pixels gate other layers rather than being drawn), and
   * once normally for the visible sprites.
   */
  private renderSprites(line: number, maskPass: boolean): void {
    const oam = this.host.oam;
    const vram = this.host.vram;
    // In bitmap modes the sprite tile area starts higher, because the bitmap occupies VRAM.
    const tileBase = this.mode >= 3 ? 0x14000 : 0x10000;
    // DISPCNT bit 6 selects 1D tile mapping.
    const oneDimensional = (this.dispcnt & 0x0040) !== 0;

    for (let index = 127; index >= 0; index--) {
      const base = index * 8;
      const attr0 = oam[base]! | (oam[base + 1]! << 8);
      const attr1 = oam[base + 2]! | (oam[base + 3]! << 8);
      const attr2 = oam[base + 4]! | (oam[base + 5]! << 8);

      // Bit 8 is rotation/scaling. It changes what bit 9 means: "double size" for an affine
      // sprite, "disabled" for a normal one.
      const affine = (attr0 & 0x0100) !== 0;
      if (!affine && (attr0 & 0x0200) !== 0) continue;

      const shape = (attr0 >>> 14) & 3;
      const size = (attr1 >>> 14) & 3;
      const [width, height] = spriteSize(shape, size);

      // Double size draws the rotated sprite inside a box twice as large, so corners that
      // swing outside the sprite rectangle stay visible instead of being clipped.
      const doubleSize = affine && (attr0 & 0x0200) !== 0;
      const boxWidth = doubleSize ? width * 2 : width;
      const boxHeight = doubleSize ? height * 2 : height;

      let y = attr0 & 0xff;
      if (y + boxHeight > 256) y -= 256;
      const screenRow = line - y;
      if (screenRow < 0 || screenRow >= boxHeight) continue;

      let x = attr1 & 0x1ff;
      if (x >= 240) x -= 512;

      const objMode = (attr0 >>> 10) & 3;
      // The mask pass wants window sprites only; the visible pass wants everything else.
      if (maskPass !== (objMode === 2)) continue;

      const fullColour = (attr0 & 0x2000) !== 0;
      const priority = (attr2 >>> 10) & 3;
      const paletteBank = (attr2 >>> 12) & 0xf;
      const tile = attr2 & 0x3ff;
      const tilesWide = width >> 3;

      // Mosaic quantises the SCREEN coordinate (see the note on bgMosaicX), so a sprite
      // moved by one pixel samples different source pixels — which is the re-centring
      // trick GBATEK describes.
      const mosaic = (attr0 & 0x1000) !== 0;
      const mosaicX = mosaic ? this.objMosaicX : 1;
      const sampledRow = mosaic ? line - (line % this.objMosaicY) - y : screenRow;
      if (sampledRow < 0 || sampledRow >= boxHeight) continue;

      // Flip bits and the affine parameter group occupy the same attr1 field, so only one
      // of the two is ever meaningful.
      const flipX = !affine && (attr1 & 0x1000) !== 0;
      const flipY = !affine && (attr1 & 0x2000) !== 0;

      // PA-PD live in the 16-bit gaps between OAM entries: group g holds them at
      // g*32 + 6, +14, +22 and +30. They are 8.8 signed fixed point.
      let pa = 0x100;
      let pb = 0;
      let pc = 0;
      let pd = 0x100;
      if (affine) {
        const group = ((attr1 >>> 9) & 0x1f) * 32;
        pa = signed16(oam[group + 6]! | (oam[group + 7]! << 8));
        pb = signed16(oam[group + 14]! | (oam[group + 15]! << 8));
        pc = signed16(oam[group + 22]! | (oam[group + 23]! << 8));
        pd = signed16(oam[group + 30]! | (oam[group + 31]! << 8));
      }

      // The rotation centre is the middle of the box; the texture centre is the middle of
      // the sprite. For a double-size box those differ, which is what keeps the sprite
      // centred in its larger window.
      const halfBoxWidth = boxWidth >> 1;
      const halfBoxHeight = boxHeight >> 1;
      const halfWidth = width >> 1;
      const halfHeight = height >> 1;
      const dy = sampledRow - halfBoxHeight;

      for (let column = 0; column < boxWidth; column++) {
        const screenX = x + column;
        if (screenX < 0 || screenX >= GBA_WIDTH) continue;

        // Sample position within the box, after mosaic quantisation.
        const sampled = mosaicX === 1 ? column : screenX - (screenX % mosaicX) - x;
        if (sampled < 0 || sampled >= boxWidth) continue;

        let tileRow: number;
        let tileColumn: number;
        if (affine) {
          // Inverse-transform the screen offset into texture space. Anything that lands
          // outside the sprite rectangle is transparent — that is the clipping the
          // double-size flag exists to avoid.
          const dx = sampled - halfBoxWidth;
          tileColumn = ((pa * dx + pb * dy) >> 8) + halfWidth;
          tileRow = ((pc * dx + pd * dy) >> 8) + halfHeight;
          if (tileColumn < 0 || tileColumn >= width || tileRow < 0 || tileRow >= height) {
            continue;
          }
        } else {
          tileColumn = flipX ? width - 1 - sampled : sampled;
          tileRow = flipY ? height - 1 - sampledRow : sampledRow;
        }

        // 1D mapping lays a sprite's tiles consecutively; 2D uses a 32-tile-wide grid.
        const tileIndex = oneDimensional
          ? tile +
            (tileRow >> 3) * tilesWide * (fullColour ? 2 : 1) +
            ((tileColumn >> 3) << (fullColour ? 1 : 0))
          : tile + (tileRow >> 3) * 32 + (tileColumn >> 3);

        let colourIndex: number;
        let colour: number;
        if (fullColour) {
          const offset = tileBase + tileIndex * 32 + (tileRow & 7) * 8 + (tileColumn & 7);
          colourIndex = vram[offset]!;
          if (colourIndex === 0) continue;
          colour = this.paletteColour(256 + colourIndex);
        } else {
          const offset = tileBase + tileIndex * 32 + (tileRow & 7) * 4 + ((tileColumn & 7) >> 1);
          const byte = vram[offset]!;
          colourIndex = (tileColumn & 1) === 0 ? byte & 0xf : byte >>> 4;
          if (colourIndex === 0) continue;
          colour = this.paletteColour(256 + paletteBank * 16 + colourIndex);
        }

        // A window sprite is never drawn: its opaque pixels only mark the mask.
        if (maskPass) {
          this.lineObjWindow[screenX] = 1;
          continue;
        }

        if (!this.layerVisibleAt(LAYER_OBJ, screenX, line)) continue;

        this.plot(screenX, colour, LAYER_OBJ, priority);
        this.lineIsSprite[screenX] = 1;
        // Mode 1 asks for alpha blending regardless of what BLDCNT's mode says.
        this.lineObjBlend[screenX] = objMode === 1 ? 1 : 0;
      }
    }
  }

  /* -------------------------------- mosaic -------------------------------- */

  /**
   * Block sizes, each stored minus 1.
   *
   * GBATEK describes mosaic in DISPLAY coordinates — "pixels 0-5 of each display row are
   * colorized as pixel 0" — and both of its notes (re-centre a background by *scrolling*
   * it, re-centre a sprite by *moving* it) only work if the grid is fixed to the screen
   * rather than to the layer. So every quantisation below is on the screen coordinate.
   */
  private get bgMosaicX(): number {
    return (this.mosaic & 0xf) + 1;
  }

  private get bgMosaicY(): number {
    return ((this.mosaic >>> 4) & 0xf) + 1;
  }

  private get objMosaicX(): number {
    return ((this.mosaic >>> 8) & 0xf) + 1;
  }

  private get objMosaicY(): number {
    return ((this.mosaic >>> 12) & 0xf) + 1;
  }

  private paletteColour(index: number): number {
    const offset = index * 2;
    return this.host.palette[offset]! | (this.host.palette[offset + 1]! << 8);
  }

  private fillLine(line: number, rgb: number): void {
    let offset = line * GBA_WIDTH * 4;
    for (let x = 0; x < GBA_WIDTH; x++) {
      this.frameBuffer[offset] = (rgb >>> 16) & 0xff;
      this.frameBuffer[offset + 1] = (rgb >>> 8) & 0xff;
      this.frameBuffer[offset + 2] = rgb & 0xff;
      this.frameBuffer[offset + 3] = 0xff;
      offset += 4;
    }
  }

  /* ----------------------------------- I/O ------------------------------------ */

  readRegister(address: number): number {
    switch (address) {
      case 0x04000000:
        return this.dispcnt;
      case 0x04000004:
        return this.dispstat;
      case 0x04000006:
        return this.vcount;
      case 0x04000008:
      case 0x0400000a:
      case 0x0400000c:
      case 0x0400000e:
        return this.bgControl[(address - 0x04000008) >> 1]!;
      default:
        return 0;
    }
  }

  writeRegister(address: number, value: number): void {
    const half = value & 0xffff;
    switch (address) {
      case 0x04000000:
        this.dispcnt = half;
        return;
      // DISPSTAT bits 0-2 are read-only status; only the enables and VCOUNT target write.
      case 0x04000004:
        this.dispstat = (this.dispstat & 0x0007) | (half & 0xff38);
        return;
      case 0x04000008:
      case 0x0400000a:
      case 0x0400000c:
      case 0x0400000e:
        this.bgControl[(address - 0x04000008) >> 1] = half;
        return;
      case 0x04000010:
      case 0x04000014:
      case 0x04000018:
      case 0x0400001c:
        this.bgHofs[(address - 0x04000010) >> 2] = half & 0x1ff;
        return;
      case 0x04000012:
      case 0x04000016:
      case 0x0400001a:
      case 0x0400001e:
        this.bgVofs[(address - 0x04000012) >> 2] = half & 0x1ff;
        return;

      /* ---- affine parameters: 0x20-0x2F is BG2, 0x30-0x3F is BG3 ---- */
      case 0x04000020:
        this.bgPA[0] = signed16(half);
        return;
      case 0x04000022:
        this.bgPB[0] = signed16(half);
        return;
      case 0x04000024:
        this.bgPC[0] = signed16(half);
        return;
      case 0x04000026:
        this.bgPD[0] = signed16(half);
        return;
      case 0x04000030:
        this.bgPA[1] = signed16(half);
        return;
      case 0x04000032:
        this.bgPB[1] = signed16(half);
        return;
      case 0x04000034:
        this.bgPC[1] = signed16(half);
        return;
      case 0x04000036:
        this.bgPD[1] = signed16(half);
        return;

      // Reference points are 32-bit, written as two halves. Writing either half OUTSIDE
      // VBlank takes effect immediately for the CURRENT scanline, rather than waiting for
      // the next frame — which is how games reposition a rotating layer mid-screen.
      case 0x04000028:
        this.setRefX(0, (this.bgRefX[0]! & ~0xffff) | half);
        return;
      case 0x0400002a:
        this.setRefX(0, (this.bgRefX[0]! & 0xffff) | (half << 16));
        return;
      case 0x0400002c:
        this.setRefY(0, (this.bgRefY[0]! & ~0xffff) | half);
        return;
      case 0x0400002e:
        this.setRefY(0, (this.bgRefY[0]! & 0xffff) | (half << 16));
        return;
      case 0x04000038:
        this.setRefX(1, (this.bgRefX[1]! & ~0xffff) | half);
        return;
      case 0x0400003a:
        this.setRefX(1, (this.bgRefX[1]! & 0xffff) | (half << 16));
        return;
      case 0x0400003c:
        this.setRefY(1, (this.bgRefY[1]! & ~0xffff) | half);
        return;
      case 0x0400003e:
        this.setRefY(1, (this.bgRefY[1]! & 0xffff) | (half << 16));
        return;

      /* ---- windows ---- */
      case 0x04000040:
        this.winH[0] = half;
        return;
      case 0x04000042:
        this.winH[1] = half;
        return;
      case 0x04000044:
        this.winV[0] = half;
        return;
      case 0x04000046:
        this.winV[1] = half;
        return;
      case 0x04000048:
        this.winIn = half;
        return;
      case 0x0400004c:
        this.mosaic = half;
        return;
      case 0x0400004a:
        this.winOut = half;
        return;

      /* ---- colour special effects ---- */
      case 0x04000050:
        this.bldcnt = half;
        return;
      case 0x04000052:
        this.bldalpha = half;
        return;
      case 0x04000054:
        this.bldy = half;
        return;

      default:
        return;
    }
  }

  /**
   * Writes a reference point.
   *
   * Sign-extends from 28 bits (19 integer + 8 fraction + sign) and mirrors the value into
   * the internal register, because a mid-frame write repositions the current scanline.
   */
  private setRefX(slot: number, value: number): void {
    const extended = (value << 4) >> 4;
    this.bgRefX[slot] = extended;
    this.bgInternalX[slot] = extended;
    this.mosaicAffineX[slot] = extended;
  }

  private setRefY(slot: number, value: number): void {
    const extended = (value << 4) >> 4;
    this.bgRefY[slot] = extended;
    this.bgInternalY[slot] = extended;
    this.mosaicAffineY[slot] = extended;
  }
}

/** Sprite dimensions, indexed by shape then size. */
function spriteSize(shape: number, size: number): [number, number] {
  const table: [number, number][][] = [
    [
      [8, 8],
      [16, 16],
      [32, 32],
      [64, 64],
    ], // square
    [
      [16, 8],
      [32, 8],
      [32, 16],
      [64, 32],
    ], // wide
    [
      [8, 16],
      [8, 32],
      [16, 32],
      [32, 64],
    ], // tall
    [
      [8, 8],
      [8, 8],
      [8, 8],
      [8, 8],
    ], // prohibited
  ];
  return table[shape]![size]!;
}

/**
 * Alpha blend: I = min(31, I1 * EVA/16 + I2 * EVB/16), per channel.
 */
function alphaBlend(first: number, second: number, eva: number, evb: number): number {
  let out = 0;
  for (let shift = 0; shift <= 10; shift += 5) {
    const a = (first >>> shift) & 0x1f;
    const b = (second >>> shift) & 0x1f;
    const mixed = Math.min(31, ((a * eva + b * evb) / 16) | 0);
    out |= mixed << shift;
  }
  return out;
}

/** Brightness increase: I = I + (31 - I) * EVY/16. */
function brighten(colour: number, evy: number): number {
  let out = 0;
  for (let shift = 0; shift <= 10; shift += 5) {
    const c = (colour >>> shift) & 0x1f;
    out |= ((c + ((31 - c) * evy) / 16) | 0) << shift;
  }
  return out;
}

/** Brightness decrease: I = I - I * EVY/16. */
function darken(colour: number, evy: number): number {
  let out = 0;
  for (let shift = 0; shift <= 10; shift += 5) {
    const c = (colour >>> shift) & 0x1f;
    out |= (c - (((c * evy) / 16) | 0)) << shift;
  }
  return out;
}

/** 5-bit channel to 8-bit. `c << 3 | c >> 2`, so 31 reaches 255. */
function expand5(value: number): number {
  return (value << 3) | (value >>> 2);
}

/** Sign-extends a 16-bit value held in a JS number. */
function signed16(value: number): number {
  return (value << 16) >> 16;
}
