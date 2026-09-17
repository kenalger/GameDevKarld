import { useEffect, useRef } from 'react';
import { session } from '../emulator/EmulatorSession.js';

/**
 * The canvas. Mounts once, hands its element to the session, and then never re-renders —
 * every frame is written straight to the 2D context by the session's loop.
 */
export function Display({ romName }: { romName: string | null }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    session.attachCanvas(canvasRef.current);
    return () => session.attachCanvas(null);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="screen"
      role="img"
      aria-label={
        romName ? `Game Boy display, running ${romName}` : 'Game Boy display, no ROM loaded'
      }
    />
  );
}
