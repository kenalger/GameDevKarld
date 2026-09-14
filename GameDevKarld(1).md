# GameDevKarld — Browser-Based GB / GBC / GBA Emulator Roadmap

## 1. Project Vision

Build a browser-based emulator platform that can eventually run legally supplied Game Boy, Game Boy Color, and Game Boy Advance ROMs entirely on the user's device.

The project should be:

- Browser-based
- Privacy-focused
- No required backend database
- Modular and testable
- Designed for keyboard, mobile touch controls, and gamepad support later
- Built first around Game Boy, then expanded to Game Boy Color and Game Boy Advance

A suitable product direction is:

> **WebBoy — a privacy-first Game Boy / Game Boy Color / Game Boy Advance emulator for the browser.**

The emulator itself is the software being developed. Users provide ROM files from their own devices.

---

## 2. Important Legal / Distribution Strategy

This project should not distribute commercial game ROMs or copyrighted game assets.

Do **not**:

- Bundle Pokémon Red, Blue, Yellow, Gold, Silver, Crystal, Ruby, Sapphire, Emerald, FireRed, or LeafGreen ROM files.
- Host ROM files on a server, CDN, GitHub repository, Firebase Storage, or similar service.
- Provide download links to commercial ROMs.
- Bundle copyrighted game sprites, music, maps, logos, characters, or other commercial game assets.
- Present the project as an official Nintendo, Game Boy, Pokémon, or The Pokémon Company product.

Instead:

- Let users select a ROM from their own local device.
- Process the ROM locally in the browser.
- Do not upload the ROM to a server.
- Use legally usable homebrew/test ROMs during development.
- Clearly state that the project is independent and not affiliated with Nintendo or The Pokémon Company.
- Review all third-party emulator code and dependencies for their licenses before using them.

Example disclaimer:

> WebBoy is an independent emulator project and is not affiliated with or endorsed by Nintendo, The Pokémon Company, or any game publisher. WebBoy does not distribute commercial game ROMs. Users are responsible for providing ROM files they are legally entitled to use.

This is an engineering/legal-risk guideline, not legal advice. Laws concerning emulation, ROM dumping, circumvention, and preservation vary by jurisdiction. Obtain professional legal advice before a public or commercial launch if legal certainty is important.

---

# 3. Supported Consoles

## Phase 1 — Game Boy

Target the original Game Boy hardware first.

Potential compatible game categories include Game Boy games such as:

- Pokémon Red
- Pokémon Blue
- Pokémon Yellow

The goal is to make the emulator technically capable of running Game Boy software, rather than making Pokémon-specific code.

## Phase 2 — Game Boy Color

Add Game Boy Color hardware support.

Potential compatible game categories include:

- Pokémon Gold
- Pokémon Silver
- Pokémon Crystal

Game Boy and Game Boy Color share substantial concepts, so GBC should follow GB.

## Phase 3 — Game Boy Advance

GBA requires a separate emulator core because its CPU and hardware architecture are substantially different.

Potential compatible game categories include:

- Pokémon Ruby
- Pokémon Sapphire
- Pokémon Emerald
- Pokémon FireRed
- Pokémon LeafGreen

GBA uses an ARM7TDMI CPU and a substantially more complex memory, graphics, DMA, timer, and audio architecture.

---

# 4. Overall Architecture

```text
YOUR WEB APPLICATION
│
├── Frontend
│   ├── ROM Loader
│   ├── Emulator Screen
│   ├── Controls
│   ├── Settings
│   ├── Save/Load UI
│   └── Debug UI
│
├── Emulator Manager
│   ├── Detect ROM / System
│   ├── Start / Pause / Reset
│   ├── Frame Loop
│   └── Save State Management
│
└── Emulator Cores
    │
    ├── Game Boy Core
    │   ├── CPU
    │   ├── Memory Bus
    │   ├── Cartridge
    │   ├── PPU
    │   ├── Timer
    │   ├── Interrupts
    │   ├── Input
    │   └── APU
    │
    ├── Game Boy Color Core
    │   ├── Extended CPU/Memory behavior
    │   ├── Color PPU
    │   ├── Speed switching
    │   └── GBC cartridge behavior
    │
    └── Game Boy Advance Core
        ├── ARM7TDMI CPU
        ├── Memory Bus
        ├── Cartridge
        ├── Video
        ├── Audio
        ├── DMA
        ├── Timers
        ├── Interrupts
        └── Input
```

