import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { runGbaTest } from '../harness/gbaRunner.js';
import { Arm7, VECTOR_SWI } from '../../packages/emulator/src/gba/cpu/Arm7.js';
import { GbaMmu } from '../../packages/emulator/src/gba/memory/GbaMmu.js';
import { GameBoyAdvanceCore } from '../../packages/emulator/src/gba/GameBoyAdvanceCore.js';

const ROMS = new URL('../roms/gba-tests/', import.meta.url).pathname;
const available = existsSync(`${ROMS}arm.gba`);

/** THE PHASE 12 + 13 EXIT GATE. */
describe.skipIf(!available)('jsmolka/gba-tests against the real bus', () => {
  // arm/thumb/memory are the CPU and bus gates; none/sram/flash* are the Phase 15 save
  // gate — they exercise the 8-bit backup bus and the Flash command protocol.
  it.each(['arm', 'thumb', 'memory', 'none', 'sram', 'flash64', 'flash128'])(
    '%s.gba — all tests pass',
    (suite) => {
      const result = runGbaTest(`${ROMS}${suite}.gba`);
      expect(result.passed, `screen read:\n${result.text}`).toBe(true);
    },
  );

  /**
   * Without this, "all pass" proves nothing.
   *
   * The first version of this harness read R12 after the ROM halted and reported PASS even
   * for a deliberately broken CPU — `m_test_eval` pushes R0-R12 before evaluating and pops
   * them back before the final `b .`, so the register never held the verdict. This test
   * sabotages execution and requires the harness to notice.
   */
  it('DETECTS A BROKEN CPU: a sabotaged run must not report pass', () => {
    const mmu = new GbaMmu();
    mmu.reset();
    mmu.loadRom(new Uint8Array(readFileSync(`${ROMS}arm.gba`)));
    const cpu = new Arm7(mmu);
    cpu.reset();
    new DataView(mmu.bios.buffer).setUint32(VECTOR_SWI, 0xe1b0f00e, true);
    cpu.softwareInterrupt = () => {
      const r = cpu.regs.r;
      const a = r[0]! | 0;
      const b = r[1]! | 0;
      r[0] = (b === 0 ? 0 : Math.trunc(a / b)) >>> 0;
      r[1] = (b === 0 ? 0 : a % b) >>> 0;
      r[3] = Math.abs(r[0]! | 0) >>> 0;
    };
    let vblank = 0;
    const read16 = mmu.read16.bind(mmu);
    mmu.read16 = (address: number): number =>
      address >>> 0 === 0x04000004 ? (vblank ^= 1) : read16(address);

    let n = 0;
    for (let steps = 0; steps < 20_000_000; steps++) {
      cpu.step();
      // Corrupt a register periodically, so the ALU tests must fail.
      if (++n > 200 && n % 97 === 0) cpu.regs.r[0] = (cpu.regs.r[0]! ^ 0x8) >>> 0;
      if (steps % 5000 === 0) {
        const pc = cpu.regs.r[15]!;
        for (let k = 0; k < 4; k++) cpu.step();
        if (cpu.regs.r[15] === pc) break;
      }
    }

    // Measure the rendered width the same way the runner does.
    let leftmost = Number.POSITIVE_INFINITY;
    let rightmost = -1;
    for (let y = 70; y < 90; y++) {
      for (let x = 0; x < 240; x++) {
        if (mmu.vram[y * 240 + x] === 0) continue;
        if (x < leftmost) leftmost = x;
        if (x > rightmost) rightmost = x;
      }
    }
    const width = rightmost - leftmost + 1;
    // The pass text is 126px wide; the fail text is 100px.
    expect(width).toBeLessThan(120);
  });
});

/** Phase 15: a GBA save must survive the emulator being torn down and rebuilt. */
describe.skipIf(!available)('GBA battery saves', () => {
  const SRAM = 0x0e000000;

  /** Flash only accepts a byte after the unlock pair plus the 0xA0 command. */
  function flashWrite(core: GameBoyAdvanceCore, offset: number, byte: number): void {
    core.mmu.write8(SRAM + 0x5555, 0xaa);
    core.mmu.write8(SRAM + 0x2aaa, 0x55);
    core.mmu.write8(SRAM + 0x5555, 0xa0);
    core.mmu.write8(SRAM + offset, byte);
  }

  it.each([
    ['sram', 'sram', 0x8000],
    ['flash64', 'flash64', 0x10000],
    ['flash128', 'flash128', 0x20000],
  ])('%s.gba is detected as %s and round-trips through getSaveData', (rom, type, size) => {
    const bytes = new Uint8Array(readFileSync(`${ROMS}${rom}.gba`));

    const core = new GameBoyAdvanceCore();
    core.loadRom(bytes);
    expect(core.mmu.backup.getType()).toBe(type);
    expect(core.hasBatterySave()).toBe(true);
    expect(core.getSaveData()!.length).toBe(size);
    expect(core.consumeSaveRamDirty()).toBe(false);

    // Write through the bus exactly as a game would, then read back through it.
    const flash = type !== 'sram';
    for (let i = 0; i < 256; i++) {
      const byte = (i * 7 + 1) & 0xff;
      if (flash) flashWrite(core, i, byte);
      else core.mmu.write8(SRAM + i, byte);
    }
    expect(core.consumeSaveRamDirty()).toBe(true);
    expect(core.consumeSaveRamDirty()).toBe(false); // consumed, not sticky
    expect(core.mmu.read8(SRAM + 5)).toBe(36);

    const saved = core.getSaveData()!;

    // A console reset must NOT wipe the cartridge.
    core.reset();
    expect(core.mmu.read8(SRAM + 5)).toBe(36);

    // A brand-new core with the same ROM must see the same bytes back.
    const restored = new GameBoyAdvanceCore();
    restored.loadRom(bytes);
    expect(restored.mmu.read8(SRAM)).toBe(0xff); // erased until the save is loaded
    restored.loadSaveData(saved);
    for (let i = 0; i < 256; i++) expect(restored.mmu.read8(SRAM + i)).toBe((i * 7 + 1) & 0xff);
    expect(restored.consumeSaveRamDirty()).toBe(false); // loading is not a change
  });
});
