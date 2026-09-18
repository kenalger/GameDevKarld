# WebBoy — Features

**What the application does, feature by feature, and how each one behaves.**

This is the user-facing catalogue: what is there, how to use it, what it does when things go
wrong, and what is deliberately absent. For the machinery underneath, see
[`how-it-works.md`](how-it-works.md). For plan and status, see
[`software-development-plan.md`](software-development-plan.md).

Status key: ✅ shipped and test-verified · ⚠️ shipped but not verified on real devices ·
🚧 partial, with a known gap · ⛔ deliberately absent.

---

## The screen, at a glance

```text
┌─────────────────────────────────────────────────────────────┐
│  WebBoy            Your ROM never leaves this device        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│      ┌───────────────────────────────┐    ● running         │
│      │                               │    ROM name          │
│      │      160×144 / 240×160        │    FPS · frames      │
│      │        game display           │                      │
│      └───────────────────────────────┘                      │
│            Arrows · Z=A · X=B · Enter=Start                 │  ← key legend
│                                                             │
│  [ Pause ] │ [Quick save][Quick load] │ Speed [1x] │        │  ← transport
│            │ [Mute][Fullscreen] │ [Reset]                    │
│                                                             │
│  ┌ Cartridge │ Controls │ Saves │ States │ Cheats │ Debug ┐ │  ← panels
│  │                                                        │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  [ on-screen D-pad and buttons — touch devices only ]       │
│  Disclaimer: not affiliated with Nintendo. Bring your own   │
└─────────────────────────────────────────────────────────────┘
```

The transport row is **grouped, not a flat row of eight equal buttons** — playback, save state,
speed, output, reset. Pause and Resume are one toggling button, so no control is ever dead.

---

## 1. Loading a game

| | |
|---|---|
| **Status** | ✅ |
| **Where** | The ROM picker, and the Cartridge panel |
| **Accepts** | `.gb`, `.gbc`, `.gba` from your own device |

Pick a file. The bytes go `File → ArrayBuffer → Uint8Array → emulator` **and stop there**. There is
no upload, no `fetch` carrying ROM data, no third-party SDK anywhere on that path.

The header parser reads the title, mapper type, ROM and RAM size, checksums and the CGB flag, and
the right core starts automatically. The **Cartridge panel** shows all of it, and doubles as the
first diagnostic when a game misbehaves: *"MBC5, 128 KB RAM, checksum invalid"* is usually the
answer.

**System picker — Auto / Game Boy / Game Boy Advance.** Auto reads the header and is right almost
always. The override exists for the one case that genuinely needs it: a CGB-compatible cartridge
also runs on original Game Boy hardware and looks entirely different doing so. If your override
disagrees with the cartridge, the app **says so** rather than silently obeying — *"this cartridge
reports GB, but you chose Game Boy Advance"* — because "I picked Advance and my Game Boy game
broke" must not be a mystery. The choice is remembered in `localStorage`.

⛔ **No ROM is supplied, hosted, linked or looked up.** You bring software you are entitled to use.

---

## 2. Playing

| | |
|---|---|
| **Status** | ✅ emulation · ⚠️ real-device behaviour not yet verified |

**Display.** Native resolution — 160×144 for GB/GBC, 240×160 for GBA — backed at that size and
scaled up by CSS with `image-rendering: pixelated`. Never blurred; a soft emulator screen is the
most common amateur tell. Fullscreen is one button.

**Speed.** 0.25× · 0.5× · 1× · 2× · 4× · 8×. Audio is rescaled by the same factor, so
fast-forward shifts pitch rather than crackling — which is what fast-forward has always sounded
like, and an honest signal that you are not at normal speed.

**Pause / Resume / Reset.** Pausing flushes your battery save and releases every held button, so
nothing is stuck down when you come back.

