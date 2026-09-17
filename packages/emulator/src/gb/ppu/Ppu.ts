import type { InterruptController } from '../cpu/interrupts.js';
import { INT_STAT, INT_VBLANK } from '../cpu/interrupts.js';
import { PALETTE_DMG_GREEN, type ShadePalette } from './palette.js';
import { CgbPaletteRam } from './cgbPalette.js';

export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 144;
export const DOTS_PER_LINE = 456;
export const LINES_PER_FRAME = 154;
export const DOTS_PER_FRAME = DOTS_PER_LINE * LINES_PER_FRAME; // 70224

export const MODE_HBLANK = 0;
export const MODE_VBLANK = 1;
export const MODE_OAM_SCAN = 2;
export const MODE_DRAWING = 3;

const OAM_SCAN_DOTS = 80;
const MAX_SPRITES_PER_LINE = 10;

/** Background fetcher states. Each occupies two dots. */
const FETCH_TILE = 0;
const FETCH_DATA_LOW = 1;
const FETCH_DATA_HIGH = 2;
const FETCH_PUSH = 3;

/**
 * The DMG PPU, implemented as a pixel FIFO.
 *
 * ARCHITECTURE DECISION (Phase 04, see docs/graphics.md): this models the real hardware —
 * a background fetcher and a sprite fetcher feeding FIFOs that push one pixel per dot —
 * rather than composing whole scanlines at HBlank.
 *
 * A scanline renderer is simpler and can pass dmg-acid2, but it can never express
 * mid-scanline register writes, so it cannot pass Mealybug and cannot render the raster
 * effects real games use. Retrofitting the FIFO later would mean rewriting the PPU, so it
 * is built this way from the start.
 *
 * Mode 3's length is therefore emergent, not a constant: it stretches with SCX % 8, window
 * activation, and each sprite fetched.
 */
export class Ppu {
  /* ------------------------------- registers ------------------------------- */
  lcdc = 0x91;
  private stat = 0x85;
  scy = 0;
  scx = 0;
  ly = 0;
  lyc = 0;

  /**
   * The LY=LYC comparison is LATCHED, not evaluated on read.
   *
   * The comparison has its own clock, and that clock stops with the PPU: while the LCD is
   * off the bit holds whatever it last was, and writing LYC does not disturb it. Switching
   * the LCD back on runs one comparison immediately, against the freshly zeroed LY.
   * Mooneye's stat_lyc_onoff walks through every combination of this.
   */
  private coincidence = false;

  /**
   * Set while the PPU is on its first OAM scan after the LCD was switched on.
   *
   * That scan happens, but it is not REPORTED: STAT reads mode 0 through it, and the mode-2
   * STAT interrupt does not fire. Mooneye's stat_lyc_onoff catches this the moment the LCD
   * comes back on, and the lcdon_* tests measure it directly.
   */
  private lcdJustEnabled = false;
  bgp = 0xfc;
  obp0 = 0xff;
  obp1 = 0xff;
  wy = 0;
  wx = 0;

  palette: ShadePalette = PALETTE_DMG_GREEN;

