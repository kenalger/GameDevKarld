# Phase 16 — Cheats & Controller Configuration

**Owner:** `gb-memory-engineer` (engine) · `webboy-frontend-engineer` (panels) · **Gate:** `emu-accuracy-tester`
**Depends on:** 08 (save states), 11 (CGB) · **Roadmap:** not in the original 16 — added on request
**Status:** ✅ **GB/GBC done** — 2026-09-18. Game Genie and GameShark decode and apply, keyboard
bindings are user-editable, both persist per cartridge. GBA cheats deferred, see below.

| Built | |
|---|---|
| Game Genie | 9- and 6-character, compare byte, ROM read substitution |
| GameShark | 8-character, types `01` and `9x`, per-frame RAM write |
| Persistence | Own IndexedDB database, keyed by cartridge identity |
| Cheats panel | Type / name / toggle / delete, format auto-detected |
| Key rebinding | Picker + optional key capture, steal semantics, restore defaults |
| Quick state | Save/Load on the transport row, sharing slot 0 with the panel |

> **The ROM image is never mutated, and that is a correctness requirement rather than a
> preference.** `saveKey` is `title:globalChecksum:romLength`, the checksum sums every ROM byte,
> and that key is the IndexedDB key for the battery save **and** every save-state slot. An
> in-place patch — which is how mGBA and Gambatte implement Game Genie — would change the key,
> point the app at a different record, and make the player's save appear to vanish. A test asserts
> the ROM array is byte-identical after a cheat has run.
>
> Patching on read is also what the hardware does. A Game Genie is a pass-through adapter that
> substitutes as the game reads, so the compare byte handles bank switching for free: switch to a
> bank where the byte differs and the compare simply fails. No mapper knowledge leaks into the
> cheat module and there is nothing to undo when a code is disabled.
>
> **The hook sits in `Mmu.readDirect`**, after the mapper resolves the bank. OAM DMA and HDMA route
> through the same function, so a DMA sourcing from ROM sees patched bytes — as it would on
> hardware, and for free.
>
> **The compare byte is `ror8(x, 2) ^ 0xBA`, not `ror8(x ^ 0xBA, 2)`.** The wrong order
> **round-trips perfectly** while getting all 256 possible compare bytes wrong. Every decode test
> therefore asserts literal values and there is no round-trip test in the file. Fixtures were
> cross-checked against SameBoy, VBA-M and mGBA, which agree on every input by four different
> routes. Sabotaging the order fails four named tests.
>
> **Idle cost is asserted exactly, by a counter, not a stopwatch.** An interleaved A/B benchmark of
> two *identical* workloads measured ±10% per pair on this machine, so no timing threshold tight
> enough to catch a per-read map lookup could avoid being flaky. `checksPerformed` must be exactly
> 0 after 60 frames with no cheats, and after loading then clearing codes.
>
> **GameShark `8x` codes are refused**, not applied. They select a cartridge RAM bank, which means
> writing MBC control registers behind the game's back — and on MBC1 that can also move the mapped
> ROM bank. Silently desynchronising the mapper is worse than saying no.

## Controls

The key picker is the **primary** control and key-capture is the enhancement, not the reverse.
Press-a-key capture cannot work for a screen-reader user: in NVDA's and JAWS' browse mode single
letters are navigation commands, intercepted before the browser sees them, so the keydown never
arrives. A native `<select>` works there, with voice control, and on a phone.

Capture, where it is used, handles the trap that bites everyone: it is started by pressing Enter or
Space on a button, and **Enter is the default Start binding** — so anything already held when
capture begins is ignored until its own keyup. Escape cancels, Tab cancels *without*
`preventDefault` (the guaranteed way out of a keyboard trap), and there is an 8-second timeout.

Bindings are keyed by `KeyboardEvent.code`, so one key maps to at most one button and a duplicate
is structurally impossible. Taking a key already in use is therefore a **steal**, not a swap — no
surveyed emulator swaps, because handing the victim a replacement key is a guess. It steals and
says so.

## What is NOT done

- **GBA cheats.** They need TEA decryption plus a CPU breakpoint hook, and the `DEADFACE` reseed
  depends on two 256-byte translation tables published nowhere except inside mGBA (MPL-2.0). That
  was a licensing decision; it is now decided. **WebBoy is MIT, so mGBA's MPL-2.0 tables cannot be
  copied in.** The reseed must be reimplemented from GBATEK, or the feature ships without it.
- **Gamepad remapping.** The `InputSource` shape is designed to take it without churn, but the pad
  map is still a hardcoded standard-layout index table.
- **The A/B defaults are still inverted** relative to hardware and to mGBA/SameBoy/RetroArch. See
  `docs/handoff.md`.
- **Multi-line / multi-code entry.** One code per row.
- **A "did this code match?" indicator.** BGB shows whether a Game Genie compare actually hit,
  which is the best diagnostic in any cheat UI — without it a code for the wrong ROM revision
  silently does nothing.

## Exit gate

- [x] Decode fixtures from Pan Docs and three independent implementations, asserted literally.
- [x] Compare byte gates the patch; disabling restores the original byte.
- [x] The ROM image and the save key are unchanged by an active cheat.
- [x] Exactly zero per-read work when no cheats are active.
- [x] Codes and bindings persist per cartridge and survive a reload.
- [x] No regression: 975 tests, Mooneye 60/66, sm83 500,000/500,000, GBA 7/7, ~20x realtime.
- [ ] **Verified in a browser.** Blocked with phases 09 and 10.

## Fetch before implementing

https://gbdev.io/pandocs/Shark_Cheats.html — the only primary source for GB cheat formats ·
https://problemkaputt.de/gbatek-gba-cheat-devices.htm — GBA, when it is attempted.

## Out of scope, permanently

**A bundled or remote cheat database.** A remote lookup has to send an identifier derived from the
player's ROM, which is exactly the quiet exfiltration law 3 exists to prevent; a bundled one puts a
list of commercial game titles in the repository, which law 4 forecloses. If either is proposed
later it is an escalation, not a feature request.
