import { EmulatorManager, DMG_FRAMES_PER_SECOND, SCREEN_SIZE } from '@webboy/emulator';
import { FramePacer } from './FramePacer.js';
import { InputLatch } from './input/InputLatch.js';
import { KeyboardInput } from './input/KeyboardInput.js';
import { GamepadInput } from './input/GamepadInput.js';
import { loadBindings, saveBindings, type Bindings } from './input/bindings.js';
import { SavePersistence } from './SavePersistence.js';
import { AudioOutput } from '../audio/AudioOutput.js';
import { stateStore, SLOT_COUNT, type StateSlot } from '../storage/StateStore.js';

export type SessionStatus = 'empty' | 'running' | 'paused';

export interface SessionSnapshot {
  readonly status: SessionStatus;
  readonly romName: string | null;
  readonly savesRestored: boolean;
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
  };
  private rafId: number | null = null;
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
      this.manager.loadRom(data);
      this.frameCount = 0;
      this.pacer.reset();
      this.update({ status: 'running', romName: name, error: null });
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
      this.update({ error: null });
      this.notify();
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

  private async startAudio(): Promise<void> {
    try {
      await this.audio.start();
      this.manager.setAudioSink(this.audio.sampleRate, (left, right) =>
        this.audio.push(left, right),
      );
    } catch (cause) {
      // Audio is a nicety; the game must still be playable without it.
      this.update({
        error: `Sound is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
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
    return () => {
      this.detachKeyboard?.();
      this.detachKeyboard = null;
    };
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
    // Otherwise a button held when the player hit Pause is still held on resume.
    this.input.releaseAll();
    this.manager.setInput(0);
    this.update({ status: 'paused' });
  }

  resume(): void {
    if (this.snapshot.status !== 'paused') return;
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

  /** Pause on hide; on return, drop accumulated time rather than running a catch-up burst. */
  handleVisibilityChange(hidden: boolean): void {
    // A key held when the tab is hidden never delivers its keyup.
    if (hidden) {
      this.input.releaseAll();
      this.gamepad.releaseAll();
    }
    if (hidden) this.flushSave();
    if (hidden) void this.audio.suspend();
    if (hidden) {
      if (this.snapshot.status === 'running') {
        this.stop();
        this.manager.pause();
        this.update({ status: 'paused' });
      }
    } else {
      this.pacer.reset();
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

    const frames = this.pacer.advance(now);
    for (let i = 0; i < frames; i++) {
      // The Gamepad API is poll-based: read it here, inside the loop, then sample as late
      // as possible before the frame runs. Latency is a feature — never buffer input.
      this.gamepad.poll();
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
