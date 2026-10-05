import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { onRendererReset, type RendererWindow } from './rendererReset';

function fakeWindow() {
  const win = new EventEmitter();
  const webContents = new EventEmitter();
  return { win, webContents, host: Object.assign(win, { webContents }) as unknown as RendererWindow };
}

describe('onRendererReset', () => {
  it('resets when the document is replaced or gone, not for a navigation the window may cancel', () => {
    const { win, webContents, host } = fakeWindow();
    let resets = 0;
    onRendererReset(host, () => resets++);
    // A link the window cancels in will-navigate: these fire, the document stays.
    webContents.emit('did-start-loading');
    webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://example.com/' });
    webContents.emit('will-navigate', { preventDefault: () => undefined }, 'https://example.com/');
    webContents.emit('did-navigate-in-page');
    expect(resets).toBe(0);
    // A reload commits a new document.
    webContents.emit('did-navigate', {}, 'file:///app/index.html', 200, 'OK');
    expect(resets).toBe(1);
    webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(resets).toBe(2);
    win.emit('closed');
    expect(resets).toBe(3);
  });
});
