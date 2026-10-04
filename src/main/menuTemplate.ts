// Application menu template. Pure (Electron types only) so it can be unit tested; menu.ts
// builds and installs it.
//
// App commands are shortcuts the renderer already handles itself (App.tsx), so their
// accelerators are display-only: registerAccelerator is false (Windows/Linux) and clicks that
// come from an accelerator are ignored (macOS sends unhandled key equivalents to the menu).
// Role items keep their native accelerators. While Tape is locked every custom item is disabled
// except Lock; the standard roles (Quit, Hide, Minimize, Close, Edit, …) keep working.

import type { MenuItemConstructorOptions } from 'electron';
import type { AppCommand } from '@shared/ipc';
import type { Lang } from '@shared/types';
import { createMessages } from './i18n';

export const MARKET_DATA_URL = 'https://www.interactivebrokers.com/en/pricing/market-data-pricing.php';
export const API_SETTINGS_URL = 'https://www.interactivebrokers.com/docs/tws-api/doc/tws-settings/tws-configuration-for-api-use/introduction';

const m = createMessages({
  en: {
    about: 'About Tape',
    settings: 'Settings…',
    lock: 'Lock Tape',
    services: 'Services',
    hide: 'Hide Tape',
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quitMac: 'Quit Tape',
    file: 'File',
    quit: 'Quit',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    portfolio: 'Portfolio',
    trade: 'Trade',
    orders: 'Orders',
    search: 'Search…',
    toggleTheme: 'Toggle theme',
    reload: 'Reload',
    devTools: 'Toggle Developer Tools',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullScreen: 'Toggle Full Screen',
    cancelLast: 'Cancel last open order',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front',
    close: 'Close Window',
    help: 'Help',
    marketData: 'IBKR market data subscriptions',
    apiHelp: 'API settings help',
  },
  zh: {
    about: '关于 Tape',
    settings: '设置…',
    lock: '锁定 Tape',
    services: '服务',
    hide: '隐藏 Tape',
    hideOthers: '隐藏其他',
    showAll: '全部显示',
    quitMac: '退出 Tape',
    file: '文件',
    quit: '退出',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    view: '视图',
    portfolio: '组合',
    trade: '交易',
    orders: '订单',
    search: '搜索…',
    toggleTheme: '切换主题',
    reload: '重新加载',
    devTools: '开发者工具',
    actualSize: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    fullScreen: '切换全屏',
    cancelLast: '撤销最后一笔挂单',
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    front: '前置全部窗口',
    close: '关闭窗口',
    help: '帮助',
    marketData: 'IBKR 行情订阅',
    apiHelp: 'API 设置帮助',
  },
});

export interface MenuActions {
  command(command: AppCommand): void;
  openExternal(url: string): void;
  /** Locks Tape (main asks the renderer for a PIN first when none is set). */
  lock(): void;
}

export interface MenuOptions {
  platform: NodeJS.Platform;
  lang: Lang;
  isDev: boolean;
  /** Tape is locked: custom items other than Lock are disabled. */
  locked?: boolean;
  actions: MenuActions;
}

const separator: MenuItemConstructorOptions = { type: 'separator' };

export function buildMenuTemplate({ platform, lang, isDev, locked = false, actions }: MenuOptions): MenuItemConstructorOptions[] {
  const t = m(lang);
  const mac = platform === 'darwin';

  const command = (label: string, accelerator: string, cmd: AppCommand): MenuItemConstructorOptions => ({
    id: cmd,
    label,
    accelerator,
    registerAccelerator: false,
    enabled: !locked,
    click: (_item, _window, event) => {
      if (!event?.triggeredByAccelerator) actions.command(cmd);
    },
  });
  const link = (label: string, url: string): MenuItemConstructorOptions => ({ label, enabled: !locked, click: () => actions.openExternal(url) });
  // ⌘L / Ctrl+L is handled by the renderer like the other shortcuts (⌘⇧L is the theme toggle).
  const lockItem: MenuItemConstructorOptions = {
    id: 'lock',
    label: t.lock,
    accelerator: 'CmdOrCtrl+L',
    registerAccelerator: false,
    click: (_item, _window, event) => {
      if (!event?.triggeredByAccelerator) actions.lock();
    },
  };

  const appMenu: MenuItemConstructorOptions = {
    label: 'Tape',
    submenu: [
      { label: t.about, role: 'about' },
      separator,
      command(t.settings, 'CmdOrCtrl+,', 'open-settings'),
      lockItem,
      separator,
      { label: t.services, role: 'services' },
      separator,
      { label: t.hide, role: 'hide' },
      { label: t.hideOthers, role: 'hideOthers' },
      { label: t.showAll, role: 'unhide' },
      separator,
      { label: t.quitMac, role: 'quit' },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: t.file,
    submenu: [command(t.settings, 'CmdOrCtrl+,', 'open-settings'), lockItem, separator, { label: t.quit, role: 'quit' }],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: t.edit,
    submenu: [
      { label: t.undo, role: 'undo' },
      { label: t.redo, role: 'redo' },
      separator,
      { label: t.cut, role: 'cut' },
      { label: t.copy, role: 'copy' },
      { label: t.paste, role: 'paste' },
      { label: t.selectAll, role: 'selectAll' },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: t.view,
    submenu: [
      command(t.portfolio, 'CmdOrCtrl+1', 'page-portfolio'),
      command(t.trade, 'CmdOrCtrl+2', 'page-trade'),
      command(t.orders, 'CmdOrCtrl+3', 'page-orders'),
      separator,
      command(t.search, 'CmdOrCtrl+K', 'focus-search'),
      command(t.toggleTheme, 'CmdOrCtrl+Shift+L', 'toggle-theme'),
      separator,
      ...(isDev
        ? [{ label: t.reload, role: 'reload' } as const, { label: t.devTools, role: 'toggleDevTools' } as const, separator]
        : []),
      { label: t.actualSize, role: 'resetZoom' },
      { label: t.zoomIn, role: 'zoomIn' },
      { label: t.zoomOut, role: 'zoomOut' },
      separator,
      { label: t.fullScreen, role: 'togglefullscreen' },
    ],
  };

  const tradeMenu: MenuItemConstructorOptions = {
    label: t.trade,
    submenu: [command(t.cancelLast, 'CmdOrCtrl+Backspace', 'cancel-last-order')],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: t.window,
    role: 'window',
    submenu: mac
      ? [{ label: t.minimize, role: 'minimize' }, { label: t.zoom, role: 'zoom' }, separator, { label: t.front, role: 'front' }]
      : [{ label: t.minimize, role: 'minimize' }, { label: t.close, role: 'close' }],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: t.help,
    role: 'help',
    submenu: [
      link(t.marketData, MARKET_DATA_URL),
      link(t.apiHelp, API_SETTINGS_URL),
      ...(mac ? [] : [separator, { label: t.about, role: 'about' } as const]),
    ],
  };

  return [mac ? appMenu : fileMenu, editMenu, viewMenu, tradeMenu, windowMenu, helpMenu];
}
