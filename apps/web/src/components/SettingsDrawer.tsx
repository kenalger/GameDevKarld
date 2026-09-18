import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { session, type SystemPreference } from '../emulator/EmulatorSession.js';
import { StatesPanel } from './StatesPanel.js';
import { CheatsPanel } from './CheatsPanel.js';
import { ControlsPanel } from './ControlsPanel.js';
import { SavesPanel } from './SavesPanel.js';
import { RomInfoPanel } from './RomInfoPanel.js';
import { DebugPanel } from './DebugPanel.js';

/**
 * Everything that is configuration, behind one door.
 *
 * The page used to carry a six-tab strip — Cartridge, Controls, Saves, States, Cheats,
 * Debug — expanded inline underneath the device, permanently, while you played. None of
 * the eight emulators this was checked against does that: mGBA, ares, Mesen and SameBoy
 * keep a thin menu bar and put configuration in dialogs; RetroArch, BGB, EmulatorJS,
 * Delta and Provenance show nothing at all during play. Settings live behind a quick menu
 * (RetroArch F1), a gear popover (EmulatorJS) or a pause menu (Delta).
 *
 * A DRAWER rather than a modal, on the Nielsen Norman distinction: a modal is for an
 * interruption you want the user to deal with, a drawer is right when the user has to
 * keep the underlying screen visible while working. Nearly everything in here — speed,
 * palette, bindings, cheats, states — changes the picture you are looking at, so the
 * picture has to stay on screen.
 *
 * Two structural choices from the same survey:
 *  - Debug is NOT a peer of Saves and Controls. It is not in the list at all until
 *    developer mode is on, which is how ares ("Developer") and Mesen (a separate
 *    top-level Debug menu) treat it, and RetroArch, EmulatorJS and Delta ship no
 *    player-facing debugger whatsoever.
 *  - Cartridge is read-only information, not a settings category — no reference has one.
 *    mGBA files the same panel under `ROM info…` in the File menu. It is last but one
 *    here for the same reason: it is a diagnostic you go looking for, not a preference.
 *
 * Nothing in here subscribes per frame. The only live thing is the debugger, which
 * mounts only when its section is open and reads through the core's inspection interface
 * on a 250ms interval of its own.
 */

type SectionId =
  | 'states'
  | 'cheats'
  | 'input'
  | 'emulation'
  | 'audio'
  | 'saves'
  | 'cartridge'
  | 'advanced'
  | 'debug';

interface Section {
  readonly id: SectionId;
  readonly label: string;
  /** True when the section has nothing to say until a cartridge is in. */
  readonly needsCartridge: boolean;
}

/** Named, because it is also the fallback when the selected section disappears. */
const ADVANCED: Section = { id: 'advanced', label: 'Advanced', needsCartridge: false };

/**
 * Order matters: quick-access things first (states, cheats), then the categories every
 * reference emulator has — Input, Emulation, Audio — then storage, then the read-only
 * cartridge panel, then the developer switches.
 */
const SECTIONS: readonly Section[] = [
  { id: 'states', label: 'Save states', needsCartridge: true },
  { id: 'cheats', label: 'Cheats', needsCartridge: true },
  { id: 'input', label: 'Input', needsCartridge: false },
  { id: 'emulation', label: 'Emulation', needsCartridge: false },
  { id: 'audio', label: 'Audio', needsCartridge: false },
  { id: 'saves', label: 'Saves', needsCartridge: true },
  { id: 'cartridge', label: 'Cartridge', needsCartridge: true },
  ADVANCED,
];

const DEBUG_SECTION: Section = { id: 'debug', label: 'Debug', needsCartridge: true };

