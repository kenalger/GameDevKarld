import { beforeEach, describe, expect, it } from 'vitest';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import { buildRom } from '../harness/rom.js';

let core: GameBoyCore;

/** One M-cycle of peripheral time. */
const tickM = (c: GameBoyCore): void => c.cpu.tickT(4);

beforeEach(() => {
  core = new GameBoyCore();
  core.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2 }));
  // The PPU locks the CPU out of VRAM during mode 3 and OAM during modes 2 and 3. These
  // tests are about address decoding, not lockout (ppu.test.ts covers that), so switch the
  // LCD off — the same thing real code does before touching VRAM outside VBlank.
  core.mmu.write(0xff40, 0x00);
});

describe('address decoding', () => {
  it('folds echo RAM onto work RAM rather than copying it', () => {
    core.mmu.write(0xc000, 0x11);
    expect(core.mmu.read(0xe000)).toBe(0x11);

    // A write through the echo window must be visible in work RAM too.
    core.mmu.write(0xe123, 0x22);
    expect(core.mmu.read(0xc123)).toBe(0x22);

    // Echo covers 0xE000-0xFDFF, mirroring 0xC000-0xDDFF.
    core.mmu.write(0xdd00, 0x33);
    expect(core.mmu.read(0xfd00)).toBe(0x33);
  });

  it('reads the prohibited region as 0x00 on a DMG and ignores writes', () => {
    expect(core.mmu.read(0xfea0)).toBe(0x00);
    expect(core.mmu.read(0xfeff)).toBe(0x00);
    core.mmu.write(0xfea0, 0xff);
    expect(core.mmu.read(0xfea0)).toBe(0x00);
  });

  it('reads unmapped I/O as all ones', () => {
    expect(core.mmu.read(0xff03)).toBe(0xff);
    expect(core.mmu.read(0xff08)).toBe(0xff);
    expect(core.mmu.read(0xff7f)).toBe(0xff);
  });

  it('sets the unused upper bits of IF', () => {
    core.mmu.write(0xff0f, 0x00);
    expect(core.mmu.read(0xff0f) & 0xe0).toBe(0xe0);
  });

  it('exposes IE at 0xFFFF and HRAM just below it', () => {
    core.mmu.write(0xffff, 0x1f);
    expect(core.mmu.read(0xffff)).toBe(0x1f);
    core.mmu.write(0xfffe, 0x42);
    expect(core.mmu.read(0xfffe)).toBe(0x42);
    expect(core.mmu.read(0xffff)).toBe(0x1f); // not clobbered by the HRAM write
  });

  it('routes VRAM and OAM to their own storage', () => {
    core.mmu.write(0x8000, 0xaa);
    core.mmu.write(0xfe00, 0xbb);
    expect(core.mmu.read(0x8000)).toBe(0xaa);
    expect(core.mmu.read(0xfe00)).toBe(0xbb);
  });

  it('ignores writes to ROM but routes them to the cartridge', () => {
    const before = core.mmu.read(0x0100);
    core.mmu.write(0x0100, (before ^ 0xff) & 0xff);
    expect(core.mmu.read(0x0100)).toBe(before);
  });
});

describe('OAM DMA', () => {
  it('copies 160 bytes from the selected page once it has run', () => {
    for (let i = 0; i < 0xa0; i++) core.mmu.write(0xc000 + i, i);
    core.mmu.write(0xff46, 0xc0);
    for (let i = 0; i < 162; i++) tickM(core);
    for (let i = 0; i < 0xa0; i++) expect(core.mmu.read(0xfe00 + i)).toBe(i);
  });
});

describe('serial', () => {
  it('captures a byte when a transfer starts with the internal clock', () => {
    core.mmu.write(0xff01, 0x41); // 'A'
    core.mmu.write(0xff02, 0x81); // start + internal clock
    expect(core.serial.text).toBe('A');
  });

  it('does not capture without the transfer-start bit', () => {
    core.mmu.write(0xff01, 0x41);
    core.mmu.write(0xff02, 0x01);
    expect(core.serial.text).toBe('');
  });
});