---

# 5. Recommended Technology Stack

## Frontend

- React
- TypeScript
- Vite
- CSS
- HTML Canvas

## Emulator Core

Start with TypeScript.

Do not start with WebAssembly unless performance actually requires it.

Possible future implementation:

```text
TypeScript emulator core
        ↓
Performance bottleneck discovered
        ↓
Rust / C / C++ core
        ↓
WebAssembly
```

## Storage

Use browser storage rather than a backend database:

- IndexedDB for save RAM
- IndexedDB for save states
- LocalStorage for small preferences

## Optional Future APIs

- Gamepad API
- Web Audio API
- Web Workers
- Fullscreen API
- File System Access API where supported

---

# 6. Repository Structure

```text
GameDevKarld/
├── apps/
│   └── web/
│       ├── src/
│       │   ├── components/
│       │   ├── pages/
│       │   ├── hooks/
│       │   ├── services/
│       │   └── styles/
│       └── public/
│
├── packages/
│   └── emulator/
│       ├── core/
│       │   ├── EmulatorCore.ts
│       │   └── EmulatorManager.ts
│       │
│       ├── gb/
│       │   ├── cpu/
│       │   ├── memory/
│       │   ├── ppu/
│       │   ├── apu/
│       │   ├── timer/
│       │   ├── input/
│       │   ├── cartridge/
│       │   └── GameBoyCore.ts
│       │
│       ├── gbc/
│       │   ├── ppu/
│       │   ├── memory/
│       │   ├── speed/
│       │   └── GameBoyColorCore.ts
│       │
│       ├── gba/
│       │   ├── cpu/
│       │   ├── memory/
│       │   ├── video/
│       │   ├── audio/
│       │   ├── dma/
│       │   ├── timers/
│       │   ├── input/
│       │   ├── cartridge/
│       │   └── GameBoyAdvanceCore.ts
│       │
│       └── shared/
│           ├── types/
│           ├── utils/
│           └── serialization/
│
├── tests/
│   ├── gb/
│   │   ├── cpu/
│   │   ├── memory/
│   │   ├── ppu/
│   │   └── timing/
│   ├── gbc/
│   └── gba/
│       ├── cpu/
│       ├── memory/
│       └── timing/
│
├── docs/
│   ├── architecture.md
│   ├── cpu.md
│   ├── memory.md
│   ├── graphics.md
│   ├── audio.md
│   ├── testing.md
│   └── legal.md
│
├── LICENSE
├── README.md
├── package.json
└── GameDevKarld.md
```

Do not create a `roms/` directory containing commercial ROMs.

Do not commit files such as:

```text
pokemon-red.gb
pokemon-blue.gb
pokemon-yellow.gb
```

---

# 7. Phase 0 — Project Setup

## Goals

Create the repository and establish the basic application architecture.

## Tasks

1. Create the React + TypeScript application.
2. Configure Vite.
3. Create the emulator package.
4. Create the Game Boy core interface.
5. Create the emulator manager.
6. Create the canvas display.
7. Create a basic ROM file picker.
8. Add linting and formatting.
9. Add unit testing.
10. Add the project README.
11. Add the legal/distribution notes.

Initial interface:

```ts
export interface EmulatorCore {
  reset(): void;
  runFrame(): void;
  pause(): void;
  resume(): void;
  loadRom(data: Uint8Array): void;
  getFrameBuffer(): Uint8Array;
}
```

---

