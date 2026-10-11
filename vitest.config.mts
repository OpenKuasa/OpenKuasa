import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Next provides `server-only` in prod; vitest's node runtime cannot resolve it.
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // Per-file cleanup of live-test users and workspaces (tests/helpers/live-workspaces.ts)
    // relies on `isolate: true` (the default: each file gets its own module registry) and on
    // nothing setting `sequence.hooks` to 'list' or 'parallel' (the helper's afterAll must run
    // after the file's own). Do not change either without revisiting that helper.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
