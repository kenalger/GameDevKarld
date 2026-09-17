import { useEffect, useRef } from 'react';
import { session } from '../emulator/EmulatorSession.js';

/**
 * Live counters. Deliberately NOT React state: this writes to DOM text nodes on a ~4Hz
 * interval, so a running emulator triggers zero re-renders anywhere in the tree.
 */
export function StatusBar(): React.JSX.Element {
  const fpsRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      const fps = fpsRef.current;
      const frames = frameRef.current;
      if (fps) fps.textContent = session.getMeasuredFps().toFixed(1);
      if (frames) frames.textContent = session.getFrameCount().toLocaleString();
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  return (
    <dl className="statusbar panel" aria-label="Emulator status">
      <div>
        <dt>fps</dt>
        <dd ref={fpsRef}>0.0</dd>
      </div>
      <div>
        <dt>frames</dt>
        <dd ref={frameRef}>0</dd>
      </div>
      <div>
        <dt>target</dt>
        <dd>59.7275 Hz</dd>
      </div>
    </dl>
  );
}
