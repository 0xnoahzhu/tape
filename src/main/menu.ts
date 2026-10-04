// Installs the localized application menu and rebuilds it when the language changes.

import { app, Menu, shell } from 'electron';
import type { Lang } from '@shared/types';
import type { MainContext } from './context';
import { buildMenuTemplate } from './menuTemplate';
import { showAndEmit } from './showAndEmit';

export function installMenu(ctx: MainContext): void {
  app.setAboutPanelOptions({
    applicationName: 'Tape',
    applicationVersion: app.getVersion(),
    copyright: 'Apache License 2.0',
  });

  const install = (lang: Lang) => {
    const template = buildMenuTemplate({
      platform: process.platform,
      lang,
      isDev: ctx.isDev,
      actions: {
        command: (command) => showAndEmit(ctx, { type: 'command', command }),
        openExternal: (url) => void shell.openExternal(url),
      },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  let lang = ctx.store.getSettings().appearance.language;
  install(lang);
  ctx.store.onSettingsChanged((next) => {
    if (next.appearance.language === lang) return;
    lang = next.appearance.language;
    install(lang);
  });
}
