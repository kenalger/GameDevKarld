# Phase 13 — GBA: Memory, DMA & Timers

**Owner:** `gb-memory-engineer` · **Supporting:** `gb-cpu-engineer` (timers/waitstates) · **Gate:** `emu-accuracy-tester`
**Depends on:** 12 · **Roadmap:** §29 GBA Memory, §31 DMA, §32 Timers
**Status:** ✅ Gate met — 2026-09-17. **jsmolka `memory.gba`, `arm.gba` and `thumb.gba` all pass against the real bus** (not the flat test double used in Phase 12). 29 unit tests cover region decoding, mirroring, bus widths, waitstates, DMA and timers.

Built: the full region map with mirroring, `WAITCNT` waitstates and per-region bus widths, BIOS read protection, open bus, four DMA channels with all four timing modes, and four timers with cascade.

> **The important finding was a broken harness, not broken hardware.**
>
> My first runner read `R12` after the ROM halted and reported **PASS for everything — including a deliberately sabotaged CPU.** `m_test_eval` pushes R0-R12 before evaluating and pops them back before the final `b .`, so that register never holds the verdict. Three separate "all pass" results were meaningless.
>
> The runner now reads the **rendered screen** (the ROMs report there by design), and a **negative control is a permanent test**: it sabotages execution and asserts the harness reports failure. Two further false signals were caught on the way — a 160px crop that truncated the pass text, and `memory.gba`'s deliberate VRAM test-writes being mistaken for glyphs.
>
> **Not done:** cartridge backup (SRAM/Flash/EEPROM detection) is unimplemented — `sram.gba`, `flash64.gba` and `flash128.gba` are not yet run. DMA is modelled as a burst rather than interleaved with the CPU; since DMA halts the CPU on hardware, the observable difference is confined to cycle counts.

## Tasks

**Memory bus**
- [ ] Regions: BIOS `0x00000000` (read-protected — outside reads return the last fetched BIOS
      opcode) · EWRAM `0x02000000` 256 KB, 16-bit bus, waitstated · IWRAM `0x03000000` 32 KB, 32-bit,
      fast · I/O `0x04000000` · Palette `0x05000000` · VRAM `0x06000000` 96 KB (**non-power-of-two
      mirroring quirk**) · OAM `0x07000000` · ROM `0x08000000` + waitstate mirrors · SRAM
      `0x0E000000` (8-bit bus only).
- [ ] **Bus width matters**: 8/16/32-bit access to 16-bit regions differs, misaligned reads rotate,
      unaligned writes to VRAM/PAL/OAM duplicate the halfword. **Open bus returns stale prefetch,
      not zero.**
- [ ] `WAITCNT` waitstates + the ROM prefetch buffer. Not optional for timing-sensitive games.

**DMA**
- [ ] Four channels with differing capability and triggers: immediate, VBlank, HBlank, sound FIFO
      (ch1/2), video capture (ch3). Source/dest address control modes, repeat, transfer width,
      channel-priority ordering. Test each channel independently.

**Timers**
- [ ] Four channels: reload, prescalers, overflow, **cascade**, interrupt generation — integrated
      with the central scheduler, not free-running.

**Cartridge backup**
- [ ] SRAM, Flash (command sequences + device IDs), EEPROM (bit-serial over DMA). Detect by scanning
      the ROM for the ID string — the documented standard technique.
- [ ] Wire GBA saves into the existing Phase 06 IndexedDB layer.

## Exit gate — `emu-accuracy-tester`

- [ ] jsmolka/gba-tests memory and DMA suites pass.
- [ ] Timer tests including cascade and interrupt timing.
- [ ] Each backup type round-trips through save and reload.
- [ ] All prior gates green.

## Fetch before implementing

https://problemkaputt.de/gbatek.htm — GBA Memory Map, DMA Transfers, Timers, Cartridge Backup,
Memory/Bus Widths and Waitstates.
