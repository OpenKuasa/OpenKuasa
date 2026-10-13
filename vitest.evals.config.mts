import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Accuracy checks call real models, so they are slow and are kept out of
// `pnpm test`. Run them with `pnpm eval:tuah`.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Next provides `server-only` in prod; vitest's node runtime cannot resolve it (as in vitest.config.mts).
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['evals/**/*.eval.ts'],
    // Runs are spaced out and a refused run waits before it is tried again.
    testTimeout: 1_200_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // The report is the point of a run, so it is printed whether or not cases pass.
    silent: false,
  },
});
