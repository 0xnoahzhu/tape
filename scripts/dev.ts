// Development runner: Vite dev server for the renderer, watch builds for main and
// preload, and an Electron process that restarts whenever main or preload change.
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { build, createServer, type Rollup } from 'vite';
import { mainConfig, preloadConfig } from '../vite.electron.config.ts';

const require = createRequire(import.meta.url);
const electronBin = require('electron') as unknown as string;

const server = await createServer({ configFile: 'vite.config.ts', mode: 'development' });
await server.listen();
const devUrl = server.resolvedUrls?.local[0] ?? 'http://localhost:5183/';
server.printUrls();

let electron: ChildProcess | null = null;
let restarting = false;
let pending = 2;

function startElectron(): void {
  electron = spawn(electronBin, ['.', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl, NODE_ENV: 'development' },
  });
  electron.once('exit', (code) => {
    if (restarting) return;
    void server.close();
    process.exit(code ?? 0);
  });
}

function restartElectron(): void {
  if (!electron) return startElectron();
  restarting = true;
  electron.once('exit', () => {
    restarting = false;
    startElectron();
  });
  electron.kill();
}

function watch(watcher: Rollup.RollupWatcher, label: string): void {
  let first = true;
  watcher.on('event', (event) => {
    if (event.code === 'ERROR') console.error(`[${label}]`, event.error);
    if (event.code !== 'END') return;
    if (first) {
      first = false;
      if (--pending === 0) startElectron();
      return;
    }
    console.log(`[${label}] rebuilt, restarting Electron`);
    restartElectron();
  });
}

const opts = { mode: 'development', watch: true } as const;
watch((await build(mainConfig(opts))) as Rollup.RollupWatcher, 'main');
watch((await build(preloadConfig(opts))) as Rollup.RollupWatcher, 'preload');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    electron?.kill();
    void server.close().then(() => process.exit(0));
  });
}
