import type { StateReader, StateWriter } from './StateBuffer.js';
import type { Ppu } from '../ppu/Ppu.js';
import type { Apu } from '../apu/Apu.js';
import type { Mmu } from '../memory/Mmu.js';
import type { Cartridge } from '../../shared/types/cartridge.js';

/**
 * Per-subsystem save-state sections.
 *
 * These live here rather than on each class so the emulator's hot-path files stay focused
 * on hardware behaviour. The container and its versioning are owned by `GameBoyCore`; each
 * function below only knows how to write and read its own subsystem.
 *
 * ANY change to a layout here REQUIRES bumping STATE_VERSION.
 */

export function savePpu(ppu: Ppu, w: StateWriter): void {
  const s = ppu.serializableState();
  w.u8(s.lcdc);
  w.u8(s.stat);
  w.u8(s.scy);
  w.u8(s.scx);
  w.u8(s.ly);
  w.u8(s.lyc);
  w.bool(s.coincidence);
  w.u8(s.bgp);
  w.u8(s.obp0);
  w.u8(s.obp1);
  w.u8(s.wy);
  w.u8(s.wx);
  w.u16(s.dot);
  w.u8(s.mode);
  w.bool(s.statLine);
  w.u8(s.windowLine);
  w.bool(s.windowActive);
  w.u8(s.vramBank);
  w.bytesOf(s.bgPalettes.bytes);
  w.u8(s.bgPalettes.index);
  w.bool(s.bgPalettes.autoIncrement);
  w.bytesOf(s.objPalettes.bytes);
  w.u8(s.objPalettes.index);
  w.bool(s.objPalettes.autoIncrement);
}

export function loadPpu(ppu: Ppu, r: StateReader): void {
  ppu.restoreState({
    lcdc: r.u8(),
    stat: r.u8(),
    scy: r.u8(),
    scx: r.u8(),
    ly: r.u8(),
    lyc: r.u8(),
    coincidence: r.bool(),
    bgp: r.u8(),
    obp0: r.u8(),
    obp1: r.u8(),
    wy: r.u8(),
    wx: r.u8(),
    dot: r.u16(),
    mode: r.u8(),
    statLine: r.bool(),
    windowLine: r.u8(),
    windowActive: r.bool(),
    vramBank: r.u8(),
    // Copied out of the reader's view, which is a window onto the caller's buffer.
    bgPalettes: {
      bytes: new Uint8Array(r.bytesOf()),
      index: r.u8(),
      autoIncrement: r.bool(),
    },
    objPalettes: {
      bytes: new Uint8Array(r.bytesOf()),
      index: r.u8(),
      autoIncrement: r.bool(),
    },
  });
}

/**
 * APU state.
 *
 * The mixer and frame sequencer, THEN each channel in turn. The per-channel half is the
 * part that was missing: duty, frequency, phase, the length counters, every envelope,
 * channel 1's sweep (including `sweepNegateUsed`) and channel 4's LFSR all live on the
 * channel objects, not in any register array, so a state without them restored an APU
 * that was silent, stuck, or playing the wrong note. Wave RAM rides along inside
 * `ch3.saveState`.
 */
export function saveApu(apu: Apu, w: StateWriter): void {
  const s = apu.serializableState();
  w.bool(s.powered);
  w.u8(s.sequencerStep);
  w.bool(s.lastDivBit);
  w.u8(s.leftVolume);
  w.u8(s.rightVolume);
  w.bool(s.vinLeft);
  w.bool(s.vinRight);
  w.u8(s.panning);
  apu.ch1.saveState(w);
  apu.ch2.saveState(w);
  apu.ch3.saveState(w);
  apu.ch4.saveState(w);
}

export function loadApu(apu: Apu, r: StateReader): void {
  apu.restoreState({
    powered: r.bool(),
    sequencerStep: r.u8(),
    lastDivBit: r.bool(),
    leftVolume: r.u8(),
    rightVolume: r.u8(),
    vinLeft: r.bool(),
    vinRight: r.bool(),
    panning: r.u8(),
  });
  apu.ch1.loadState(r);
  apu.ch2.loadState(r);
  apu.ch3.loadState(r);
  apu.ch4.loadState(r);
}

export function saveMemory(
  mmu: Mmu,
  vram: Uint8Array,
  oam: Uint8Array,
  cartridge: Cartridge | null,
  w: StateWriter,
): void {
  w.bytesOf(vram);
  w.bytesOf(oam);
  mmu.saveState(w);
  // Cartridge RAM and banking. A state taken mid-game must restore the mapped bank, or
  // execution resumes in the wrong ROM bank and crashes immediately.
  const sram = cartridge?.getSaveRam() ?? new Uint8Array(0);
  w.bytesOf(sram);
}

export function loadMemory(
  mmu: Mmu,
  vram: Uint8Array,
  oam: Uint8Array,
  cartridge: Cartridge | null,
  r: StateReader,
): void {
  r.intoArray(vram);
  r.intoArray(oam);
  mmu.loadState(r);
  const sram = r.bytesOf();
  if (sram.length > 0) cartridge?.loadSaveRam(sram);
}
