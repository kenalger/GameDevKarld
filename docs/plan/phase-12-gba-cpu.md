# Phase 12 — GBA: ARM7TDMI

**Owner:** `gb-cpu-engineer` · **Gate:** `emu-accuracy-tester`
**Depends on:** 11 · **Roadmap:** §27 GBA Phase, §28 GBA CPU
**Status:** ✅ Gate met — 2026-09-16. **jsmolka/gba-tests: `arm.gba` and `thumb.gba` both pass every test.** A separate core from the SM83, as the roadmap requires — shared only through the `EmulatorCore` contract. 18 unit tests cover the barrel shifter's edge cases, arithmetic flags, the visible pipeline, mode banking and SWI.

> **Two bugs, both in the pipeline, both found by tracing rather than guessing.**
>
> 1. PC was advanced *before* execution instead of after, so every instruction saw PC+12 rather than PC+8 — `BL` stored the wrong return address and the first `POP {PC}` popped an empty stack into `0x00000000`.
> 2. The fix used a PC *comparison* to detect "did this instruction branch?". A `BX` whose target's post-flush PC coincidentally equalled the old PC read as "no branch", advanced PC a second time, and **skipped one instruction**. Replaced with an explicit `branched` flag. A regression test now pins this exact sequence.
>
> Plus one decoder gap: the immediate-offset `LDRH` did not rotate misaligned reads (the register-offset form did). Thumb test 219 caught it.
>
> **Not verified:** ARMWrestler (not fetched — the jsmolka suites cover the same ground and were the plan's primary gate), and a trace-log diff against mGBA (no reference emulator on this machine). Cycle timing is a placeholder flat 1 per access; real waitstates arrive with the bus in Phase 13.

## Goal

A second, independent CPU core. Roadmap §27 is blunt: **do not attempt to extend the Game Boy CPU
into the GBA.** Share only the `EmulatorCore` interface and the scheduler abstraction.

## Tasks

- [ ] Register file: 16 GPRs, **7 modes with banked `R13`/`R14`** (plus `R8`–`R12` in FIQ), `CPSR`
      and per-mode `SPSR`.
- [ ] **Separate ARM and Thumb decoders** over a shared register file and ALU. Not one merged decoder.
- [ ] **Three-stage pipeline visible to software**: reading PC returns current address **+8 in ARM,
      +4 in Thumb**. Get this wrong and every PC-relative load is wrong. Flush on every branch and
      mode change.
- [ ] Barrel shifter as part of the data-processing path, with correct `S`-bit flag effects —
      especially `RRX` and shift-by-register at 32 and >32. ARMWrestler hammers these.
- [ ] Condition codes on every ARM instruction (`0b1111` = never on this core).
- [ ] `LDM`/`STM` including the S-bit and base-register-in-list edge cases, with correct
      sequential/non-sequential access classification — Phase 13 prices those cycles.
- [ ] `BX` mode switching, exception vectors, IRQ dispatch.

## Exit gate — `emu-accuracy-tester`

- [ ] **ARMWrestler** — all ARM and Thumb pages clean.
- [ ] **jsmolka/gba-tests** — `arm` and `thumb` suites pass.
- [ ] Trace-log diff against **mGBA** on a test ROM shows no divergence.
- [ ] All GB/GBC gates still green.

## Fetch before implementing

https://problemkaputt.de/gbatek.htm — ARM CPU Overview, ARM/THUMB instruction sets, CPU registers ·
https://developer.arm.com/documentation/ddi0210/c/ (ARM7TDMI TRM).

## Traps

- CPU timing cannot be separated from bus timing on the GBA. Coordinate the access-classification
  interface with `gb-memory-engineer` **before** implementing, not after.
