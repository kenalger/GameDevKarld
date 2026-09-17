# Phase 01 — SM83 CPU

**Owner:** `gb-cpu-engineer` · **Gate:** `emu-accuracy-tester`
**Depends on:** 00 · **Roadmap:** §8 Phase 1 CPU, §16 Interrupts
**Status:** ✅ Complete — 2026-09-15. **SingleStepTests/sm83: 500,000/500,000 (100%)** across all 500 opcode files, including per-M-cycle bus activity. Plus 37 dedicated tests for interrupt dispatch, the EI delay and the HALT bug.

## Goal

Every legal opcode, correct flags, correct cycle counts, correct interrupt dispatch — verified
per-opcode against hardware-derived test data, against a flat memory array. No bus, no PPU, no ROM.

## The decision that must be made on day one

**Tick every subsystem per memory access, not once per instruction.** A core that runs an instruction
and then adds 16 cycles cannot pass Phase 03 and cannot be fixed without a rewrite. Decide this now,
write it in `docs/cpu.md`, and build the `tick()` plumbing before the second opcode.

## Tasks

- [ ] `Registers` — `A F B C D E H L`, pairs `AF BC DE HL`, `PC`, `SP`. **Low nibble of `F` is
      hardwired to 0** — `POP AF` with `0xFF` reads back `0xF0`.
- [ ] `Flags` (Z N H C), `ALU` (add/adc/sub/sbc/and/or/xor/cp/inc/dec, rotates/shifts, DAA).
- [ ] `Decoder` — flat `Function[256]` jump table + parallel cycle table, plus the `CB` page.
      Unused opcodes (`D3 DB DD E3 E4 EB EC ED F4 FC FD`) lock the CPU.
- [ ] `Executor` — all families in roadmap §8: LD, INC/DEC, ADD/ADC/SUB/SBC, AND/OR/XOR/CP,
      JP/JR/CALL/RET/RST, PUSH/POP, BIT/SET/RES, rotates, HALT, STOP, DI, EI.
- [ ] `InterruptController` — IE/IF/IME, 5 M-cycle dispatch, priority VBlank `0x40` > STAT `0x48` >
      Timer `0x50` > Serial `0x58` > Joypad `0x60`.
- [ ] `EI` one-instruction delay; `DI` immediate; `RETI` immediate.
- [ ] **The HALT bug**: `IME=0` and `(IE & IF & 0x1F) != 0` → does not halt, **PC fails to
      increment**, next byte executes twice. Games depend on this.
- [ ] Flat-memory test double so the CPU is unit-testable with no bus.

## Exit gate — `emu-accuracy-tester`

- [ ] **SingleStepTests/sm83 — 100% of all `00-FF` and `CB 00-CB FF`**, including per-cycle bus
      activity. Not "most." Not "all except DAA."
- [ ] Unit tests asserting *flags and cycles* for every instruction family.
- [ ] Interrupt dispatch, `EI` delay and the HALT bug each have a dedicated test.

## Fetch before implementing

https://rgbds.gbdev.io/docs/gbz80.7 (per-opcode semantics/flags/cycles) ·
https://gbdev.io/gb-opcodes/optables/ and https://izik1.github.io/gbops/ (cross-check them) ·
https://gbdev.io/pandocs/ CPU Registers and Flags, Interrupts ·
Gekkio's technical reference for per-M-cycle internals.

## Traps

- `ADD SP,e8` / `LD HL,SP+e8` derive H and C from the **low byte** unsigned add; Z and N always clear.
- `DAA` branches on the N flag and does not clear C on the add path.
- If SP is placed so an interrupt push overwrites `0xFFFF`, the IE read mid-dispatch changes the
  vector taken. Mooneye tests this in Phase 03.

## Out of scope

The timer (03) — but leave the hook. Real memory (02). STOP's CGB speed-switch behavior (11).
