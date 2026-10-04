// Main process entry: creates the services, the window and the IPC bridge.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, screen, shell, type WebContents } from 'electron';
import { EVENT_CHANNEL, INVOKE_METHODS, invokeChannel, type InvokeResult, type TapeEvent, type TapeHandlers } from '@shared/ipc';
import type { AppSnapshot } from '@shared/types';
import type { MainContext } from './context';
import { createStore } from './store';
import { createDatabase } from './db';
import { createApiLog, createLogViewers } from './ib/apiLog';
import { createConnection } from './ib/connection';
import { createNotifier } from './notifications';
import { createContractService } from './market/contracts';
import { createQuoteService } from './market/quotes';
import { createHistoryService } from './market/history';
import { createDepthService } from './market/depth';
import { createOptionsService } from './market/options';
import { createAlertService } from './market/alerts';
import { createAccountService } from './ib/account';
import { createOrderService } from './ib/orders';
import { createAppearance, titleBarOverlay } from './appearance';
import { installMenu } from './menu';
import { setupDevCapture } from './devCapture';

const here = fileURLToPath(new URL('.', import.meta.url));
const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;

app.setName('Tape');
// Development: isolate profiles (settings, logs, single-instance lock) per run.
if (process.env.TAPE_USER_DATA) app.setPath('userData', process.env.TAPE_USER_DATA);
// macOS notifications and the dock need a stable app id on Windows as well.
if (process.platform === 'win32') app.setAppUserModelId('app.tape.client');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

const ctx = {
  demo: process.env.TAPE_DEMO === '1',
  isDev,
  emit(event: TapeEvent) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, event);
    }
  },
  getMainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  showMainWindow() {
    const win = ctx.getMainWindow();
    if (!win) return void createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  },
} as MainContext;

// Order matters only for construction; services reach each other lazily through ctx.
ctx.store = createStore();
ctx.db = createDatabase(ctx);
ctx.apiLog = createApiLog(ctx);
ctx.ib = createConnection(ctx);
ctx.notifier = createNotifier(ctx);
ctx.contracts = createContractService(ctx);
ctx.quotes = createQuoteService(ctx);
ctx.history = createHistoryService(ctx);
ctx.depth = createDepthService(ctx);
ctx.options = createOptionsService(ctx);
ctx.alerts = createAlertService(ctx);
ctx.account = createAccountService(ctx);
ctx.orders = createOrderService(ctx);
ctx.appearance = createAppearance(ctx);

const apiLogViewers = createLogViewers(ctx.apiLog);

// Appearance subscribes first (in its factory), so the theme is applied before this broadcast.
ctx.store.onSettingsChanged((settings) => ctx.emit({ type: 'settings', settings, dark: ctx.appearance.isDark() }));

async function snapshot(): Promise<AppSnapshot> {
  // The only async part comes first, so every other field is read in the same tick as the reply.
  const nav = await ctx.db.nav.all().catch(() => []);
  return {
    platform: process.platform,
    appVersion: app.getVersion(),
    demo: ctx.demo,
    settings: ctx.store.getSettings(),
    dark: ctx.appearance.isDark(),
    connection: ctx.ib.getState(),
    account: ctx.account.getSummary(),
    positions: ctx.account.getPositions(),
    orders: ctx.orders.getOrders(),
    executions: ctx.orders.getExecutions(),
    watchlists: ctx.store.getWatchlists(),
    priceAlerts: ctx.store.getPriceAlerts(),
    notifications: ctx.store.getNotifications(),
    nav,
    logFilePath: ctx.apiLog.filePath(),
  };
}