  /** RGBA output at native resolution. Allocated once; never reallocated. */
  readonly frameBuffer = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);

  private readonly vram: Uint8Array;
  private readonly oam: Uint8Array;

  /** CGB mode changes palette handling, sprite priority and the meaning of LCDC bit 0. */
  cgb = false;

  /** 0 or 1. VRAM is two 8KB banks on CGB; bank 1 holds BG tile attributes. */
  vramBank = 0;

  readonly bgPalettes = new CgbPaletteRam();
  readonly objPalettes = new CgbPaletteRam();

  /** Per-pixel BG attribute for the tile currently being pushed. */
  private fetchAttributes = 0;
  /** Parallel to bgFifo: the CGB palette and priority bit of each queued pixel. */
  private readonly bgAttr = new Uint8Array(16);
  /** Parallel to the sprite FIFO: CGB palette index 0-7. */
  private readonly spCgbPalette = new Uint8Array(8);
  /** OAM index owning each sprite slot. CGB resolves priority by this alone. */
  private readonly spOamIndex = new Uint8Array(8).fill(0xff);

  private dot = 0;
  private mode = MODE_OAM_SCAN;
  private statLine = false;

  /* ------------------------- per-line drawing state ------------------------ */
  private lcdX = 0;
  private fetcherState = FETCH_TILE;
  private fetcherStep = 0;
  private fetcherX = 0;
  private fetchTile = 0;
  private fetchLow = 0;
  private fetchHigh = 0;

  /** The discarded first tile fetch of this line has completed. */
  private firstFetchDone = false;

  /** Background FIFO: colour indices 0-3, up to 16 deep. */
  private readonly bgFifo = new Uint8Array(16);
  private bgHead = 0;
  private bgCount = 0;

  /** Sprite FIFO, parallel arrays so nothing allocates per pixel. */
  private readonly spColor = new Uint8Array(8);
  private readonly spPalette = new Uint8Array(8);
  private readonly spPriority = new Uint8Array(8);
  private spCount = 0;

  private scxDiscard = 0;
  private windowLine = 0;
  private windowActive = false;
  private windowTriggered = false;

  /** Sprites selected during OAM scan: x, y, tile, attributes, in OAM order. */
  private readonly lineSprites = new Uint8Array(MAX_SPRITES_PER_LINE * 4);
  /** OAM index of each selected sprite, parallel to lineSprites. */
  private readonly lineSpriteOam = new Uint8Array(MAX_SPRITES_PER_LINE);
  private lineSpriteCount = 0;
  private readonly spriteFetched = new Uint8Array(MAX_SPRITES_PER_LINE);
  private spriteFetchIndex = -1;
  private spriteFetchStep = 0;

  constructor(
    private readonly interrupts: InterruptController,
    vram: Uint8Array,
    oam: Uint8Array,
  ) {
    this.vram = vram;
    this.oam = oam;
    this.clearFrame();
  }

  reset(): void {
    this.lcdc = 0x91;
    this.stat = 0x85;
    this.scy = this.scx = this.ly = this.lyc = 0;
    this.bgp = 0xfc;
    this.obp0 = this.obp1 = 0xff;
    this.wy = this.wx = 0;
    this.dot = 0;
    this.mode = MODE_OAM_SCAN;
    this.statLine = false;
    this.windowLine = 0;
    this.windowTriggered = false;
    this.vramBank = 0;
    this.bgPalettes.reset();
    this.objPalettes.reset();
    this.startLine();
    this.clearFrame();
  }

  get enabled(): boolean {
    return (this.lcdc & 0x80) !== 0;
  }

  get currentMode(): number {
    return this.enabled ? this.mode : MODE_HBLANK;
  }

  /** True while the CPU may not see VRAM. */
  get vramBlocked(): boolean {
    return this.enabled && this.mode === MODE_DRAWING;
  }

  /** True while the CPU may not see OAM. */
  get oamBlocked(): boolean {
    return this.enabled && (this.mode === MODE_OAM_SCAN || this.mode === MODE_DRAWING);
  }

  private clearFrame(): void {
    for (let i = 0; i < this.frameBuffer.length; i += 4) {
      this.writePixel(i, 0);
    }
  }

  private writePixel(offset: number, shade: number): void {
    this.writeColour(offset, this.palette[shade] ?? 0);
  }

  private writeColour(offset: number, colour: number): void {
    this.frameBuffer[offset] = (colour >> 16) & 0xff;
    this.frameBuffer[offset + 1] = (colour >> 8) & 0xff;
    this.frameBuffer[offset + 2] = colour & 0xff;
    this.frameBuffer[offset + 3] = 0xff;
  }

  /* --------------------------------- timing -------------------------------- */

  /** Advances one dot. Returns true on the dot VBlank begins. */
  tickT(): boolean {
    if (!this.enabled) {
      this.ly = 0;
      this.dot = 0;
      this.mode = MODE_HBLANK;
      this.windowLine = 0;
      return false;
    }

    let frameCompleted = false;

    if (this.mode === MODE_OAM_SCAN && this.dot === 0) this.scanOam();

    switch (this.mode) {
      case MODE_OAM_SCAN:
        if (this.dot >= OAM_SCAN_DOTS - 1) {
          this.mode = MODE_DRAWING;
          this.startDrawing();
        }
        break;
      case MODE_DRAWING:
        this.drawDot();
        if (this.lcdX >= SCREEN_WIDTH) this.mode = MODE_HBLANK;
        break;
      default:
        break;
    }

    this.dot++;

    if (this.dot >= DOTS_PER_LINE) {
      this.dot = 0;
      if (this.windowActive) this.windowLine++;
      this.ly++;

      if (this.ly === SCREEN_HEIGHT) {
        this.mode = MODE_VBLANK;
        this.interrupts.request(INT_VBLANK);
        frameCompleted = true;
      } else if (this.ly >= LINES_PER_FRAME) {
        this.ly = 0;
        this.windowLine = 0;
        this.windowTriggered = false;
        this.mode = MODE_OAM_SCAN;
        this.startLine();
      } else if (this.ly < SCREEN_HEIGHT) {
        this.mode = MODE_OAM_SCAN;
        this.startLine();
      }
    }

    this.updateStatLine();
    return frameCompleted;
  }

  private startLine(): void {
    this.lcdX = 0;
    this.fetcherX = 0;
    this.fetcherState = FETCH_TILE;
    this.fetcherStep = 0;
    this.firstFetchDone = false;
    this.bgHead = this.bgCount = 0;
    this.spCount = 0;
    this.windowActive = false;
    this.spriteFetchIndex = -1;
    this.spriteFetchStep = 0;
    this.spriteFetched.fill(0);
    this.spOamIndex.fill(0xff);
  }

  private startDrawing(): void {
    // Mode 3 is stretched by the sub-tile scroll: these pixels are fetched then dropped.
    this.scxDiscard = this.scx & 7;
  }

  /* ------------------------------- OAM scan -------------------------------- */

  /**
   * Selects up to 10 sprites for this line, in OAM order.
   *
   * A sprite at X=0 or X>=168 is off-screen but still consumes one of the ten slots.
   */
  private scanOam(): void {
    this.lineSpriteCount = 0;
    if ((this.lcdc & 0x02) === 0) return;

    const height = (this.lcdc & 0x04) !== 0 ? 16 : 8;
    for (let i = 0; i < 40 && this.lineSpriteCount < MAX_SPRITES_PER_LINE; i++) {
      const base = i * 4;
      const spriteY = this.oam[base]! - 16;
      if (this.ly < spriteY || this.ly >= spriteY + height) continue;

      const slot = this.lineSpriteCount * 4;
      this.lineSprites[slot] = this.oam[base]!;
      this.lineSprites[slot + 1] = this.oam[base + 1]!;
      this.lineSprites[slot + 2] = this.oam[base + 2]!;
      this.lineSprites[slot + 3] = this.oam[base + 3]!;
      this.lineSpriteOam[this.lineSpriteCount] = i;
      this.lineSpriteCount++;
    }
  }

  /* -------------------------------- drawing -------------------------------- */

  private drawDot(): void {
    // The window starts mid-line and restarts the fetcher.
    if (
      !this.windowActive &&
      (this.lcdc & 0x20) !== 0 &&
      this.ly >= this.wy &&
      this.lcdX >= this.wx - 7
    ) {
      this.windowActive = true;
      this.windowTriggered = true;
      this.fetcherX = 0;
      this.fetcherState = FETCH_TILE;
      this.fetcherStep = 0;
      this.bgHead = this.bgCount = 0;
    }

    // A sprite fetch already under way pauses the background fetcher entirely.
    if (this.spriteFetchIndex >= 0) {
      this.stepSpriteFetch();
      return;
    }

    this.stepFetcher();
    if (this.bgCount === 0) return;

    // Only now, with the FIFO non-empty, can a sprite starting at this X be fetched — and
    // it MUST happen before the pixel at this X is emitted. Checking earlier (while the
    // FIFO was still empty) let the first column of every sprite escape unpainted.
    this.trySpriteFetch();
    if (this.spriteFetchIndex >= 0) {
      this.stepSpriteFetch();
      return;
    }

    const bgColor = this.popBg();

    if (this.scxDiscard > 0) {
      this.scxDiscard--;
      return;
    }

    this.emitPixel(bgColor, this.poppedAttributes);
  }

  private emitPixel(bgColorIn: number, bgAttributes: number): void {
    // LCDC bit 0 means two different things. On DMG it blanks background and window
    // entirely; on CGB the background always draws and the bit instead controls whether
    // BG priority can beat sprites at all.
    const bgEnabled = this.cgb || (this.lcdc & 0x01) !== 0;
    const bgColor = bgEnabled ? bgColorIn : 0;

    const spriteColor = this.spCount > 0 ? this.spColor[0]! : 0;
    const spritePriority = this.spCount > 0 ? this.spPriority[0]! : 0;
    const spritePaletteIndex = this.spCount > 0 ? this.spPalette[0]! : 0;
    const spriteCgbPalette = this.spCount > 0 ? this.spCgbPalette[0]! : 0;
    if (this.spCount > 0) this.shiftSprite();

    let colour: number;

    if (this.cgb) {
      // CGB priority: the master bit (LCDC 0) can disable BG priority entirely; otherwise
      // either the BG tile attribute or the sprite attribute can push the sprite behind.
      const bgHasPriority =
        (this.lcdc & 0x01) !== 0 && ((bgAttributes & 0x80) !== 0 || spritePriority !== 0);
      const spriteWins = spriteColor !== 0 && (!bgHasPriority || bgColor === 0);

      colour = spriteWins
        ? this.objPalettes.colour(spriteCgbPalette, spriteColor)
        : this.bgPalettes.colour(bgAttributes & 0x07, bgColor);
    } else {
      let shade = (this.bgp >> (bgColor * 2)) & 0x03;
      // Sprite colour 0 is transparent; the priority bit puts it behind non-zero BG.
      if (spriteColor !== 0 && (spritePriority === 0 || bgColor === 0)) {
        const palette = spritePaletteIndex === 0 ? this.obp0 : this.obp1;
        shade = (palette >> (spriteColor * 2)) & 0x03;
      }
      colour = this.palette[shade] ?? 0;
    }

    if (this.ly < SCREEN_HEIGHT && this.lcdX < SCREEN_WIDTH) {
      this.writeColour((this.ly * SCREEN_WIDTH + this.lcdX) * 4, colour);
    }
    this.lcdX++;
  }

  /* ----------------------------- background fetcher ------------------------ */

  private stepFetcher(): void {
    // Pandocs: the first four steps take 2 dots each, and the PUSH is attempted EVERY dot
    // until it succeeds. Retrying it only every other dot adds a stall dot at each tile
    // boundary, which is what pushed mode 3 past its 172-dot minimum.
    if (this.fetcherState === FETCH_PUSH) {
      // Push ONLY into an empty FIFO. Pushing while pixels from the previous tile remain
      // leaves a stale pixel at every tile boundary — a wrong column every 8 pixels.
      if (this.bgCount > 0) return;
      // CGB attribute bit 5 mirrors the tile horizontally, so the bits come out in the
      // opposite order.
      const xFlip = this.cgb && (this.fetchAttributes & 0x20) !== 0;
      for (let i = 0; i < 8; i++) {
        const bit = xFlip ? i : 7 - i;
        const low = (this.fetchLow >> bit) & 1;
        const high = (this.fetchHigh >> bit) & 1;
        this.pushBg((high << 1) | low, this.fetchAttributes);
      }
      this.fetcherX++;
      this.fetcherState = FETCH_TILE;
      this.fetcherStep = 0;
      return;
    }

    this.fetcherStep++;
    if (this.fetcherStep < 2) return;
    this.fetcherStep = 0;

    switch (this.fetcherState) {
      case FETCH_TILE: {
        const mapBit = this.windowActive ? 0x40 : 0x08;
        const mapBase = (this.lcdc & mapBit) !== 0 ? 0x1c00 : 0x1800;
        const y = this.windowActive ? this.windowLine : (this.ly + this.scy) & 0xff;
        const x = this.windowActive ? this.fetcherX : ((this.scx >> 3) + this.fetcherX) & 0x1f;
        const mapOffset = mapBase + (((y >> 3) & 0x1f) << 5) + x;
        this.fetchTile = this.vram[mapOffset]!;
        // On CGB the SAME map address in bank 1 holds this tile's attributes: palette,
        // tile-data bank, X/Y flip and the BG-over-OBJ priority bit.
        this.fetchAttributes = this.cgb ? this.vram[0x2000 + mapOffset]! : 0;
        this.fetcherState = FETCH_DATA_LOW;
        break;
      }
      case FETCH_DATA_LOW: {
        this.fetchLow = this.vram[this.tileDataAddress()]!;
        this.fetcherState = FETCH_DATA_HIGH;
        break;
      }
      case FETCH_DATA_HIGH: {
        this.fetchHigh = this.vram[this.tileDataAddress() + 1]!;
        // The line's FIRST fetch is thrown away. It restarts HERE rather than travelling
        // through the push step, so it costs 6 dots, not 8. Pandocs: "The 12 extra dots of
        // penalty come from two tile fetches at the beginning of Mode 3. One is the first
        // tile in the scanline, the other is simply discarded."
        if (this.firstFetchDone) {
          this.fetcherState = FETCH_PUSH;
        } else {
          this.firstFetchDone = true;
          this.fetcherState = FETCH_TILE;
        }
        break;
      }
      default:
        break;
    }
  }

  private tileDataAddress(): number {
    const y = this.windowActive ? this.windowLine : (this.ly + this.scy) & 0xff;
    let line = y & 7;
    // CGB attribute bit 6 mirrors the tile vertically.
    if (this.cgb && (this.fetchAttributes & 0x40) !== 0) line = 7 - line;
    const row = line * 2;

    // CGB attribute bit 3 selects which VRAM bank the tile DATA comes from.
    const bank = this.cgb && (this.fetchAttributes & 0x08) !== 0 ? 0x2000 : 0;

    // LCDC bit 4 selects unsigned 0x8000 addressing or signed 0x8800 addressing.
    if ((this.lcdc & 0x10) !== 0) return bank + this.fetchTile * 16 + row;
    return bank + 0x1000 + ((this.fetchTile << 24) >> 24) * 16 + row;
  }

  private pushBg(color: number, attributes: number): void {
    if (this.bgCount >= 16) return;
    const slot = (this.bgHead + this.bgCount) & 15;
    this.bgFifo[slot] = color;
    this.bgAttr[slot] = attributes;
    this.bgCount++;
  }

  /** Attribute byte of the pixel most recently returned by popBg. */
  private poppedAttributes = 0;

  private popBg(): number {
    const color = this.bgFifo[this.bgHead]!;
    this.poppedAttributes = this.bgAttr[this.bgHead]!;
    this.bgHead = (this.bgHead + 1) & 15;
    this.bgCount--;
    return color;
  }

  /* ------------------------------ sprite fetcher --------------------------- */

  private trySpriteFetch(): void {
    if ((this.lcdc & 0x02) === 0 || this.bgCount === 0) return;
    for (let i = 0; i < this.lineSpriteCount; i++) {
      if (this.spriteFetched[i] === 1) continue;
      const x = this.lineSprites[i * 4 + 1]! - 8;
      if (this.lcdX >= x && this.lcdX < x + 8) {
        this.spriteFetchIndex = i;
        this.spriteFetchStep = 0;
        return;
      }
    }
  }

  private stepSpriteFetch(): void {
    // A sprite fetch costs 6 dots, which is part of why mode 3 stretches.
    this.spriteFetchStep++;
    if (this.spriteFetchStep < 6) return;

    const index = this.spriteFetchIndex;
    const oamIndex = this.lineSpriteOam[index]!;
    const slot = index * 4;
    const spriteY = this.lineSprites[slot]! - 16;
    const spriteX = this.lineSprites[slot + 1]! - 8;
    let tile = this.lineSprites[slot + 2]!;
    const attributes = this.lineSprites[slot + 3]!;

    const height = (this.lcdc & 0x04) !== 0 ? 16 : 8;
    if (height === 16) tile &= 0xfe; // the low bit is ignored in 8x16 mode

    let row = this.ly - spriteY;
    if ((attributes & 0x40) !== 0) row = height - 1 - row; // Y flip

    // CGB attribute bit 3 selects the VRAM bank the sprite's tile data lives in.
    const bank = this.cgb && (attributes & 0x08) !== 0 ? 0x2000 : 0;
    const address = bank + tile * 16 + row * 2;
    const low = this.vram[address]!;
    const high = this.vram[address + 1]!;

    const xFlip = (attributes & 0x20) !== 0;
    const palette = (attributes & 0x10) !== 0 ? 1 : 0;
    const cgbPalette = attributes & 0x07;
    const priority = (attributes & 0x80) !== 0 ? 1 : 0;

    for (let i = 0; i < 8; i++) {
      const screenX = spriteX + i;
      if (screenX < this.lcdX) continue; // already output
      const slotIndex = screenX - this.lcdX;
      if (slotIndex >= 8) break;

      const bit = xFlip ? i : 7 - i;
      const color = (((high >> bit) & 1) << 1) | ((low >> bit) & 1);
      if (color === 0) continue;

      while (this.spCount <= slotIndex) {
        this.spColor[this.spCount] = 0;
        this.spPalette[this.spCount] = 0;
        this.spCgbPalette[this.spCount] = 0;
        this.spPriority[this.spCount] = 0;
        this.spOamIndex[this.spCount] = 0xff;
        this.spCount++;
      }
      // Who owns this pixel? On CGB priority is by OAM index alone, so a lower-indexed
      // sprite fetched LATER must still win. On DMG the first writer (smallest X) keeps it.
      if (this.spColor[slotIndex] !== 0) {
        if (!this.cgb) continue;
        if (this.spOamIndex[slotIndex]! <= oamIndex) continue;
      }
      this.spColor[slotIndex] = color;
      this.spPalette[slotIndex] = palette;
      this.spCgbPalette[slotIndex] = cgbPalette;
      this.spPriority[slotIndex] = priority;
      this.spOamIndex[slotIndex] = oamIndex;
    }

    this.spriteFetched[index] = 1;
    this.spriteFetchIndex = -1;
    this.spriteFetchStep = 0;
  }

  private shiftSprite(): void {
    for (let i = 0; i < this.spCount - 1; i++) {
      this.spColor[i] = this.spColor[i + 1]!;
      this.spPalette[i] = this.spPalette[i + 1]!;
      this.spCgbPalette[i] = this.spCgbPalette[i + 1]!;
      this.spPriority[i] = this.spPriority[i + 1]!;
      this.spOamIndex[i] = this.spOamIndex[i + 1]!;
    }
    if (this.spCount > 0) this.spCount--;
  }

  /** The mode STAT reports, which differs from `mode` on the first line after enable. */
  private get reportedMode(): number {
    return this.lcdJustEnabled && this.mode === MODE_OAM_SCAN ? MODE_HBLANK : this.mode;
  }

  /* ---------------------------------- STAT --------------------------------- */

  /**
   * STAT is one logical OR of the enabled conditions, and the IRQ fires only on its RISING
   * edge. Requesting per condition produces spurious interrupts and breaks games.
   */
  private updateStatLine(): void {
    // Nothing in here runs while the PPU is off: not the comparison, not the interrupt
    // line. That is what makes an LYC write during LCD-off inert, and it is also why
    // statLine has to survive the power-off — see the LCDC write.
    if (!this.enabled) return;
    // Once the PPU leaves that first OAM scan it reports normally again.
    if (this.lcdJustEnabled && this.mode !== MODE_OAM_SCAN) this.lcdJustEnabled = false;
    this.coincidence = this.ly === this.lyc;
    const line =
      (this.coincidence && (this.stat & 0x40) !== 0) ||
      (this.reportedMode === MODE_HBLANK && (this.stat & 0x08) !== 0) ||
      (this.reportedMode === MODE_VBLANK && (this.stat & 0x10) !== 0) ||
      (this.reportedMode === MODE_OAM_SCAN && (this.stat & 0x20) !== 0);

    if (line && !this.statLine) this.interrupts.request(INT_STAT);
    this.statLine = line;
  }

  /* --------------------------------- I/O ----------------------------------- */

  read(address: number): number {
    switch (address) {
      case 0xff40:
        return this.lcdc;
      case 0xff41:
        return (
          (this.stat & 0x78) |
          0x80 |
          (this.coincidence ? 0x04 : 0) |
          (this.enabled ? this.reportedMode : 0)
        );
      case 0xff42:
        return this.scy;
      case 0xff43:
        return this.scx;
      case 0xff44:
        return this.ly;
      case 0xff45:
        return this.lyc;
      case 0xff47:
        return this.bgp;
      case 0xff48:
        return this.obp0;
      case 0xff49:
        return this.obp1;
      case 0xff4a:
        return this.wy;
      case 0xff4b:
        return this.wx;
      default:
        return 0xff;
    }
  }

  write(address: number, value: number): void {
    const byte = value & 0xff;
    switch (address) {
      case 0xff40: {
        const wasEnabled = this.enabled;
        this.lcdc = byte;
        if (wasEnabled && !this.enabled) {
          this.ly = 0;
          this.dot = 0;
          this.mode = MODE_HBLANK;
          this.windowLine = 0;
          this.lcdJustEnabled = false;
          // statLine is deliberately RETAINED. Clearing it would manufacture a rising edge
          // the next time the LCD comes on with a condition that was already true — and
          // stat_lyc_onoff round 2 does exactly that, expecting no interrupt.
          // this.coincidence is deliberately left alone: the comparison clock has stopped,
          // so the bit keeps the value it had when the LCD went off.
        } else if (!wasEnabled && this.enabled) {
          this.dot = 0;
          this.mode = MODE_OAM_SCAN;
          this.lcdJustEnabled = true;
          this.startLine();
          this.updateStatLine();
        }
        break;
      }
      case 0xff41:
        this.stat = byte & 0x78;
        break;
      case 0xff42:
        this.scy = byte;
        break;
      case 0xff43:
        this.scx = byte;
        break;
      case 0xff44:
        break; // LY is read-only
      case 0xff45:
        this.lyc = byte;
        // While the LCD is off this write is inert — the latch is not re-evaluated.
        this.updateStatLine();
        break;
      case 0xff47:
        this.bgp = byte;
        break;
      case 0xff48:
        this.obp0 = byte;
        break;
      case 0xff49:
        this.obp1 = byte;
        break;
      case 0xff4a:
        this.wy = byte;
        break;
      case 0xff4b:
        this.wx = byte;
        break;
      default:
        break;
    }
  }

  /* -------------------------------- save state -------------------------------- */

  /**
   * The PPU state a save must carry.
   *
   * Mid-scanline fetcher state is deliberately NOT included: restoring at a line boundary
   * and letting the first line redraw is indistinguishable to the player and keeps the
   * format stable as the FIFO evolves.
   */
  serializableState() {
    return {
      lcdc: this.lcdc,
      stat: this.stat,
      scy: this.scy,
      scx: this.scx,
      ly: this.ly,
      lyc: this.lyc,
      coincidence: this.coincidence,
      bgp: this.bgp,
      obp0: this.obp0,
      obp1: this.obp1,
      wy: this.wy,
      wx: this.wx,
      dot: this.dot,
      mode: this.mode,
      statLine: this.statLine,
      windowLine: this.windowLine,
      windowActive: this.windowActive,
    };
  }

  restoreState(s: ReturnType<Ppu['serializableState']>): void {
    this.lcdc = s.lcdc;
    this.stat = s.stat;
    this.scy = s.scy;
    this.scx = s.scx;
    this.ly = s.ly;
    this.lyc = s.lyc;
    this.coincidence = s.coincidence ?? this.ly === this.lyc;
    this.bgp = s.bgp;
    this.obp0 = s.obp0;
    this.obp1 = s.obp1;
    this.wy = s.wy;
    this.wx = s.wx;
    this.dot = s.dot;
    this.mode = s.mode;
    this.statLine = s.statLine;
    this.windowLine = s.windowLine;
    this.windowActive = s.windowActive;
    this.startLine();
  }

  /** True when the window rendered at least one pixel this frame. Debug aid. */
  get windowWasUsed(): boolean {
    return this.windowTriggered;
  }
}