**Tab switching handled properly.** Hiding the tab releases held keys (a key held when a tab hides
never delivers its `keyup`), flushes the save, suspends audio and pauses. Coming back resumes
automatically and drops the accumulated time instead of running a catch-up burst — **but only if
*we* paused.** A pause you asked for is left alone. This exists because coming back to a frozen
picture with no sound and no explanation reads as a crash, and it was the single most common
complaint about the app.

---

## 3. Controls

| | |
|---|---|
| **Status** | ✅ keyboard, touch · 🚧 gamepad (see the gap below) |
| **Where** | The Controls panel, the key legend, the on-screen pad |

### Keyboard

| Button | Default key |
|---|---|
| D-pad | Arrow keys |
| A | `Z` |
| B | `X` |
| Start | `Enter` |
| Select | `Shift` (either) |

Bindings are **user-editable** in the Controls panel and stored in `localStorage`. Capture is by
physical key code, not the typed character, so a non-QWERTY layout binds the key you actually
pressed. During a rebind, **every** input source is suppressed — a capture should not be
interrupted by a thumb on the on-screen pad or a resting gamepad stick.

Bound keys are prevented from reaching the game while you are typing in a text field, and released
on blur.

**The key legend is printed under the device**, not buried in a tab. That is deliberate: a player
once loaded a game, reached the first text box, and reported the emulator as frozen. It was running
at a perfect 60 fps — waiting for A, which is bound to Z, which nothing on screen said.

> ⚠️ **Open decision.** WebBoy maps `Z → A, X → B`. mGBA, SameBoy and RetroArch use the opposite.
> See the plan, §7 item 3.

### Touch

On-screen D-pad and buttons appear on touch devices. Hit-testing resolves the control under your
finger **fresh on every move**, so sliding a thumb from Left to Up works without lifting.
`touch-action: none` stops the browser scrolling, zooming or rubber-banding under your thumb.

⚠️ The layout has never been used on a real phone. Customisation is deliberately deferred until it
has been — making an unvalidated layout configurable ships the problem to the player.

### Gamepad

Standard-layout controllers work through the Gamepad API, polled once per frame.

> 🚧 **Known gap, and it is a correctness bug rather than a missing nicety.** The pad map is a
> hardcoded standard-layout index table. For a controller the browser does **not** report as
> `mapping: "standard"`, indices mean nothing and buttons land on the wrong actions. Hot-plug
> listeners are also missing, so a pad connected before page load is invisible in Safari and
> Firefox until you press something.

### Why three sources don't fight

Each source keeps its own held-state; the emulator sees the union. Without that, holding `Z` on the
keyboard and then tapping the on-screen A button would **release** A in the game while the key is
still physically down — and it would never re-press, because the keydown already fired.

A tap that starts *and ends* between two frames is still delivered: the latch tracks both what is
held now and what was pressed at any point since the last sample, so **every press registers for at
least one frame**.

---

## 4. Sound

| | |
|---|---|
| **Status** | 🚧 shipped; 19/24 Blargg sound tests pass (wave RAM) |

All four Game Boy channels — two pulse, wave, noise — plus GBA PSG and Direct Sound. Mute is one
button.

Output is an **AudioWorklet**, off the main thread, fed by a ring buffer held at half full (~85 ms
at 48 kHz — deep enough to survive a GC pause, shallow enough not to feel laggy). The device picks
the sample rate; the emulator decimates to it. Drift is corrected by **nudging the resample ratio,
never by dropping samples** — a dropped sample is an audible click, a 0.2% pitch shift is not.

Browsers only let audio start from a user gesture. Loading a ROM is one, so sound normally just
works. When a tab returns and the context cannot wake without a gesture, the app **does not raise a
banner on every tab switch** — it arms the next key press or tap to wake it.

If audio fails entirely, the game stays playable. Sound is a nicety; the game is not.

---

## 5. Saving

Two independent things, often confused, both local.

### 5.1 Battery saves (the game's own save file)

| | |
|---|---|
| **Status** | ✅ |
| **Where** | Automatic, plus the Saves panel |

What the cartridge itself writes — the in-game save. Only cartridges with a battery have one.

