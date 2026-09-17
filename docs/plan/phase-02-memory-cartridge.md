# Phase 02 — Memory Bus & Cartridge

**Owner:** `gb-memory-engineer` · **Gate:** `emu-accuracy-tester`
**Depends on:** 01 · **Roadmap:** §9 Memory Bus, §10 Cartridge, §11 ROM Header, §19 Manager
**Status:** ✅ Complete — 2026-09-15. **Blargg `cpu_instrs` 11/11**, plus `instr_timing` 1/1 and `mem_timing` 3/3. **Mooneye MBC1 13/13** including multicart. 42 unit tests for the bus, header and mapper.

> **Scope note:** the gate needed a timer and an LCD state machine, which the plan had scheduled for Phases 03 and 04. Blargg `02-interrupts` requires timer interrupts, and every Blargg ROM waits on VBlank at startup — without LY progression the ROM hangs before printing anything. Both landed here; Phase 03 now verifies timer edge cases rather than building the timer, and Phase 04 adds rendering on top of the existing LCD timing.

## Goal

A real address-decoded bus and a real cartridge, so the CPU stops talking to a flat array and a ROM
actually boots. **This is the phase where the first commercial-grade test ROM runs end to end.**

## Tasks

**Bus**
- [ ] Address map: `0000-3FFF` ROM0 · `4000-7FFF` ROMX · `8000-9FFF` VRAM · `A000-BFFF` SRAM ·
      `C000-CFFF` WRAM0 · `D000-DFFF` WRAMX · `E000-FDFF` **echo (an address fold, not a copy)** ·
      `FE00-FE9F` OAM · `FEA0-FEFF` prohibited · `FF00-FF7F` I/O · `FF80-FFFE` HRAM · `FFFF` IE.
- [ ] **Reads/writes are behavior, not storage.** Unmapped I/O bits read as 1. Leave the PPU-mode
      lockout hooks in place for Phase 04 (`0xFF` from VRAM in mode 3, OAM in modes 2–3).
- [ ] Serial stub `FF01`/`FF02` that captures output — **Blargg's results come out of here**, and
      without it the gate is unreadable.
- [ ] Dispatch by region (high-nibble switch or a 256-entry page table). Measure; this is the hottest
      function in the program. Zero allocation in `read`/`write`.

**Cartridge**
- [ ] `Cartridge` interface; ROM-ONLY implementation.
- [ ] **MBC1** — the mode bit at `0x6000-7FFF`, the `0x20/0x40/0x60` bank-0 quirk, and the separate
      multicart wiring. Read the whole Pan Docs page; MBC1 is the most half-implemented mapper alive.
- [ ] Header parser (`CartridgeInfo` per roadmap §11): `0x0134-43` title (**verify the
      manufacturer-code/CGB-flag overlap against Pan Docs**), `0x0143` CGB flag, `0x0147` type,
      `0x0148` ROM size, `0x0149` RAM size, `0x014D` checksum. Validate and report a bad header.
- [ ] `detectCartridge()` → `'GB' | 'GBC' | 'GBA'`, wired into `EmulatorManager`. GBA is detected by
      **its own header** (entry branch `0x00`, logo `0x04`, fixed `0x96` at `0xB2`) — never by filename.

## Exit gate — `emu-accuracy-tester`

- [ ] **Blargg `cpu_instrs` — 11/11**, results read from serial. This is milestone M1's first half
      and it means the instruction set is genuinely real.
- [ ] Mooneye `emulator-only/mbc1/*` passes.
- [ ] Header parser produces correct info for ROM-only and MBC1 homebrew; a truncated/corrupt ROM
      produces a clean error, not a crash.
- [ ] Echo RAM, prohibited region and unmapped-bit reads each have a test.

## Fetch before implementing

https://gbdev.io/pandocs/ Memory Map, The Cartridge Header, Memory Bank Controllers ·
https://gbdev.io/pandocs/The_Cartridge_Header.html (read the offset table; do not trust recall).

## Traps

- Do not implement echo RAM as a copy. Do not omit it — games hit it.
- Filename-based system detection will eventually mis-route a ROM. Use the header.

## Out of scope

MBC2/3/5 and battery saves (06). OAM DMA (04, once the PPU exists to make it observable).
