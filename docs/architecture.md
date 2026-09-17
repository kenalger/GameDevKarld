# Architecture

```text
apps/web  (React + Vite)          packages/emulator  (pure TypeScript)
├── App, components               ├── core/
├── EmulatorSession  ──────────▶  │   ├── EmulatorCore      (the contract)
│   owns the frame loop           │   ├── EmulatorManager   (core selection)
│   OUTSIDE React                 │   └── StubCore          (Phase 00 placeholder)
└── canvas display                └── shared/types/
                                      ├── MemoryBus, Cartridge, CartridgeInfo
                                      ├── CoreInspector     (read-only debug view)
                                      └── Serializable      (save states)
```

## The boundary

The frontend depends on `EmulatorCore`, `EmulatorManager` and `CoreInspector` — **never** on a CPU,
PPU, or cartridge internal. The core imports no React, no DOM, no canvas, no Web Audio. Browser APIs
live in `apps/web/src/emulator/` as an adapter layer.

This is what makes the core testable headlessly and movable into a Web Worker in Phase 10 without a
rewrite. The UI↔core interface is already message-shaped for that reason.

## Frame loop ownership — decided in Phase 00

**`EmulatorSession` owns the clock.** It is a module-level singleton, so no React lifecycle can
create a second loop, and the loop is never started from a re-runnable effect.

Pacing is `FramePacer`, a pure and unit-tested accumulator:

- Target is **59.7275 Hz** (`4194304 / 70224`), not 60. Forcing 60 would change game speed and audio
  pitch. On a 60 Hz display this correctly yields 59 frames per second of ticks.
- A gap over 250 ms (hidden tab, blocked thread) counts as **one** frame, never a catch-up burst.
- At most 4 frames run per tick; hitting the cap drops the backlog rather than carrying debt.
- `reset()` on resume and on tab return.

**Phase 07 may move pacing to the audio ring buffer.** If it does, exactly one component still owns
the clock — two clocks fighting produce judder that looks like a PPU bug.

## React never re-renders during emulation

The charter's most easily-broken rule, enforced here:

- Per-frame work touches only the canvas 2D context. Zero `setState`.
- `ImageData` is allocated **once** in `attachCanvas` and its buffer mutated every frame.
- Status that changes rarely (`empty` / `running` / `paused`, ROM name, error) goes through
  `useSyncExternalStore`.
- Live counters (FPS, frame count) are read through getters by `StatusBar`, which writes to DOM text
  nodes on a 250 ms interval — never through React state.

## Display

Backing canvas at native 160×144; CSS scales it up with `image-rendering: pixelated` and
`imageSmoothingEnabled = false`. A blurry emulator screen is the most common amateur tell.

## Privacy

ROM bytes go `File → ArrayBuffer → Uint8Array → EmulatorManager` and stop. There is no `fetch`, no
upload, no analytics and no third-party SDK anywhere in the app. CI fails the build if any ROM or
save file is tracked by git.
