// Development aid: scripted screenshots of the real window.
//
//   TAPE_CAPTURE_DIR=/tmp/shots \
//   TAPE_CAPTURE_STEPS='[{"name":"trade","js":"__tape.store.setState({page:\"trade\"})","delay":1500}]' \
//   TAPE_CAPTURE_QUIT=1 electron .
//
// Each step runs `js` in the renderer (where `window.__tape.store` is the zustand store),
// waits `delay` ms, then writes `<dir>/<name>.png` (a value the js evaluates to is logged).
// Without steps a single "app.png" is taken.

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
  /**
   * Optional real input after `js`: an expression evaluated in the renderer that returns mouse events
   * ({ type: 'mouseDown' | 'mouseMove' | 'mouseUp', x, y, clickCount?, wait? ms before it }), sent
   * through webContents.sendInputEvent so the page sees them as a real mouse (drag, cursor, capture).
   */
  mouse?: string;
}

interface MouseStep {
  type: 'mouseDown' | 'mouseMove' | 'mouseUp';
  x: number;
  y: number;
  clickCount?: number;
  wait?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function setupDevCapture(win: BrowserWindow): void {
  const dir = process.env.TAPE_CAPTURE_DIR;
  // Never in a packaged app: the steps run arbitrary code in the renderer (e.g. past the lock screen).
  if (!dir || app.isPackaged) return;
  mkdirSync(dir, { recursive: true });
  const steps: Step[] = process.env.TAPE_CAPTURE_STEPS ? (JSON.parse(process.env.TAPE_CAPTURE_STEPS) as Step[]) : [{ name: 'app' }];
  const initialDelay = Number(process.env.TAPE_CAPTURE_DELAY ?? 3500);

  win.webContents.once('did-finish-load', async () => {
    await sleep(initialDelay);
    // The left button is held from a mouseDown to its mouseUp (across steps, so a step can capture a
    // drag midway). The events between say so (`leftbuttondown`), as a physical mouse's do: without
    // it Chromium reports buttons 0, so pointer capture never holds and moves are hovers.
    let held = false;
    for (const step of steps) {
      try {
        if (step.width && step.height) win.setContentSize(step.width, step.height);
        // Focus events (inputs, dropdowns) only fire in a focused window.
        win.focus();
        win.webContents.focus();
        if (step.js) {
          const value: unknown = await win.webContents.executeJavaScript(step.js, true);
          if (value !== undefined) console.log(`[capture] ${step.name}: ${JSON.stringify(value)}`);
        }
        if (step.mouse) {
          const events = (await win.webContents.executeJavaScript(step.mouse, true)) as MouseStep[];
          for (const e of events) {
            if (e.wait) await sleep(e.wait);
            if (e.type === 'mouseDown') held = true;
            else if (e.type === 'mouseUp') held = false;
            win.webContents.sendInputEvent({
              type: e.type,
              x: Math.round(e.x),
              y: Math.round(e.y),
              button: 'left',
              clickCount: e.clickCount ?? 1,
              modifiers: held ? ['leftbuttondown'] : [],
            });
          }
          console.log(`[capture] ${step.name}: sent ${events.length} mouse events`);
        }
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