describe('timer', () => {
  it('exposes DIV as the high byte of the internal counter', () => {
    const before = core.mmu.read(0xff04);
    for (let i = 0; i < 128; i++) tickM(core);
    expect(core.mmu.read(0xff04)).not.toBe(before);
  });

  it('resets the whole internal counter when DIV is written', () => {
    for (let i = 0; i < 300; i++) tickM(core);
    core.mmu.write(0xff04, 0xff);
    expect(core.mmu.read(0xff04)).toBe(0x00);
  });

  it('does not increment TIMA while TAC is disabled', () => {
    core.mmu.write(0xff07, 0x00); // disabled
    core.mmu.write(0xff05, 0x00);
    for (let i = 0; i < 2000; i++) tickM(core);
    expect(core.mmu.read(0xff05)).toBe(0x00);
  });

  it('increments TIMA and raises the timer interrupt on overflow', () => {
    core.mmu.write(0xff07, 0x05); // enabled, 262144 Hz
    core.mmu.write(0xff06, 0x00);
    core.mmu.write(0xff05, 0xff);
    core.mmu.write(0xff0f, 0x00);
    for (let i = 0; i < 64; i++) tickM(core);
    expect(core.mmu.read(0xff0f) & 0x04).toBe(0x04);
  });
});

describe('LCD timing', () => {
  /** These need the LCD running, unlike the address-decoding tests above. */
  const lcdOn = (): void => core.mmu.write(0xff40, 0x91);

  it('advances LY and wraps after 154 lines', () => {
    lcdOn();
    const seen = new Set<number>();
    for (let i = 0; i < 70224; i++) {
      tickM(core);
      seen.add(core.mmu.read(0xff44));
    }
    expect(seen.has(0)).toBe(true);
    expect(seen.has(143)).toBe(true);
    expect(seen.has(153)).toBe(true);
    expect(Math.max(...seen)).toBe(153);
  });

  it('raises VBlank when LY reaches 144', () => {
    lcdOn();
    core.mmu.write(0xff0f, 0x00);
    let raised = false;
    for (let i = 0; i < 70224 && !raised; i++) {
      tickM(core);
      if ((core.mmu.read(0xff0f) & 0x01) !== 0) raised = true;
    }
    expect(raised).toBe(true);
  });

  it('parks LY at 0 while the LCD is off', () => {
    core.mmu.write(0xff40, 0x00);
    for (let i = 0; i < 5000; i++) tickM(core);
    expect(core.mmu.read(0xff44)).toBe(0);
  });

  it('keeps LY read-only', () => {
    core.mmu.write(0xff44, 0x50);
    expect(core.mmu.read(0xff44)).not.toBe(0x50);
  });
});

describe('I/O read masks', () => {
  it('reads unimplemented bits of implemented registers as 1', () => {
    core.mmu.write(0xff07, 0x00); // TAC — only bits 0-2 exist
    expect(core.mmu.read(0xff07) & 0xf8).toBe(0xf8);

    core.mmu.write(0xff02, 0x00); // SC — bits 1-6 unused on DMG
    expect(core.mmu.read(0xff02) & 0x7e).toBe(0x7e);
  });

  it('reads entirely unmapped I/O as 0xFF', () => {
    for (const address of [0xff03, 0xff08, 0xff0e, 0xff15, 0xff1f, 0xff27, 0xff4c, 0xff7f]) {
      expect(core.mmu.read(address)).toBe(0xff);
    }
  });

  it('restores post-boot I/O values on reset', () => {
    core.reset();
    expect(core.mmu.read(0xff40)).toBe(0x91); // LCDC
    expect(core.mmu.read(0xff47)).toBe(0xfc); // BGP
    expect(core.mmu.read(0xff26)).toBe(0xf1); // NR52
  });

  it('keeps the DMA source register readable', () => {
    core.mmu.write(0xff46, 0xc0);
    expect(core.mmu.read(0xff46)).toBe(0xc0);
  });
});

