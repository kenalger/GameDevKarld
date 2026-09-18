import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A minimal valid cartridge, built here rather than imported from tests/harness so this
 * file stays inside the app's tsconfig rootDir.
 */
function syntheticRom(): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom[0x0147] = 0x00; // ROM ONLY
  rom[0x0148] = 0x00; // 32 KB
  rom[0x0149] = 0x00; // no RAM
  // Header checksum over 0x0134-0x014C, or the loader rejects the cartridge.
  let checksum = 0;
  for (let i = 0x0134; i <= 0x014c; i++) checksum = (checksum - rom[i]! - 1) & 0xff;
  rom[0x014d] = checksum;
  return rom;
}

/**
 * The tab-switch round trip, driven by a fake clock.
 *
 * This exists because of a real bug report: "if i move tabs or exit the browser and play
 * again to continue, i can no longer click or continue to the game". Two things were
 * wrong, and neither threw, so the console was clean and the app just looked dead:
 *
 *   1. Hiding the tab suspended the AudioContext and NOTHING ever resumed it, so sound was
 *      gone for the rest of the session.
 *   2. Hiding the tab paused the emulator and nothing ever un-paused it, so returning left
 *      the player staring at a frozen frame with no indication why.
 */

let now = 0;
const queue: ((time: number) => void)[] = [];
let audioState = 'suspended';
/** Button 0 of a fake standard gamepad. Flip to drive the gamepad path. */
let padButton0 = false;
const fakePads = [
  {
    mapping: 'standard',
    // A getter, not a value: the array is built once, so a plain boolean would freeze
    // whatever padButton0 was at module load.
    buttons: Array.from({ length: 17 }, (_, i) => ({
      get pressed() {
        return i === 0 && padButton0;
      },
    })),
    axes: [0, 0, 0, 0],
  },
];

/** Runs one animation frame, 16.7ms later. */
function frame(): void {
  now += 16.7;
  for (const callback of queue.splice(0, queue.length)) callback(now);
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g['requestAnimationFrame'] = (cb: (t: number) => void): number => queue.push(cb);
  g['cancelAnimationFrame'] = (): void => {
    queue.length = 0;
  };
  g['performance'] = { now: () => now };
  g['localStorage'] = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  g['window'] = { addEventListener: () => undefined, removeEventListener: () => undefined };
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => fakePads },
    configurable: true,
  });
  g['AudioContext'] = class {
    readonly sampleRate = 48000;
    get state(): string {
      return audioState;
    }
    async resume(): Promise<void> {
      audioState = 'running';
    }
    async suspend(): Promise<void> {
      audioState = 'suspended';
    }
    get audioWorklet(): { addModule: () => Promise<void> } {
      return { addModule: async () => undefined };
    }
    createGain(): unknown {
      return {
        gain: { value: 0 },
        connect() {
          return this;
        },
      };
    }
    get destination(): unknown {
      return {};
    }
  };
  g['AudioWorkletNode'] = class {
    readonly port = { onmessage: null, postMessage: () => undefined };
    connect(): unknown {
      return this;
    }
  };
});

afterAll(() => {
  queue.length = 0;
});

describe('tab switching', () => {
  it('RESUMES ON ITS OWN when the tab comes back, without a button press', async () => {
    const { session } = await import('./EmulatorSession.js');
    await session.loadRom('test.gb', syntheticRom());
    for (let i = 0; i < 10; i++) frame();
    expect(session.getSnapshot().status).toBe('running');

    session.handleVisibilityChange(true);
    expect(session.getSnapshot().status).toBe('paused');

    now += 5000; // away for a while
    session.handleVisibilityChange(false);

    // No Resume click: coming back to a frozen picture reads as a crash.
    expect(session.getSnapshot().status).toBe('running');
    const before = session.getFrameCount();
    for (let i = 0; i < 20; i++) frame();
    expect(session.getFrameCount()).toBeGreaterThan(before);
  });

  it('WAKES THE AUDIO CONTEXT, which a hidden tab suspends', async () => {
    const { session } = await import('./EmulatorSession.js');
    await session.loadRom('test.gb', syntheticRom());
    for (let i = 0; i < 5; i++) frame();
    expect(audioState).toBe('running');

    session.handleVisibilityChange(true);
    expect(audioState).toBe('suspended');

    session.handleVisibilityChange(false);
    await Promise.resolve(); // the wake is a promise chain
    await Promise.resolve();
    expect(audioState).toBe('running');
  });

  /**
   * GamepadInput keeps its own shadow set of held buttons and only emits a press on a
   * false->true edge. pause() cleared the latch but not that set, so a button held across
   * a pause looked like it was still down afterwards, no press was ever emitted, and it
   * stayed dead until the player let go and pressed again.
   */
  it('REVIVES A PAD BUTTON HELD ACROSS A PAUSE', async () => {
    const { session } = await import('./EmulatorSession.js');
    const { buttonBit } = await import('@webboy/emulator');
    await session.loadRom('test.gb', syntheticRom());

    padButton0 = true; // and never released
    for (let i = 0; i < 3; i++) frame();
    expect(session.input.peek() & buttonBit('a')).toBeTruthy();

    session.pause();
    session.resume();
    for (let i = 0; i < 3; i++) frame();

    expect(session.input.peek() & buttonBit('a')).toBeTruthy();
    padButton0 = false;
    for (let i = 0; i < 3; i++) frame();
  });

  it('LEAVES A MANUAL PAUSE ALONE — only an automatic one is undone', async () => {
    const { session } = await import('./EmulatorSession.js');
    await session.loadRom('test.gb', syntheticRom());
    for (let i = 0; i < 5; i++) frame();

    session.pause();
    expect(session.getSnapshot().status).toBe('paused');

    session.handleVisibilityChange(true);
    session.handleVisibilityChange(false);

    // Resuming a game the player deliberately paused would be its own bug.
    expect(session.getSnapshot().status).toBe('paused');
  });
});

