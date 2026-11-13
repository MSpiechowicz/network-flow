import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // Third-party code and the scenario content change at different rates: keep them in
        // separate files so each stays well under Vite's 500 kB warning and caches on its own.
        codeSplitting: {
          groups: [
            { name: 'vendor', test: /node_modules/ },
            { name: 'scenarios', test: /src\/scenarios\/data\// },
          ],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
