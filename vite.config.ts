import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer (browser) build. Main and preload are built by vite.electron.config.ts.
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
  server: { port: 5183, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL(`./${process.env.TAPE_OUT ?? 'out'}/renderer`, import.meta.url)),
    emptyOutDir: true,
    target: 'chrome140',
  },
});