/**
 * Session-wide switches belong in the snapshot, not in a component's useState.
 *
 * `muted` used to live in App.tsx while `setMuted` only touched the gain node, so nothing
 * else in the app could read it, show it or restore it — the settings drawer and the
 * control bar could not have agreed on the state even if both had shown it.
 */
describe('session settings', () => {
  it('PUTS MUTE IN THE SNAPSHOT and notifies subscribers', async () => {
    const { session } = await import('./EmulatorSession.js');
    expect(session.getSnapshot().muted).toBe(false);

    let notified = 0;
    const unsubscribe = session.subscribe(() => {
      notified += 1;
    });

    session.setMuted(true);
    expect(session.getSnapshot().muted).toBe(true);
    expect(notified).toBeGreaterThan(0);

    session.setMuted(false);
    expect(session.getSnapshot().muted).toBe(false);
    unsubscribe();
  });

  it('keeps the performance readout and developer mode OFF by default', async () => {
    const { session } = await import('./EmulatorSession.js');
    // Nothing was ever stored (the fake localStorage returns null for everything), and
    // both of these are opt-in — RetroArch ships `DEFAULT_FPS_SHOW false` for the same
    // reason, and a debugger is not a player-facing feature.
    expect(session.getSnapshot().showPerformance).toBe(false);
    expect(session.getSnapshot().developerMode).toBe(false);

    session.setDeveloperMode(true);
    expect(session.getSnapshot().developerMode).toBe(true);
    session.setShowPerformance(true);
    expect(session.getSnapshot().showPerformance).toBe(true);

    session.setDeveloperMode(false);
    session.setShowPerformance(false);
    expect(session.getSnapshot().developerMode).toBe(false);
    expect(session.getSnapshot().showPerformance).toBe(false);
  });

  /** It had exactly one call site, inside the pre-cartridge block, so it was unreachable. */
  it('lets the system preference change AFTER a cartridge is loaded', async () => {
    const { session } = await import('./EmulatorSession.js');
    await session.loadRom('test.gb', syntheticRom());
    expect(session.getSnapshot().status).not.toBe('empty');

    session.setSystemPreference('GB');
    expect(session.getSnapshot().systemPreference).toBe('GB');
    session.setSystemPreference('auto');
    expect(session.getSnapshot().systemPreference).toBe('auto');
  });
});

describe('the settings drawer pauses', () => {
  it('PAUSES WHILE THE MENU IS OPEN, so the keys you read it with do not drive the game', async () => {
    const { session } = await import('./EmulatorSession.js');
    await session.loadRom('test.gb', syntheticRom());
    for (let i = 0; i < 10; i++) frame();
    expect(session.getSnapshot().status).toBe('running');

    session.menuOpened();
    expect(session.getSnapshot().status).toBe('paused');

    // And it really is stopped, not merely labelled as stopped.
    const before = session.getFrameCount();
    for (let i = 0; i < 20; i++) frame();
    expect(session.getFrameCount()).toBe(before);

    session.menuClosed();
    expect(session.getSnapshot().status).toBe('running');
    for (let i = 0; i < 20; i++) frame();
    expect(session.getFrameCount()).toBeGreaterThan(before);
  });

  it('LEAVES AN ALREADY-PAUSED GAME PAUSED after the menu closes', async () => {
    const { session } = await import('./EmulatorSession.js');
    await session.loadRom('test.gb', syntheticRom());
    for (let i = 0; i < 10; i++) frame();

    session.pause();
    expect(session.getSnapshot().status).toBe('paused');

    session.menuOpened();
    session.menuClosed();

    // Closing settings must not start a game the player deliberately stopped.
    expect(session.getSnapshot().status).toBe('paused');
  });

  it('does not resume a game that was never running when the menu opened', async () => {
    const { session } = await import('./EmulatorSession.js');
    session.menuOpened();
    session.menuClosed();
    expect(session.getSnapshot().status).not.toBe('running');
  });
});
