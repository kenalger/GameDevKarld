import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@webboy/emulator': new URL('./packages/emulator/src/index.ts', import.meta.url).pathname,
    },
  },
});
