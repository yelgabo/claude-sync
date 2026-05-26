import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    poolOptions: { threads: { singleThread: false } },
    testTimeout: 20_000,
    hookTimeout: 30_000,
    setupFiles: ['./test/setup.ts'],
    server: {
      deps: {
        inline: ['libsodium-wrappers', 'libsodium'],
      },
    },
  },
});
