import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Unit tests import the TypeScript sources directly; the e2e test exercises
      // the built server (dist), which resolves the package via node_modules.
      '@mcp-perfectpixel/core': `${root}packages/core/src/index.ts`,
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