# 8. Phase 1 — Game Boy CPU

The CPU is the first major emulator component.

The original Game Boy uses the Sharp LR35902 processor, which is Z80-like but not identical to a standard Z80.

## Registers

Implement:

```text
A
F
B
C
D
E
H
L
PC
SP
```

Support register-pair operations such as:

```text
AF
BC
DE
HL
```

## CPU Responsibilities

- Fetch opcode
- Decode opcode
- Execute instruction
- Update registers
- Update flags
- Update PC
- Update SP
- Track machine cycles
- Handle interrupts

## Instruction Families

Implement and test instructions such as:

- LD
- INC
- DEC
- ADD
- ADC
- SUB
- SBC
- AND
- OR
- XOR
- CP
- JP
- JR
- CALL
- RET
- PUSH
- POP
- RST
- HALT
- STOP
- DI
- EI
- BIT
- SET
- RES
- Rotate/shift instructions

## CPU Design

Prefer small, testable components:

```text
CPU
├── Registers
├── Decoder
├── Instruction Executor
├── ALU
├── Flags
└── Interrupt Handler
```

Do not put the entire CPU implementation into one giant class.

---

# 9. Phase 1 — Game Boy Memory Bus

The CPU needs a memory abstraction instead of directly accessing arrays.

```text
CPU
 ↓
Memory Bus
 ├── Cartridge ROM
 ├── VRAM
 ├── External RAM
 ├── Work RAM
 ├── OAM
 ├── I/O Registers
 ├── HRAM
 └── Interrupt Registers
```

Basic interface:

```ts
interface MemoryBus {
  read(address: number): number;
  write(address: number, value: number): void;
}
```

The memory bus should control address-specific behavior.

---

# 10. Cartridge System

Create a cartridge abstraction:

```ts
interface Cartridge {
  read(address: number): number;
  write(address: number, value: number): void;
  load(data: Uint8Array): void;
}
```

Start with simple ROM cartridges.

Then implement common bank controllers:

1. ROM ONLY
2. MBC1
3. MBC2
4. MBC3
5. MBC5

The cartridge system should be independent of the CPU.

---

# 11. ROM Header Detection

When a user selects a ROM, inspect the cartridge header.

Read information such as:

- Game title
- Cartridge type
- ROM size
- RAM size
- CGB compatibility flags
- Header checksum

Create a structure such as:

```ts
interface CartridgeInfo {
  title: string;
  cartridgeType: number;
  romSize: number;
  ramSize: number;
  isColorCapable: boolean;
}
```

Use this information to select the appropriate emulator core.

---

# 12. Phase 1 — Game Boy PPU / Graphics

The original Game Boy display is:

```text
160 × 144 pixels
```

Use HTML Canvas initially.

Recommended first implementation:

```text
PPU
 ↓
Framebuffer
 ↓
ImageData
 ↓
Canvas
```

## PPU Responsibilities

- VRAM access
- Tile decoding
- Background rendering
- Window rendering
- Sprite/OAM rendering
- LCD modes
- Scanline progression
- VBlank
- STAT behavior
- Palette handling

Do not start with WebGL.

Canvas and `ImageData` are sufficient for the first implementation.

---

# 13. Phase 1 — Input

Default keyboard mapping:

| Game Boy | Keyboard |
|---|---|
| Up | Arrow Up |
| Down | Arrow Down |
| Left | Arrow Left |
| Right | Arrow Right |
| A | Z |
| B | X |
| Start | Enter |
| Select | Shift |

Create an input abstraction:

```ts
interface InputController {
  press(button: GameBoyButton): void;
  release(button: GameBoyButton): void;
  isPressed(button: GameBoyButton): boolean;
}
```

Prevent browser actions from interfering with gameplay when appropriate.

---

# 14. Mobile Controls

Add an on-screen controller for mobile devices.

Suggested layout:

