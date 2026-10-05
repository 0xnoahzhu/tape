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

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app } from 'electron';
import { defaultSettings, defaultWatchlists } from '@shared/defaults';
import type { AppNotification, DeepPartial, NavPoint, PriceAlert, Settings, Watchlist } from '@shared/types';
import type { AppStore } from './context';
import { createMessages } from './i18n';
import { openJsonFile, type JsonFile } from './jsonFile';
import { createNotification, prependNotification } from './notificationModel';
import {
  applySettingsPatch,
  capNotifications,
  hadReadOnlyMode,
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

const m = createMessages({
  en: {
    readOnlyRemovedTitle: 'Read-only mode was removed',
    readOnlyRemovedBody:
      'Tape no longer has its own read-only mode, which you had on: orders you send now go to IB. To block them, turn on “Read-Only API” in IB Gateway › Configure › Settings › API › Settings (TWS: Global Configuration › API › Settings).',
  },
  zh: {
    readOnlyRemovedTitle: '只读模式已移除',
    readOnlyRemovedBody:
      'Tape 已移除自带的只读模式（你之前开启了它），发出的订单会直接交给 IB。如需禁止下单，请在 IB Gateway › Configure › Settings › API › Settings（TWS：Global Configuration › API › Settings）中打开 “Read-Only API”。',
  },
});

export function createStore(): AppStore {
  const dir = app.getPath('userData');
  const file = <T>(name: string, parse: (raw: unknown) => T | null, fallback: () => T, pretty = true): JsonFile<T> =>
    openJsonFile<T>(join(dir, name), { parse: (raw) => parse(raw) ?? undefined, fallback, pretty });

  // app.getLocale() is only available after `ready`; until then the preferred system
  // language stands in (it only matters on first launch, before any window exists).
  const provisionalLanguage = languageFromLocale(app.getPreferredSystemLanguages()[0]);

  let readOnlyRemoved = false;
  const settings = file<Settings>(
    'settings.json',
    (raw) => {
      if (!isObject(raw)) return null;
      readOnlyRemoved = hadReadOnlyMode(raw);
      return loadSettings(raw, defaultSettings(provisionalLanguage, process.platform));
    },
    () => defaultSettings(provisionalLanguage, process.platform),
  );
  const watchlists = file<Watchlist[]>('watchlists.json', (raw) => sanitizeWatchlists(raw, defaultWatchlists()), defaultWatchlists);
  const alerts = file<PriceAlert[]>('alerts.json', sanitizeAlerts, () => []);
  const notifications = file<AppNotification[]>('notifications.json', sanitizeNotifications, () => [], false);
  const nav = file<NavPoint[]>('nav.json', sanitizeNav, () => [], false);
  const windowBounds = file<WindowBounds | null>('window.json', sanitizeWindowBounds, () => null);
  const files: JsonFile<unknown>[] = [settings, watchlists, alerts, notifications, nav, windowBounds];

  // The saved settings still had the removed read-only switch on: say so in the notification
  // list, and save the settings without the key so the notice is posted once.
  if (readOnlyRemoved) {
    const notice = createNotification(
      { kind: 'sys', title: m.both((t) => t.readOnlyRemovedTitle), body: m.both((t) => t.readOnlyRemovedBody) },
      randomUUID(),
      Date.now(),
    );
    notifications.set(prependNotification(notifications.get(), notice));
    settings.set(settings.get());
  }

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
