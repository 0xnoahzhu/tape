// Development aid: scripted screenshots of the real window.
//
//   TAPE_CAPTURE_DIR=/tmp/shots \
//   TAPE_CAPTURE_STEPS='[{"name":"trade","js":"__tape.store.setState({page:\"trade\"})","delay":1500}]' \
//   TAPE_CAPTURE_QUIT=1 electron .
//
// Each step runs `js` in the renderer (where `window.__tape.store` is the zustand store),
// waits `delay` ms, then writes `<dir>/<name>.png`. Without steps a single "app.png" is taken.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, type BrowserWindow } from 'electron';

interface Step {
  name: string;
  js?: string;
  delay?: number;
  /** Optional window size for this step. */
  width?: number;
  height?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function setupDevCapture(win: BrowserWindow): void {
  const dir = process.env.TAPE_CAPTURE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const steps: Step[] = process.env.TAPE_CAPTURE_STEPS ? (JSON.parse(process.env.TAPE_CAPTURE_STEPS) as Step[]) : [{ name: 'app' }];
  const initialDelay = Number(process.env.TAPE_CAPTURE_DELAY ?? 3500);

  win.webContents.once('did-finish-load', async () => {
    await sleep(initialDelay);
    for (const step of steps) {
      try {
        if (step.width && step.height) win.setContentSize(step.width, step.height);
        // Focus events (inputs, dropdowns) only fire in a focused window.
        win.focus();
        win.webContents.focus();
        if (step.js) await win.webContents.executeJavaScript(step.js, true);
        await sleep(step.delay ?? 800);
        const image = await win.webContents.capturePage();
        writeFileSync(join(dir, `${step.name}.png`), image.toPNG());
        console.log(`[capture] ${step.name}.png`);
      } catch (err) {
        console.error(`[capture] ${step.name} failed:`, err);
      }
    }
    if (process.env.TAPE_CAPTURE_QUIT === '1') app.quit();
  });
}
