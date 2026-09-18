# WebBoy — Software Development Plan

**What this application is, how it works, and how it gets built.**

Status of this document: written 2026-09-18 against a measured build — the test counts, sizes and
suite results below were produced by running the commands, not recalled. Where a number is a
measurement it says so and gives the command that produced it.

| Read this for | Go to |
|---|---|
| What the product is, and what it deliberately is not | [1. The product](#1-the-product) |
| How a ROM becomes pixels and sound | [2. How it works](#2-how-it-works) |
| Where the code lives | [3. Repository and technology](#3-repository-and-technology) |
| How work is planned, assigned and reviewed | [4. Development process](#4-development-process) |
| How "done" is decided | [5. Quality strategy](#5-quality-strategy) |
| Where the project actually stands | [6. Status, measured](#6-status-measured) |
| What happens next, in order | [7. Forward plan](#7-forward-plan) |
| What could go wrong | [8. Risks and open decisions](#8-risks-and-open-decisions) |

---

## 1. The product

WebBoy is a **Game Boy, Game Boy Color and Game Boy Advance emulator that runs entirely inside a
web browser**. You open a page, pick a ROM file from your own device, and play it. There is no
installer, no account, no server and no database.

### What it does

- Runs **DMG** (original Game Boy), **CGB** (Game Boy Color) and **GBA** software, with the system
  chosen automatically from the cartridge header or forced by hand.
- Renders at the native resolution — 160×144 for GB/GBC, 240×160 for GBA — scaled up with nearest
  neighbour, never blurred.
- Emulates the sound hardware and plays it through Web Audio.
- Accepts **keyboard, gamepad and on-screen touch** input, with user-editable key bindings.
- Persists **battery saves** (the cartridge SRAM a game writes its own save file into) and
  **save states** (a complete snapshot of the machine), in the browser, in IndexedDB.
- Supports **Game Genie and GameShark cheat codes** for GB/GBC.
- Ships a **developer panel** — registers, disassembly, breakpoints, watchpoints, timing counters.

### What it deliberately is not

These are not gaps to be filled later. They are the shape of the project.

| Non-goal | Why |
|---|---|
| No backend, accounts or cloud saves | Every feature that needs a server is a feature that can leak a ROM |
| No ROMs supplied, hosted or linked | Legal position, see [`legal.md`](legal.md). You supply software you own |
| No analytics, telemetry or error reporting | A stack trace or a filename is enough to leak what you are playing |
| No Nintendo branding or trade dress | The disclaimer ships in the UI, not only in the README |
| "It boots" is not a success criterion | Accuracy is the product — see [§5](#5-quality-strategy) |
| Pokémon is not the first milestone | First success is a **legal homebrew ROM**, by design |

### The four hard constraints

Everything below is downstream of these. They are stated in full as "the Law" in
[`/CLAUDE.md`](../CLAUDE.md); these four are the ones that shape the architecture rather than the
working style.

1. **The ROM never leaves the device.** No upload, no `fetch` carrying ROM bytes, no service worker
   caching ROM data, no third-party SDK anywhere in the app. This is verified empirically against
   the running app — a network log, not a code read.
2. **The core knows nothing about the browser.** CPU, memory, PPU and APU import no React, no DOM,
   no canvas, no Web Audio. Browser APIs live in an adapter layer behind a narrow interface.
3. **Cycle-accurate from the start.** Subsystems tick per *memory access*, not once per
   instruction. A "run the instruction, then add its cycles" core cannot be corrected later without
   a rewrite, so it was never written that way.
4. **Never implement hardware behaviour from memory.** Pan Docs, GBATEK and Gekkio's technical
   reference are fetched and cited before a register, flag rule or timing value is written. Recall
   is unreliable at exactly the precision that matters here.

---

## 2. How it works

### 2.1 The two halves

```text
   apps/web  (React + Vite, knows about the browser)
   ┌──────────────────────────────────────────────┐
   │  App.tsx — tabs, panels, disclaimer          │
   │  Display  — <canvas>, 160×144 or 240×160     │
   │  RomPicker, Controls, Saves, States,         │
   │  Cheats, Debug panels                        │
   │                                              │
   │  EmulatorSession  ◀── owns the frame loop,   │
   │    (module singleton, OUTSIDE React)         │
   │    ├─ FramePacer      pacing                 │
   │    ├─ InputLatch      keyboard/pad/touch     │
   │    ├─ AudioOutput     AudioWorklet + ring    │
   │    ├─ SavePersistence debounced writes       │
   │    └─ SaveStore / StateStore / CheatStore    │
   │                           (IndexedDB)        │
   └───────────────┬──────────────────────────────┘
                   │  EmulatorCore  ← the only contract crossed
   ┌───────────────▼──────────────────────────────┐
   │  packages/emulator  (pure TypeScript)        │
   │    EmulatorManager — picks a core from the   │
   │                      cartridge header        │
   │    ├─ GameBoyCore        (DMG + CGB)         │
   │    │    Cpu · Mmu · Ppu · Apu · Timer ·      │
   │    │    Serial · Joypad · cartridge/MBCs ·   │
   │    │    OamDma · Hdma · Debugger · cheats    │
   │    └─ GameBoyAdvanceCore (GBA)               │
   │         Arm7 · GbaMmu · GbaPpu · GbaApu ·    │
   │         Dma · Timers · GbaKeypad · backup    │
   └──────────────────────────────────────────────┘
```

The frontend depends on `EmulatorCore`, `EmulatorManager` and `CoreInspector` — **never** on a CPU,
PPU or cartridge internal. That single boundary is what makes the core testable headlessly under
Node (no canvas, no DOM) and movable into a Web Worker without a rewrite.

### 2.2 The contract

`packages/emulator/src/core/EmulatorCore.ts` is the whole interface between the app and any
emulated system:

| Method | Contract note |
|---|---|
| `loadRom` / `reset` / `pause` / `resume` | Lifecycle |
| `runFrame()` | Advances exactly one frame of emulated time |
| `setInput(mask)` | Applied **once per frame at a defined point in emulated time** — DOM events never poke emulator state directly, because they arrive asynchronously and a fast tap between frames would be lost or double-counted |
| `getFrameBuffer()` | Returns a **stable** RGBA buffer — the same object every frame, never a copy, never a fresh allocation |
| `setAudioSink(rate, sink)` | The **device** picks the sample rate; the core decimates to it |
| `getSaveData` / `loadSaveData` / `consumeSaveRamDirty` | Battery saves, in the `.sav` layout other emulators understand |
| `serialize` / `deserialize` | Save states |
| `getCartridgeInfo` / `getInspector` | Read-only views for the UI and the debugger |

### 2.3 The path a ROM takes

```text
 <input type=file>
   └─ File → ArrayBuffer → Uint8Array          ← and stops. No fetch, no upload, ever.
        └─ EmulatorManager.load()
             ├─ parseHeader()      title, mapper, ROM/RAM size, checksums, CGB flag
             ├─ detectSystem()     GB / CGB / GBA  (overridable in the UI)
             ├─ createCartridge()  ROM-only, MBC1, MBC2, MBC3(+RTC), MBC5, GBA backup
             └─ new GameBoyCore(...) | new GameBoyAdvanceCore(...)
                  └─ SaveStore.load(saveKey) → core.loadSaveData()   ← previous battery save
```

### 2.4 The frame loop — one owner, decided once

**`EmulatorSession` owns the clock.** It is a module-level singleton, so no React lifecycle can
create a second loop, and the loop is never started from a re-runnable effect. Two clocks fighting
produce judder that looks like a PPU bug, so the ownership is written down rather than assumed.

Pacing is `FramePacer`, a pure, unit-tested accumulator:

- Target is **59.7275 Hz** (`4194304 / 70224`) — not 60. Forcing 60 would change game speed and
  audio pitch.
- A gap over **250 ms** (hidden tab, blocked thread) counts as **one** frame, never a catch-up burst.
- At most **4 frames** run per tick; hitting the cap drops the backlog rather than carrying debt.
- `reset()` on resume and on tab return.

Per tick: latch input → `core.runFrame()` → blit the framebuffer into a **once-allocated**
`ImageData` → drain audio into the ring buffer.

### 2.5 React never re-renders during emulation

The charter's most easily-broken rule, and the reason the app stays at full speed:

- Per-frame work touches only the canvas 2D context. **Zero `setState`.**
- `ImageData` is allocated **once** in `attachCanvas`; its buffer is mutated every frame.
- Rarely-changing status (`empty` / `running` / `paused`, ROM name, error) goes through
  `useSyncExternalStore`.
- Live counters (FPS, frame count) are read through getters by `StatusBar`, which writes to DOM text
  nodes on a 250 ms interval — never through React state.

### 2.6 Graphics: a pixel FIFO, not a scanline renderer

The single largest architectural decision in the emulator, taken in Phase 04 and recorded in
[`graphics.md`](graphics.md).

A scanline renderer composes each line at HBlank, and therefore *cannot express* a write to `SCX`,
`LCDC` or a palette register that lands **during mode 3** — the raster effects real games use
constantly. Retrofitting a FIFO later means rewriting the PPU, so it was built that way from the
start, at substantially higher effort.

```text
        VRAM
          │
   background fetcher ──▶ BG FIFO (8) ──┐
   (tile → low → high → push)           ├──▶ mix ──▶ framebuffer
   sprite fetcher ──────▶ sprite FIFO ──┘
```

Behaviour that **falls out of the model** rather than being hard-coded: mode 3's length stretches
with `SCX % 8`, window activation and every sprite fetched; the first tile fetch of each line is
discarded; the BG fetcher pushes only into an empty FIFO.

The display canvas is backed at native resolution and scaled by CSS with
`image-rendering: pixelated` and `imageSmoothingEnabled = false`. A blurry emulator screen is the
most common amateur tell.

### 2.7 Audio

The APU runs at its native **1048576 Hz** and decimates to whatever the `AudioContext` reports —
44100, 48000, sometimes 96000. Output is an **AudioWorklet**, never a `ScriptProcessorNode` (which
is deprecated and runs on the main thread, so it glitches whenever the UI does anything), fed
through a lock-free ring buffer of 4096 samples (~85 ms at 48 kHz) held at 50% fill.

**Drift is corrected by nudging the resample ratio, never by dropping or duplicating samples.** A
dropped sample is an audible click; a 0.2% pitch shift is inaudible.

One deployment consequence, already fixed: everything under `/assets/` is content-hashed but the
worklet file is not, so it must not be served stale — a cached worklet running the previous
deploy's processor against new main-thread code produces crackle that looks like an emulator bug.

### 2.8 Input

`InputLatch` merges three sources — keyboard, Gamepad API, on-screen touch — into one button mask
that is applied once per frame. Ownership is split deliberately: the **audio/IO** side owns the
joypad register, the latch and browser event handling; the **frontend** side owns how the on-screen
controls look and where they sit.

Four classes of silent bug have already been fixed here and are worth not reintroducing: bound keys
being stolen from text fields, one source's key release clearing a button another source is
holding, macOS dropping `keyup` while Command is held, and a pad button held across a pause staying
stuck.

### 2.9 Persistence

Three IndexedDB databases, all local, all versioned:

| Database | Store | Holds |
|---|---|---|
| `webboy` | `saves` | Battery-backed cartridge SRAM, keyed by cartridge, in `.sav` layout |
| `webboy-states` | `states` | Save states, 4 slots per cartridge (slot 0 doubles as the quick slot) |
| `webboy-cheats` | `cheats` | Cheat codes exactly as typed, plus enabled flags |

Battery saves are written debounced off a `consumeSaveRamDirty()` flag and flushed on `pagehide`
(**not** `beforeunload` — mobile Safari often backgrounds a tab without firing it, which is exactly
when a player expects their save to survive).

**Save states** use a binary container owned by the memory side; every other subsystem supplies its
own `serialize()` / `deserialize()`. The container carries a magic (`WBST`, and a separate one for
GBA so "wrong console" is a clean refusal rather than a misparse), a **format version that must be
bumped whenever any subsystem's layout changes**, and a 32-bit cartridge fingerprint so a state
cannot be resumed into the wrong ROM. A state that silently misparses is far worse than one that
refuses to load: the game appears to work, then corrupts.

---

## 3. Repository and technology

### Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict), ES modules | One language across core, app, harness and scripts |
| App | React 19 + Vite 6 | Fast dev server, small static output |
| Core | Plain TypeScript, zero runtime dependencies | Testable under Node, portable to a Worker |
| Tests | Vitest | Same config for core, app and harness |
| Persistence | IndexedDB | The only browser store that holds megabytes reliably |
| Audio | Web Audio + AudioWorklet | Off-main-thread, no deprecated APIs |
| Build/deploy | `vite build` → static files | No server, so anything that serves files works |
| Repo | npm workspaces, one repo | `packages/*` and `apps/*` |

Runtime: Node `^20.19.0 || >=22.12.0`, pinned in `.nvmrc` (a Node too old for Vite is the likeliest
cause of a first deploy failing).

### Layout

```text
apps/web/                 React + TypeScript + Vite frontend
  src/emulator/           EmulatorSession, FramePacer, input sources, SavePersistence
  src/audio/              AudioOutput (AudioWorklet), RingBuffer
  src/storage/            SaveStore, StateStore, CheatStore (IndexedDB)
  src/components/         Display, RomPicker, panels, TouchControls, DebugPanel
packages/emulator/        Emulator core — no React, no DOM, no canvas
  src/core/               EmulatorCore contract, EmulatorManager, StubCore
  src/gb/                 cpu · memory · ppu · apu · timer · serial · input ·
                          cartridge (MBC1/2/3+RTC/5) · state · debug · cheats
  src/gba/                cpu (ARM7TDMI: ARM + Thumb) · memory (+DMA, waitstates,
                          backup) · video · audio (PSG + Direct Sound FIFO) ·
                          timer · input
  src/cheats/             Game Genie / GameShark decoding
  src/shared/types/       MemoryBus, Cartridge, CoreInspector, Serializable
tests/harness/            Headless ROM runner, stop conditions, scoreboard
tests/unit/               Per-subsystem tests (the enforced gate)
tests/roms/, tests/sm83/  Fetched corpus — gitignored, never committed
scripts/                  Corpus fetch, gate runners, scoreboard, benchmark
docs/plan/                16 phases, each with an owner and a hard exit gate
.claude/agents/           Seven project specialists
mock/                     UI design reference
```

Source size, measured today: **14,857 lines** of non-test `.ts`/`.tsx` across
`packages/emulator/src` and `apps/web/src`.

### Commands

```bash
npm install
npm run dev              # http://localhost:5173
npm test                 # unit + harness  (the enforced gate)
npm run typecheck
npm run lint
npm run build            # → apps/web/dist, a static bundle

npm run fetch-test-roms  # pinned, checksum-verified corpus → gitignored tests/roms/
npm run fetch-cpu-tests  # SingleStepTests/sm83 → gitignored tests/sm83/
npm run fetch-gba-tests  # jsmolka/gba-tests

npm run sm83             # Phase 01 gate — 500,000 per-opcode cases
npm run blargg           # Phase 02 gate — cpu_instrs via serial + memory protocol
npm run mooneye          # Phase 03 gate — acceptance suite
npm run gba-cpu          # Phase 12/13 gate — ARM + Thumb + memory
npm run sound            # Blargg sound suites
npm run compat           # the whole corpus, all three systems, one table
npm run scoreboard       # regenerate tests/scoreboard.md
npm run bench            # core throughput vs realtime
```

---

## 4. Development process

### 4.1 How work is organised

Work is broken into **16 numbered phases**, one file each in [`docs/plan/`](plan/README.md). Every
phase file carries: an owner, a task list, the reference sections to fetch before writing code, the
known traps, and — the part that matters — a **hard exit gate stated as a test result, not an
opinion**.

Phases **00 → 05 are a strict chain**: foundation → CPU → memory → timing → PPU → input. Nothing
parallelises before First Playable, because every one of those layers is the substrate of the next.
After 05 lands, phases 06–10 run in parallel across four owners, and the GBA phases 12–15 chain
again.

### 4.2 Who owns what

Seven specialists live in `.claude/agents/` — **five who build, two who verify**.

| Owner | Owns |
|---|---|
| `gb-cpu-engineer` | SM83 + ARM7TDMI cores, decoder, ALU/flags, interrupts, timers, scheduler |
| `gb-memory-engineer` | Bus, cartridges/MBCs, header parsing, DMA, IndexedDB saves, state format |
| `gb-ppu-engineer` | PPU, tile/sprite/window rendering, LCD timing, palettes, GBA video, blit |
| `gb-audio-io-engineer` | APU, Web Audio, A/V sync, joypad register, keyboard/touch/gamepad |
| `webboy-frontend-engineer` | React app, display, mobile controls, settings, debugger UI, perf |
| `emu-accuracy-tester` | "Is the hardware right?" — harness, corpus, scoreboard, bisection |
| `webboy-app-qa` | "Is the product right?" — privacy audit, browsers, mobile, a11y, perf |

The two verifiers are **independent of the builders and do not fix core code** — they diagnose and
hand off. `emu-accuracy-tester` has final say on whether a milestone is done. **Neither may mark
something as passing without having run it.**

Boundaries that are easy to get wrong, and are therefore assigned explicitly: bus access
restrictions during PPU modes (PPU defines the state machine, memory enforces the behaviour);
input (IO owns the register and events, frontend owns the look); save states (memory owns the
container, everyone supplies their own section); frame pacing (exactly one owner); GBA Direct Sound
(CPU, memory and audio coordinate *before* anyone implements).

### 4.3 Running a phase

1. Read the phase file and the roadmap sections it cites.
2. Delegate to the phase owner. **The owner fetches its own hardware references** — required, not
   optional, and not from memory.
3. Owner implements with unit tests **alongside**, not postponed.
4. `emu-accuracy-tester` runs the gate and reports the scoreboard delta.
5. **Gate red → the phase is not done.** There is no "fix it later" in an emulator: a deferred
   accuracy bug becomes ten mystery bugs in the phases above it.
6. Update the status line in the phase file and the table in `docs/plan/README.md`.

### 4.4 Commit and review discipline

- Small, focused commits — `feat: implement mbc1 banking` — one hardware subsystem at a time.
- Cite the reference section for any hardware behaviour, in the commit or the report.
- Third-party emulator code is **licence-reviewed before use**. Reading another emulator to
  understand hardware is fine; copying its code without checking the licence is not. WebBoy is MIT,
  which is inbound-compatible with MIT only — so SameBoy (MIT) may be borrowed from with
  attribution, mGBA (MPL-2.0) may not be copied into this tree, and Gambatte/VBA-M (GPL-2.0) would
  force the whole project to GPL.
- **No commercial ROMs or copyrighted assets, ever** — not in `roms/`, not as a fixture, not
  base64'd into a test, not as branding. CI enforces this.
- State is recorded in [`handoff.md`](handoff.md), including what is broken. The plan says what to
  build; the handoff says where things actually are.

---

## 5. Quality strategy

**Accuracy is the product**, so "the game boots" is not evidence of anything. Test ROMs are the
definition of done.

### 5.1 The layers

| Layer | What | Where |
|---|---|---|
| Unit | Per-subsystem logic, flags, cycle counts | `tests/unit/`, `npm test` |
| Per-opcode | SingleStepTests/sm83 — 500 opcodes × 1000 cases, asserting registers, memory **and the exact per-M-cycle bus activity** | `npm run sm83` |
| Integration | Test ROMs through the headless harness | `npm run compat`, `npm run scoreboard` |
| Screenshot | Framebuffer vs reference PNG, pixel-exact, reported as a differing-pixel **count and bounding box** | `scripts/run-screenshots.ts` |
| Product | Real browsers, a real phone, a real network log | `webboy-app-qa` |

### 5.2 The harness

`tests/harness/runTest()` loads a ROM, runs frames, and asks a `StopCondition` for a verdict after
each one. No canvas, no React, no DOM. Four conditions:

- **Mooneye** — the ROM runs `LD B,B` when finished; PASS on the Fibonacci register signature
  `B=3 C=5 D=8 E=13 H=21 L=34`, FAIL when every register is `0x42`.
- **Blargg** — reads the serial port (which reports *which sub-test* failed) plus the `0xA000`
  memory protocol.
- **Screenshot** — pixel comparison with a diff bounding box, so a 4-pixel sprite-row diff and a
  full-screen diff are distinguishable without opening an image.
- **Timeout** — a frame budget. **A hang is a failure, not a suspended run.**

### 5.3 Honesty rules

These exist because a false green in an early phase poisons every gate above it.

- A condition whose hardware hooks do not exist returns **`unavailable`** — never `pass`.
  `unavailable` is not a pass. Neither is `screenshot` without the pixel comparison having run.
- **A previously-passing test that fails is a build-breaking regression.** Re-baselining a failure
  requires an explicit, recorded decision.
- Known-inapplicable tests are listed with reasons in `tests/expected-failures.ts` — for example
  Mooneye's `boot_*` variants that target DMG0/MGB/SGB hardware WebBoy does not emulate.
- The corpus comes from `github.com/c-sp/game-boy-test-roms`, fetched by script, pinned to a tag,
  checksum-verified, **gitignored, never committed**.

### 5.4 What CI actually enforces

Be precise about this, because it is narrower than the strategy above:

- CI runs `lint`, `typecheck`, `test`, `build`, plus a **`no-roms` job** that fails if any
  `.gb/.gbc/.gba/.sav/.srm/.state` file is tracked by git.
- `npm test` is therefore **the only automated regression gate a PR hits**. A corpus test must live
  in `tests/unit/` to be enforced.
- `npm run scoreboard` always exits 0, so `tests/scoreboard.md` is a **human-reviewed diff**, not a
  gate.

---

## 6. Status, measured

All figures below were produced on **2026-09-18** by running the commands named. The accuracy
figures are the ones re-confirmed in [`handoff.md`](handoff.md) via `npm run compat`.

### Build health

| | | Command |
|---|---|---|
| Tests | **980 passing, 1 skipped**, 27 files, 5.4 s | `npm test` |
| Typecheck / lint / format | green (30 pre-existing `no-console` warnings in `scripts/`) | `npm run typecheck`, `lint` |
| Build | **11 files, 500 KB** — JS 397 KB / **120 KB gzipped**, CSS 14 KB | `npm run build` |
| Core throughput | ~20× realtime, p99 well under frame budget | `npm run bench` |
| Branch | `main`, clean, pushed | |
| Deployed | **no** — the build is ready and [`deploy.md`](deploy.md) is written; nobody has run it | |

### Accuracy corpus

| Suite | Result |
|---|---|
| SingleStepTests/sm83 | **500,000 / 500,000 (100%)** across 500 opcodes |
| Blargg `cpu_instrs` + timing | 18 / 19 — `halt_bug` times out |
| Blargg sound (DMG + CGB) | 19 / 24 — wave RAM |
| Mooneye acceptance | **60 / 66 applicable** (9 skipped: DMG0/MGB/SGB targets) |
| dmg-acid2, cgb-acid2 | **pixel-exact** |
| cgb-acid-hell | 2 / 23040 pixels differ |
| Mealybug Tearoom | **0 / 24** — reported, not gated |
| jsmolka gba-tests (arm, thumb, memory) | **7 / 7** |

### Phases

| # | Phase | Owner | Gate |
|---|---|---|---|
| 00 | Foundation | frontend | ✅ builds, harness runs, CI green |
| 01 | SM83 CPU | cpu | ✅ sm83 500,000/500,000 |
| 02 | Memory & Cartridge | memory | ✅ `cpu_instrs` 11/11, MBC1 13/13 |
| 03 | Timing & Interrupts | cpu | ✅ **M1** — Mooneye 60/66 applicable |
| 04 | PPU & Display | ppu | ✅ **M2** — dmg-acid2 exact, mode 3 = 172 dots |
| 05 | Input → First Playable | audio/IO | ✅ **🏁 M3** |
| 06 | Mappers & Persistence | memory | ✅ every Mooneye mapper test passes |
| 07 | Audio | audio/IO | ⚠️ **not met** — `dmg_sound` 9/12 (wave RAM) |
| 08 | Save States | memory | ✅ **M4** — 1000-frame round-trip identical |
| 09 | UX & Mobile | frontend | ⚠️ built, **unverified** — needs a phone + 3 browsers |
| 10 | Debugger, Worker & Perf | frontend | ⚠️ debugger + perf done; Worker deferred (no bottleneck) |
| 11 | Game Boy Color | all five | ✅ **M6** — cgb-acid2 pixel-exact |
| 12 | GBA — ARM7TDMI | cpu | ✅ jsmolka arm + thumb pass |
| 13 | GBA — Memory & DMA | memory | ✅ memory/arm/thumb pass on the real bus |
| 14 | GBA — Video | ppu | ✅ all modes, affine, windows, mosaic, blending |
| 15 | GBA — Audio & Compat | audio/IO | ⚠️ audio + saves done; no commercial-ROM testing |
| 16 | Cheats & Controls | memory | ✅ GB/GBC codes + rebinding; GBA cheats deferred |

**M5 (v1.0 DMG, end of Phase 10) is the milestone actually outstanding**, and it is outstanding for
one reason: phases 09 and 10 cannot be signed off without a real browser and a real phone.

### The binding constraint

> Every "done" claim in this repository rests on tests, typecheck and build. **The distance between
> *passes its tests* and *works when a person opens it* has never been measured even once.**

The app has never been deployed and never been watched running in a browser by a person. The build
is deployable and `docs/deploy.md` has the exact settings; what is missing is an account and ten
minutes. This is the top item in [§7](#7-forward-plan) not because it is easiest but because
everything else is built on top of it.

A pattern already observed twice in Phase 16 and worth carrying: **two bugs were "a working feature
nobody could find."** Both were reported as "it's broken" and diagnosed twice as a crash that was
not happening. A screenshot settled in seconds what an hour of reading state machines did not. When
a live report says *broken*, ask what is on screen before reading code.

---

## 7. Forward plan

Ordered. Each item states its own exit condition, because an item without one is a wish.

### Now — close the verification gap

**1. Deploy it and open it.** Owner: `webboy-app-qa`.
Follow [`deploy.md`](deploy.md) to a static host. Then, in a real browser: load a homebrew ROM,
play it, check the console, and **confirm in the Network tab that every request is same-origin**.
*Exit:* a URL, a clean console, and a network log proving Law 3 empirically — not a code read.

**2. Sign off Phase 09 on real devices.** Owner: `webboy-app-qa`.
Chrome, Firefox and Safari; one real phone for touch controls and layout; the 10-minute run
watching for audio underruns and frame-pacing drift.
*Exit:* three browsers and one phone pass; no underruns over 10 minutes.

**3. Settle the A/B keyboard default.** Owner: the project owner — this is a judgement call, not a
technical one.
WebBoy maps `Z → A, X → B`. mGBA, SameBoy and RetroArch all use `X → A, Z → B`, which preserves the
physical left/right relationship and generalises to the GBA diamond. EmulatorJS matches WebBoy.
Migration if changed: bindings exactly equal to the old defaults were never customised, so upgrade
silently; otherwise keep the user's mapping and show a dismissible note.
*Exit:* a decision recorded in `handoff.md`, and the migration shipped if it changes.

### Next — the largest remaining accuracy gap

**4. Mid-scanline PPU register effects.** Owner: `gb-ppu-engineer`, gated by `emu-accuracy-tester`.
Mealybug 0/24 plus five Mooneye `ppu/*` tests are **the same bug seen from two sides**: register
writes (LCDC, BGP, the window) landing during mode 3.
Two hypotheses are **disproved and recorded** in `docs/plan/phase-04-ppu.md` — mode 3's length (now
exactly 172 dots, verified) and a constant FIFO-pop-to-palette lag (delaying BGP by 0–4 dots is
monotonically worse). **Not eliminated:** the CPU write phase; offset 0 is still best (pixel diff
2218 vs 5084 at offsets 1–3).
**Method, and this is the part that was previously got wrong: measure the pixel diff, never the
pass/fail verdict.** A verdict count cannot tell you whether you moved closer.
*Exit:* Mealybug pass count above 0 with the diff trend recorded, or a third hypothesis
explicitly disproved and written down.

**5. Blargg sound — wave RAM.** Owner: `gb-audio-io-engineer`.
19/24, recorded as debt after five attempts. The gap is **phase, not window width**, and needs
per-cycle wave-unit modelling rather than more tuning. Phase 07's gate stays red until this moves.
*Exit:* `dmg_sound` 12/12, or a written decision to accept 9/12 permanently.

**6. Gamepad remapping.** Owner: `gb-audio-io-engineer`.
The pad map is a hardcoded standard-layout index table — a latent **correctness** bug, not only a
gap: for any controller the browser does not report as `mapping: "standard"`, indices mean nothing
and buttons land on the wrong actions. Hot-plug listeners are also missing, so an
already-connected pad is invisible in Safari and Firefox until a button is pressed. The
`InputSource` shape is designed to absorb this.
*Exit:* a non-standard pad maps correctly; a pad connected before page load is visible in all three
browsers.

### Then

**7. `halt_bug` timeout** (times out at 2500 frames) and **`cgb-acid-hell`** (2 pixels at x=80,
y=68–69) — both small, both bounded, both real.

**8. GBA cheats.** Unblocked in principle now the licence is MIT, but the `DEADFACE` reseed depends
on two 256-byte tables published nowhere except inside mGBA (MPL-2.0). Those tables **may not be
copied**. Either derive them from GBATEK or ship without `DEADFACE` support — and say which in the
UI.

**9. EEPROM backup** — detected but unimplemented, and no test ROM in the corpus covers it. Needs a
test before it needs an implementation.

**10. Multi-line cheat entry and a "did this code match?" indicator.** BGB shows whether a Game
Genie compare hit, which is the best diagnostic in any cheat UI: without it, a code for the wrong
ROM revision silently does nothing and the emulator looks broken.

**11. Touch-control customisation** — deliberately deferred. Making an unvalidated layout
configurable ships the problem to the player instead of fixing it. This unblocks after item 2.

### Process debt, worth an hour

- `npm run screenshots` is referenced by `docs/testing.md` and `tests/scoreboard.md` but **is not
  defined in `package.json`**. `scripts/run-screenshots.ts` exists; the fix is a one-line `scripts`
  entry or a correction to both docs. Until then: `npx vite-node scripts/run-screenshots.ts`.
- `docs/graphics.md` still states the mode 3 baseline as 175 dots. It is **172** since `64ed1ff`.
- The scoreboard is not a gate (see [§5.4](#54-what-ci-actually-enforces)). Deciding whether it
  should be is a real decision, not a chore.

### Not planned

The Web Worker move from Phase 10 is **deferred, not forgotten**: at ~20× realtime there is no
bottleneck to move, and the charter's optimisation order is explicit — stop React re-renders,
remove allocations, move to a Worker, optimise hot loops, then consider WebAssembly. **Profile
before optimising; do not skip ahead.** The `EmulatorCore` interface is already message-shaped so
this stays cheap when it is actually needed.

---

## 8. Risks and open decisions

| Risk | Impact | Mitigation |
|---|---|---|
| **Nothing has been verified in a real browser** | Everything downstream is assumed | Items 1–2 of §7; this is the top priority |
| Mid-scanline PPU accuracy stalls | Games with raster effects render wrong; the gap is invisible to current gates | Diff-driven method recorded; two hypotheses already eliminated |
| Only `npm test` is enforced by CI | A corpus regression can land silently | Move corpus checks into `tests/unit/`, or gate the scoreboard |
| Licence contamination | Copying MPL/GPL emulator code would force a relicence of an MIT project | Review before use; GBA cheat tables explicitly ruled out |
| A privacy regression via a new dependency | Breaks the project's central promise | No third-party SDKs; empirical network audit every release |
| Save-state format drift | Silent misparse corrupts a player's game | Magic + version + cartridge fingerprint; **bump the version on any layout change** |
| Git history is a retrospective import | `git bisect` does not work across the early commits | Known and accepted; commit messages carry the reasoning |

**Open decision:** the A/B keyboard default (§7 item 3). It is muscle memory, so it is the owner's
call, and it shapes work that is ready to start.

**Settled, for the record:** MIT licence (2026-09-18); git history kept unsquashed; `EmulatorSession`
owns the clock; pixel FIFO over scanline renderer; CSP and COOP/COEP deliberately left off, with
reasons recorded in `_headers`.

---

## 9. Definition of done

| Milestone | Criterion |
|---|---|
| M1 | Instructions and cycles verified — ✅ |
| M2 | dmg-acid2 pixel-exact — ✅ |
| **M3 — First Playable** | A legal homebrew ROM loads, runs, renders, accepts input, keeps time, resets and pauses — ✅ |
| M4 | Battery saves and save states, exportable, round-trip identical — ✅ |
| **M5 — v1.0 DMG** | Shippable: mobile, audio, debugger. **Blocked on real-device verification** |
| M6 — v1.1 CGB | cgb-acid2 pixel-exact — ✅ |
| M7 — v2.0 GBA | ✅ on the test corpus; no commercial-ROM compatibility sweep |

A release additionally requires, every time: `webboy-app-qa` confirming the privacy guarantee
against the **running** app with a network log; no previously-passing test failing; the scoreboard
regenerated and diffed.

---

## 10. Document map

| Document | Answers |
|---|---|
| [`/CLAUDE.md`](../CLAUDE.md) | The charter — the team, the Law, the milestones |
| [`GameDevKarld(1).md`](../GameDevKarld%281%29.md) | The roadmap — *what* to build |
| [`plan/README.md`](plan/README.md) | The 16 phases — order, owners, exit gates |
| **This document** | What the app is, how it works, how it is built, what is next |
| [`handoff.md`](handoff.md) | Where things actually are **right now**, including what is broken |
| [`architecture.md`](architecture.md) | The app/core boundary and frame-loop ownership |
| [`graphics.md`](graphics.md) | Why the PPU is a pixel FIFO |
| [`testing.md`](testing.md) | The harness, the corpus, the gate order, how to bisect |
| [`deploy.md`](deploy.md) | Putting the static build on a URL |
| [`legal.md`](legal.md) | Distribution rules and the privacy guarantee |

When the plan and the handoff disagree, **the handoff is the state and the plan is the intent**.