```text
             [ UP ]

       [ LEFT ] [ RIGHT ]
             [ DOWN ]

                         [ B ] [ A ]

                   [ SELECT ] [ START ]
```

Requirements:

- Touch-friendly button sizes
- Prevent accidental scrolling
- Visual pressed state
- Support simultaneous inputs where appropriate
- Landscape layout option

---

# 15. Phase 1 — Timing

Timing is one of the most important emulator components.

Implement:

- CPU cycles
- Machine cycles
- PPU timing
- Scanlines
- LCD modes
- VBlank
- Timer increments
- Divider register
- Timer overflow
- Interrupt timing

The emulator should not simply execute instructions as fast as possible.

It must model the target hardware's timing closely enough for software compatibility.

---

# 16. Interrupt System

Implement Game Boy interrupt handling.

Major interrupt sources include:

- VBlank
- LCD STAT
- Timer
- Serial
- Joypad

Implement:

```text
IE — Interrupt Enable
IF — Interrupt Flag
IME — Interrupt Master Enable
```

CPU interrupt behavior should be tested independently.

---

# 17. Phase 1 — Audio

Audio should come after the core CPU, memory, graphics, input, and timing are functioning.

Implement the Game Boy APU channels incrementally.

The audio layer should use Web Audio API output rather than trying to reproduce sound directly through DOM APIs.

Architecture:

```text
APU
 ↓
Audio Sample Buffer
 ↓
Web Audio API
 ↓
Browser Speakers
```

Audio timing must remain synchronized with the emulator.

---

# 18. Local ROM Loading

The ROM should be loaded from the user's device.

Example:

```ts
const file = event.target.files?.[0];

if (!file) return;

const buffer = await file.arrayBuffer();
const rom = new Uint8Array(buffer);

emulator.loadRom(rom);
```

The important design principle is:

```text
User selects ROM
        ↓
Browser reads ROM
        ↓
ROM stays in browser memory
        ↓
Emulator runs locally
```

Avoid:

```text
User selects ROM
        ↓
Upload to server
        ↓
Server stores ROM
        ↓
Server sends ROM back
```

---

# 19. Emulator Manager

Create one manager responsible for selecting and controlling emulator cores.

Example concept:

```ts
class EmulatorManager {
  private core: EmulatorCore | null = null;

  loadRom(rom: Uint8Array): void {
    const info = detectCartridge(rom);

    if (info.system === 'GB') {
      this.core = new GameBoyCore();
    }

    if (info.system === 'GBC') {
      this.core = new GameBoyColorCore();
    }

    if (info.system === 'GBA') {
      this.core = new GameBoyAdvanceCore();
    }

    this.core.loadRom(rom);
  }
}
```

The frontend should not need to know the details of the CPU, PPU, or cartridge implementation.

---

# 20. Frame Loop

The emulator should run in a controlled loop.

Conceptually:

```text
Browser Frame Loop
       ↓
Run enough CPU cycles
       ↓
Update PPU
       ↓
Update Timer
       ↓
Update APU
       ↓
Handle Interrupts
       ↓
Produce Frame
       ↓
Render Canvas
```

Later, move the emulator core into a Web Worker if the main UI becomes sluggish.

---

# 21. Save Games

Use IndexedDB for local save data.

Potential structure:

```text
IndexedDB
└── saves
    ├── cartridge-id-1
    ├── cartridge-id-2
    └── cartridge-id-3
```

Do not require a user account.

Allow optional export/import of `.sav` files.

---

# 22. Save States

Save states should contain the complete emulator state required to resume execution.

Potential state data:

```text
CPU registers
CPU flags
PC
SP
Memory
VRAM
OAM
PPU state
Timer state
Interrupt state
Input state
APU state
Cartridge banking state
External RAM
```

Prototype with JSON if useful.

For production, consider a compact binary format.

---

# 23. First Working Game Boy Milestone

The first major definition of success is not Pokémon.

The first milestone should be:

> Run a legal Game Boy homebrew/test ROM correctly from the browser.

