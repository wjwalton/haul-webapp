import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __DEV_TOOLS__: 'true',
    __BUILD__: JSON.stringify({ version: '0.0.0', channel: 'test', commit: 'test', date: '2026-01-01' }),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // The controller-update simulations run on fake timers; real-time tests get some headroom.
    testTimeout: 20_000,
  },
});
