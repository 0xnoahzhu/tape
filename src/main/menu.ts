// Installs the localized application menu and rebuilds it when the language or the lock changes.

import { app, Menu, shell } from 'electron';
import type { MainContext } from './context';
import { buildMenuTemplate } from './menuTemplate';
import { showAndEmit } from './showAndEmit';

export function installMenu(ctx: MainContext): void {
  app.setAboutPanelOptions({
    applicationName: 'Tape',
    applicationVersion: app.getVersion(),
    copyright: 'Apache License 2.0',
  });

  let lang = ctx.store.getSettings().appearance.language;
  let locked = ctx.lock.isLocked();

  const install = () => {
    const template = buildMenuTemplate({
      platform: process.platform,
      lang,
      isDev: ctx.isDev,
      locked,
      actions: {
        command: (command) => showAndEmit(ctx, { type: 'command', command }),
        openExternal: (url) => void shell.openExternal(url),
        // Without a PIN the renderer asks for one first, then locks.
        lock: () => {
          if (ctx.lock.hasPin()) ctx.lock.lock();
          else showAndEmit(ctx, { type: 'command', command: 'set-pin-and-lock' });
        },
      },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  install();
  ctx.store.onSettingsChanged((next) => {
    if (next.appearance.language === lang) return;
    lang = next.appearance.language;
    install();
  });
  ctx.lock.onChange((state) => {
    if (state.locked === locked) return;
    locked = state.locked;
    install();
  });
}
