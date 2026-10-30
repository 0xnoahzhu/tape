// Persistent application data, as JSON files.
//
// This computer's, in app.getPath('userData'):
//   settings.json       Settings (validated and deep-merged over the defaults)
//   window.json         main window bounds
//   vault.json          where the data folder is and the account it served last (vault.ts)
//
// The user's, per IB account in the data folder (vault.ts → accountDir):
//   watchlists.json     Watchlist[]
//   alerts.json         PriceAlert[]
//   notifications.json  AppNotification[] (newest first, capped)
//
// There is no data folder until the user chooses one (the renderer's first-launch screen insists:
// VaultSetup). Only one account's files are open: the connected login's account, else the last one
// connected on this computer (setAccount). Before the first, or without a usable data folder, the
// watchlists are the defaults and cannot be changed, there are no alerts, and notifications are kept
// for this run only.
//
// The store never emits IPC events; index.ts broadcasts changes.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { defaultSettings, defaultUpColor, defaultWatchlists } from '@shared/defaults';
import type { AppNotification, DeepPartial, LocalizedText, PriceAlert, Settings, VaultState, Watchlist } from '@shared/types';
import type { AppStore } from './context';
import { createMessages } from './i18n';
import { openJsonFile, type JsonFile } from './jsonFile';
import { createNotification, prependNotification } from './notificationModel';
import {
  applySettingsPatch,
  capNotifications,
  hadOpenEndedDnd,
  hadReadOnlyMode,
  isObject,
  languageFromLocale,
  loadSettings,
  sameData,
  sanitizeAlerts,
  sanitizeNotifications,
  sanitizeWatchlists,
  sanitizeWindowBounds,
  type WindowBounds,
} from './storeSchema';
import { accountDir, copyVault, createVault, inspectVault, isAccountId, VAULT_MARKER, VAULT_POINTER } from './vault';

/** How often the data folder in use is checked for being there (an unplugged drive, a deleted folder). */
export const VAULT_WATCH_MS = 3_000;

type SettingsListener = (next: Settings, prev: Settings) => void;

interface VaultPointer {
  /** The folder the user chose; absent until the first launch's choice. */
  path?: string;
  lastAccount?: string;
}

/** One account's files in the data folder. */
interface AccountFiles {
  watchlists: JsonFile<Watchlist[]>;
  alerts: JsonFile<PriceAlert[]>;
  notifications: JsonFile<AppNotification[]>;
}

function sanitizePointer(raw: unknown): VaultPointer | null {
  if (!isObject(raw)) return null;
  const p: VaultPointer = {};
  if (typeof raw.path === 'string' && raw.path.length > 0) p.path = raw.path;
  if (isAccountId(raw.lastAccount)) p.lastAccount = raw.lastAccount;
  return p;
}

