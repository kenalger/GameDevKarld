import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Required for SharedArrayBuffer, which the Web Worker move in Phase 10 depends on.
    // Verify the production host can send these before relying on SAB — a fallback is required.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
