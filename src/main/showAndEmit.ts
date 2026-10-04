// Brings the main window to the front and sends it an event.

import type { TapeEvent } from '@shared/ipc';
import type { MainContext } from './context';

/** Time for the renderer to apply its snapshot and register command listeners after load. */
const SETTLE_MS = 600;

/**
 * Shows (or re-creates) the main window, then emits `event`. When the window had to be
 * created or is still loading, the event is sent once the page has finished loading.
 * While Tape is locked the window is only shown: nothing behind the lock screen changes.
 */
export function showAndEmit(ctx: MainContext, event: TapeEvent): void {
  const existing = ctx.getMainWindow();
  ctx.showMainWindow();
  const win = existing ?? ctx.getMainWindow();
  if (!win) return;
  const send = () => {
    if (!ctx.lock.isLocked()) ctx.emit(event);
  };
  if (existing && !win.webContents.isLoading()) {
    send();
    return;
  }
  win.webContents.once('did-finish-load', () => setTimeout(send, SETTLE_MS));
}