/**
 * Everything inside the drawer that can take focus.
 *
 * File inputs are excluded on purpose: the panels keep them visually hidden behind a
 * visible button, so including them would put an invisible stop in the tab order.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]):not([type="file"]), [tabindex]:not([tabindex="-1"])';

export function SettingsDrawer({ onClose }: { onClose: () => void }): React.JSX.Element {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [section, setSection] = useState<SectionId>('states');
  const dialogRef = useRef<HTMLDivElement>(null);

  const loaded = snapshot.status !== 'empty';
  const sections = snapshot.developerMode ? [...SECTIONS, DEBUG_SECTION] : SECTIONS;
  // Turning developer mode off while standing in Debug must not leave a blank pane.
  const found = sections.find((entry) => entry.id === section);
  const current = found ?? ADVANCED;
  const active = current.id;

  // Focus moves in on open and is restored to whatever opened us on close — required for
  // a dialog, and the difference between "settings opened" and "focus fell to the top of
  // the document" for a screen-reader or keyboard user.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => opener?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // Not if something already handled it: the controls panel's "press a key" capture
      // uses Escape to cancel, and cancelling a rebind should not also close settings.
      if (!event.defaultPrevented) onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const stops = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;

    // Trapped: a dialog the tab key can walk out of, leaving the dialog open behind it,
    // is worse than no dialog.
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const needsCartridge = current.needsCartridge && !loaded;

  return (
    <>
      {/* Clicking the page behind a drawer dismisses it — the standard, and the reason a
          drawer feels lighter than a modal. */}
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />

      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={handleKeyDown}
      >
        <div className="drawer-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="drawer-body">
          <nav className="drawer-nav" aria-label="Settings sections">
            <ul>
              {sections.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-current={entry.id === active ? 'true' : undefined}
                    onClick={() => setSection(entry.id)}
                  >
                    {entry.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="drawer-content">
            {needsCartridge ? (
              <section className="panel">
                <h3 className="panel-title">{current.label}</h3>
                <p className="hint" style={{ marginTop: 0 }}>
                  There is no cartridge in. Load a ROM and this fills in.
                </p>
              </section>
            ) : (
              <>
                {active === 'states' && <StatesPanel />}
                {active === 'cheats' && <CheatsPanel />}
                {active === 'input' && <ControlsPanel />}
                {active === 'emulation' && (
                  <EmulationSection loaded={loaded} preference={snapshot.systemPreference} />
                )}
                {active === 'audio' && <AudioSection muted={snapshot.muted} />}
                {active === 'saves' && <SavesPanel restored={snapshot.savesRestored} />}
                {active === 'cartridge' && <RomInfoPanel />}
                {active === 'advanced' && (
                  <AdvancedSection
                    showPerformance={snapshot.showPerformance}
                    developerMode={snapshot.developerMode}
                  />
                )}
                {/* Mounted only while its section is open, so a closed debugger costs the
                    emulator nothing at all. */}
                {active === 'debug' && <DebugPanel />}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Which system to run, and Reset.
 *
 * The system picker previously had exactly one call site — inside the "no cartridge yet"
 * block — so the moment a game was loaded the setting was unreachable for the rest of the
 * session. It is here as well now, and the pre-cartridge picker stays where it is.
 */
function EmulationSection({
  loaded,
  preference,
}: {
  loaded: boolean;
  preference: SystemPreference;
}): React.JSX.Element {
  return (
    <section className="panel">
      <h3 className="panel-title">Emulation</h3>

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
            aria-checked={preference === value}
            onClick={() => session.setSystemPreference(value)}
          >
            <b>{title}</b>
            <small>{note}</small>
          </button>
        ))}
      </div>

      <p className="hint" style={{ marginTop: 0 }}>
        Auto reads the cartridge header and is right almost always. A change applies the next time a
        ROM is loaded.
      </p>

      <h4 className="panel-title" style={{ marginTop: 'var(--gap)' }}>
        Reset
      </h4>
      <div className="transport">
        <button type="button" onClick={() => session.reset()} disabled={!loaded}>
          Reset
        </button>
      </div>
      <p className="hint">
        Restarts the game from power-on. Your battery save is kept; anything since your last save
        state is not.
      </p>
    </section>
  );
}

/** One switch today. It is a category every reference emulator has, so it gets a section. */
function AudioSection({ muted }: { muted: boolean }): React.JSX.Element {
  return (
    <section className="panel">
      <h3 className="panel-title">Audio</h3>
      <ul className="slots">
        <li>
          <input
            type="checkbox"
            id="setting-muted"
            checked={muted}
            onChange={(event) => session.setMuted(event.target.checked)}
          />
          <span className="slot-label">
            <label htmlFor="setting-muted">Mute</label>
            <small>silences output without stopping the emulated sound hardware</small>
          </span>
        </li>
      </ul>
      <p className="hint">
        Browsers refuse to start audio until you interact with the page, so sound begins when you
        load a ROM or press a key.
      </p>
    </section>
  );
}

/** The two switches that change what the rest of the app shows. Both off by default. */
function AdvancedSection({
  showPerformance,
  developerMode,
}: {
  showPerformance: boolean;
  developerMode: boolean;
}): React.JSX.Element {
  return (
    <section className="panel">
      <h3 className="panel-title">Advanced</h3>
      <ul className="slots">
        <li>
          <input
            type="checkbox"
            id="setting-performance"
            checked={showPerformance}
            onChange={(event) => session.setShowPerformance(event.target.checked)}
          />
          <span className="slot-label">
            <label htmlFor="setting-performance">Show performance readout</label>
            <small>frame rate, frame count and target rate under the device</small>
          </span>
        </li>
        <li>
          <input
            type="checkbox"
            id="setting-developer"
            checked={developerMode}
            onChange={(event) => session.setDeveloperMode(event.target.checked)}
          />
          <span className="slot-label">
            <label htmlFor="setting-developer">Developer mode</label>
            <small>adds a Debug section: registers, disassembly and breakpoints</small>
          </span>
        </li>
      </ul>
      <p className="hint">
        Both are off by default and remembered on this device. The readout is opt-in because a
        counter over the picture is a development tool, not a feature of the game.
      </p>
    </section>
  );
}
