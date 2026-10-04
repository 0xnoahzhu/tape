import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isResetConfirmation, resetWordMatches } from '@shared/lock';
import { defaultSettings } from '@shared/defaults';
import { loadSettings } from '../storeSchema';
import { isTapeFile, readResetMarker, removeResetMarker, RESET_MARKER, startReset, wipeTapeData, writeResetMarker, type ResetFs, type StartResetDeps } from './reset';

/** An in-memory file system: path → contents; directories are implied by their files. */
function fakeFs(files: Record<string, string>, failing: string[] = []) {
  const data = new Map(Object.entries(files));
  const fds = new Map<number, string>();
  let nextFd = 3;
  const fs: ResetFs = {
    existsSync: (p) => data.has(p),
    readFileSync: (p) => {
      const v = data.get(p);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return v;
    },
    writeFileSync: (p, d) => void data.set(p, d),
    readdirSync: (dir) => {
      const names = [...data.keys()].filter((p) => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/')).map((p) => p.slice(dir.length + 1));
      if (!names.length && ![...data.keys()].some((p) => p.startsWith(dir + '/'))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return names;
    },
    rmSync: (p) => {
      if (failing.includes(p)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      data.delete(p);
    },
    openSync: (p) => {
      const fd = nextFd++;
      fds.set(fd, p);
      data.set(p, '');
      return fd;
    },
    writeSync: (fd, d) => {
      const p = fds.get(fd)!;
      data.set(p, data.get(p)! + d);
      return d.length;
    },
    fsyncSync: () => undefined,
    closeSync: (fd) => void fds.delete(fd),
  };
  return { fs, data };
}

const UD = '/u/Tape';
const LOGS = '/u/Logs/Tape';

const profile = () => ({
  [`${UD}/settings.json`]: '{"appearance":{"language":"zh","theme":"dark","timeFormat":"24h","upColor":"us"}}',
  [`${UD}/watchlists.json`]: '[]',
  [`${UD}/alerts.json`]: '[]',
  [`${UD}/notifications.json`]: '[]',
  [`${UD}/nav.json`]: '[]',
  [`${UD}/window.json`]: '{}',
  [`${UD}/lock.json`]: '{"pin":{}}',
  [`${UD}/settings.corrupt-1700000000000.json`]: 'x',
  [`${UD}/alerts.json.4242.tmp`]: 'x',
  [`${UD}/tape.db`]: 'db',
  [`${UD}/tape.db-wal`]: 'wal',
  [`${UD}/tape.db-shm`]: 'shm',
  [`${UD}/tape.db.corrupt-1700000000000`]: 'old',
  [`${UD}/tape.db.corrupt-1700000000000-wal`]: 'old',
  // Chromium's files and anything else that is not Tape's own stay.
  [`${UD}/SingletonLock`]: '',
  [`${UD}/Local State`]: '{}',
  [`${UD}/Local Storage/leveldb/000003.log`]: '',
  [`${UD}/Preferences`]: '{}',
  [`${UD}/notes.txt`]: 'mine',
  [`${LOGS}/api-20261003.log`]: 'log',
  [`${LOGS}/api-20261004.log`]: 'log',
  [`${LOGS}/other.log`]: 'other',
});

describe('Forgot-PIN reset', () => {
  it('knows which files are Tape’s', () => {
    for (const name of ['settings.json', 'lock.json', 'window.json', 'nav.corrupt-1.json', 'lock.json.99.tmp', 'tape.db', 'tape.db-shm', 'tape.db.corrupt-5-wal'])
      expect(isTapeFile(name), name).toBe(true);
    for (const name of ['Local State', 'Preferences', 'SingletonLock', 'tape.db.bak', 'settings.json.bak', 'reset-pending', 'my-settings.json', 'Cache'])
      expect(isTapeFile(name), name).toBe(false);
  });

  it('writes and reads the marker with the kept language and theme', () => {
    const { fs } = fakeFs({});
    expect(readResetMarker(fs, UD)).toBeNull();
    writeResetMarker(fs, UD, { language: 'zh', theme: 'dark', at: 5 });
    expect(readResetMarker(fs, UD)).toEqual({ language: 'zh', theme: 'dark', at: 5 });
  });

  it('still resets with a damaged marker', () => {
    const { fs } = fakeFs({ [join(UD, RESET_MARKER)]: '{oops' });
    expect(readResetMarker(fs, UD)).toEqual({ language: 'en', theme: 'system', at: 0 });
  });

  it('deletes all of Tape’s data and API logs, keeping language and theme only', () => {
    const { fs, data } = fakeFs({ ...profile(), [join(UD, RESET_MARKER)]: '' });
    const res = wipeTapeData(fs, { userData: UD, logDir: LOGS, marker: { language: 'zh', theme: 'dark', at: 1 } });
    expect(res.failed).toEqual([]);
    expect([...data.keys()].sort()).toEqual(
      [
        `${UD}/Local State`,
        `${UD}/Local Storage/leveldb/000003.log`,
        `${UD}/Preferences`,
        `${UD}/SingletonLock`,
        `${UD}/notes.txt`,
        `${UD}/${RESET_MARKER}`,
        `${UD}/settings.json`,
        `${LOGS}/other.log`,
      ].sort(),
    );
    expect(JSON.parse(data.get(`${UD}/settings.json`)!)).toEqual({ appearance: { language: 'zh', theme: 'dark' } });
    // Only language and theme are kept: the time format (24-hour before) is back to the default.
    expect(loadSettings(JSON.parse(data.get(`${UD}/settings.json`)!), defaultSettings('zh')).appearance).toMatchObject({ language: 'zh', theme: 'dark', timeFormat: '12h' });
    // The marker goes last, after the renderer storage was cleared (index.ts).
    removeResetMarker(fs, UD);
    expect(data.has(join(UD, RESET_MARKER))).toBe(false);
  });

  it('reports files it could not delete and carries on', () => {
    const { fs, data } = fakeFs(profile(), [`${UD}/tape.db`]);
    const res = wipeTapeData(fs, { userData: UD, logDir: null, marker: { language: 'en', theme: 'system', at: 1 } });
    expect(res.failed).toEqual(['tape.db']);
    expect(data.has(`${UD}/tape.db-wal`)).toBe(false);
    expect(data.has(`${UD}/lock.json`)).toBe(false);
    // Without a log folder the log files stay.
    expect(data.has(`${LOGS}/api-20261004.log`)).toBe(true);
  });

  it('tolerates a missing log folder', () => {
    const { fs } = fakeFs({ [`${UD}/lock.json`]: '{}' });
    expect(wipeTapeData(fs, { userData: UD, logDir: '/nowhere', marker: { language: 'en', theme: 'system', at: 1 } })).toEqual({ deleted: ['lock.json'], failed: [] });
  });

  it('needs the confirmation word', () => {
    expect(resetWordMatches(' reset ', 'en')).toBe(true);
    expect(resetWordMatches('RESET', 'zh')).toBe(false);
    expect(resetWordMatches('重置', 'zh')).toBe(true);
    expect(resetWordMatches('重 置', 'zh')).toBe(false);
    expect(resetWordMatches('RESETS', 'en')).toBe(false);
    expect(isResetConfirmation('Reset')).toBe(true);
    expect(isResetConfirmation(' 重置')).toBe(true);
    for (const bad of ['', 'yes', null, undefined, 1, ['RESET']]) expect(isResetConfirmation(bad)).toBe(false);
  });

  describe('phase 1 (the running app)', () => {
    function deps(over: Partial<StartResetDeps> = {}) {
      const { fs, data } = fakeFs(profile());
      const order: string[] = [];
      const app = { relaunch: vi.fn(() => void order.push('relaunch')), exit: vi.fn(() => void order.push('exit')) };
      const d: StartResetDeps = {
        fs,
        userData: UD,
        keep: () => ({ language: 'zh', theme: 'light' }),
        teardown: [async () => void order.push('disconnect'), async () => void order.push('db')],
        relaunch: true,
        app,
        argv: ['/Applications/Tape.app/Contents/MacOS/Tape', '--flag'],
        now: () => 42,
        settleMs: 20,
        ...over,
      };
      return { d, data, app, order };
    }

    it('refuses without the confirmation word and changes nothing', async () => {
      for (const word of ['', 'yes', 'RESE', null, undefined]) {
        const t = deps();
        await expect(startReset(word, t.d)).rejects.toThrow(/RESET/);
        expect(t.data.has(join(UD, RESET_MARKER))).toBe(false);
        expect(t.order).toEqual([]);
      }
    });

    it('writes the marker, closes the connection and the database, then restarts', async () => {
      const t = deps();
      await startReset(' reset ', t.d);
      expect(JSON.parse(t.data.get(join(UD, RESET_MARKER))!)).toEqual({ language: 'zh', theme: 'light', at: 42 });
      // Nothing is deleted by the running app: phase 2 does that after the restart.
      expect(t.data.has(`${UD}/lock.json`)).toBe(true);
      expect(t.order).toEqual(['disconnect', 'db', 'relaunch', 'exit']);
      expect(t.app.relaunch).toHaveBeenCalledWith({ args: ['--flag'] });
      expect(t.app.exit).toHaveBeenCalledWith(0);
    });

    it('accepts 重置 and exits without restarting in development', async () => {
      const t = deps({ relaunch: false });
      await startReset('重置', t.d);
      expect(t.order).toEqual(['disconnect', 'db', 'exit']);
    });

    it('does not wait forever for a teardown that hangs or fails', async () => {
      const t = deps({ teardown: [() => new Promise(() => undefined), () => Promise.reject(new Error('busy'))] });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await startReset('RESET', t.d);
      expect(t.order).toEqual(['relaunch', 'exit']);
      vi.restoreAllMocks();
    });
  });
});
