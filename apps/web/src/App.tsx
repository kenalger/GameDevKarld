import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { session } from './emulator/EmulatorSession.js';
import { Display } from './components/Display.js';
import { RomPicker } from './components/RomPicker.js';
import { StatusBar } from './components/StatusBar.js';
import { Disclaimer } from './components/Disclaimer.js';
import { ControlsPanel } from './components/ControlsPanel.js';
import { SavesPanel } from './components/SavesPanel.js';
import { StatesPanel } from './components/StatesPanel.js';
import { RomInfoPanel } from './components/RomInfoPanel.js';
import { TouchControls } from './components/TouchControls.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { DebugPanel } from './components/DebugPanel.js';
import { KeyLegend } from './components/KeyLegend.js';
import { CheatsPanel } from './components/CheatsPanel.js';

const TABS = ['Cartridge', 'Controls', 'Saves', 'States', 'Cheats', 'Debug'] as const;
type Tab = (typeof TABS)[number];

export function App(): React.JSX.Element {
  // Status changes rarely (load / pause / resume / error), so it may live in a store.
  // Nothing that changes per frame is allowed through here.
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [tab, setTab] = useState<Tab>('Cartridge');
  const [muted, setMuted] = useState(false);
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

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      session.setMuted(!current);
      return !current;
    });
  }, []);

  const exportState = useCallback(() => {
    const state = session.exportState();
    if (!state) return;
    const bytes = new Uint8Array(state.data.length);
    bytes.set(state.data);
    const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
    const link = document.createElement('a');
    link.href = url;
    link.download = state.filename;
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  const loaded = snapshot.status !== 'empty';

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
        <p className="empty-state">
          <strong>No ROM loaded</strong>
          Choose a Game Boy ROM from your device to begin. The file is read in your browser and is
          never sent anywhere.
        </p>
      )}

      <div className="transport" role="group" aria-label="Emulator controls">
        <button
          type="button"
          onClick={() => session.pause()}
          disabled={snapshot.status !== 'running'}
        >
          Pause
        </button>
        <button
          type="button"
          onClick={() => session.resume()}
          disabled={snapshot.status !== 'paused'}
        >
          Resume
        </button>
        <button type="button" onClick={() => session.reset()} disabled={!loaded}>
          Reset
        </button>
        {/* Quick save/load live here rather than only in the States tab: a feature you
            cannot find is a feature you do not have. The panel keeps the full slot list. */}
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
        <button type="button" onClick={toggleMute} disabled={!loaded} aria-pressed={muted}>
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          type="button"
          disabled={!loaded}
          onClick={() => {
            if (appRef.current) void session.toggleFullscreen(appRef.current);
          }}
        >
          Fullscreen
        </button>
      </div>

      {/* On desktop the on-screen pad is hidden, so the keyboard is the only way in.
          Saying so here is the difference between a game and an apparently frozen one. */}
      {loaded && <KeyLegend />}

      <StatusBar />

      {loaded && (
        <>
          <hr className="rule" />
          <div className="tabs" role="tablist" aria-label="Panels">
            {TABS.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <div role="tabpanel" aria-label={tab}>
            {tab === 'Cartridge' && <RomInfoPanel />}
            {tab === 'Controls' && <ControlsPanel />}
            {tab === 'Saves' && <SavesPanel restored={snapshot.savesRestored} />}
            {tab === 'States' && <StatesPanel />}
            {tab === 'Cheats' && <CheatsPanel />}
            {/* Mounted only when open, so a closed debugger costs the emulator nothing. */}
            {tab === 'Debug' && <DebugPanel />}
          </div>
        </>
      )}

      <p aria-live="polite" className="visually-hidden">
        {snapshot.status === 'running' && snapshot.romName
          ? `Running ${snapshot.romName}`
          : snapshot.status === 'paused'
            ? 'Paused'
            : 'No ROM loaded'}
      </p>

      <Disclaimer />
    </div>
  );
}