const m = createMessages({
  en: {
    readOnlyRemovedTitle: 'Read-only mode was removed',
    readOnlyRemovedBody:
      'Tape no longer has its own read-only mode, which you had on: orders you send now go to IB. To block them, turn on “Read-Only API” in IB Gateway › Configure › Settings › API › Settings (TWS: Global Configuration › API › Settings).',
    dndOffTitle: 'Do not disturb was turned off',
    dndOffBody:
      'Do not disturb was on with no end, which could keep fills and order updates out of the notification center for days. It now ends by itself, after an hour or at 9:00 AM New York time, and never holds back order rejections, connection loss or option risk alerts. Turn it on again in Settings › Notifications.',
    noAccount: 'Connect to IB first: watchlists and price alerts are kept per account',
    unavailable: 'The data folder is not available (moved, deleted, or on a drive that is not connected). Tape cannot be used until it is back or another folder is chosen',
    unset: 'Choose a data folder first',
    folderInUse: 'This folder holds other files. Choose an empty folder or a Tape data folder',
    folderNewer: 'This data folder was written by a newer version of Tape. Update Tape to use it',
    folderGone: 'This folder is not available',
    moveNotEmpty: 'Data can only be moved into an empty folder',
    sameFolder: 'This is the current data folder',
  },
  zh: {
    readOnlyRemovedTitle: '只读模式已移除',
    readOnlyRemovedBody:
      'Tape 已移除自带的只读模式（你之前开启了它），发出的订单会直接交给 IB。如需禁止下单，请在 IB Gateway › Configure › Settings › API › Settings（TWS：Global Configuration › API › Settings）中打开 “Read-Only API”。',
    dndOffTitle: '勿扰模式已关闭',
    dndOffBody:
      '之前的勿扰模式没有结束时间，可能让成交和订单通知好几天都不进系统通知中心。现在勿扰模式会自动结束（1 小时后，或美东时间上午 9:00），并且不会拦下订单被拒、连接中断和期权风险提醒。可在 设置 › 通知 中重新开启。',
    noAccount: '请先连接 IB：自选列表和价格提醒按账户保存',
    unavailable: '数据目录不可用（被移动、删除，或所在的硬盘未连接）。在它恢复或选择其他文件夹之前，Tape 无法使用',
    unset: '请先选择数据目录',
    folderInUse: '这个文件夹里有其他文件。请选择空文件夹或 Tape 数据目录',
    folderNewer: '这个数据目录由更新版本的 Tape 写入。请先更新 Tape',
    folderGone: '这个文件夹不可用',
    moveNotEmpty: '只能把数据移动到空文件夹',
    sameFolder: '这就是当前的数据目录',
  },
});

