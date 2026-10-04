import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { AppCommand } from '@shared/ipc';
import { API_SETTINGS_URL, MARKET_DATA_URL, buildMenuTemplate, type MenuOptions } from './menuTemplate';

type Item = MenuItemConstructorOptions;
type Click = (item: never, window: never, event: { triggeredByAccelerator?: boolean }) => void;

function build(overrides: Partial<MenuOptions> = {}) {
  const command = vi.fn<(c: AppCommand) => void>();
  const openExternal = vi.fn<(url: string) => void>();
  const template = buildMenuTemplate({ platform: 'darwin', lang: 'en', isDev: false, actions: { command, openExternal }, ...overrides });
  return { template, command, openExternal };
}

const flatten = (items: Item[]): Item[] => items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu as Item[]) : [])]);
const find = (items: Item[], pred: (i: Item) => boolean) => flatten(items).find(pred);
const click = (item: Item | undefined, triggeredByAccelerator = false) => (item!.click as unknown as Click)(undefined as never, undefined as never, { triggeredByAccelerator });

describe('buildMenuTemplate', () => {
  it('has the macOS menus in order', () => {
    const { template } = build();
    expect(template.map((m) => m.label)).toEqual(['Tape', 'Edit', 'View', 'Trade', 'Window', 'Help']);
  });

  it('uses a File menu with Settings and Quit on Windows and Linux', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const { template } = build({ platform });
      expect(template[0].label).toBe('File');
      const file = template[0].submenu as Item[];
      expect(file[0]).toMatchObject({ id: 'open-settings', accelerator: 'CmdOrCtrl+,' });
      expect(file.some((i) => i.role === 'quit')).toBe(true);
      expect(find(template, (i) => i.role === 'services')).toBeUndefined();
    }
  });

  it('keeps the clipboard roles needed by text inputs', () => {
    const { template } = build();
    const roles = flatten(template).map((i) => i.role);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) expect(roles).toContain(role);
  });

  it('app commands show accelerators without registering them', () => {
    const { template } = build();
    const commands = flatten(template).filter((i) => i.id && !i.role);
    expect(commands.map((i) => [i.id, i.accelerator])).toEqual([
      ['open-settings', 'CmdOrCtrl+,'],
      ['page-portfolio', 'CmdOrCtrl+1'],
      ['page-trade', 'CmdOrCtrl+2'],
      ['page-orders', 'CmdOrCtrl+3'],
      ['focus-search', 'CmdOrCtrl+K'],
      ['toggle-theme', 'CmdOrCtrl+Shift+L'],
      ['cancel-last-order', 'CmdOrCtrl+Backspace'],
    ]);
    for (const item of commands) expect(item.registerAccelerator).toBe(false);
  });

  it('sends commands on click but ignores accelerator-triggered clicks', () => {
    const { template, command } = build();
    const item = find(template, (i) => i.id === 'toggle-theme');
    click(item, true);
    expect(command).not.toHaveBeenCalled();
    click(item);
    expect(command).toHaveBeenCalledWith('toggle-theme');
  });

  it('shows developer items only in development', () => {
    expect(find(build().template, (i) => i.role === 'toggleDevTools')).toBeUndefined();
    expect(find(build().template, (i) => i.role === 'reload')).toBeUndefined();
    const dev = build({ isDev: true }).template;
    expect(find(dev, (i) => i.role === 'toggleDevTools')).toBeDefined();
    expect(find(dev, (i) => i.role === 'reload')).toBeDefined();
  });

  it('help items open the IBKR pages', () => {
    const { template, openExternal } = build();
    const help = template[template.length - 1].submenu as Item[];
    click(help[0]);
    click(help[1]);
    expect(openExternal.mock.calls).toEqual([[MARKET_DATA_URL], [API_SETTINGS_URL]]);
  });

  it('is localized', () => {
    const en = flatten(build().template);
    const zh = flatten(build({ lang: 'zh' }).template);
    expect(zh).toHaveLength(en.length);
    // Every visible item has a label, and everything except the app name is translated.
    expect(zh.filter((i) => i.type !== 'separator' && !i.label)).toEqual([]);
    const same = zh.filter((i, n) => i.type !== 'separator' && i.label === en[n].label).map((i) => i.label);
    expect(same).toEqual(['Tape']);
  });
});
