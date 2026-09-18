import { EmulatorManager, DMG_FRAMES_PER_SECOND, SCREEN_SIZE } from '@webboy/emulator';
import { FramePacer } from './FramePacer.js';
import { InputLatch } from './input/InputLatch.js';
import { KeyboardInput } from './input/KeyboardInput.js';
import { GamepadInput } from './input/GamepadInput.js';
import { loadBindings, saveBindings, type Bindings } from './input/bindings.js';
import { SavePersistence } from './SavePersistence.js';
import { AudioOutput } from '../audio/AudioOutput.js';
import { stateStore, SLOT_COUNT, type StateSlot } from '../storage/StateStore.js';
import { cheatStore, type StoredCheat } from '../storage/CheatStore.js';
import { decodeCheat, CheatParseError, type ParsedCheat } from '@webboy/emulator';
import { DEVELOPER_KEY, PERFORMANCE_KEY, loadFlag, saveFlag } from './settings.js';

/**
 * Which system to run. 'auto' reads the cartridge header, which is right almost always.
 *
 * The override exists for the one case that genuinely needs it: a CGB-compatible cartridge
 * can also run on original Game Boy hardware, and looks entirely different doing so.
 */
export type SystemPreference = 'auto' | 'GB' | 'GBA';

const SYSTEM_KEY = 'webboy.system.v1';

