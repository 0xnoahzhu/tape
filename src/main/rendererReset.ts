// Tells the main process when a window's renderer document is gone (reload, crash, window closed),
// so state kept for it (its quote owners and copies) goes with it. Pure wiring, unit-tested.

/** The parts of a BrowserWindow that onRendererReset uses. */
export interface RendererWindow {
  on(event: 'closed', listener: () => void): unknown;
  readonly webContents: {
    on(event: 'did-navigate', listener: () => void): unknown;
    on(event: 'render-process-gone', listener: () => void): unknown;
  };
}

/**
 * Calls `reset` when the window's document is replaced or gone: a committed main-frame navigation
 * (`did-navigate`: a reload, or a load after a crash), a crashed renderer, the window closing.
 * Not on `did-start-navigation` or `did-start-loading`: they also fire for a navigation the window
 * then cancels (`will-navigate`), while the same document keeps running and never declares its
 * state again. A commit is also ordered with IPC (checked in Electron 44): the old document's last
 * messages arrive before it and the new document's first ones after it.
 */
export function onRendererReset(win: RendererWindow, reset: () => void): void {
  win.webContents.on('did-navigate', reset);
  win.webContents.on('render-process-gone', reset);
  win.on('closed', reset);
}