describe('timer reload window', () => {
  const armOverflow = (): void => {
    core.mmu.write(0xff07, 0x05); // enabled, fastest
    core.mmu.write(0xff06, 0x77); // TMA
    core.mmu.write(0xff05, 0xff); // TIMA about to overflow
  };

  it('loads TMA into TIMA after the overflow delay', () => {
    armOverflow();
    // Run to the instant TIMA wraps, then just past the 4-cycle reload window.
    for (let i = 0; i < 64 && core.mmu.read(0xff05) !== 0x00; i++) core.cpu.tickT(1);
    expect(core.mmu.read(0xff05)).toBe(0x00); // reads 0 during the window
    core.cpu.tickT(4);
    expect(core.mmu.read(0xff05)).toBe(0x77); // TMA loaded
  });

  it('lets a write during the window cancel the pending reload', () => {
    armOverflow();
    // Step until TIMA wraps to 0, which is the start of the reload window.
    for (let i = 0; i < 64 && core.mmu.read(0xff05) !== 0x00; i++) core.cpu.tickT(1);
    core.mmu.write(0xff05, 0x23);
    core.cpu.tickT(4);
    expect(core.mmu.read(0xff05)).toBe(0x23); // not overwritten by TMA
  });
});

describe('OAM DMA is cycle-stepped, not instant', () => {
  it('does not finish immediately when started', () => {
    for (let i = 0; i < 0xa0; i++) core.mmu.write(0xc000 + i, 0x5a);
    core.mmu.write(0xfe00, 0x00);
    core.mmu.write(0xff46, 0xc0);
    expect(core.mmu.oamDma.isActive || core.mmu.read(0xfe00) !== 0x5a).toBe(true);
  });

  it('completes after 160 M-cycles and copies every byte', () => {
    for (let i = 0; i < 0xa0; i++) core.mmu.write(0xc000 + i, i ^ 0x5a);
    core.mmu.write(0xff46, 0xc0);
    for (let i = 0; i < 162; i++) tickM(core);
    expect(core.mmu.oamDma.isActive).toBe(false);
    for (let i = 0; i < 0xa0; i++) expect(core.mmu.read(0xfe00 + i)).toBe(i ^ 0x5a);
  });

  /**
   * Mooneye's oam_dma_start pins this down: M=0 is the write to FF46, M=1 still has OAM
   * accessible, and the transfer is running by M=2. One M-cycle either way moves the end
   * of the transfer too, which is what the whole call/ret/push timing family measures.
   */
  it('STARTS AT M=2, not M=1: OAM is still readable for one cycle after the write', () => {
    core.mmu.write(0xfe00, 0x5a);
    for (let i = 0; i < 0xa0; i++) core.mmu.write(0xc000 + i, 0x11);

    core.mmu.write(0xff46, 0xc0); // M = 0
    tickM(core); // M = 1
    expect(core.mmu.oamDma.isActive).toBe(false);
    expect(core.mmu.read(0xfe00)).toBe(0x5a); // OAM still the CPU's

    tickM(core); // M = 2
    expect(core.mmu.oamDma.isActive).toBe(true);
    expect(core.mmu.read(0xfe00)).toBe(0xff); // now locked
  });

  it('runs for exactly 160 M-cycles once started', () => {
    for (let i = 0; i < 0xa0; i++) core.mmu.write(0xc000 + i, 0x11);
    core.mmu.write(0xff46, 0xc0);
    for (let i = 0; i < 161; i++) tickM(core);
    expect(core.mmu.oamDma.isActive).toBe(true); // the 160th byte has not moved yet
    tickM(core);
    expect(core.mmu.oamDma.isActive).toBe(false);
  });

  /**
   * The Game Boy has two buses and the transfer only occupies the one its source is on.
   * Pandocs' "only HRAM during DMA" is the safe rule for programmers; the hardware is
   * finer-grained, and every Mooneye timing test runs its payload out of echo RAM while a
   * VRAM-sourced transfer is still going.
   */
  it('a VRAM-SOURCED transfer leaves the external bus alone', () => {
    core.mmu.write(0xc500, 0x77);
    core.mmu.write(0x8000, 0x22);
    core.mmu.write(0xff46, 0x80); // source = VRAM
    tickM(core);
    tickM(core);
    expect(core.mmu.oamDma.isActive).toBe(true);

    expect(core.mmu.read(0xc500)).toBe(0x77); // WRAM: different bus, untouched
    expect(core.mmu.read(0x8000)).toBe(core.mmu.oamDma.conflictValue); // VRAM: conflicts
  });

  it('an EXTERNAL-SOURCED transfer leaves VRAM alone', () => {
    core.mmu.write(0x8000, 0x22);
    core.mmu.write(0xc500, 0x77);
    core.mmu.write(0xff46, 0xc0); // source = WRAM
    tickM(core);
    tickM(core);
    expect(core.mmu.read(0x8000)).toBe(0x22); // VRAM: different bus
    expect(core.mmu.read(0xc500)).toBe(core.mmu.oamDma.conflictValue);
  });

  it('OAM reads 0xFF while the transfer runs — it is LOCKED, not conflicted', () => {
    for (let i = 0; i < 0xa0; i++) core.mmu.write(0xc000 + i, 0x11);
    core.mmu.write(0xff46, 0xc0);
    // Three cycles in, so at least one byte has moved and the bus value is a real 0x11
    // rather than the idle 0xFF — otherwise this test could not tell lock from conflict.
    tickM(core);
    tickM(core);
    tickM(core);
    expect(core.mmu.oamDma.conflictValue).toBe(0x11);
    expect(core.mmu.read(0xfe00)).toBe(0xff);
  });

  it('DROPS a CPU write into OAM while the transfer runs', () => {
    for (let i = 0; i < 0xa0; i++) core.mmu.write(0xc000 + i, 0x11);
    core.mmu.write(0xff46, 0xc0);
    tickM(core);
    tickM(core);
    core.mmu.write(0xfe50, 0x99);
    for (let i = 0; i < 161; i++) tickM(core);
    expect(core.mmu.oamDma.isActive).toBe(false);
    expect(core.mmu.read(0xfe50)).toBe(0x11); // the transfer's byte, not the CPU's
  });

  it('DROPS a CPU write onto the bus the transfer owns', () => {
    core.mmu.write(0x8100, 0x22);
    core.mmu.write(0xff46, 0x80); // VRAM source: the video bus is busy
    tickM(core);
    tickM(core);
    core.mmu.write(0x8100, 0x99);
    expect(core.mmu.readDirect(0x8100)).toBe(0x22);
    // ...but a write on the other bus lands.
    core.mmu.write(0xc600, 0x99);
    expect(core.mmu.readDirect(0xc600)).toBe(0x99);
  });

  /**
   * The transfer's source decode sees one more mirror than the CPU's: 0xE000-0xFFFF folds
   * onto 0xC000-0xDFFF entirely, so page 0xFE reads WRAM and not OAM.
   */
  it('folds source pages 0xE0-0xFF onto work RAM, including 0xFE and 0xFF', () => {
    for (let i = 0; i < 0xa0; i++) core.mmu.write(0xde00 + i, i ^ 0x3c);
    core.mmu.write(0xff46, 0xfe);
    for (let i = 0; i < 162; i++) tickM(core);
    for (let i = 0; i < 0xa0; i++) expect(core.mmu.read(0xfe00 + i)).toBe(i ^ 0x3c);
  });

  it('locks the bus everywhere except HRAM while running', () => {
    core.mmu.write(0xff80, 0x99); // HRAM stays reachable
    for (let i = 0; i < 0xa0; i++) core.mmu.write(0xc000 + i, 0x11);
    core.mmu.write(0xff46, 0xc0);
    tickM(core);
    tickM(core);
    expect(core.mmu.oamDma.isActive).toBe(true);
    expect(core.mmu.read(0xff80)).toBe(0x99);
    expect(core.mmu.read(0x0100)).toBe(core.mmu.oamDma.conflictValue);
  });
});
