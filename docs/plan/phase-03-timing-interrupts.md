# Phase 03 — Timing, Timer & Interrupt Accuracy — 🏳️ M1

**Owner:** `gb-cpu-engineer` · **Supporting:** `gb-memory-engineer` (access timing) · **Gate:** `emu-accuracy-tester`
**Depends on:** 02 · **Roadmap:** §15 Timing, §16 Interrupts
**Status:** ✅ Gate met — 2026-09-15, extended 2026-09-17. Blargg `instr_timing` 1/1, `mem_timing` 3/3, `mem_timing-2` 3/3. Mooneye `acceptance/timer/*` **13/13**, `interrupts/*` 1/1, `halt_ime*` 4/4, `ei_*` 2/2 — **zero failures in the gated subsets**. Overall Mooneye acceptance rose 32 → 40 → 57 → **60 of 66 applicable**.

> **2026-09-17: the instruction-timing family was never about instructions.** `call_timing`, `ret_timing`, `push_timing`, `rst_timing`, `jp_timing`, `add_sp_e_timing` and their variants — eleven tests — all failed for one reason, and it was in OAM DMA. Each one aligns a memory access against the end of a transfer and reads what comes back. Fixing the transfer fixed all of them; the model is recorded in phase 04.
>
> **The runner now skips tests that target other hardware.** Mooneye encodes the models a test is expected to pass on in the filename suffix, and `-dmg0`, `-mgb`, `-sgb`, `-sgb2` and `-S` fail on a DMG **by design**. Nine tests were being counted as failures for emulating the wrong console. Every one of them has an applicable sibling — `boot_regs-dmgABC` beside `boot_regs-sgb` — and those siblings are run and pass, so this removes noise rather than hiding anything. The denominator changed from 75 to 66 and the run prints what it skipped and why.

> **Calibration note.** `ACCESS_T_OFFSET` (where in an M-cycle the bus access lands) was swept 0–4 against Mooneye rather than assumed: it scored 36/35/35/35/32, so it is pinned at 0. An interrupt-sampling-delay hypothesis was swept the same way and **disproved** (0 was best), so it was reverted rather than kept. Re-run the sweep before changing either.

## Goal

Cycles land in the right *place*, not just the right *count*. This is the phase that separates an
emulator that runs Tetris from one that runs everything, and it is the phase most projects skip and
then pay for forever.

## Tasks

- [ ] **Master scheduler.** One T-cycle clock; every subsystem ticks from it in lockstep with memory
      accesses. Must express CGB double-speed (CPU and timer double, **PPU does not**) without a
      rewrite in Phase 11 — design the abstraction now even though CGB is far off.
- [ ] **DIV** = upper 8 bits of a free-running 16-bit counter at the system clock. **Writing any
      value to DIV resets the whole 16-bit counter**, which can produce a spurious TIMA increment.
- [ ] **TIMA via falling-edge detection** on a TAC-selected bit of that counter ANDed with the enable
      bit. Model the edge detector. Do **not** model "increment every N cycles" — it cannot pass.
- [ ] **TIMA overflow window**: reads `0x00` for 4 T-cycles *before* loading TMA and raising the
      interrupt. Writing TIMA in that window cancels the reload; writing TMA in it loads the new value.
- [ ] Per-access read/write cycle placement inside each instruction (with `gb-memory-engineer`).
- [ ] Interrupt timing edge cases, including the `0xFFFF`-overlapping-push IE corruption from 01.

## Exit gate — `emu-accuracy-tester`

- [ ] Blargg **`instr_timing`** passes.
- [ ] Blargg **`mem_timing`** and **`mem_timing-2`** pass.
- [ ] Mooneye **`acceptance/timer/*`** — all of it, including `rapid_toggle` and `tima_write_reloading`.
- [ ] Mooneye **`acceptance/interrupts/*`**, **`halt_ime*`**, **`ei_*`**.
- [ ] Scoreboard committed. **🏁 M1 — "The CPU is real."**

## Fetch before implementing

https://gbdev.io/pandocs/ Timer and Divider Registers, Interrupts ·
Gekkio's technical reference (per-M-cycle internal operation) ·
Kevin Horton's *Nitty Gritty Gameboy Cycle Timing* via https://github.com/gbdev/awesome-gbdev.

## Traps

- If the scheduler is bolted on after the CPU rather than driving it, these tests will not pass and
  the fix is a rewrite. If Phase 01 skipped per-access ticking, **stop and fix it here** — it only
  gets more expensive.
- The APU frame sequencer is clocked from a DIV bit (Phase 07). A DIV bug becomes an audio bug later,
  so get DIV exactly right now.

## Out of scope

Anything visual. Resist starting the PPU until this gate is green.
