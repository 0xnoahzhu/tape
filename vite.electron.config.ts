import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
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

/**
 * Where a bundle is built: `out/<bundle>`, or `<TAPE_OUT>/<bundle>` with TAPE_OUT absolute or relative
 * to the repository (the renderer's vite.config.ts resolves it the same way).
 */
export const outDir = (bundle: 'main' | 'preload' | 'renderer'): string => resolve(root, process.env.TAPE_OUT ?? 'out', bundle);

/** Extra entries built next to a bundle's index.js (the database worker runs from its own file). */
const extraEntries: Record<string, Record<string, string>> = { main: { dbWorker: 'src/main/db/worker.ts' } };

/**
 * The build number shown in the About panel: the number of commits on HEAD, so it goes up with every
 * commit; undefined outside a git checkout.
 */
function buildNumber(): string | undefined {
  try {
    return execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

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
    define: { 'process.env.NODE_ENV': JSON.stringify(mode), 'process.env.TAPE_BUILD': JSON.stringify(buildNumber() ?? '') },
    build: {
      outDir: outDir(name),
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
