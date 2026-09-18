import { useCallback, useEffect, useRef, useState } from 'react';
import { disassembleRange, type Instruction } from '@webboy/emulator';
import { session } from '../emulator/EmulatorSession.js';

const hex = (n: number, width = 2): string => n.toString(16).padStart(width, '0').toUpperCase();

/**
 * Developer-mode debugger.
 *
 * Mounted only when the panel is open, and it reads state through the core's read-only
 * inspection interface — it never mutates emulator internals. The live view refreshes on a
 * throttled interval rather than per frame, so watching registers does not itself cost
 * frames.
 */
export function DebugPanel(): React.JSX.Element {
  const [listing, setListing] = useState<Instruction[]>([]);
  const registersRef = useRef<HTMLPreElement>(null);
  const [breakpoints, setBreakpoints] = useState<number[]>([]);
  const [address, setAddress] = useState('');

  const refresh = useCallback(() => {
    const inspector = session.getInspector();
    if (!inspector) return;

    const cpu = inspector.getCpuSnapshot();
    const pre = registersRef.current;
    if (pre) {
      pre.textContent =
        `A:${hex(cpu.a)} F:${hex(cpu.f)}   ` +
        `B:${hex(cpu.b)} C:${hex(cpu.c)}\n` +
        `D:${hex(cpu.d)} E:${hex(cpu.e)}   ` +
        `H:${hex(cpu.h)} L:${hex(cpu.l)}\n` +
        `PC:${hex(cpu.pc, 4)}  SP:${hex(cpu.sp, 4)}\n` +
        `IME:${cpu.ime ? 1 : 0}  HALT:${cpu.halted ? 1 : 0}  ` +
        `cycles:${cpu.cycles.toLocaleString()}`;
    }
    setListing(disassembleRange(cpu.pc, 10, (a) => inspector.readMemory(a)));
  }, []);

  useEffect(() => {
    refresh();
    // 4Hz: fast enough to follow, slow enough to cost nothing.
    const id = window.setInterval(refresh, 250);
    return () => window.clearInterval(id);
  }, [refresh]);

  const addBreakpoint = (): void => {
    const parsed = Number.parseInt(address.replace(/^\$|^0x/i, ''), 16);
    if (Number.isNaN(parsed)) return;
    session.toggleBreakpoint(parsed);
    setBreakpoints(session.listBreakpoints());
    setAddress('');
  };

  return (
    <section className="panel">
      <h3 className="panel-title">Debug</h3>

      <pre className="regs" ref={registersRef} aria-label="CPU registers" />

      <div className="transport" style={{ margin: 'var(--gap) 0' }}>
        <button
          type="button"
          onClick={() => {
            session.stepInstruction();
            refresh();
          }}
        >
          Step
        </button>
        <button
          type="button"
          onClick={() => {
            session.stepFrame();
            refresh();
          }}
        >
          Step frame
        </button>
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      </div>

      <ol className="listing">
        {listing.map((instruction, index) => (
          <li key={instruction.address} data-current={index === 0 ? 'true' : undefined}>
            <code>{hex(instruction.address, 4)}</code>
            <code className="listing-bytes">{instruction.bytes.map((b) => hex(b)).join(' ')}</code>
            <code>{instruction.text}</code>
          </li>
        ))}
      </ol>

      <div className="transport" style={{ marginTop: 'var(--gap)' }}>
        <input
          type="text"
          value={address}
          placeholder="Breakpoint, e.g. 0150"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addBreakpoint()}
          aria-label="Breakpoint address in hexadecimal"
        />
        <button type="button" onClick={addBreakpoint}>
          Toggle
        </button>
      </div>
      {breakpoints.length > 0 && (
        <p className="hint">Breakpoints: {breakpoints.map((b) => `$${hex(b, 4)}`).join(', ')}</p>
      )}
    </section>
  );
}