Minimum requirements:

- ROM loads
- CPU executes instructions
- Memory works
- PPU renders
- Input works
- Timing works
- Reset works
- Pause works

Only after this should commercial-game compatibility be evaluated with legally supplied ROMs.

---

# 24. Debugger

Create a developer-only debugging interface.

Useful tools:

- CPU register viewer
- Flag viewer
- Program counter
- Stack pointer
- Memory viewer
- VRAM viewer
- OAM viewer
- Cartridge information
- Instruction counter
- FPS counter
- Frame counter
- Breakpoints
- Step instruction
- Step frame
- Basic disassembler

Example:

```text
CPU
A: 01
F: B0
B: 00
C: 13
D: 00
E: D8
H: 01
L: 4D
PC: 0150
SP: FFFE
```

This will dramatically reduce debugging time.

---

# 25. Testing Strategy

Testing should be continuous rather than postponed until the end.

## CPU Tests

Test:

- Register operations
- Flags
- Arithmetic
- Logic
- Jumps
- Calls
- Returns
- Stack operations
- Bit operations
- Interrupts

## Memory Tests

Test:

- Address ranges
- ROM reads
- RAM writes
- VRAM
- OAM
- I/O registers
- HRAM
- Interrupt registers

## PPU Tests

Test:

- Tile rendering
- Background
- Window
- Sprites
- Palette
- Scanline progression
- VBlank
- LCD modes

## Timing Tests

Test:

- CPU cycle counts
- Timer increments
- PPU transitions
- Interrupt timing

## Integration Tests

Run complete test ROMs and compare expected behavior.

Only use ROMs that are legally available for development/testing.

---

# 26. Game Boy Color Phase

After the original Game Boy core is stable, add Game Boy Color functionality.

Important areas include:

- Color palettes
- Additional VRAM bank
- Additional work RAM banks
- GBC-specific registers
- Speed switching
- GBC-compatible cartridges
- GBC PPU behavior

Reuse the existing architecture where hardware behavior is shared.

Do not duplicate the entire GB implementation unnecessarily.

Suggested relationship:

```text
GameBoyCore
   ↑
Shared GB behavior
   ↑
GameBoyColorCore
   ├── GBC Memory
   ├── GBC PPU
   └── GBC Speed Controller
```

---

# 27. Game Boy Advance Phase

GBA should be treated as a separate major project phase.

The core components are:

```text
Game Boy Advance
├── ARM7TDMI CPU
├── Memory Bus
├── BIOS interface/behavior as appropriate
├── Cartridge
├── Video
├── Audio
├── DMA
├── Timers
├── Interrupts
├── Input
└── System Control
```

Do not attempt to simply extend the Game Boy CPU into GBA.

---

# 28. GBA CPU

The GBA uses an ARM7TDMI processor.

Implement the CPU separately from the Game Boy CPU.

Areas to implement and test include:

- ARM instruction set
- Thumb instruction set
- General-purpose registers
- CPSR/SPSR behavior as applicable
- Branching
- Arithmetic
- Logical operations
- Load/store operations
- Stack behavior
- Interrupt handling
- Pipeline behavior where needed for compatibility

Suggested architecture:

```text
ARM7TDMI
├── Registers
├── ARM Decoder
├── Thumb Decoder
├── ALU
├── Branch Unit
├── Memory Interface
└── Interrupt/Mode Handling
```

---

# 29. GBA Memory

Create a dedicated GBA memory bus.

Conceptually:

```text
ARM7TDMI
   ↓
GBA Memory Bus
   ├── BIOS region
   ├── External Work RAM
   ├── Internal Work RAM
   ├── I/O registers
   ├── Palette RAM
   ├── VRAM
   ├── OAM
   └── Cartridge
```

Memory access timing matters for accurate emulation.

---

# 30. GBA Graphics

The GBA graphics subsystem is considerably more complex than the original Game Boy.

Support the required display modes incrementally.

