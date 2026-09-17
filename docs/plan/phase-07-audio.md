# Phase 07 — Audio (APU + Web Audio)

**Owner:** `gb-audio-io-engineer` · **Gate:** `emu-accuracy-tester` + `webboy-app-qa`
**Depends on:** 05 (needs Phase 03's DIV to be exact) · **Roadmap:** §17 Audio
**Status:** ⚠️ **Gate NOT met** — 2026-09-15. Blargg `dmg_sound` **9/12**, target 12/12. All four channels, the DIV-clocked frame sequencer, DAC separation, NR52 power rules and the length extra-clocking quirk are implemented; 27 unit tests pass. The AudioWorklet output path is written but unverified in a browser.

> **The three failures are one bug**, not three: `09-wave read while on`, `10-wave trigger while on` and `12-wave write while on` all depend on the narrow DMG window in which the CPU may reach wave RAM while channel 3 plays. A window is implemented (reads went from all-`0xFF` to partially correct), but its phase relative to the CPU access is wrong. Sweeping the window width 1–6 T-cycles and trying always-accessible both left the count at 9/12, so this needs the per-cycle relationship worked out rather than tuned.
>
> **Also unverified:** "zero underruns over a sustained 10-minute run", and Safari/Firefox behaviour. Both need a real browser; the Chrome extension is not connected here.
>
> Practical impact of the gap is small — games do not read wave RAM while it plays — but the gate says 12/12 and it is 9/12.
>
> **2026-09-17, further attempt — still 19/24 across DMG+CGB.** Confirmed the rule from the gg8 APU reference: on DMG the CPU may touch wave RAM *only* while the channel is itself reading it; otherwise reads return `0xFF`.
>
> Instrumented the failing test: it sets frequency 2046, so the channel advances every **4 T-cycles**, and it performs single reads ~3600 T-cycles apart — not a tight loop. A 2-cycle window inside a 4-cycle period therefore hits about half the time, which exactly explains the alternating `FF 11 FF 11` output.
>
> Tried the principled alternative — the channel holds its sample for the **whole period**, so any access between advances lands in-window. That **fixes `10-wave trigger while on` on CGB** but breaks `12-wave` ("timer period or phase resetting is wrong"). **Net zero: still 19/24.**
>
> **The remaining gap is phase, not width.** Both the CPU accesses and the channel advances sit on a 4-T grid, so whether they coincide depends on their relative phase. The fix is therefore to model *when within the period* the wave unit performs its read — per-cycle wave-unit modelling, not a wider window. Five tuning attempts have not moved the score, so this is left as recorded debt rather than tuned further.

## Goal

All four channels correct, and a browser output path that does not crackle.

## Build the output path first

Get the clock relationship right before writing a single channel. A "close enough" pacing design
produces crackle that cannot be tuned away afterward.

- [ ] **`AudioWorkletNode` only.** `ScriptProcessorNode` is deprecated and main-thread; it will glitch.
- [ ] Ring buffer between emulator and worklet — `SharedArrayBuffer` + atomics preferred, with a
      **working** `postMessage`/transferable fallback when cross-origin isolation is unavailable.
- [ ] Resample native rate → `audioContext.sampleRate` (44100/48000/96000 — **do not assume**).
- [ ] **One component owns frame pacing** (with `webboy-frontend-engineer`). Audio-buffer-driven is
      most robust: run frames until the buffer is adequately full, correct drift by nudging the
      resample ratio a fraction of a percent. **Never drop or duplicate samples** — that is audible;
      a 0.2% pitch shift is not. Record the decision in `docs/audio.md`.
- [ ] Target ~50–80 ms buffer, exposed as a setting; surface underrun count and depth to the perf panel.
- [ ] `AudioContext` starts suspended — resume on the user gesture that loads/plays. Suspend on tab
      hide; never free-run into a giant buffer while hidden.

## APU

- [ ] Channels 1 (pulse+sweep), 2 (pulse), 3 (wave, `FF30-3F`), 4 (noise LFSR 15/7-bit). `NR10-NR52`.
- [ ] **Frame sequencer at 512 Hz clocked by a falling edge of a DIV bit** (bit 4 normal, bit 5 double
      speed) — *not* a free-running timer. Length 256 Hz (steps 0,2,4,6), envelope 64 Hz (step 7),
      sweep 128 Hz (steps 2,6). Writing DIV can clock it early; Blargg detects this.
- [ ] `trigger()` (bit 7 of `NRx4`) as one carefully-sourced function: enable, reload length if zero,
      reload frequency timer and envelope, and for ch1 run the sweep calculation immediately — which
      can disable the channel on the spot.
- [ ] The **length-counter extra-clocking quirk** (Blargg `03-trigger`). Not optional.
- [ ] `NR52` bit 7 power-off zeroes registers and blocks writes; bits 0–3 are read-only status.
- [ ] **DAC is separate from the channel** — zeroing the upper 5 bits of `NRx2` disables it and
      re-enabling requires a trigger. Ch3's DAC is `NR30` bit 7.
- [ ] Wave RAM access restrictions while ch3 plays, and the retrigger first-sample corruption.
- [ ] `NR50` master volume, `NR51` per-channel L/R panning. Mute/volume gate the worklet, not just gain.

## Exit gate

- [ ] **Blargg `dmg_sound` — 12/12.** (`emu-accuracy-tester`)
- [ ] **Zero underruns** over a sustained 10-minute run. (`webboy-app-qa`)
- [ ] Clean through tab switch, device sleep, headphone connect/disconnect, and a high-latency
      Bluetooth output.
- [ ] Verified in Chrome, Firefox **and Safari** — Safari's Web Audio differences bite here.
- [ ] No regression in Phase 03 timing gates (the APU shares DIV).

## Fetch before implementing

https://gbdev.io/pandocs/Audio_details.html — **read the obscure-behavior section in full** ·
https://gbdev.gg8.se/wiki/articles/Gameboy_sound_hardware · MDN AudioWorklet.

## Out of scope

GBA Direct Sound (15). `cgb_sound` (11).
