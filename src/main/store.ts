// Persistent application data: one JSON file per kind of data in app.getPath('userData').
//
//   settings.json       Settings (validated and deep-merged over the defaults)
//   watchlists.json     Watchlist[]
//   alerts.json         PriceAlert[]
//   notifications.json  AppNotification[] (newest first, capped)
//   nav.json            NavPoint[] (oldest first); legacy: imported once into tape.db, then emptied
//   window.json         main window bounds
//
// The store never emits IPC events; index.ts broadcasts changes.

import { join } from 'node:path';
import { app } from 'electron';
import { defaultSettings, defaultWatchlists } from '@shared/defaults';
import type { AppNotification, DeepPartial, NavPoint, PriceAlert, Settings, Watchlist } from '@shared/types';
import type { AppStore } from './context';
import { openJsonFile, type JsonFile } from './jsonFile';
import {
  applySettingsPatch,
  capNotifications,
  isObject,
  languageFromLocale,
  loadSettings,
  sameData,
  sanitizeAlerts,
  sanitizeNav,
  sanitizeNotifications,
  sanitizeWatchlists,
  sanitizeWindowBounds,
  type WindowBounds,
} from './storeSchema';

type SettingsListener = (next: Settings, prev: Settings) => void;

export function createStore(): AppStore {
  const dir = app.getPath('userData');
  const file = <T>(name: string, parse: (raw: unknown) => T | null, fallback: () => T, pretty = true): JsonFile<T> =>
    openJsonFile<T>(join(dir, name), { parse: (raw) => parse(raw) ?? undefined, fallback, pretty });

  // app.getLocale() is only available after `ready`; until then the preferred system
  // language stands in (it only matters on first launch, before any window exists).
  const provisionalLanguage = languageFromLocale(app.getPreferredSystemLanguages()[0]);

  const settings = file<Settings>(
    'settings.json',
    (raw) => (isObject(raw) ? loadSettings(raw, defaultSettings(provisionalLanguage)) : null),
    () => defaultSettings(provisionalLanguage),
  );
  const watchlists = file<Watchlist[]>('watchlists.json', (raw) => sanitizeWatchlists(raw, defaultWatchlists()), defaultWatchlists);
  const alerts = file<PriceAlert[]>('alerts.json', sanitizeAlerts, () => []);
  const notifications = file<AppNotification[]>('notifications.json', sanitizeNotifications, () => [], false);
  const nav = file<NavPoint[]>('nav.json', sanitizeNav, () => [], false);
  const windowBounds = file<WindowBounds | null>('window.json', sanitizeWindowBounds, () => null);
  const files: JsonFile<unknown>[] = [settings, watchlists, alerts, notifications, nav, windowBounds];

  const listeners = new Set<SettingsListener>();

  function commitSettings(next: Settings): Settings {
    const prev = settings.get();
    if (sameData(prev, next)) return prev;
    settings.set(next);
    for (const listener of [...listeners]) {
      try {
        listener(next, prev);
      } catch (err) {
        console.error('[store] settings listener failed:', err);
      }
    }
    return next;
  }

  // First launch (or unreadable settings): pick the language from the app locale and save.
  if (settings.status !== 'ok') {
    const firstLaunch = () => {
      const current = settings.get();
      commitSettings({ ...current, appearance: { ...current.appearance, language: languageFromLocale(app.getLocale()) } });
      // Save even when nothing changed, so the next launch is not a first launch again.
      settings.set(settings.get());
    };
    if (app.isReady()) firstLaunch();
    else void app.whenReady().then(firstLaunch);
  }

  return {
    getSettings: () => settings.get(),
    updateSettings: (patch: DeepPartial<Settings>) => commitSettings(applySettingsPatch(settings.get(), patch)),
    onSettingsChanged(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    getWatchlists: () => watchlists.get(),
    setWatchlists(lists) {
      const clean = sanitizeWatchlists(lists, defaultWatchlists());
      if (clean) watchlists.set(clean);
      else console.warn('[store] ignored invalid watchlists');
    },

    getPriceAlerts: () => alerts.get(),
    setPriceAlerts(list) {
      const clean = sanitizeAlerts(list);
      if (clean) alerts.set(clean);
      else console.warn('[store] ignored invalid price alerts');
    },

    getNotifications: () => notifications.get(),
    // Written by the notifier only, which keeps the list newest first.
    setNotifications: (list) => notifications.set(capNotifications(list)),

    // NAV history lives in the database (ctx.db.nav); these only serve its one-time import.
    getNav: () => nav.get(),
    setNav: (points) => nav.set(points),

    getWindowBounds: () => windowBounds.get(),
    setWindowBounds(b) {
      const clean = sanitizeWindowBounds(b);
      if (clean) windowBounds.set(clean);
    },

    flush() {
      for (const f of files) f.flush();
    },
  };
}
