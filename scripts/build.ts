// Production build of all three bundles into out/ (or TAPE_OUT, absolute or relative to the repository).
import { build } from 'vite';
import { mainConfig, outDir, preloadConfig } from '../vite.electron.config.ts';

const opts = { mode: 'production' } as const;
await build({ configFile: 'vite.config.ts', mode: 'production' });
await build(mainConfig(opts));
await build(preloadConfig(opts));
console.log(`Build complete: ${outDir('main')}, ${outDir('preload')}, ${outDir('renderer')}`);