const handlers: TapeHandlers = {
  getSnapshot: async () => snapshot(),
  updateSettings: async (patch) => ctx.store.updateSettings(patch),
  connect: () => ctx.ib.connect(),
  disconnect: () => ctx.ib.disconnect(),
  setQuoteSubscriptions: async (owner, subs) => ctx.quotes.setSubscriptions(owner, subs),
  getHistory: (req) => ctx.history.get(req),
  getOlderBars: (req, before, limit) => ctx.history.getOlder(req, before, limit),
  searchSymbols: (pattern) => ctx.contracts.search(pattern),
  getContractInfo: (c) => ctx.contracts.getInfo(c),
  setDepthSubscription: (c) => ctx.depth.set(c),
  getOptionChainParams: (c) => ctx.options.getChainParams(c),
  placeOrder: (req) => ctx.orders.place(req),
  modifyOrder: (id, req) => ctx.orders.modify(id, req),
  cancelOrder: (id) => ctx.orders.cancel(id),
  cancelAllOrders: () => ctx.orders.cancelAll(),
  refreshExecutions: () => ctx.orders.refreshExecutions(),
  saveWatchlists: async (lists) => {
    ctx.store.setWatchlists(lists);
    ctx.emit({ type: 'watchlists', watchlists: ctx.store.getWatchlists() });
  },
  savePriceAlerts: async (alerts) => ctx.alerts.save(alerts),
  notify: async (n) => void ctx.notifier.notify(n),
  markNotificationsRead: async (ids) => ctx.notifier.markRead(ids),
  testNotification: async () => ctx.notifier.test(),
  getApiLog: async () => ctx.apiLog.getEntries(),
  // `this` is the calling renderer (see below): a reload or a closed window ends its stream.
  setApiLogStreaming: async function (this: WebContents, on) {
    apiLogViewers.set(this, on);
  },
  clearApiLog: async () => {
    ctx.apiLog.clear();
    ctx.emit({ type: 'apiLog', entries: [], reset: true, logFilePath: ctx.apiLog.filePath() });
  },
  exportApiLog: async () => {
    const win = ctx.getMainWindow();
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const options = { defaultPath: `tape-api-${stamp}.log`, filters: [{ name: 'Log', extensions: ['log', 'txt'] }] };
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return null;
    await ctx.apiLog.exportTo(res.filePath);
    return res.filePath;
  },
  revealLogFile: async () => shell.showItemInFolder(ctx.apiLog.filePath()),
  openExternal: async (url) => {
    if (/^https:\/\//.test(url)) await shell.openExternal(url);
  },
};

for (const method of INVOKE_METHODS) {
  const fn = handlers[method] as (...args: unknown[]) => unknown;
  ipcMain.handle(invokeChannel(method), async (event, ...args: unknown[]): Promise<InvokeResult> => {
    try {
      // Handlers that keep per-renderer state read the sender as `this`.
      return { ok: true, value: await fn.apply(event.sender, args) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Saved bounds, or null when they no longer intersect any connected display. */
function visibleSavedBounds() {
  const saved = ctx.store.getWindowBounds();
  if (!saved || saved.x == null || saved.y == null) return saved;
  const { x, y, width, height } = saved;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) => x < a.x + a.width - 80 && x + width > a.x + 80 && y < a.y + a.height - 40 && y + height > a.y);
  return onScreen ? saved : { width, height, maximized: saved.maximized };
}

function createWindow(): BrowserWindow {
  const saved = visibleSavedBounds();
  const win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    ...(saved?.x != null && saved?.y != null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1180,
    minHeight: 720,
    show: false,
    title: 'Tape',
    // The top bar is the title bar (design: macOS traffic lights at the left edge of the bar,
    // Windows caption buttons at the right edge). On Windows / Linux the native caption buttons
    // are drawn as an overlay so snap layouts and hit testing stay native.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 20, y: 22 } }
      : { titleBarOverlay: titleBarOverlay(ctx.appearance.isDark()) }),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow = win;
  ctx.appearance.attach(win);
  if (saved?.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());
  setupDevCapture(win);
  const saveBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    ctx.store.setWindowBounds({ ...win.getNormalBounds(), maximized: win.isMaximized() });
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Links open in the default browser; the app never navigates away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  if (isDev) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else {
    void win.loadFile(join(here, '../renderer/index.html'));
  }
  return win;
}

app.on('second-instance', () => ctx.showMainWindow());

// A failure in the main process must not leave a packaged app running without a window.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception', err);
  if (app.isPackaged) dialog.showErrorBox('Tape', `${err.message}\n\n${err.stack ?? ''}`);
});

app.whenReady().then(() => {
  installMenu(ctx);
  createWindow();
  if (ctx.store.getSettings().connection.autoConnect && process.env.TAPE_NO_CONNECT !== '1') {
    ctx.ib.connect().catch(() => undefined);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else ctx.showMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ctx.store.flush();
  void ctx.db.close();
  void ctx.ib.disconnect();
});
