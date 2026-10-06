import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/defaults';
import type { TapeEvent } from '@shared/ipc';
import type { Settings } from '@shared/types';
import type { MainContext } from './context';

// nativeTheme stand-in: themeSource resolves against a fake OS appearance; 'updated' is emitted
// asynchronously in Electron, tests emit it by hand.
const fake = vi.hoisted(() => ({
  systemDark: false,
  dockIcons: [] as string[],
  packaged: false,
  finderEnv: null as unknown,
  finderWants: [] as boolean[],
}));
// The Finder icon's own behavior is tested in finderIcon.test.ts; here only what appearance asks of it.
vi.mock('./finderIcon', () => ({
  finderIconFor: (env: unknown) => {
    fake.finderEnv = env;
    return { want: (dark: boolean) => fake.finderWants.push(dark), idle: () => Promise.resolve() };
  },
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class NativeTheme extends EventEmitter {
    themeSource: 'system' | 'dark' | 'light' = 'system';
    get shouldUseDarkColors() {
      return this.themeSource === 'system' ? fake.systemDark : this.themeSource === 'dark';
    }
  }
  return {
    nativeTheme: new NativeTheme(),
    nativeImage: { createFromPath: (path: string) => ({ path, isEmpty: () => false }) },
    app: {
      get isPackaged() {
        return fake.packaged;
      },
      isReady: () => true,
      whenReady: () => Promise.resolve(),
      getAppPath: () => '/app',
      getPath: (name: string) => ({ exe: '/Applications/Tape.app/Contents/MacOS/Tape', home: '/Users/n' })[name],
      hasSingleInstanceLock: () => true,
      dock: { setIcon: (img: { path: string }) => fake.dockIcons.push(img.path.split('/').pop()!) },
    },
  };
});

const { nativeTheme } = await import('electron');
const { createAppearance } = await import('./appearance');

type Listener = (next: Settings, prev: Settings) => void;

function setup(theme: Settings['appearance']['theme']) {
  let settings: Settings = { ...defaultSettings(), appearance: { ...defaultSettings().appearance, theme } };
  const listeners: Listener[] = [];
  const events: TapeEvent[] = [];
  const ctx = {
    emit: (e: TapeEvent) => events.push(e),
    store: {
      getSettings: () => settings,
      onSettingsChanged: (l: Listener) => listeners.push(l),
    },
  } as unknown as MainContext;
  const appearance = createAppearance(ctx);
  const update = (next: Settings['appearance']['theme']) => {
    const prev = settings;
    settings = { ...settings, appearance: { ...settings.appearance, theme: next } };
    listeners.forEach((l) => l(settings, prev));
  };
  const win = { isDestroyed: () => false, once: vi.fn(), setBackgroundColor: vi.fn(), setIcon: vi.fn() };
  return { appearance, events, update, win };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Appearance', () => {
  const platform = process.platform;
  beforeEach(() => {
    fake.systemDark = false;
    fake.dockIcons.length = 0;
    fake.packaged = false;
    fake.finderEnv = null;
    fake.finderWants.length = 0;
    nativeTheme.removeAllListeners();
  });
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));

  it('applies the theme setting and the matching dock icon at startup', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { appearance } = setup('dark');
    expect(nativeTheme.themeSource).toBe('dark');
    expect(appearance.isDark()).toBe(true);
    await flush();
    expect(fake.dockIcons).toEqual(['icon-dark.png']);
  });

  it('switches icon and window background when the theme setting changes', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { appearance, update, win, events } = setup('dark');
    await flush();
    appearance.attach(win as never);
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#15181A');
    update('light');
    expect(nativeTheme.themeSource).toBe('light');
    expect(fake.dockIcons).toEqual(['icon-dark.png', 'icon-light.png']);
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#EAEDEA');
    // The 'updated' event caused by our own change is not re-broadcast (index.ts broadcasts it).
    nativeTheme.emit('updated');
    expect(events).toEqual([]);
    expect(win.setIcon).not.toHaveBeenCalled();
  });

  it('follows the OS appearance while on "system" and broadcasts it', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { events } = setup('system');
    await flush();
    expect(fake.dockIcons).toEqual(['icon-light.png']);
    fake.systemDark = true;
    nativeTheme.emit('updated');
    expect(fake.dockIcons).toEqual(['icon-light.png', 'icon-dark.png']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'settings', dark: true });
    // Unrelated 'updated' events (e.g. high contrast) change nothing.
    nativeTheme.emit('updated');
    expect(events).toHaveLength(1);
  });

  it('packaged on macOS, the Finder icon follows the resolved theme', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    fake.packaged = true;
    const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', { value: '/Applications/Tape.app/Contents/Resources', configurable: true });
    try {
      const { update } = setup('system');
      expect(fake.finderEnv).toMatchObject({ platform: 'darwin', primary: true, exe: '/Applications/Tape.app/Contents/MacOS/Tape', home: '/Users/n' });
      await flush();
      expect(fake.finderWants).toEqual([false]);
      fake.systemDark = true;
      nativeTheme.emit('updated');
      expect(fake.finderWants).toEqual([false, true]);
      // Only changes of the resolved theme reach it.
      nativeTheme.emit('updated');
      update('dark');
      expect(fake.finderWants).toEqual([false, true]);
      update('light');
      expect(fake.finderWants).toEqual([false, true, false]);
    } finally {
      if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath);
      else delete (process as { resourcesPath?: string }).resourcesPath;
    }
  });

  it('leaves the Finder icon alone when not packaged and on other platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    setup('dark');
    await flush();
    expect(fake.finderEnv).toBeNull();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    fake.packaged = true;
    setup('dark');
    await flush();
    expect(fake.finderEnv).toBeNull();
  });

  it('sets the window icon on Windows and Linux instead of the dock', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { appearance, update, win } = setup('light');
    await flush();
    appearance.attach(win as never);
    expect(win.setIcon.mock.calls.at(-1)?.[0].path).toMatch(/icon-light-256\.png$/);
    update('dark');
    expect(win.setIcon.mock.calls.at(-1)?.[0].path).toMatch(/icon-dark-256\.png$/);
    expect(fake.dockIcons).toEqual([]);
  });
});
