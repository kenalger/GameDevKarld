# Phase 00 — Foundation

**Owner:** `webboy-frontend-engineer` · **Supporting:** `emu-accuracy-tester` (harness), `gb-memory-engineer` (interfaces)
**Depends on:** nothing · **Roadmap:** §6 Repository Structure, §7 Phase 0, §2 Legal
**Status:** ✅ Complete — 2026-09-15. All exit-gate checks green; see tests/scoreboard.md.

## Goal

A repo that builds, tests, lints, and renders a canvas — plus a headless test harness — before a
single line of hardware emulation exists.

## Why first

The harness is the thing every later phase is graded by. Building it after the CPU means the CPU gets
written without feedback, which is how emulators end up with a rewrite in week three.

## Tasks

**Scaffold** — `webboy-frontend-engineer`
- [ ] Monorepo per roadmap §6: `apps/web` (React+TS+Vite), `packages/emulator`, `tests/`, `docs/`.
- [ ] TypeScript **strict**, `noUncheckedIndexedAccess`, no `any`. ESLint + Prettier.
- [ ] Vitest configured for both packages. `npm test` runs everything.
- [ ] CI: install → lint → typecheck → test on every push.

**Core interfaces** — `gb-memory-engineer` + `gb-cpu-engineer` agree on these before anyone codes
- [ ] `EmulatorCore` exactly as roadmap §7: `reset/runFrame/pause/resume/loadRom/getFrameBuffer`.
- [ ] `MemoryBus` (`read`/`write`), `Cartridge` (`read`/`write`/`load`).
- [ ] `EmulatorManager` skeleton — detects system, selects core, owns the frame loop. Stub cores.
- [ ] An **inspection interface** for the debugger to read state without mutating it. Design it now,
      even empty; bolting it on later means touching every subsystem.

**Display + ROM in** — `webboy-frontend-engineer`
- [ ] 160×144 backing canvas, `ImageData` allocated once, CSS-scaled, `image-rendering: pixelated`,
      `imageSmoothingEnabled = false`. Render a test pattern to prove the path.
- [ ] File picker + drag-and-drop → `ArrayBuffer` → `Uint8Array`. **No upload, no fetch.**
- [ ] rAF frame loop with a time accumulator, started once, living outside React state.

**Harness** — `emu-accuracy-tester`
- [ ] Headless runner: load ROM → run N frames → assert. No canvas, no React.
- [ ] Stop conditions: Mooneye `LD B,B` + Fibonacci registers; Blargg serial capture; screenshot
      diff vs reference PNG; frame-budget timeout (a hang is a failure).
- [ ] `scripts/fetch-test-roms.sh` — pulls a pinned tag of `c-sp/game-boy-test-roms`, checksums it,
      into a **gitignored** directory.
- [ ] Scoreboard generator (markdown + JSON), committed. Everything red is fine today.

**Legal + docs** — `webboy-frontend-engineer`
- [ ] README with the disclaimer; the same disclaimer **visible in the UI**, not just the README.
- [ ] `docs/legal.md`, LICENSE, `docs/architecture.md`.
- [ ] `.gitignore` covers `*.gb`, `*.gbc`, `*.gba`, `*.sav`, `*.state`, and the test-ROM directory.

## Exit gate — `emu-accuracy-tester` + `webboy-app-qa`

- [ ] `npm run build`, `lint`, `typecheck`, `test` all pass in CI from a clean clone.
- [ ] Harness loads a ROM file and runs frames against a stub core without a browser.
- [ ] Test-ROM fetch script works; no ROM is tracked by git (`git ls-files | grep -iE '\.gb[ac]?$'` empty).
- [ ] Canvas shows a crisp, unblurred test pattern at 1×, 2× and 3×.
- [ ] Picking a file produces the right byte length in memory with **zero network requests** (verified
      by `webboy-app-qa` with a network log, not a code read).

## Traps

- Do not let React own the frame loop via `useEffect` — it will re-run and start two loops.
- Do not skip the inspection interface. Retrofitting it is the single most annoying refactor here.
- Pin the test-ROM release tag. An unpinned corpus makes yesterday's scoreboard meaningless.

## Out of scope

Header parsing (02), any real hardware (01+), audio (07), worker (10).
