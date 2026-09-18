import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { session } from './emulator/EmulatorSession.js';
import './styles/theme.css';

// Dev-only handle, so a stuck session can be inspected from the console instead of
// guessed at: webboy.getSnapshot(), webboy.input.peek(), webboy.getBindings().
// import.meta.env.DEV is statically false in a production build, so this is dropped.
if (import.meta.env.DEV) {
  (globalThis as unknown as { webboy: unknown }).webboy = session;
}

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