Important areas:

- Background layers
- Tile maps
- Character/tile data
- Bitmap modes
- Sprites
- Object attributes
- Palettes
- Windowing
- Blending
- Affine transformations
- Scanline behavior

Do not attempt to implement every feature simultaneously.

Start with the simplest video mode and build upward.

---

# 31. GBA DMA

DMA is important for GBA software.

Implement DMA channels separately and test them thoroughly.

```text
DMA
├── Channel 0
├── Channel 1
├── Channel 2
└── Channel 3
```

Test:

- Source address
- Destination address
- Transfer length
- Address control
- Timing
- Immediate transfers
- VBlank transfers
- HBlank transfers
- Repeat behavior

---

# 32. GBA Timers

Implement the four timer channels.

Important behavior:

- Reload values
- Prescalers
- Overflow
- Cascade
- Interrupt generation
- Timing

Timers should be integrated with the central emulation scheduler.

---

# 33. GBA Audio

Implement GBA audio after CPU, memory, video, DMA, and timers are reasonably stable.

Separate:

- Direct sound channels
- FIFO behavior
- PSG-style channels
- Sound control registers
- Sample timing

Use Web Audio API for final browser output.

---

# 34. Web Worker Architecture

Once the emulator becomes heavy enough, move emulation work away from the UI thread.

Recommended structure:

```text
Main Thread
├── React UI
├── Canvas / Display
├── Controls
└── Settings

        ↕ postMessage

Emulator Worker
├── CPU
├── Memory
├── PPU
├── APU
├── Timers
├── DMA
└── Cartridge
```

Benefits:

- UI remains responsive
- Better separation of concerns
- Easier performance management
- Emulator can run independently of React rendering

Do not introduce workers before the single-threaded emulator is stable unless there is a clear reason.

---

# 35. Performance Plan

Performance should be measured instead of guessed.

Track:

- FPS
- Emulator frame time
- CPU instruction throughput
- Audio buffer health
- Worker latency
- Memory usage

Potential optimizations:

1. Reduce unnecessary object allocations.
2. Use typed arrays.
3. Avoid React re-renders during emulation.
4. Batch framebuffer updates.
5. Move core execution to a Web Worker.
6. Optimize hot CPU paths.
7. Consider WebAssembly only when profiling demonstrates a real need.

---

# 36. Frontend UX

The emulator UI should look like a professional developer/productivity application rather than a childish game page.

Suggested layout:

```text
┌──────────────────────────────────────────┐
│ WebBoy                         Settings   │
├──────────────────────────────────────────┤
│                                          │
│            ┌──────────────┐              │
│            │              │              │
│            │   DISPLAY    │              │
│            │   160x144    │              │
│            │              │              │
│            └──────────────┘              │
│                                          │
├──────────────────────────────────────────┤
│ [Load ROM] [Pause] [Reset] [Save State] │
├──────────────────────────────────────────┤
│ Controls | Save | Debug | Performance    │
└──────────────────────────────────────────┘
```

Features:

- Clean dark/light theme
- Responsive layout
- Fullscreen mode
- Clear emulator status
- ROM information panel
- Keyboard controls panel
- Mobile controls
- Save state management
- Developer tools toggle

---

# 37. Privacy Design

One of the strongest product ideas is privacy.

Marketing message:

> **Your ROM stays on your device.**

Architecture:

```text
ROM File
   ↓
Browser File API
   ↓
Memory / IndexedDB
   ↓
Emulator
   ↓
Canvas + Web Audio
```

No ROM upload is necessary.

No account is necessary.

No backend database is necessary.

---

# 38. Database Requirement

The core application does not need a database.

Use:

```text
React
TypeScript
Canvas
IndexedDB
LocalStorage
Web Worker
```

Optional backend services should only be introduced for unrelated features such as:

- Public user profiles
- Community features
- Cloud synchronization
- Shared challenge links
- Analytics

Those are not required for the emulator itself.

---

