// Production build of all three bundles into out/.
import { build } from 'vite';
import { mainConfig, preloadConfig } from '../vite.electron.config.ts';

const opts = { mode: 'production' } as const;
await build({ configFile: 'vite.config.ts', mode: 'production' });
await build(mainConfig(opts));
await build(preloadConfig(opts));
const out = process.env.TAPE_OUT ?? 'out';
console.log(`Build complete: ${out}/main, ${out}/preload, ${out}/renderer`);
