import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The determinism gates run thousands of emulated frames against a real ROM and sat at
    // ~90% of vitest's 5s default, so any added work tipped them into a spurious timeout.
    // These are correctness tests, not performance ones — perf is guarded by
    // scripts/benchmark.ts and by the exact counter in tests/unit/cheats.test.ts.
    testTimeout: 30_000,
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@webboy/emulator': new URL('./packages/emulator/src/index.ts', import.meta.url).pathname,
    },
  },
});
