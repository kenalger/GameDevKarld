# WebBoy — How It Works

**How the pieces are wired, what each function is responsible for, and how the features interact.**

[`features.md`](features.md) says what the app does. This says how. Names in `code font` are real
symbols — every walkthrough below traces actual calls, not an idealised design.

| | |
|---|---|
| [1. The two halves and the one contract](#1-the-two-halves-and-the-one-contract) | The boundary everything else respects |
| [2. The cast](#2-the-cast) | Every module, one line each |
| [3. Walkthroughs](#3-walkthroughs) | Boot, frame, input, audio, save, state, cheat, pause |
| [4. Inside the core](#4-inside-the-core) | CPU/PPU/APU/bus lockstep |
| [5. Feature interaction map](#5-feature-interaction-map) | Which features touch which, and where they collide |
| [6. Invariants](#6-invariants) | The rules that break the app silently when violated |
| [7. Headless: the same core, no browser](#7-headless-the-same-core-no-browser) | How tests drive it |

---

## 1. The two halves and the one contract

```text
  ┌──────────────── apps/web ─────────────────┐   ┌──── packages/emulator ────┐
  │ React components (render rarely)          │   │ pure TypeScript           │
  │      ▲                    │               │   │ no React, no DOM,         │
  │      │ useSyncExternal    │ user actions  │   │ no canvas, no Web Audio   │
  │      │ Store              ▼               │   │                           │
  │  ┌───┴──────────────────────────────┐     │   │  EmulatorManager          │
  │  │        EmulatorSession           │─────┼───┼─▶ EmulatorCore            │
  │  │  singleton · owns the clock      │     │   │    ├ GameBoyCore          │
  │  │  rAF loop · never in React       │◀────┼───┼──  └ GameBoyAdvanceCore   │
  │  └───┬────┬────┬────┬────┬──────────┘     │   │                           │
  │      │    │    │    │    │                │   │  CoreInspector (read-only)│
  │  FramePacer │  │  AudioOutput             │   └───────────────────────────┘
  │       InputLatch │   SavePersistence      │
  │            KeyboardInput/Gamepad/Touch    │
  │            SaveStore·StateStore·CheatStore│
  └───────────────────────────────────────────┘
```

The frontend imports `EmulatorCore`, `EmulatorManager`, `CoreInspector` and a few constants —
**never** a CPU, PPU or cartridge class. That single narrow contract is what buys three things at
once: the core is testable under Node with no browser, the app can swap DMG for GBA without knowing
how either works, and the core can move into a Web Worker later without a rewrite (the interface is
already message-shaped: whole-state pushes, no chatty getters in the hot path).

**Direction of dependency is one-way.** The core never calls into the app. It publishes results the
app comes and takes: a stable framebuffer, a pushed audio sink, dirty flags. Nothing in
`packages/emulator` knows a browser exists.

---

## 2. The cast

### Application side — `apps/web/src`

| Module | Responsibility |
|---|---|
| `App.tsx` | Layout and the control bar. Subscribes to session status; renders on status change only |
| `EmulatorSession` | **The centre.** Owns the core, the rAF loop, input, audio, persistence, cheats, states |
| `FramePacer` | Turns wall-clock time into a whole number of frames to run. Pure, unit-tested |
| `InputLatch` | Merges keyboard/touch/gamepad into one mask; sticky bits so no tap is lost |
| `KeyboardInput` · `TouchInput` · `GamepadInput` | Source adapters. DOM in, `latch.press/release` out |
| `bindings.ts` | Default and user key bindings, persisted in `localStorage` |
| `AudioOutput` | `AudioContext` + `AudioWorkletNode` + `RingBuffer`; drift correction, mute, stats |
| `SavePersistence` | Debounced battery-save writes, flush on demand |
| `SaveStore` · `StateStore` · `CheatStore` | The three IndexedDB databases |
| `Display` | Mounts the `<canvas>`, hands the element to the session, then never re-renders |
| `StatusBar` | Live counters written straight to DOM text nodes on a ~4 Hz interval |
| `SettingsDrawer` | The one configuration surface. Owns section nav, focus trap, and pausing while open |
| Panels (`RomInfo`, `Controls`, `Saves`, `States`, `Cheats`, `Debug`) | Feature UIs inside the drawer; all call session methods |

### Core side — `packages/emulator/src`

| Module | Responsibility |
|---|---|
| `EmulatorCore` | The contract (§1) |
| `EmulatorManager` | Reads the header, picks and owns a core, forwards lifecycle calls |
| `GameBoyCore` | Wires CPU · MMU · PPU · APU · Timer · Serial · Joypad · cartridge; owns VRAM and OAM |
| `Cpu` | SM83 fetch–decode–execute; calls `onTCycle` for **every** T-cycle it consumes |
| `Mmu` | Address decoding, IO registers, PPU-mode access gating, OAM DMA, HDMA, cheat read hook |
| `Ppu` | Pixel-FIFO renderer, LCD mode state machine, STAT interrupts, palettes, framebuffer |
| `Apu` | Four channels + frame sequencer; decimates to the host rate and pushes to a sink |
| `Timer` · `Serial` · `Joypad` | DIV/TIMA, the link port, the joypad register |
| `cartridge/` | Header parsing, ROM-only + MBC1/2/3(+RTC)/5, battery SRAM, `.sav` packing |
| `state/` | `StateWriter`/`StateReader`, magic, version, cartridge fingerprint, per-subsystem sections |
| `cheats/` + `gb/cheats/GbCheatEngine` | Code decoding; ROM-read substitution and per-frame RAM pokes |
| `debug/` | `Debugger` (breakpoints, watchpoints), `disassemble` |
| `gba/` | `Arm7` (ARM + Thumb), `GbaMmu` (+`Dma`, waitstates, backup), `GbaPpu`, `GbaApu`, `Timers`, `GbaKeypad` |

---

## 3. Walkthroughs

### 3.1 Loading a ROM

`RomPicker` reads the file and calls `session.loadRom(name, bytes)`.

```text
session.loadRom(name, data)
 ├─ saves.flush(previousCore)          flush the OUTGOING game first — swapping
 │                                     cartridges must not lose the last second
 ├─ manager.loadRom(data, preference?)
 │    ├─ parseHeader()      title, cartridgeType, ROM/RAM size, checksums, CGB flag
 │    ├─ detectSystem()     → GB | GBA      (preference overrides, mismatch reported)
 │    ├─ createCartridge()  → RomOnly | Mbc1 | Mbc2 | Mbc3(+RTC) | Mbc5
 │    └─ new GameBoyCore() | new GameBoyAdvanceCore()
 │         core.loadRom() → mmu.setCartridge() → core.reset()
 │              reset() also writes POST-BOOT register state by hand:
 │              there is no boot ROM, and test ROMs depend on those values
 ├─ pacer.reset(); frameCount = 0
 ├─ update({status:'running', romName, activeSystem})   → the ONE React re-render
 ├─ refreshQuickState()   does the quick slot hold a state?  (enables Load State)
 ├─ restoreCheats()       cheatStore.list(saveKey)  → applyCheats()
 ├─ restoreSave()         saveStore.load(saveKey)   → core.loadSaveData()
 ├─ startAudio()          a file pick is a USER GESTURE — the only moment a
 │                        browser will let an AudioContext start
 └─ start()               requestAnimationFrame(tick)
```

Everything after `update(...)` is asynchronous and independently failure-tolerant: a failed cheat
restore, a failed save read or a failed audio start each report themselves and **leave the game
running**. There is no ordering dependency between them.

`CartridgeInfo.saveKey` — `title:globalChecksum:romLength` — is the identity used by the save store,
every state slot and the cheat store. It is derived from ROM content, so the same game from a
different dump resolves to the same records and two different games never collide.

### 3.2 One frame

`EmulatorSession.tick` is the whole runtime loop.

```text
tick(now)                                    ← requestAnimationFrame
 ├─ requestAnimationFrame(tick)              reschedule FIRST: a throw below must
 │                                           not silently kill the loop
 ├─ gamepad.poll()                           ONCE per tick, not per frame: the browser
 │                                           cannot produce new pad data within one
 │                                           animation frame, and polling inside the
 │                                           catch-up loop allocated an array each time
 ├─ frames = pacer.advance(now)              0..4  (see §3.3)
 ├─ for each frame:
 │    ├─ manager.setInput(input.sample())    sampled as late as possible, ONCE per
 │    │                                      emulated frame — each frame must consume
 │    │                                      its own sticky bits
 │    └─ manager.runFrame()                  → core.runFrame()  (see §4)
 ├─ if frames > 0:
 │    ├─ paint()                             image.data.set(core.getFrameBuffer())
 │    │                                      putImageData — ONE preallocated ImageData
 │    └─ saves.poll(core)                    consumeSaveRamDirty() → debounce a write
 └─ every 250 ms: recompute measuredFps      read by StatusBar through a getter
```

**Zero `setState` anywhere in that path.** The screen updates through the canvas context; counters
update through DOM text nodes. React is not involved in a running frame at all.

### 3.3 Pacing — `FramePacer`

```text
advance(now) → how many frames to run
  • target 59.7275 Hz  (4194304 / 70224) — NOT 60. Forcing 60 changes game
    speed and audio pitch.
  • gap > 250 ms  → count it as ONE frame. A hidden tab must not produce a
    catch-up burst that fast-forwards the game.
  • cap 4 frames per tick → drop the backlog rather than carry debt.
  • setSpeed(m) scales the accumulator; reset() on resume, tab return,
    state load and ROM load.
```

Exactly one component owns the clock. If audio-driven pacing is ever adopted, it replaces this
rather than joining it — two clocks fighting produce judder that looks like a PPU bug.

### 3.4 Input, end to end

```text
 keydown/keyup ──▶ KeyboardInput ─┐
 touchstart/move ▶ TouchInput ────┼─▶ InputLatch ──▶ sample() ──▶ manager.setInput(mask)
 gamepad poll ───▶ GamepadInput ──┘   per-source        once            core.joypad.setState()
                                      held state      per frame
```

`InputLatch` holds **one held-mask per source** plus a **sticky** mask of anything pressed since the
last sample. `sample()` returns `heldByAnySource | sticky`, then clears sticky.

Two bugs that design exists to prevent:

- *Shared mask.* Hold `Z`, tap on-screen A, lift — with one shared mask, A releases in the game
  while the key is still down, and never re-presses because `keydown` already fired.
- *Sub-frame taps.* Sampling only current physical state drops a press that began and ended between
  two frames, which at 60 Hz is an achievable human action and feels like being ignored.

`releaseAll()` is called on blur, on tab hide, on pause and around a rebind capture. The gamepad
gets told **separately** because it keeps its own shadow set: without that, a pad button held across
a pause is seen as still-down afterwards and never emits another press.

### 3.5 Audio

```text
core.setAudioSink(rate, sink)
   └─ Apu.setOutputRate(rate)      decimate 1048576 Hz → device rate
        every emulated sample ──▶ sink(left, right)
             └─ AudioOutput.push() ──▶ RingBuffer (4096 samples, held ~50% full)
                                          │
                     AudioWorklet (audio thread) pulls ──▶ speakers
```

- **AudioWorklet, never `ScriptProcessorNode`** — the latter is deprecated and runs on the main
  thread, so it glitches whenever the UI does anything.
- **The device picks the rate** (44100/48000/96000); the APU decimates to it.
- **Drift is corrected by nudging the resample ratio**, never by dropping or duplicating samples.
- **Speed interacts here.** `setSpeed(m)` re-installs the sink at `deviceRate / m`. Without that, 2×
  produces samples twice as fast as the device drains them, the ring overflows, pushes are dropped,
  and you hear constant crackle. Rescaling shifts pitch instead.
- **Gesture policy.** `wakeAudio()` on resume; if the context refuses (no gesture), the failure is
  *recorded, not reported*, and `wakeAudioOnGesture` — a pointerdown/keydown listener that bails on
  its first line unless audio is actually waiting — wakes it at the next touch. A banner on every
  tab switch would be noise.

### 3.6 Battery saves

```text
per frame:  saves.poll(core)
              └─ core.consumeSaveRamDirty()   reads AND clears the flag
                    └─ true → restart a 1000 ms debounce timer
                                 └─ saveStore.put(saveKey, core.getSaveData())

immediate:  flushSave()  ← pause · tab hide · pagehide · ROM swap · .sav import
```

`getSaveData()` packs SRAM plus, for MBC3, a 48-byte RTC tail carrying a real-world timestamp —
which is what lets a cartridge clock keep running while the game is closed.

`pagehide`, **not** `beforeunload`: mobile Safari frequently backgrounds a tab without firing the
latter, which is exactly the case where a player expects the save to survive.

### 3.7 Save states

```text
save:  core.serialize()            StateWriter: magic + version + fingerprint + sections
          ↑ each subsystem contributes its own section (savePpu, saveApu, saveMemory, saveCpuState)
       captureThumbnail()          offscreen canvas → PNG data URL; failure returns null,
                                   because a thumbnail is decoration and must never block a save
       stateStore.save(saveKey, slot, bytes, thumbnail)
       statesRevision++            an open panel re-reads ONLY on this counter — listing pulls
                                   every slot's full bytes out of IndexedDB, and pause/resume
                                   must not pay for that across eight slots

load:  stateStore.load(saveKey, slot)
       core.deserialize(buffer)    refuses on wrong magic / version / fingerprint
       pacer.reset(); paint()      the screen must show the restored frame immediately

list:  readStateHeader()           reads the six-byte container header WITHOUT parsing the state,
                                   so a slot this build cannot load is labelled as such instead of
                                   failing on click. It returns the version rather than a boolean:
                                   labelling requires reading a header `deserialize` must reject.
                                   Its tests cover a view at a non-zero byte offset, because
                                   IndexedDB hands back windows onto a larger buffer and
                                   `new DataView(data.buffer)` would read the wrong six bytes.
```

The container is owned by one place; **every subsystem supplies its own `serialize`/`deserialize`**.
The version must be bumped whenever any section's layout changes: a state that silently misparses is
far worse than one that refuses to load, because the game appears to work and then corrupts.

GBA states carry a **different magic**, so "wrong console" is a clean refusal instead of a misparse.

### 3.8 Cheats

```text
addCheat(code) ─▶ decodeCheat()  validate NOW, so a bad code never reaches storage
                 ─▶ cheats[] ─▶ persistCheats()
                                  ├─ applyCheats()          push the WHOLE active set in ONE call
                                  │     └─ mmu.cheats.setCheats(parsed)
                                  └─ cheatStore.save(saveKey, ...)

runtime:  Game Genie  → checked in Mmu.readDirect, every ROM read
          GameShark   → written once per frame, from the VBlank handler
```

Three design consequences worth knowing:

- **Whole-set push, not add/remove.** When the core moves to a Worker this is one message with no
  ordering to get wrong.
- **The ROM image is never patched.** `saveKey` contains a checksum over every ROM byte; one patched
  byte would change the key, the app would look in a different record, and the player's save would
  appear to have vanished. Read-path substitution also makes disabling instant, with nothing to undo.
- **Idle cost is a compare.** `romCount === 0` is one integer load and a predicted branch; a 4 KB
  bitset keeps misses to two loads and a mask. A `Map` per read measured 35× worse.

A stored code that no longer parses is **skipped, not fatal** — the list is the player's, and
refusing to run the game over one bad row would be worse than ignoring it.

### 3.9 Pause, tab switch, resume

```text
pause()                       manual
  manager.pause() · stop() · flushSave()
  input.releaseAll() · gamepad.releaseAll() · manager.setInput(0)
  status → 'paused'

handleVisibilityChange(hidden = true)
  input.releaseAll()          a key held when a tab hides never delivers keyup
  gamepad.releaseAll() · flushSave() · audio.suspend()
  if running → stop() · manager.pause() · autoPaused = true · status → 'paused'

handleVisibilityChange(hidden = false)
  pacer.reset()               drop accumulated time; never a catch-up burst
  if autoPaused → resume()    ONLY if we paused. A pause the player asked for is left alone.
      resume() → wakeAudio() · manager.resume() · pacer.reset() · start()
```

The `autoPaused` flag is the entire distinction between "the app helpfully resumed" and "the app
overrode my pause."

### 3.10 The debugger

```text
DebugPanel (open)  ──▶ session.getInspector() ──▶ core.getInspector()
                          getCpuSnapshot() · readMemory() · readMemoryRange()
                          getInstructionCount() · getFrameCount()
                       session.stepInstruction() / stepFrame() → paint()
                       session.toggleBreakpoint(addr) / listBreakpoints()
```

`CoreInspector` is **read-only by contract**, and implementations read live state on demand rather
than snapshotting per frame — so the panel costs the emulator nothing while it is closed, and a
throttled interval means watching registers does not itself drop frames. It was defined in Phase 00
precisely because retrofitting it later would mean touching every subsystem.

---

## 4. Inside the core

### 4.1 Lockstep — the decision everything rests on

`GameBoyCore`'s constructor installs one callback, and that callback is the whole timing model:

```ts
this.cpu.onTCycle = () => {
  this.timer.tickT();
  this.apu.tickT(this.timer.apuClockBit);   // the frame sequencer runs off a DIV bit,
                                            // so the timer MUST advance first
  this.mmu.tickT();                         // OAM DMA, HDMA
  if (this.ppu.tickT()) this.frameComplete = true;
};
```

The CPU calls this for **every T-cycle it consumes, including the cycles inside an instruction** —
not once at the end. That is the charter's cycle-accuracy rule made concrete, and it is why a write
landing mid-instruction is visible to the PPU at the right dot. **A "run the instruction, then add
its cycles" core cannot be corrected later without a rewrite**, which is why it was never written
that way.

Ordering inside the callback is itself load-bearing: the APU's frame sequencer is clocked from a DIV
bit, so the timer advances before it.

### 4.2 `runFrame`

```ts
runFrame() {
  if (!this.running) return;
  this.frameComplete = false;
  let elapsed = 0;
  while (!this.frameComplete && elapsed < MAX_T_CYCLES_PER_FRAME) {
    elapsed += this.cpu.step();
  }
}
```

The frame ends when **the PPU says so** — `ppu.tickT()` returning true at the end of a frame — not
when a cycle count is reached. The cap (two frames' worth of dots) exists only as slack against a
runaway loop, never as the normal exit.

### 4.3 Shared memory, two different rules

VRAM and OAM are allocated in `GameBoyCore` and shared **by reference** with both the MMU and the
PPU. That is not a shortcut — it is the hardware:

- The **MMU** gates *CPU* access by PPU mode (VRAM is unreadable during mode 3, OAM during modes 2
  and 3).
- The **PPU** reads the same arrays directly, because the PPU is **not** subject to its own lockout.

This is also the boundary the charter assigns to two different owners: the PPU engineer defines the
mode state machine, the memory engineer enforces the access behaviour, and neither invents it alone.

### 4.4 CGB is a mode, not a second core

```ts
const cgb = info.isColorCapable;
this.ppu.cgb = cgb;  this.mmu.cgb = cgb;  this.apu.cgb = cgb;
// and reset() leaves A = 0x11, which is how CGB software detects the hardware
```

Colour switches PPU, bus and timer behaviour **in place**. GBA, by contrast, is a genuinely separate
core: `GameBoyAdvanceCore` shares the `EmulatorCore` contract and nothing else, because the CPU, bus
and PPU have nothing in common with a Game Boy.

### 4.5 The pixel FIFO

```text
   background fetcher ──▶ BG FIFO (8) ──┐
   (tile → low → high → push)           ├──▶ mix ──▶ framebuffer
   sprite fetcher ──────▶ sprite FIFO ──┘
```

One pixel per dot, two fetchers, two FIFOs. Behaviour that **emerges** rather than being coded:
mode 3's length stretches with `SCX % 8`, window activation and every sprite fetched; the first tile
fetch of each line is discarded; the BG fetcher pushes only into an *empty* FIFO (pushing early
leaves a stale pixel at every tile boundary).

A scanline renderer composes at HBlank and therefore cannot express a write to `SCX`, `LCDC` or a
palette register landing *during* mode 3. Retrofitting the FIFO means rewriting the PPU, so it was
built this way from the start. Full reasoning: [`graphics.md`](graphics.md).

### 4.6 GBA Direct Sound — a loop that spans three subsystems

This is the clearest example of why cross-subsystem wiring is closed in exactly one place:

```ts
this.mmu.timers.onFifoTick = (i) => this.apu.notifyTimerOverflow(i);   // timer pops a byte
this.apu.onFifoRefill = (f) => this.mmu.dma.notifyFifo(f === 0 ? 1 : 2); // empty FIFO asks DMA
```

A timer overflow pops one FIFO byte; an empty-ish FIFO asks DMA channel 1 or 2 to refill it. CPU
timers, memory DMA and audio all participate, and the loop closes in `GameBoyAdvanceCore`'s
constructor — coordinated before implementation, as the charter requires, rather than discovered
afterwards.

---

## 5. Feature interaction map

Where features touch each other is where the bugs live. This is the map.

| A | B | How they interact | The trap |
|---|---|---|---|
| **Speed** | **Audio** | `setSpeed` re-installs the sink at `rate / speed` | Forgetting it overflows the ring → constant crackle |
| **Speed** | **Pacing** | `pacer.setSpeed` scales the accumulator | Two speed knobs would fight |
| **Pause** | **Input** | Pause calls `releaseAll()` on latch *and* gamepad | The pad's shadow set leaves a button dead until re-pressed |
| **Tab hide** | **Audio + pacing + saves** | Suspend, flush, auto-pause; resume only if `autoPaused` | Resuming a manual pause; or a catch-up burst on return |
| **Cheats** | **Save keys** | Codes patch on read, never the ROM image | Patching changes `saveKey` → saves "vanish" |
| **Cheats** | **Save states** | Cheat effects are in RAM, so they ride along in a state | A state taken with cheats on restores those RAM values |
| **Save states** | **Battery saves** | Independent: one is a machine snapshot, one is the game's own file | Loading a state does not rewrite `.sav` until the game next writes SRAM |
| **ROM swap** | **Battery saves** | Outgoing core is flushed *before* the new one loads | Otherwise the last second of the previous game is lost |
| **Save key** | **Everything persisted** | Saves, all eight state slots and cheats share `saveKey` | Anything that alters ROM bytes orphans all three at once |
| **Rebinding** | **All input sources** | Capture suppresses keyboard *and* releases touch + pad | A resting stick would otherwise hijack the capture |
| **Bound keys** | **Text fields** | Keyboard handler ignores events from inputs | Typing a cheat code would otherwise drive the game |
| **Settings drawer** | **Input** | The drawer pauses the game while open | Arrow keys reading the menu would otherwise drive the character |
| **Debugger** | **Frame loop** | `stepInstruction`/`stepFrame` run outside rAF, then `paint()` | Stepping without painting looks frozen |
| **Canvas** | **Framebuffer** | One `ImageData`, allocated in `attachCanvas`, mutated per frame | Reallocating per frame is a GC pause per frame |
| **PPU mode** | **CPU access** | PPU defines modes; MMU enforces the lockout | Two owners, one rule — invent it in one place only |
| **Timer** | **APU** | Frame sequencer clocked from a DIV bit | Tick order in `onTCycle` is not arbitrary |
| **Status** | **React** | `useSyncExternalStore`, status transitions only | Anything per-frame through React costs frames |

---

## 6. Invariants

Break one of these and the app does not throw — it degrades in a way that looks like a different
bug entirely. That is what makes them worth writing down.

1. **One clock.** `EmulatorSession` owns it, as a module singleton, started outside any re-runnable
   effect. *Violated →* judder that reads as a PPU bug.
2. **No React state per frame.** Canvas context and DOM text nodes only. *Violated →* the frame rate
   falls and profiling blames the emulator.
3. **No allocation in hot paths.** One `ImageData`, typed arrays, preallocated buffers, integer math.
   *Violated →* audio crackle and dropped frames from GC.
4. **A stable framebuffer reference.** `getFrameBuffer()` returns the same object every frame.
   *Violated →* a copy per frame, plus the Worker move stops being free.
5. **Input applied once per frame, at a defined point in emulated time.** DOM events never poke
   emulator state. *Violated →* dropped or double-counted taps.
6. **Subsystems tick per memory access.** *Violated →* unfixable without a rewrite.
7. **The core imports nothing from the browser.** *Violated →* headless tests stop working, which is
   how accuracy is measured at all.
8. **The ROM image is never modified.** *Violated →* `saveKey` changes and saves appear to vanish.
9. **Bump the save-state version on any layout change.** *Violated →* silent misparse, then
   corruption.
10. **ROM bytes never leave the device.** No fetch, no analytics, no service-worker caching.
    *Violated →* the project's central promise is gone.

---

## 7. Headless: the same core, no browser

Accuracy is measured by running the **identical** core under Node with no DOM at all:

```text
tests/harness/runTest(rom, condition)
  core.loadRom(bytes)
  loop: core.runFrame()  →  condition(core) → pass | fail | continue | unavailable
                            └ mooneyeCondition  — LD B,B, then the Fibonacci register
                              signature B=3 C=5 D=8 E=13 H=21 L=34 (all 0x42 = fail)
                            └ blarggCondition   — serial output plus the 0xA000 protocol
                            └ screenshotCondition — framebuffer vs reference PNG, reported
                              as a differing-pixel COUNT and BOUNDING BOX
                            └ timeout — a frame budget; a hang is a FAILURE, not a pause
```

Two honesty rules make the results mean something: a condition whose hardware hooks do not exist
returns **`unavailable`**, never `pass`; and a previously-passing test that fails is a
build-breaking regression, never quietly re-baselined.

The per-opcode gate goes deeper than ROMs can: SingleStepTests/sm83 asserts not only registers and
memory after each instruction but **the exact sequence of per-M-cycle bus accesses** — read, write,
internal. That is what catches a cycle error the moment it is introduced, rather than three phases
later as a mystery.

Because the core is browser-free, the debugger, the harness and the app all drive it through the
same methods — `runFrame`, `stepInstruction`, `getInspector` — and there is no "test mode" that
could diverge from what a player runs.

---

## See also

- [`features.md`](features.md) — what each feature does, from the outside
- [`software-development-plan.md`](software-development-plan.md) — plan, status, what is next
- [`architecture.md`](architecture.md) — the boundary and frame-loop ownership, in brief
- [`graphics.md`](graphics.md) — why the PPU is a pixel FIFO
- [`testing.md`](testing.md) — the harness, the corpus and the gate order
- [`handoff.md`](handoff.md) — the live state, including what is broken today