function loadSystemPreference(): SystemPreference {
  try {
    const stored = localStorage.getItem(SYSTEM_KEY);
    return stored === 'GB' || stored === 'GBA' ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

/** Slot 0 doubles as the quick slot, so the transport and the panel agree. */
const QUICK_SLOT = 0;

export type SessionStatus = 'empty' | 'running' | 'paused';

export interface SessionSnapshot {
  readonly status: SessionStatus;
  readonly romName: string | null;
  readonly savesRestored: boolean;
  /** Whether the quick slot holds a state, so the Load button can disable itself. */
  readonly hasQuickState: boolean;
  /**
   * Bumped whenever a slot is written. The states panel re-reads its list on a change.
   *
   * A counter rather than a boolean because two saves to the same slot must still be two
   * events, and rather than refreshing on every notify because listing reads every slot's
   * full bytes out of IndexedDB — pause and resume should not pay for that.
   */
  readonly statesRevision: number;
  /** Emulation speed multiplier. 1 is real time. */
  readonly speed: number;
  /**
   * Whether sound output is muted.
   *
   * In the snapshot rather than in a component's `useState` because it is a property of
   * the session, like `speed`: it was local to App, so `setMuted` could change the gain
   * node while nothing else in the app could read the result or restore it.
   */
  readonly muted: boolean;
  /** Show the fps / frames / target readout under the device. Opt-in, like RetroArch's. */
  readonly showPerformance: boolean;
  /** Reveal the debugger. Off by default; the debugger is not a player-facing feature. */
  readonly developerMode: boolean;
  /** Which system the player asked for. 'auto' trusts the cartridge header. */
  readonly systemPreference: SystemPreference;
  /** Which core is actually running, once a cartridge is in. */
  readonly activeSystem: string | null;
  readonly error: string | null;
}

/**
 * Owns the emulator and the frame loop, OUTSIDE React.
 *
 * Two rules from the charter are enforced here:
 *  - The loop starts once and is never driven by a re-runnable effect.
 *  - React never re-renders during emulation: per-frame work touches only the canvas,
 *    and subscribers are notified solely on status transitions.
 */
class EmulatorSession {
  private readonly manager = new EmulatorManager();
  private readonly pacer = new FramePacer(DMG_FRAMES_PER_SECOND);
  private readonly listeners = new Set<() => void>();

  readonly input = new InputLatch();
  private readonly keyboard = new KeyboardInput(this.input);
  private readonly gamepad = new GamepadInput(this.input);
  private detachKeyboard: (() => void) | null = null;

  private readonly saves = new SavePersistence((message) => this.update({ error: message }));
  readonly audio = new AudioOutput();

  private snapshot: SessionSnapshot = {
    status: 'empty',
    romName: null,
    error: null,
    savesRestored: false,
    hasQuickState: false,
    statesRevision: 0,
    speed: 1,
    muted: false,
    showPerformance: loadFlag(PERFORMANCE_KEY),
    developerMode: loadFlag(DEVELOPER_KEY),
    systemPreference: loadSystemPreference(),
    activeSystem: null,
  };
  private rafId: number | null = null;
  /** True when the tab-hide handler paused us, so returning may resume automatically. */
  private autoPaused = false;
  /** True when the settings drawer paused us, so closing it may resume. */
  private pausedByMenu = false;
  /** Set when audio could not be woken without a gesture; the next input wakes it. */
  private audioNeedsGesture = false;
  private ctx: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;

  // Per-frame counters. Read through getters by a throttled UI; never React state.
  private frameCount = 0;
  private lastFpsSample = 0;
  private framesSinceSample = 0;
  private measuredFps = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  getMeasuredFps = (): number => this.measuredFps;
  getFrameCount = (): number => this.frameCount;
  getCartridgeInfo = () => this.manager.getCore()?.getCartridgeInfo() ?? null;

  /**
   * Attach the display. The ImageData is allocated ONCE here and its buffer is mutated
   * every frame — never reallocated, never copied.
   */
  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.ctx = null;
    this.image = null;
    if (!canvas) return;

    const { width, height } = SCREEN_SIZE.GB;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      this.update({ error: 'Could not acquire a 2D canvas context.' });
      return;
    }
    ctx.imageSmoothingEnabled = false;
    this.ctx = ctx;
    this.image = ctx.createImageData(width, height);
    this.paint();
  }

  loadRom(name: string, data: Uint8Array): void {
    // Flush the outgoing game's save before swapping cartridges.
    const previous = this.manager.getCore();
    if (previous) void this.saves.flush(previous);

    try {
      const preference = this.snapshot.systemPreference;
      this.manager.loadRom(data, preference === 'auto' ? undefined : preference);

      // Say so when the override disagrees with the cartridge, rather than silently
      // honouring it: "I picked Advance and my Game Boy game broke" must not be a mystery.
      const detected = this.manager.getDetectedSystem();
      const active = this.manager.getActiveSystem();
      const mismatch =
        preference !== 'auto' && detected !== null && detected !== active
          ? `This cartridge reports ${detected}, but you chose ${preference === 'GB' ? 'Game Boy' : 'Game Boy Advance'}. Switch to Auto if it misbehaves.`
          : null;
      this.frameCount = 0;
      this.pacer.reset();
      this.update({
        status: 'running',
        romName: name,
        error: mismatch,
        activeSystem: this.manager.getActiveSystem(),
      });
      void this.refreshQuickState();
      void this.restoreCheats();
      void this.restoreSave();
      // Loading a ROM is a user gesture, which is the only moment a browser will let an
      // AudioContext start.
      void this.startAudio();
      this.start();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.update({ status: 'empty', romName: null, error: `Could not load ROM: ${message}` });
    }
  }

  /**
   * Restores the battery save, keyed by CARTRIDGE IDENTITY rather than filename, so the
   * same game from a different dump resolves to the same save and two different games
   * never collide.
   */
  private async restoreSave(): Promise<void> {
    const core = this.manager.getCore();
    const info = core?.getCartridgeInfo();
    if (!core || !info) return;
    const restored = await this.saves.attach(core, info.saveKey, info.title);
    if (restored) this.update({ savesRestored: true });
  }

  /* --------------------------------- debugger --------------------------------- */

  getInspector() {
    return this.manager.getCore()?.getInspector() ?? null;
  }

  stepInstruction(): void {
    this.manager.stepInstruction();
    this.paint();
  }

  stepFrame(): void {
    this.manager.runFrame();
    this.paint();
  }

  toggleBreakpoint(address: number): void {
    if (this.breakpoints.has(address)) this.breakpoints.delete(address);
    else this.breakpoints.add(address);
  }

  listBreakpoints(): number[] {
    return [...this.breakpoints].sort((a, b) => a - b);
  }

  private readonly breakpoints = new Set<number>();

  /* --------------------------------- display --------------------------------- */

  /** Enters or leaves fullscreen on the given element. */
  async toggleFullscreen(element: HTMLElement): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await element.requestFullscreen({ navigationUI: 'hide' });
    } catch (cause) {
      this.update({
        error: `Fullscreen is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  /* -------------------------------- save states ------------------------------- */

  /** Captures a small PNG of the current screen, for the slot list. */
  private captureThumbnail(): string | null {
    const core = this.manager.getCore();
    if (!core) return null;
    try {
      const { width, height } = SCREEN_SIZE.GB;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const image = ctx.createImageData(width, height);
      image.data.set(core.getFrameBuffer());
      ctx.putImageData(image, 0, 0);
      return canvas.toDataURL('image/png');
    } catch {
      // A thumbnail is decoration; never let it block the save itself.
      return null;
    }
  }

  async saveStateToSlot(slot: number): Promise<void> {
    const core = this.manager.getCore();
    const info = core?.getCartridgeInfo();
    if (!core || !info) return;
    try {
      const data = new Uint8Array(core.serialize());
      await stateStore.save(info.saveKey, slot, data, this.captureThumbnail());
      this.update({ error: null, statesRevision: this.snapshot.statesRevision + 1 });
    } catch (cause) {
      this.update({
        error: `Could not save state ${slot + 1}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  async loadStateFromSlot(slot: number): Promise<void> {
    const core = this.manager.getCore();
    const info = core?.getCartridgeInfo();
    if (!core || !info) return;
    try {
      const record = await stateStore.load(info.saveKey, slot);
      if (!record) {
        this.update({ error: `Slot ${slot + 1} is empty.` });
        return;
      }
      const bytes = new Uint8Array(record.data);
      core.deserialize(bytes.buffer.slice(0) as ArrayBuffer);
      this.pacer.reset();
      this.paint();
      this.update({ error: null });
    } catch (cause) {
      this.update({
        error: `Could not load state ${slot + 1}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  /**
   * The quick slot is slot 0 — the same one the States panel shows first.
   *
   * Save states existed for a while with no way to reach them except a tab below the
   * fold, which is how a player concludes the feature is missing. Quick save and load
   * belong next to Pause, where the hand already is; the panel keeps the full set with
   * thumbnails for when you want to choose.
   */
  async quickSave(): Promise<void> {
    await this.saveStateToSlot(QUICK_SLOT);
    await this.refreshQuickState();
  }

  async quickLoad(): Promise<void> {
    await this.loadStateFromSlot(QUICK_SLOT);
  }

  /** Cheap: one indexed read, and only on load/save, never per frame. */
  async refreshQuickState(): Promise<void> {
    const info = this.manager.getCore()?.getCartridgeInfo();
    if (!info) {
      this.update({ hasQuickState: false });
      return;
    }
    const record = await stateStore.load(info.saveKey, QUICK_SLOT).catch(() => null);
    this.update({ hasQuickState: record !== null });
  }

  /* ---------------------------------- cheats --------------------------------- */

  private cheats: StoredCheat[] = [];

  listCheats(): readonly StoredCheat[] {
    return this.cheats;
  }

  /**
   * Parses a code and adds it, enabled.
   *
   * Returns the error message rather than throwing: this is driven by a text field, and
   * "that is not a code" is an ordinary outcome of typing, not an exceptional one.
   */
  async addCheat(code: string, label: string): Promise<string | null> {
    try {
      decodeCheat(code); // validate now, so a bad code never reaches storage
    } catch (cause) {
      return cause instanceof CheatParseError ? cause.message : String(cause);
    }

    this.cheats = [
      ...this.cheats,
      {
        id: `${Date.now().toString(36)}-${this.cheats.length}`,
        label: label.trim() || 'Unnamed code',
        code: code.trim().toUpperCase(),
        enabled: true,
        createdAt: Date.now(),
      },
    ];
    await this.persistCheats();
    return null;
  }

  async setCheatEnabled(id: string, enabled: boolean): Promise<void> {
    this.cheats = this.cheats.map((cheat) => (cheat.id === id ? { ...cheat, enabled } : cheat));
    await this.persistCheats();
  }

  async removeCheat(id: string): Promise<void> {
    this.cheats = this.cheats.filter((cheat) => cheat.id !== id);
    await this.persistCheats();
  }

  /**
   * Pushes the whole active set to the core in ONE call.
   *
   * Deliberately not add/remove: when the core moves to a Web Worker this becomes a single
   * message with no ordering to get wrong.
   */
  private applyCheats(): void {
    const core = this.manager.getCore();
    if (!core || !('mmu' in core)) return;

    const parsed: ParsedCheat[] = [];
    for (const cheat of this.cheats) {
      if (!cheat.enabled) continue;
      try {
        parsed.push(decodeCheat(cheat.code));
      } catch {
        // A stored code that no longer parses is skipped rather than fatal — the list is
        // the player's, and refusing to run the game over one bad row would be worse.
      }
    }
    (
      core as { mmu: { cheats: { setCheats(list: readonly ParsedCheat[]): void } } }
    ).mmu.cheats.setCheats(parsed);
    this.notify();
  }

  private async persistCheats(): Promise<void> {
    this.applyCheats();
    const info = this.manager.getCore()?.getCartridgeInfo();
    if (!info) return;
    try {
      await cheatStore.save(info.saveKey, info.title, this.cheats);
    } catch (cause) {
      this.update({
        error: `Could not save cheats: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  private async restoreCheats(): Promise<void> {
    const info = this.manager.getCore()?.getCartridgeInfo();
    if (!info) return;
    this.cheats = [...(await cheatStore.list(info.saveKey).catch(() => []))];
    this.applyCheats();
  }

  async listStateSlots(): Promise<(StateSlot | null)[]> {
    const info = this.manager.getCore()?.getCartridgeInfo();
    if (!info) return new Array<null>(SLOT_COUNT).fill(null);
    return stateStore.list(info.saveKey).catch(() => new Array<null>(SLOT_COUNT).fill(null));
  }

  /** The current state as a downloadable `.state` payload. */
  exportState(): { data: Uint8Array; filename: string } | null {
    const core = this.manager.getCore();
    if (!core) return null;
    try {
      const title = core.getCartridgeInfo()?.title || 'webboy';
      return { data: new Uint8Array(core.serialize()), filename: `${title.toLowerCase()}.state` };
    } catch {
      return null;
    }
  }

  importState(data: Uint8Array): void {
    const core = this.manager.getCore();
    if (!core) return;
    try {
      core.deserialize(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      );
      this.pacer.reset();
      this.paint();
      this.update({ error: null });
    } catch (cause) {
      this.update({
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /* ---------------------------------- audio ---------------------------------- */

  /**
   * Wakes a suspended AudioContext.
   *
   * Hiding the tab suspends it, and a suspended context can only be resumed by a USER
   * GESTURE. When this runs from a click that is satisfied; when it runs from the
   * visibility handler it is not, so a failure is recorded rather than reported and the
   * next key or tap wakes it. Raising an error banner on every tab switch would be noise.
   */
  private wakeAudio(): void {
    void this.audio
      .start()
      .then(() => {
        this.audioNeedsGesture = false;
      })
      .catch(() => {
        this.audioNeedsGesture = true;
      });
  }

  /** Called from the first input after a gesture-less resume. Cheap and idempotent. */
  private wakeAudioOnGesture = (): void => {
    if (!this.audioNeedsGesture) return;
    this.audioNeedsGesture = false;
    void this.audio.start().catch(() => undefined);
  };

  private async startAudio(): Promise<void> {
    try {
      await this.audio.start();
      this.manager.setAudioSink(this.audio.sampleRate / this.pacer.speed, (left, right) =>
        this.audio.push(left, right),
      );
    } catch (cause) {
      // Audio is a nicety; the game must still be playable without it.
      this.update({
        error: `Sound is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  /**
   * Runs the game faster or slower than real time.
   *
   * The audio output rate is rescaled by the same factor. Without that, running at 2x
   * produces samples twice as fast as the device drains them, the ring buffer overflows
   * and pushes are dropped — audible as constant crackle. Rescaling keeps the buffer
   * balanced and shifts the pitch instead, which is what fast-forward has always sounded
   * like and is the honest signal that the game is not running at normal speed.
   */
  setSpeed(multiplier: number): void {
    this.pacer.setSpeed(multiplier);
    const speed = this.pacer.speed;
    this.manager.setAudioSink(this.audio.sampleRate / speed, (left, right) =>
      this.audio.push(left, right),
    );
    this.update({ speed });
  }

  setSystemPreference(preference: SystemPreference): void {
    try {
      localStorage.setItem(SYSTEM_KEY, preference);
    } catch {
      // A remembered preference is a convenience, never a requirement.
    }
    this.update({ systemPreference: preference });
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
    this.update({ muted });
  }

  /**
   * The performance readout and the debugger, both off by default.
   *
   * They live here rather than in component state for the same reason the speed does:
   * they are session-wide, they persist across a reload, and the settings drawer that
   * changes them is not the only thing that reads them.
   */
  setShowPerformance(showPerformance: boolean): void {
    saveFlag(PERFORMANCE_KEY, showPerformance);
    this.update({ showPerformance });
  }

  setDeveloperMode(developerMode: boolean): void {
    saveFlag(DEVELOPER_KEY, developerMode);
    this.update({ developerMode });
  }

  getAudioStats() {
    return this.audio.stats();
  }

  /** Surface a user-facing problem (bad file, unreadable ROM) without touching emulation. */
  reportError(message: string): void {
    this.update({ error: message });
  }

  /* ------------------------------ battery saves ------------------------------ */

  /** Writes the battery save immediately. Safe to call at any time. */
  flushSave(): void {
    const core = this.manager.getCore();
    if (core) void this.saves.flush(core);
  }

  /** The current save as a `.sav` payload, or null when the cartridge has no battery. */
  exportSave(): { data: Uint8Array; filename: string } | null {
    const core = this.manager.getCore();
    const data = core?.getSaveData();
    if (!core || !data) return null;
    const title = core.getCartridgeInfo()?.title || 'webboy';
    return { data: new Uint8Array(data), filename: `${title.toLowerCase()}.sav` };
  }

  /** Replaces the battery save from an imported `.sav`, then persists it. */
  importSave(data: Uint8Array): void {
    const core = this.manager.getCore();
    if (!core) return;
    if (!core.hasBatterySave()) {
      this.update({ error: 'This cartridge has no battery, so there is no save to import.' });
      return;
    }
    core.loadSaveData(data);
    void this.saves.flush(core);
    this.update({ error: null, savesRestored: true });
  }

  /* ---------------------------------- input ---------------------------------- */

  /** Starts listening for keyboard input. Returns a teardown function. */
  attachInput(): () => void {
    this.keyboard.setBindings(loadBindings());
    this.detachKeyboard = this.keyboard.attach();

    // Returning to the tab resumes the game without a gesture, so the AudioContext may
    // refuse to wake. These are the cheapest possible listeners — they bail on the first
    // line unless audio is actually waiting — and they are what gets sound back for a
    // player who resumes with the keyboard and never touches a button.
    window.addEventListener('pointerdown', this.wakeAudioOnGesture, { passive: true });
    window.addEventListener('keydown', this.wakeAudioOnGesture, { passive: true });

    return () => {
      this.detachKeyboard?.();
      this.detachKeyboard = null;
      window.removeEventListener('pointerdown', this.wakeAudioOnGesture);
      window.removeEventListener('keydown', this.wakeAudioOnGesture);
    };
  }

  /**
   * Stops player input reaching the game, for the duration of a binding capture.
   *
   * Every source, not just the keyboard: a rebind should not be interrupted by a thumb on
   * the on-screen pad or a resting gamepad stick.
   */
  setInputSuppressed(suppressed: boolean): void {
    this.keyboard.setSuppressed(suppressed);
    this.input.releaseAll();
    this.gamepad.releaseAll();
  }

  getBindings(): Bindings {
    return this.keyboard.getBindings();
  }

  setBindings(bindings: Bindings): void {
    this.keyboard.setBindings(bindings);
    saveBindings(bindings);
    this.update({});
  }

  pause(): void {
    if (this.snapshot.status !== 'running') return;
    this.manager.pause();
    this.stop();
    this.flushSave();
    // Otherwise a button held when the player hit Pause is still held on resume. The
    // gamepad needs telling separately: it keeps its own shadow set, and without this a
    // pad button held across a pause is seen as still-down afterwards, so no press is
    // ever emitted and that button is dead until released and pressed again.
    this.input.releaseAll();
    this.gamepad.releaseAll();
    this.manager.setInput(0);
    this.update({ status: 'paused' });
  }

  resume(): void {
    if (this.snapshot.status !== 'paused') return;

    this.wakeAudio();

    this.manager.resume();
    this.pacer.reset();
    this.update({ status: 'running' });
    this.start();
  }

  reset(): void {
    if (!this.manager.hasRom()) return;
    this.manager.reset();
    this.frameCount = 0;
    this.pacer.reset();
    this.paint();
  }

  /**
   * Pause while the settings drawer is open, and resume on close.
   *
   * Every emulator this was checked against pauses when its menu opens — RetroArch's
   * Quick Menu, Delta's pause menu, mGBA. Without it the game runs on behind the drawer,
   * and the arrow keys used to read the menu also drive the character.
   *
   * Kept out of the component because "resume only if WE paused" is a rule with a state
   * machine behind it, and the same rule already exists for tab switching below.
   */
  menuOpened(): void {
    this.pausedByMenu = this.snapshot.status === 'running';
    if (this.pausedByMenu) this.pause();
  }

  /** A game already paused before the drawer opened stays paused after it closes. */
  menuClosed(): void {
    if (!this.pausedByMenu) return;
    this.pausedByMenu = false;
    this.resume();
  }

  /** Pause on hide; on return, drop accumulated time rather than running a catch-up burst. */
  handleVisibilityChange(hidden: boolean): void {
    if (hidden) {
      // A key held when the tab is hidden never delivers its keyup.
      this.input.releaseAll();
      this.gamepad.releaseAll();
      this.flushSave();
      void this.audio.suspend();

      if (this.snapshot.status === 'running') {
        this.stop();
        this.manager.pause();
        this.autoPaused = true;
        this.update({ status: 'paused' });
      }
      return;
    }

    this.pacer.reset();

    // Coming back to a frozen picture with no sound and no explanation reads as a crash —
    // it is the single most common complaint about this app. If WE paused on hide, undo it.
    // A pause the player asked for is left alone.
    if (this.autoPaused) {
      this.autoPaused = false;
      this.resume();
    }
  }

  private start(): void {
    if (this.rafId !== null) return;
    this.pacer.reset();
    this.lastFpsSample = performance.now();
    this.framesSinceSample = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.rafId === null) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private readonly tick = (now: number): void => {
    this.rafId = requestAnimationFrame(this.tick);

    // The Gamepad API is poll-based, and the browser cannot produce new data within one
    // animation frame — so polling once per tick is both correct and enough. Inside the
    // catch-up loop it ran up to four times after any hitch, allocating an array each time
    // for data that could not have changed.
    this.gamepad.poll();

    const frames = this.pacer.advance(now);
    for (let i = 0; i < frames; i++) {
      // Sample as late as possible before the frame runs, and once PER frame: each
      // emulated frame has to consume its own sticky bits. Latency is a feature.
      this.manager.setInput(this.input.sample());
      this.manager.runFrame();
      this.frameCount++;
      this.framesSinceSample++;
    }
    if (frames > 0) {
      this.paint();
      const core = this.manager.getCore();
      if (core) this.saves.poll(core);
    }

    // FPS is sampled ~4Hz and read through a getter. It is never React state.
    const elapsed = now - this.lastFpsSample;
    if (elapsed >= 250) {
      this.measuredFps = (this.framesSinceSample * 1000) / elapsed;
      this.framesSinceSample = 0;
      this.lastFpsSample = now;
    }
  };

  private paint(): void {
    const core = this.manager.getCore();
    if (!core || !this.ctx || !this.image) return;
    this.image.data.set(core.getFrameBuffer());
    this.ctx.putImageData(this.image, 0, 0);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** One session per page. Module-level so no React lifecycle can create a second loop. */
export const session = new EmulatorSession();