Written **automatically**, debounced one second after SRAM goes quiet (games write in bursts), and
flushed on pause, on tab hide and on `pagehide` — **not** `beforeunload`, because mobile Safari
frequently backgrounds a tab without ever firing it, which is exactly when you expect your save to
survive.

Keyed by **cartridge identity, not filename**, so the same game from a different dump finds the
same save and two different games never collide.

**Export and import `.sav`** in the common layout other emulators understand — raw SRAM plus a
48-byte RTC tail for clock cartridges — so your saves move between emulators and machines rather
than being trapped here. Importing into a cartridge with no battery tells you so instead of
silently doing nothing.

**MBC3 real-time clock** keeps running while the game is closed, so a day/night cycle does not
freeze between sessions.

### 5.2 Save states (a snapshot of the whole machine)

| | |
|---|---|
| **Status** | ✅ — verified 1000-frame identical after a round trip |
| **Where** | Quick save / quick load on the transport row, and the States panel |

Four slots per cartridge. **Slot 0 is the quick slot**, so the transport row and the panel agree
about what "quick" means. Each slot captures a **thumbnail** at save time, because "slot 3" tells
you nothing a month later and a picture of where you were tells you everything.

Quick save and quick load sit next to Pause, where your hand already is. They were moved there
after save states spent a while reachable only through a tab below the fold — which is how a player
concludes a feature is missing.

States **export and import** as `.state` files. A state carries a format magic, a version and a
32-bit cartridge fingerprint, and is **refused** if any of them disagree — a state from another game
or another console cannot be resumed into the wrong ROM. A state that silently misparses is far
worse than one that refuses to load: the game appears to work, then corrupts.

---

## 6. Cheats

| | |
|---|---|
| **Status** | ✅ Game Boy / Game Boy Color · ⛔ GBA (blocked, see below) |
| **Where** | The Cheats panel |

**Game Genie** (ROM substitution) and **GameShark** (RAM poke) codes, typed in by hand. The detected
format is shown live beside the field as confirmation that the parse worked, and a bad code is an
ordinary "that is not a code" message rather than an error.

Codes are stored per cartridge and restored when you load that game again, each with its own on/off
toggle. Disabling is instant and exact, because **the ROM image is never modified** — Game Genie
codes are applied on the read path instead. That is not a style preference: the save key includes a
checksum over every ROM byte, so a single patched byte would send the app looking in a different
record and your battery save would appear to have vanished.

Cheats cost the emulator effectively nothing when none are active — one integer compare on the ROM
read path.

⛔ **WebBoy ships no cheat database and looks nothing up.** A remote lookup would have to send an
identifier derived from your ROM, which is exactly the quiet exfiltration the privacy rule exists to
prevent. The only way a code gets in is that someone typed it.

🚧 **GBA cheats are blocked on a licensing question**, not on effort: the `DEADFACE` reseed depends
on two tables published nowhere except inside an MPL-2.0 codebase, which an MIT project may not
copy. Either they get derived from GBATEK or the feature ships without that one code type.

**Wanted, not yet built:** multi-line entry, and a "did this code actually match?" indicator. Without
the latter, a code for the wrong ROM revision silently does nothing and the emulator looks broken.

---

## 7. Developer tools

| | |
|---|---|
| **Status** | ✅ |
| **Where** | The Debug panel |

- **CPU registers** — A/F/B/C/D/E/H/L, PC, SP, IME, halted, cycle count
- **Disassembly** around the program counter
- **Memory inspection** by address and range
- **Breakpoints** and **watchpoints** (read / write)
- **Step one instruction** and **step one frame**, each repainting the screen
- Instruction and frame counters

Two properties make this safe to have in a shipped app: the debugger reads through a **read-only**
inspection interface and never mutates core internals, and it **costs the emulator nothing while the
panel is closed** — state is read on demand, never snapshotted per frame. The live view refreshes on
a throttled interval, so watching registers does not itself cost you frames.

