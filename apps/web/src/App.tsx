import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { session } from './emulator/EmulatorSession.js';
import { downloadBytes } from './util/download.js';
import { Display } from './components/Display.js';
import { RomPicker } from './components/RomPicker.js';
import { StatusBar } from './components/StatusBar.js';
import { Disclaimer } from './components/Disclaimer.js';
import { TouchControls } from './components/TouchControls.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { KeyLegend } from './components/KeyLegend.js';
import { SettingsDrawer } from './components/SettingsDrawer.js';

export function App(): React.JSX.Element {
  // Status changes rarely (load / pause / resume / error), so it may live in a store.
  // Nothing that changes per frame is allowed through here.
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onVisibility = (): void => session.handleVisibilityChange(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    const detachInput = session.attachInput();
    // Not beforeunload: mobile Safari often backgrounds a tab without firing it, which is
    // exactly when a player expects their save to survive.
    const onPageHide = (): void => session.flushSave();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      detachInput();
    };
  }, []);

  const handleLoad = useCallback((name: string, data: Uint8Array) => {
    session.loadRom(name, data);
  }, []);

  const handleError = useCallback((message: string) => {
    session.reportError(message);
  }, []);

  const exportState = useCallback(() => {
    const state = session.exportState();
    if (state) downloadBytes(state.data, state.filename);
  }, []);

  const loaded = snapshot.status !== 'empty';
  const running = snapshot.status === 'running';

  return (
    <div className="app" ref={appRef}>
      <header className="header">
        <h1>WebBoy</h1>
        <span className="tagline">Your ROM never leaves this device</span>
      </header>

      {snapshot.error && (
        <p className="error" role="alert">
          {snapshot.error}
        </p>
      )}

      <ErrorBoundary onExportState={exportState}>
        <RomPicker onLoad={handleLoad} onError={handleError}>
          <div className="body">
            <div className="plate">
              <span className="lamp" data-running={snapshot.status === 'running'} aria-hidden />
              <span>
                {snapshot.status === 'running' ? 'Running' : loaded ? 'Paused' : 'No cartridge'}
              </span>
              {snapshot.romName && <span className="rom-name">{snapshot.romName}</span>}
            </div>
            <div className="stage">
              <Display romName={snapshot.romName} />
            </div>
            {/* Inside the plastic: the pad is hardware. The transport below is not. */}
            {loaded && <TouchControls />}
          </div>
        </RomPicker>
      </ErrorBoundary>

      {!loaded && (
        <div className="empty-state">
          <strong>Choose a system</strong>
          <p>
            The cartridge header says which system it needs, so Auto is right almost always. Pick a
            system to run a Game Boy Color cartridge in original Game Boy mode, which many support
            and which looks entirely different.
          </p>
          <div className="system-picker" role="radiogroup" aria-label="System">
            {(
              [
                ['auto', 'Auto', 'Read it from the cartridge'],
                ['GB', 'Game Boy', 'Original and Color'],
                ['GBA', 'Game Boy Advance', '32-bit, 240×160'],
              ] as const
            ).map(([value, title, note]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={snapshot.systemPreference === value}
                onClick={() => session.setSystemPreference(value)}
              >
                <b>{title}</b>
                <small>{note}</small>
              </button>
            ))}
          </div>
          <p className="hint">
            Then load a ROM with the button above. The file is read in your browser and is never
            sent anywhere.
          </p>
        </div>
      )}

      {/* Quick controls only. Everything that is configuration is behind Settings.

          The bar used to carry seven controls and was followed by a six-tab strip with
          every panel expanded inline, permanently, while you played. No emulator that was
          checked does that: the persistent surface is a thin menu bar (mGBA, ares, Mesen,
          SameBoy) or nothing at all (RetroArch, BGB, EmulatorJS, Delta). What survives
          here is what those references keep within one action of the game — pause, save
          state, load state, speed, fullscreen — plus the door to the rest.

          Mute moved to Settings › Audio and Reset to Settings › Emulation. Reset in
          particular was one slip away from Save State, which is a bad place for "throw
          the run away".

          DELIBERATELY NOT AUTO-HIDING, unlike EmulatorJS, which fades its bar out after
          3000ms. Three separate bugs in this project have turned out to be a working
          feature nobody could find, and nobody can open a browser here to check what a
          hidden bar actually does. A bar that is always there is the safe side of that
          trade. */}
      <div className="controlbar" role="group" aria-label="Emulator controls">
        <div className="controlbar-group">
          <button
            type="button"
            className="primary"
            onClick={() => (running ? session.pause() : session.resume())}
            disabled={!loaded}
          >
            {running ? 'Pause' : 'Resume'}
          </button>
        </div>

        {/* Quick save/load live here rather than only in the panel: a feature you cannot
            find is a feature you do not have. The panel keeps the full slot list. */}
        <div className="controlbar-group" role="group" aria-label="Save state">
          <button type="button" onClick={() => void session.quickSave()} disabled={!loaded}>
            Save State
          </button>
          <button
            type="button"
            onClick={() => void session.quickLoad()}
            disabled={!loaded || !snapshot.hasQuickState}
            title={snapshot.hasQuickState ? 'Load the quick slot' : 'Nothing saved yet'}
          >
            Load State
          </button>
        </div>

        <div className="controlbar-group">
          <label className="speed">
            <span>Speed</span>
            <select
              value={snapshot.speed}
              disabled={!loaded}
              onChange={(event) => session.setSpeed(Number(event.target.value))}
              aria-label="Emulation speed"
            >
              <option value={0.25}>0.25x</option>
              <option value={0.5}>0.5x</option>
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={4}>4x</option>
              <option value={8}>8x</option>
            </select>
          </label>
        </div>

        <div className="controlbar-group">
          <button
            type="button"
            disabled={!loaded}
            onClick={() => {
              if (appRef.current) void session.toggleFullscreen(appRef.current);
            }}
          >
            Fullscreen
          </button>

          {/* Never disabled. Bindings, the system preference and developer mode are all
              worth reaching before a cartridge is in, and the complaint that started this
              was that there was no way in at all. */}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={() => {
              session.menuOpened();
              setSettingsOpen(true);
            }}
          >
            Settings
          </button>
        </div>
      </div>

      {/* On desktop the on-screen pad is hidden, so the keyboard is the only way in.
          Saying so here is the difference between a game and an apparently frozen one.
          This is information, not configuration, so it stays on the page. */}
      {loaded && <KeyLegend />}

      {/* Opt-in, and off by default — RetroArch ships `DEFAULT_FPS_SHOW false` for the
          same reason. Unmounting it also stops its 250ms interval. */}
      {snapshot.showPerformance && <StatusBar />}

      <p aria-live="polite" className="visually-hidden">
        {snapshot.status === 'running' && snapshot.romName
          ? `Running ${snapshot.romName}`
          : snapshot.status === 'paused'
            ? 'Paused'
            : 'No ROM loaded'}
      </p>

      <Disclaimer />

      {/* Mounted only while open: the panels inside it, including the debugger, do not
          exist when it is closed. Rendered inside `.app` on purpose — `.app` is the
          element that goes fullscreen, and a drawer portalled to the body would be
          invisible for the whole time the app is fullscreen. */}
      {settingsOpen && (
        <SettingsDrawer
          onClose={() => {
            setSettingsOpen(false);
            session.menuClosed();
          }}
        />
      )}
    </div>
  );
}
