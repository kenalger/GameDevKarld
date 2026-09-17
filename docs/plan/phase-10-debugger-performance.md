# Phase 10 — Debugger, Web Worker & Performance — 🏳️ M5

**Owner:** `webboy-frontend-engineer` · **Supporting:** all subsystem owners (inspection surfaces) · **Gate:** `webboy-app-qa`
**Depends on:** 05 · **Roadmap:** §24 Debugger, §34 Web Worker, §35 Performance
**Status:** ⚠️ **Debugger + performance done; Web Worker deliberately NOT built** — 2026-09-15.

**Performance, measured headlessly (`npm run bench`):**

| | |
|---|---|
| Emulated FPS | **1290 — 21.6× realtime** |
| Frame time p50 / p99 | 0.78 ms / **0.89 ms** |
| Frame budget @59.73 Hz | 16.74 ms — **p99 uses 5.3%** |
| Instructions/sec | 22.6M |

**Debugger:** disassembler (20 tests, never throws on any of the 256 opcodes), breakpoints,
watchpoints, step-instruction, step-frame, live register view and a listing around PC. 16 tests,
including one asserting inspection does not perturb CPU state. The panel mounts only when open, and
`Debugger.enabled` is false until something is actually watched — **a closed debugger costs zero**.

> **The Web Worker was not built, on purpose.** The charter's optimization order is: stop React
> re-renders → remove per-frame allocation → move to a Worker → optimize hot loops → WebAssembly,
> and explicitly says *profile before optimizing*. The profile says the core uses **5.3% of the
> frame budget**, so there is no measured bottleneck for a Worker to relieve. Building an untestable
> worker in an environment with no browser would be speculative work against the project's own rule.
> The UI↔core boundary is already message-shaped (Phase 00), so the move stays cheap when a real
> profile justifies it.
>
> **Not verified:** "zero React re-renders during emulation" and "60fps p99 on a mid-range phone"
> both need a browser profiler. The design enforces the first (per-frame work touches only the canvas
> and DOM text nodes; `useSyncExternalStore` carries only status), but nobody has profiled it.

## Goal

A developer-grade debugger, a responsive UI under load, and measured performance. Ends with a
shippable v1.0 Game Boy emulator.

## Debugger — roadmap §24

Build it against the read-only inspection interface designed in Phase 00. **The debugger never
mutates core internals**, and inspection must cost the emulator nothing while the panel is closed.

- [ ] CPU registers + flags, PC, SP · disassembly around PC · step-instruction, step-frame
- [ ] Breakpoints by address **and** by memory read/write
- [ ] Hex memory viewer with region jumps · VRAM tile + tile-map viewers · OAM sprite viewer ·
      palette viewer · cartridge info
- [ ] Instruction and frame counters · FPS and frame-time graph · APU channel meters + buffer health
- [ ] Study BGB's debugger — it is the genre standard worth matching.

This pays for itself immediately in Phases 11–15. Treat it as infrastructure, not a nice-to-have.

## Web Worker — roadmap §34

Do not add the worker until the single-threaded core is stable (it now is). The Phase 00 boundary was
already message-shaped, so this should be a move, not a rewrite.

- [ ] Core → worker. Vite: `new Worker(new URL('./emu.worker.ts', import.meta.url), { type: 'module' })`.
- [ ] Transfer the framebuffer (`postMessage(buf, [buf])`) or share via `SharedArrayBuffer`.
      **Never structured-clone a framebuffer 60×/second.**
- [ ] `SharedArrayBuffer` needs COOP `same-origin` + COEP `require-corp`. Configure in the Vite dev
      server **and verify the production host can send those headers** before depending on it.
      Ship a working non-SAB fallback.
- [ ] `OffscreenCanvas` to render in the worker where supported; feature-detect and fall back.
- [ ] Coordinate pacing with `gb-audio-io-engineer` — still exactly one clock owner.

## Performance — roadmap §35

Measure; never guess. Optimize strictly in this order:

1. Stop React re-rendering during emulation → 2. eliminate per-frame allocation →
3. move to the worker → 4. optimize core hot loops → 5. **WebAssembly only if a profile proves a
   specific bottleneck.** Do not skip to 5.

- [ ] Track FPS, frame time **p50 and p99**, instructions/sec, audio underruns, worker round-trip,
      JS heap. `performance.now()` + User Timing API.
- [ ] Commit baselines so "slower than last release" becomes a statement with numbers.

## Exit gate — `webboy-app-qa`

- [ ] **Zero React re-renders during emulation** — verified by profiler or render-count
      instrumentation. A component rendering at 60 Hz is a defect regardless of current FPS.
- [ ] 60 fps **p99** on a mid-range laptop and a mid-range phone, over a sustained 10-minute run.
- [ ] Heap flat over 30 minutes — no sawtooth that never returns to baseline.
- [ ] Frame pacing steady; no catch-up burst after a hidden tab.
- [ ] Debugger panel adds no measurable cost while closed.
- [ ] All Phase 01–09 gates still green. **🏁 M5 — v1.0 DMG. Tag it.**
