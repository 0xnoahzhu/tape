import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { InlineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

const root = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('./src/shared', import.meta.url));

// Runtime dependencies (if any) stay in node_modules; electron-builder ships them with the app.
const runtimeDeps = Object.keys((pkg as { dependencies?: Record<string, string> }).dependencies ?? {});
const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...runtimeDeps,
].flatMap((id) => [id, new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`)]);

/** Extra entries built next to a bundle's index.js (the database worker runs from its own file). */
const extraEntries: Record<string, Record<string, string>> = { main: { dbWorker: 'src/main/db/worker.ts' } };

interface Options {
  mode: 'development' | 'production';
  watch?: boolean;
}

function nodeConfig(name: 'main' | 'preload', format: 'es' | 'cjs', { mode, watch }: Options): InlineConfig {
  return {
    configFile: false,
    root,
    mode,
    logLevel: 'warn',
    resolve: { alias: { '@shared': shared } },
    define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
    build: {
      outDir: `${process.env.TAPE_OUT ?? 'out'}/${name}`,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      sourcemap: mode === 'development' ? 'inline' : false,
      ssr: true,
      watch: watch ? {} : null,
      rolldownOptions: {
        input: { index: `src/${name}/index.ts`, ...extraEntries[name] },
        external,
        output: {
          format,
          entryFileNames: format === 'cjs' ? '[name].cjs' : '[name].js',
        },
      },
    },
  };
}

export const mainConfig = (o: Options) => nodeConfig('main', 'es', o);
// Sandboxed preload scripts must be CommonJS.
export const preloadConfig = (o: Options) => nodeConfig('preload', 'cjs', o);