# 39. Future Features

After the core emulator is stable, consider:

- Gamepad support
- Fullscreen mode
- Screen scaling filters
- Aspect ratio options
- Custom key bindings
- Multiple save slots
- Save-state thumbnails
- `.sav` import/export
- `.state` import/export
- Screenshot capture
- Recording/replay
- Debugger
- Memory viewer
- CPU profiler
- Game library metadata stored locally
- PWA/offline support
- Installable desktop-like experience

---

# 40. Features to Avoid Initially

Do not start with:

- Multiplayer
- Online accounts
- Cloud ROM storage
- ROM downloading
- ROM sharing
- Social profiles
- Chat
- Leaderboards
- Cloud save synchronization
- Massive game databases
- Automatic commercial ROM acquisition

The first goal is emulator correctness.

---

# 41. Git Strategy

Use small, focused commits.

Examples:

```text
feat: initialize webboy project
feat: add game boy cpu registers
feat: implement ld instructions
feat: implement arithmetic instructions
feat: add game boy memory bus
feat: add rom cartridge support
feat: add mbc1 support
feat: implement game boy ppu
feat: add keyboard input
feat: add game boy timing
feat: add local save support
feat: add save states
feat: add game boy color core
feat: initialize gba core
```

Avoid giant commits such as:

```text
finished emulator
```

Small commits make debugging and rollback much easier.

---

# 42. Development Rules

1. Build one hardware subsystem at a time.
2. Write tests as each subsystem is added.
3. Keep CPU independent from frontend code.
4. Keep cartridge behavior independent from CPU behavior.
5. Keep rendering independent from React.
6. Avoid global state where possible.
7. Prefer interfaces around hardware components.
8. Use typed arrays for memory-heavy operations.
9. Profile before optimizing.
10. Do not add commercial ROMs to the repository.
11. Do not copy third-party emulator code without reviewing its license.
12. Do not use copyrighted game assets as application branding.
13. Keep the frontend and emulator core independently testable.

---

# 43. Day-by-Day Development Plan

## Day 1 — Repository Setup

- Create React + TypeScript app
- Configure Vite
- Create emulator package
- Create tests
- Create documentation
- Create basic emulator UI

## Day 2 — CPU Foundation

- Registers
- Flags
- PC
- SP
- Fetch/decode/execute loop
- CPU tests

## Day 3 — CPU Instructions

- Load instructions
- Arithmetic
- Logic
- Increment/decrement
- Jumps
- Calls/returns
- Stack

## Day 4 — Memory

- Memory bus
- ROM mapping
- RAM
- VRAM
- OAM
- HRAM
- I/O registers

## Day 5 — Cartridge

- ROM cartridge
- Header parser
- Cartridge type detection
- MBC1

## Day 6 — PPU Foundation

- VRAM
- Tile decoding
- Background
- Framebuffer
- Canvas output

## Day 7 — Input + Timing

- Keyboard
- Joypad register
- CPU timing
- PPU timing
- VBlank
- Interrupts

## Day 8 — Integration

- Load test ROM
- Run CPU
- Render frames
- Fix timing problems
- Add reset/pause

## Day 9 — Save System

- IndexedDB
- Save RAM
- Import/export save
- Save states

## Day 10 — UI Polish

- Responsive layout
- Mobile controls
- Fullscreen
- Settings
- Performance indicators

At this point, you should have a usable Game Boy emulator foundation.

---

# 44. After the First 10 Days

Continue with:

```text
Game Boy
   ↓
Compatibility improvements
   ↓
More cartridge controllers
   ↓
More test ROMs
   ↓
Game Boy Color
   ↓
GBA CPU
   ↓
GBA Memory
   ↓
GBA Video
   ↓
GBA DMA / Timers
   ↓
GBA Audio
   ↓
GBA Compatibility
```

Do not skip directly from an incomplete Game Boy CPU to Pokémon-specific testing.

---

# 45. Pokémon Compatibility Goal

