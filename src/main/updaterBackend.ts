// electron-updater as Tape's UpdaterBackend (updater.ts), for packaged macOS and Windows builds
// that carry update info (resources/app-update.yml, written by electron-builder from its
// `publish` setting). Development, unpacked builds without it and Linux get null: no updates.
// TAPE_NO_UPDATE=1 turns updates off in a packaged build.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { MacUpdater, NsisUpdater, type AppUpdater } from 'electron-updater';
import type { UpdaterBackend } from './updater';

export function createUpdaterBackend(): UpdaterBackend | null {
  if (!app.isPackaged || process.env.TAPE_NO_UPDATE === '1') return null;
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) return null;
  let updater: AppUpdater;
  if (process.platform === 'darwin') updater = new MacUpdater();
  else if (process.platform === 'win32') updater = new NsisUpdater();
  else return null;

  // Tape decides when to download (Settings › About › Automatic updates, updater.ts).
  updater.autoDownload = false;
  // A version downloaded and not installed by a restart installs when Tape quits.
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  // Errors reach Tape through the 'error' event; electron-updater's own info lines are noise.
  updater.logger = { info: () => undefined, warn: (m: unknown) => console.warn('[update]', m), error: (m: unknown) => console.error('[update]', m) };

  return {
    on: (event: string, listener: (...args: never[]) => void) => updater.on(event as 'error', listener as () => void),
    checkForUpdates: () => updater.checkForUpdates(),
    downloadUpdate: () => updater.downloadUpdate(),
    // Windows: the installer runs silently and starts Tape again (the assisted installer's pages
    // are for a first install only). macOS: Squirrel replaces the bundle and relaunches.
    quitAndInstall: () => updater.quitAndInstall(true, true),
  } as UpdaterBackend;
}
