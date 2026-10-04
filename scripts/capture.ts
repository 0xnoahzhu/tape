// Takes scripted screenshots of a built app (see src/main/devCapture.ts).
//
//   TAPE_OUT=out-x pnpm build
//   node scripts/capture.ts --out out-x --dir /tmp/shots --steps steps.json [--demo] [--connect --client-id 151]
//
// steps.json: [{ "name": "trade", "js": "__tape.store.setState({ page: 'trade' })", "delay": 1200 }, ...]
// The window is 1440×900 unless a step sets width/height. The process is killed after --timeout s.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'out' },
    dir: { type: 'string' },
    steps: { type: 'string' },
    demo: { type: 'boolean', default: false },
    connect: { type: 'boolean', default: false },
    'client-id': { type: 'string' },
    'user-data': { type: 'string' },
    delay: { type: 'string', default: '3500' },
    timeout: { type: 'string', default: '120' },
  },
});

if (!values.dir) throw new Error('--dir is required');
const dir = resolve(values.dir);
mkdirSync(dir, { recursive: true });
const main = resolve(values.out!, 'main/index.js');
if (!existsSync(main)) throw new Error(`${main} not found; run TAPE_OUT=${values.out} pnpm build first`);

const steps = values.steps ? (existsSync(values.steps) ? readFileSync(values.steps, 'utf8') : values.steps) : '';
const require = createRequire(import.meta.url);
const electron = require('electron') as unknown as string;

const env: NodeJS.ProcessEnv = {
  ...process.env,
  TAPE_CAPTURE_DIR: dir,
  TAPE_CAPTURE_QUIT: '1',
  TAPE_CAPTURE_DELAY: values.delay,
  TAPE_USER_DATA: resolve(values['user-data'] ?? join(dir, 'user-data')),
};
delete env.VITE_DEV_SERVER_URL;
if (steps) env.TAPE_CAPTURE_STEPS = steps;
if (values.demo) env.TAPE_DEMO = '1';
if (!values.connect) env.TAPE_NO_CONNECT = '1';
if (values['client-id']) env.TAPE_CLIENT_ID = values['client-id'];

const child = spawn(electron, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const relay = (buf: Buffer) => {
  for (const line of buf.toString().split('\n')) {
    if (line.trim() && !/sandbox_extension|Operation not permitted/.test(line)) console.log(line);
  }
};
child.stdout.on('data', relay);
child.stderr.on('data', relay);
const timer = setTimeout(() => {
  console.error(`capture: timed out after ${values.timeout}s, killing Electron`);
  child.kill('SIGKILL');
}, Number(values.timeout) * 1000);
child.on('exit', (code) => {
  clearTimeout(timer);
  console.log(`capture: done (exit ${code}), screenshots in ${dir}`);
});