---

## 8. Privacy and legal behaviour

| | |
|---|---|
| **Status** | ✅ by construction · ⚠️ empirical verification still outstanding |

This is a feature, not a policy page.

- ⛔ No upload, no backend, no account, no database.
- ⛔ No analytics, telemetry, error reporting or third-party SDK — a stack trace or a filename is
  enough to leak what you are playing.
- ⛔ No service worker caching ROM data.
- ⛔ No Nintendo branding or trade dress. The **disclaimer ships in the UI**, not only in the README.
- ✅ CI fails the build if any ROM or save file is ever committed to the repository.

Everything you keep — battery saves, save states, cheats, key bindings, system preference — lives in
your browser (IndexedDB and `localStorage`) on your machine.

> ⚠️ The empirical check — opening the running app and confirming in the Network tab that every
> request is same-origin — **has not been performed yet**, because the app has never been deployed.
> It is the top item in the plan. The guarantee is architectural today; it is meant to be verified
> as a network log, not trusted as a code read.

---

## 9. Accuracy — what "works" actually means

WebBoy is judged by hardware test ROMs, not by whether a game boots. The current measured position:

| | |
|---|---|
| CPU, per-opcode, including per-cycle bus activity | **500,000 / 500,000** |
| Blargg `cpu_instrs` + timing | 18 / 19 |
| Mooneye acceptance | **60 / 66** applicable |
| dmg-acid2 and cgb-acid2 rendering | **pixel-exact** |
| GBA CPU + memory (jsmolka) | **7 / 7** |
| Blargg sound | 19 / 24 |
| Mealybug Tearoom (mid-scanline effects) | **0 / 24** |

The PPU is a **pixel FIFO**, so mid-scanline raster effects are expressible at all — but the
remaining Mealybug and five Mooneye `ppu/*` failures are the same bug seen from two sides, and
that is the largest known accuracy gap. Details and the diagnosis so far: the plan, §7 item 4.

**No commercial-game compatibility sweep has been run**, on any system. Compatibility is a target,
not a claim.

---

## 10. Feature status summary

| Feature | GB | GBC | GBA |
|---|---|---|---|
| CPU + memory + timing | ✅ | ✅ | ✅ |
| Video | ✅ | ✅ | ✅ all modes, affine, windows, mosaic, blending |
| Audio | 🚧 wave RAM | 🚧 | ✅ PSG + Direct Sound |
| Mappers / backup | ✅ MBC1/2/3+RTC/5 | ✅ | 🚧 EEPROM detected, unimplemented |
| Battery saves | ✅ | ✅ | ✅ |
| Save states | ✅ | ✅ | ✅ |
| Cheats | ✅ | ✅ | ⛔ blocked |
| Keyboard / touch / gamepad | ✅ / ⚠️ / 🚧 | ✅ / ⚠️ / 🚧 | ✅ / ⚠️ / 🚧 |
| Debugger | ✅ | ✅ | partial |

---

## 11. Deliberately absent

Not a backlog. These are decisions.

| | Why |
|---|---|
| Cloud saves, accounts, sync | Every server feature is a way for a ROM to leave the device |
| A ROM browser or library | We host and link nothing |
| Online cheat lookup | Would transmit an identifier derived from your ROM |
| Netplay | Needs a server, and a relay sees traffic |
| Shaders and CRT filters | Nothing until pixel-exact output is verified on real devices |
| A Web Worker core | Deferred, not forgotten — at ~20× realtime there is no bottleneck to move, and the charter forbids optimising before profiling |
| Commercial-ROM "compatibility list" | Would invite exactly the thing the legal position avoids |

---

## Where to go next

- [`how-it-works.md`](how-it-works.md) — how these features are built and how they interact
- [`software-development-plan.md`](software-development-plan.md) — the plan, the status, what is next
- [`handoff.md`](handoff.md) — the live state, including what is broken today
- [`legal.md`](legal.md) — the distribution rules and the privacy guarantee in full
