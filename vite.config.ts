import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer (browser) build. Main and preload are built by vite.electron.config.ts.
const repo = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
  server: { port: 5183, strictPort: true },
  build: {
    // TAPE_OUT absolute or relative to the repository, as for main and preload (vite.electron.config.ts).
    outDir: resolve(repo, process.env.TAPE_OUT ?? 'out', 'renderer'),
    emptyOutDir: true,
    target: 'chrome140',
  },
});
