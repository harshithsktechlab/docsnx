import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    // `src/app/**` is here because it was NOT, and a test file added beside a
    // component under src/app/components was silently never collected — it
    // reported neither pass nor fail, which is worse than failing.
    include: [
      'src/components/**/*.test.tsx', 'src/components/**/*.test.ts',
      'src/app/**/*.test.tsx', 'src/app/**/*.test.ts',
      'src/hooks/**/*.test.ts', 'src/hooks/**/*.test.tsx',
      'tests/**/*.test.ts',
    ],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/components/**/*.tsx', 'src/components/**/*.ts', 'src/hooks/**/*.ts', 'src/hooks/**/*.tsx'],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    }
  }
});