The ultimate technical goal can be:

```text
User's legally obtained ROM
          ↓
      ROM Detection
          ↓
     Emulator Selection
          ↓
┌─────────────────────────┐
│ GB / GBC / GBA Core     │
└─────────────────────────┘
          ↓
      Local Emulation
          ↓
       Game Screen
```

For example:

```text
Game Boy
├── Pokémon Red
├── Pokémon Blue
└── Pokémon Yellow

Game Boy Color
├── Pokémon Gold
├── Pokémon Silver
└── Pokémon Crystal

Game Boy Advance
├── Pokémon Ruby
├── Pokémon Sapphire
├── Pokémon Emerald
├── Pokémon FireRed
└── Pokémon LeafGreen
```

These are compatibility targets, not ROMs to distribute with the project.

---

# 46. Final Product Architecture

```text
                         WebBoy
                           │
              ┌────────────┴────────────┐
              │                         │
          Web Frontend             Emulator Manager
              │                         │
       ┌──────┼──────┐                  │
       │      │      │                  │
     Canvas Controls Settings           │
              │                         │
              └────────────┬────────────┘
                           │
                ┌──────────┼──────────┐
                │          │          │
               GB         GBC        GBA
                │          │          │
              CPU        GBC CPU    ARM7TDMI
              PPU        GBC PPU    GBA Video
              APU        GBC APU    GBA Audio
             Timer      Speed       DMA
             Input      Memory      Timers
           Cartridge   Cartridge   Cartridge
                │          │          │
                └──────────┴──────────┘
                           │
                    Local Browser Data
                           │
                    IndexedDB / Memory
```

---

# 47. Recommended MVP

The first public MVP should be much smaller than the final vision.

## MVP Features

- Game Boy emulator
- Local `.gb` ROM loading
- Canvas display
- Keyboard controls
- Mobile controls
- Pause
- Reset
- Local save RAM
- Save states
- Basic ROM information
- Fullscreen
- Responsive UI

## Not in MVP

- Game Boy Color
- Game Boy Advance
- Multiplayer
- Accounts
- Cloud saves
- ROM hosting
- ROM downloads
- Social features

---

# 48. Definition of Done — Game Boy MVP

The Game Boy phase is considered complete when:

- [ ] CPU executes required instructions correctly
- [ ] CPU tests pass
- [ ] Memory bus works
- [ ] Cartridge system works
- [ ] Common MBC behavior works
- [ ] PPU renders correctly
- [ ] Timing is sufficiently accurate
- [ ] Interrupts work
- [ ] Keyboard input works
- [ ] Mobile controls work
- [ ] Audio works
- [ ] Save RAM works
- [ ] Save states work
- [ ] ROM loading is local-only
- [ ] No commercial ROMs are included in the repository
- [ ] Documentation is complete
- [ ] Test ROMs are legally usable

---

# 49. Final Vision

The long-term application should feel like a complete browser-based emulator platform rather than a single-game website.

The user experience should be:

```text
Open WebBoy
     ↓
Select ROM
     ↓
Browser detects system
     ↓
GB / GBC / GBA emulator starts
     ↓
Game runs locally
     ↓
Save data remains local
```

The final product should emphasize:

- Technical quality
- Emulator accuracy
- Privacy
- Local execution
- Professional UI
- Modular architecture
- Strong automated testing
- No unnecessary backend infrastructure

The project should begin with the simplest technically meaningful target — **Game Boy** — and grow into a modular **GB / GBC / GBA browser emulator** only after each hardware generation is understood and tested.

---

# 50. Starting Point

The first coding task should be:

> **Create the Game Boy CPU register model, memory bus interface, and opcode execution skeleton in TypeScript.**

Do not start by building the Pokémon UI.

Do not start by downloading a ROM.

Do not start with GBA.

Start with the hardware abstraction and make a legal test ROM execute correctly.

That foundation is what makes the rest of the emulator possible.