export function createStore(): AppStore {
  const dir = app.getPath('userData');
  const file = <T>(path: string, parse: (raw: unknown) => T | null, fallback: () => T, pretty = true, canWrite?: () => boolean): JsonFile<T> =>
    openJsonFile<T>(path, { parse: (raw) => parse(raw) ?? undefined, fallback, pretty, canWrite });
  const local = <T>(name: string, parse: (raw: unknown) => T | null, fallback: () => T): JsonFile<T> => file(join(dir, name), parse, fallback);

  // app.getLocale() is only available after `ready`; until then the preferred system
  // language stands in (it only matters on first launch, before any window exists).
  const provisionalLanguage = languageFromLocale(app.getPreferredSystemLanguages()[0]);

  let readOnlyRemoved = false;
  let dndTurnedOff = false;
  const settings = local<Settings>(
    'settings.json',
    (raw) => {
      if (!isObject(raw)) return null;
      readOnlyRemoved = hadReadOnlyMode(raw);
      dndTurnedOff = hadOpenEndedDnd(raw);
      return loadSettings(raw, defaultSettings(provisionalLanguage, process.platform));
    },
    () => defaultSettings(provisionalLanguage, process.platform),
  );
  const windowBounds = local<WindowBounds | null>('window.json', sanitizeWindowBounds, () => null);
  const pointer = local<VaultPointer>(VAULT_POINTER, sanitizePointer, () => ({}));
  const text = () => m(settings.get().appearance.language);

  // ---------------------------------------------------------------------------
  // The data folder and the account it serves

  // Development and capture runs (isolated profiles) may name one instead of the first-launch choice.
  const devVault = !app.isPackaged ? process.env.TAPE_VAULT_DIR : undefined;
  if (devVault && pointer.get().path === undefined) {
    if (inspectVault(devVault) === 'empty') createVault(devVault);
    pointer.set({ ...pointer.get(), path: devVault });
  }
  const vaultPath = () => pointer.get().path ?? null;
  let vaultStatus: VaultState['status'] = 'unset';
  let account: string | null = null;
  let open: AccountFiles | null = null;
  /** The lists while no account's files are open (see the header). */
  let watchlistsNow: Watchlist[] = defaultWatchlists();
  let alertsNow: PriceAlert[] = [];
  let notificationsNow: AppNotification[] = [];
  const vaultListeners = new Set<(vault: VaultState) => void>();
  let watchTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the chosen folder can be used. A folder that is gone is never made again where it was. */
  function checkVault(): VaultState['status'] {
    const path = vaultPath();
    if (path === null) return 'unset';
    try {
      const check = inspectVault(path);
      return check === 'vault' ? 'ok' : check === 'newer' ? 'newer' : 'unavailable';
    } catch (err) {
      console.error(`[store] data folder ${path} unavailable:`, err);
      return 'unavailable';
    }
  }

  /** The marker is still there (a write would otherwise make the folders again where the vault was). */
  const vaultThere = () => {
    const path = vaultPath();
    const there = path !== null && existsSync(join(path, VAULT_MARKER));
    if (!there) queueMicrotask(watch);
    return there;
  };

  function openAccount(acct: string, path: string): AccountFiles {
    const base = accountDir(path, acct);
    return {
      watchlists: file(join(base, 'watchlists.json'), (raw) => sanitizeWatchlists(raw, defaultWatchlists()), defaultWatchlists, true, vaultThere),
      alerts: file(join(base, 'alerts.json'), sanitizeAlerts, () => [], true, vaultThere),
      notifications: file(join(base, 'notifications.json'), sanitizeNotifications, () => [], false, vaultThere),
    };
  }

  /** Writes what is pending (unless the folder is gone: then it is dropped) and closes the files. */
  function closeAccount(): void {
    if (open) for (const f of Object.values(open)) f.flush();
    open = null;
  }

  /** Opens the files of `account` in the current folder, or none (see the header). */
  function load(): void {
    closeAccount();
    const path = vaultPath();
    if (account && path !== null && vaultStatus === 'ok') open = openAccount(account, path);
    watchlistsNow = defaultWatchlists();
    alertsNow = [];
    notificationsNow = [];
    if (vaultStatus === 'ok') {
      if (!watchTimer) {
        watchTimer = setInterval(watch, VAULT_WATCH_MS);
        watchTimer.unref?.();
      }
    } else if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }

  const vaultState = (): VaultState => ({ path: vaultPath(), status: vaultStatus, account });

  function vaultChanged(): void {
    const state = vaultState();
    for (const listener of [...vaultListeners]) {
      try {
        listener(state);
      } catch (err) {
        console.error('[store] data folder listener failed:', err);
      }
    }
  }

  /** The folder in use went away (an unplugged drive, deleted, moved): nothing is read or written from now on. */
  function watch(): void {
    if (vaultStatus !== 'ok') return;
    const status = checkVault();
    if (status === 'ok') return;
    vaultStatus = status;
    load();
    vaultChanged();
  }

  vaultStatus = checkVault();
  account = pointer.get().lastAccount ?? null;
  load();

  const getWatchlists = () => open?.watchlists.get() ?? watchlistsNow;
  const getNotifications = () => open?.notifications.get() ?? notificationsNow;
  const setNotifications = (list: AppNotification[]) => {
    const capped = capNotifications(list);
    if (open) open.notifications.set(capped);
    else notificationsNow = capped;
  };
  const problem = (): string | null =>
    vaultStatus === 'ok' ? null : vaultStatus === 'unset' ? text().unset : vaultStatus === 'newer' ? text().folderNewer : text().unavailable;
  /** The files a change is written to; throws (in the user's language) when there are none. */
  const writable = (): AccountFiles => {
    if (open) return open;
    throw new Error(problem() ?? text().noAccount);
  };

  // The saved settings still had a removed switch on (Tape's read-only mode; the do-not-disturb
  // without an end): say so in the notification list, and save the settings without the key so
  // the notice is posted once.
  const notices: Array<{ title: LocalizedText; body: LocalizedText }> = [];
  if (readOnlyRemoved) notices.push({ title: m.both((t) => t.readOnlyRemovedTitle), body: m.both((t) => t.readOnlyRemovedBody) });
  if (dndTurnedOff) notices.push({ title: m.both((t) => t.dndOffTitle), body: m.both((t) => t.dndOffBody) });
  if (notices.length) {
    for (const n of notices) setNotifications(prependNotification(getNotifications(), createNotification({ kind: 'sys', ...n }, randomUUID(), Date.now())));
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

  // First launch (or unreadable settings): pick the language from the app locale, and the up /
  // down colours of that language (the provisional language may differ), and save.
  if (settings.status !== 'ok') {
    const firstLaunch = () => {
      const current = settings.get();
      const language = languageFromLocale(app.getLocale());
      commitSettings({ ...current, appearance: { ...current.appearance, language, upColor: defaultUpColor(language) } });
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

    getVault: vaultState,
    vaultProblem: problem,
    setAccount(next) {
      if (!isAccountId(next) || next === account) return;
      account = next;
      pointer.set({ ...pointer.get(), lastAccount: next });
      load();
      vaultChanged();
    },
    setVaultDir(path, how) {
      const current = vaultPath();
      // The folder in use, chosen again while it cannot be used: looked at again (a drive back).
      if (path === current && vaultStatus === 'ok') throw new Error(text().sameFolder);
      const check = inspectVault(path);
      if (check === 'newer') throw new Error(text().folderNewer);
      if (check === 'other') throw new Error(text().folderInUse);
      if (how === 'move' && vaultStatus === 'ok' && current !== null) {
        if (check !== 'empty') throw new Error(text().moveNotEmpty);
        // What is pending goes to disk first, so the copy has it.
        closeAccount();
        copyVault(current, path);
      } else if (check === 'empty') {
        createVault(path);
      }
      closeAccount();
      pointer.set({ ...pointer.get(), path });
      pointer.flush();
      vaultStatus = checkVault();
      load();
      vaultChanged();
      if (vaultStatus !== 'ok') throw new Error(text().folderGone);
      return vaultState();
    },
    recheckVault() {
      if (vaultStatus === 'ok' || vaultStatus === 'unset') return vaultState();
      // Back as it was (a drive connected again); an emptied folder stays unavailable.
      const status = checkVault();
      if (status === vaultStatus) return vaultState();
      vaultStatus = status;
      load();
      vaultChanged();
      return vaultState();
    },
    onVaultChanged(listener) {
      vaultListeners.add(listener);
      return () => void vaultListeners.delete(listener);
    },

    getWatchlists,
    setWatchlists(lists) {
      const files = writable();
      const clean = sanitizeWatchlists(lists, defaultWatchlists());
      if (clean) files.watchlists.set(clean);
      else console.warn('[store] ignored invalid watchlists');
    },

    getPriceAlerts: () => open?.alerts.get() ?? alertsNow,
    setPriceAlerts(list) {
      const files = writable();
      const clean = sanitizeAlerts(list);
      if (clean) files.alerts.set(clean);
      else console.warn('[store] ignored invalid price alerts');
    },

    getNotifications,
    // Written by the notifier only, which keeps the list newest first.
    setNotifications,
    addNotificationFor(other, item) {
      if (other === account) return setNotifications(prependNotification(getNotifications(), item));
      const path = vaultPath();
      if (!isAccountId(other) || path === null || vaultStatus !== 'ok') return;
      const list = file(join(accountDir(path, other), 'notifications.json'), sanitizeNotifications, () => [], false, vaultThere);
      list.set(capNotifications(prependNotification(list.get(), item)));
      list.flush();
    },

    getWindowBounds: () => windowBounds.get(),
    setWindowBounds(b) {
      const clean = sanitizeWindowBounds(b);
      if (clean) windowBounds.set(clean);
    },

    flush() {
      for (const f of [settings, windowBounds, pointer]) f.flush();
      if (open) for (const f of Object.values(open)) f.flush();
    },
  };
}
