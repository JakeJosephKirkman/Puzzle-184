import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    // The CRDT engine is pure logic and runs in node; the panels need a DOM to
    // render into. Match the environment per file so engine tests stay fast and
    // free of any browser shim.
    environment: 'node',
    environmentMatchGlobs: [['tests/unit/**/*.test.tsx', 'jsdom']],
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
  },
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
