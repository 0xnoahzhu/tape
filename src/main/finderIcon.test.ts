import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  appBundleDir,
  createFinderIcon,
  CUSTOM_ICON_FILE,
  finderIconOp,
  finderIconSkipReason,
  runSetIcon,
  SET_ICON_JXA,
  type ExecFileFn,
  type FinderIconOp,
} from './finderIcon';

describe('appBundleDir', () => {
  it('is the .app of the main executable', () => {
    expect(appBundleDir('/Applications/Tape.app/Contents/MacOS/Tape')).toBe('/Applications/Tape.app');
    expect(appBundleDir(`/Applications/My Apps/Tape's "x".app/Contents/MacOS/Tape`)).toBe(`/Applications/My Apps/Tape's "x".app`);
    // The shape is all it checks; app.getPath('exe') of the main process names the main bundle.
    expect(appBundleDir('/x/Tape.app/Contents/Frameworks/Tape Helper.app/Contents/MacOS/Tape Helper')).toBe(
      '/x/Tape.app/Contents/Frameworks/Tape Helper.app',
    );
  });

  it('is null outside an app bundle', () => {
    expect(appBundleDir('/usr/local/bin/tape')).toBeNull();
    expect(appBundleDir('/x/Tape.app/Contents/Resources/Tape')).toBeNull();
  });
});

describe('finderIconSkipReason', () => {
  const ok = { platform: 'darwin', isPackaged: true, primary: true, appDir: '/Applications/Tape.app', home: '/Users/n' };

  it('writes only a packaged macOS bundle of the primary instance', () => {
    expect(finderIconSkipReason({ ...ok, platform: 'win32' })).toBe('not macOS');
    expect(finderIconSkipReason({ ...ok, isPackaged: false })).toBe('not packaged');
    expect(finderIconSkipReason({ ...ok, primary: false })).toBe('second instance');
    expect(finderIconSkipReason({ ...ok, appDir: null })).toBe('not in an app bundle');
  });

  it('leaves translocated bundles and bundles outside the Applications folders alone', () => {
    expect(finderIconSkipReason({ ...ok, appDir: '/private/var/folders/ab/T/AppTranslocation/1234/d/Tape.app' })).toBe('translocated');
    for (const appDir of ['/Volumes/Tape 0.5.0/Tape.app', '/Users/n/Downloads/Tape.app', '/Applications-old/Tape.app', '/Users/m/Applications/Tape.app']) {
      expect(finderIconSkipReason({ ...ok, appDir })).toBe('not in an Applications folder');
    }
  });

  it('allows /Applications and ~/Applications, also in subfolders', () => {
    for (const appDir of ['/Applications/Tape.app', '/Applications/Finance/Tape.app', '/Users/n/Applications/Tape.app']) {
      expect(finderIconSkipReason({ ...ok, appDir })).toBeNull();
    }
  });
});

describe('finderIconOp', () => {
  it('sets the dark icon and removes it for light; light without a custom icon needs nothing', () => {
    expect(finderIconOp(true, false)).toBe('set');
    expect(finderIconOp(false, true)).toBe('remove');
    expect(finderIconOp(false, false)).toBeNull();
  });

  it('sets again over an existing Icon\\r, which may have lost its icns or the flag (xattr -cr)', () => {
    expect(finderIconOp(true, true)).toBe('set');
  });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake bundle: run() flips the custom icon; `hold` keeps runs (or the start delay) pending until released. */
function setup(opts: { custom?: boolean; writable?: boolean; holdRuns?: boolean; holdWait?: boolean; fail?: string } = {}) {
  let custom = opts.custom ?? false;
  const ops: FinderIconOp[] = [];
  const pending: Array<ReturnType<typeof deferred>> = [];
  const wait = deferred();
  if (!opts.holdWait) wait.resolve();
  const deps = {
    hasCustomIcon: () => custom,
    writable: vi.fn(async () => opts.writable ?? true),
    run: vi.fn(async (op: FinderIconOp) => {
      ops.push(op);
      if (opts.fail) throw new Error(opts.fail);
      if (opts.holdRuns) {
        const d = deferred();
        pending.push(d);
        await d.promise;
      }
      custom = op === 'set';
    }),
    wait: () => wait.promise,
    log: vi.fn(),
  };
  const icon = createFinderIcon(deps);
  /** Lets the controller reach the next await. */
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const release = async () => {
    while (pending.length) {
      pending.shift()!.resolve();
      await tick();
    }
  };
  return { icon, deps, ops, wait, tick, release, custom: () => custom };
}

describe('createFinderIcon', () => {
  it('does nothing for light without a custom icon, not even the writability check', async () => {
    const { icon, deps, ops } = setup();
    icon.want(false);
    await icon.idle();
    expect(ops).toEqual([]);
    expect(deps.writable).not.toHaveBeenCalled();
  });

  it('sets the dark icon, and removes it again for light', async () => {
    const { icon, ops, custom } = setup();
    icon.want(true);
    await icon.idle();
    expect(ops).toEqual(['set']);
    expect(custom()).toBe(true);
    icon.want(false);
    await icon.idle();
    expect(ops).toEqual(['set', 'remove']);
  });

  it('removes a custom icon left from an earlier dark session for light', async () => {
    const { icon, ops } = setup({ custom: true });
    icon.want(false);
    await icon.idle();
    expect(ops).toEqual(['remove']);
  });

  it('sets the dark icon once per session even when Icon\\r is there (it may be bare), not at every sync', async () => {
    const { icon, ops } = setup({ custom: true });
    icon.want(true);
    await icon.idle();
    icon.want(true);
    await icon.idle();
    expect(ops).toEqual(['set']);
  });

  it('applies only the last of several switches made during an update', async () => {
    const { icon, ops, tick, release } = setup({ holdRuns: true });
    icon.want(true);
    await tick();
    expect(ops).toEqual(['set']);
    icon.want(false);
    icon.want(true);
    icon.want(false);
    await release();
    await icon.idle();
    expect(ops).toEqual(['set', 'remove']);
  });

  it('runs nothing more when the switches end where the running update goes', async () => {
    const { icon, ops, tick, release } = setup({ holdRuns: true });
    icon.want(true);
    await tick();
    icon.want(false);
    icon.want(true);
    await release();
    await icon.idle();
    expect(ops).toEqual(['set']);
  });

  it('waits before the first update, then applies the theme of that moment', async () => {
    const { icon, deps, wait, tick } = setup({ holdWait: true });
    icon.want(true);
    await tick();
    expect(deps.run).not.toHaveBeenCalled();
    icon.want(false);
    wait.resolve();
    await icon.idle();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('gives up for the session when the bundle is not writable, logging once', async () => {
    const { icon, deps } = setup({ writable: false });
    icon.want(true);
    await icon.idle();
    icon.want(false);
    icon.want(true);
    await icon.idle();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(deps.log.mock.calls[0][0]).toMatch(/not writable/);
  });

  it('gives up for the session after a failed write, logging it once', async () => {
    const { icon, deps } = setup({ fail: 'setIcon:forFile: failed' });
    icon.want(true);
    await icon.idle();
    icon.want(false);
    icon.want(true);
    await icon.idle();
    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(deps.log.mock.calls[0][0]).toBe('set failed: setIcon:forFile: failed');
  });

  it('checks writability once', async () => {
    const { icon, deps, ops } = setup();
    for (const dark of [true, false, true, false]) {
      icon.want(dark);
      await icon.idle();
    }
    expect(ops).toEqual(['set', 'remove', 'set', 'remove']);
    expect(deps.writable).toHaveBeenCalledTimes(1);
  });
});

describe('runSetIcon', () => {
  type Done = Parameters<ExecFileFn>[3];
  function fakeExec(answer: (done: Done) => void) {
    const calls: Array<{ file: string; args: string[]; opts: object }> = [];
    const exec: ExecFileFn = (file, args, opts, done) => {
      calls.push({ file, args, opts });
      answer(done);
    };
    return { exec, calls };
  }

  it('passes the script and the paths as separate arguments, without a shell', async () => {
    const { exec, calls } = fakeExec((done) => done(null, 'ok\n', ''));
    const app = `/Applications/My "Apps"/Tape's $(id) \`x\` ; ok.app`;
    const icon = `/res/icon "dark" 'x'.icns`;
    await runSetIcon(app, icon, exec);
    await runSetIcon(app, null, exec);
    expect(calls[0].file).toBe('/usr/bin/osascript');
    expect(calls[0].args).toEqual(['-l', 'JavaScript', '-e', SET_ICON_JXA, app, icon]);
    expect(calls[1].args).toEqual(['-l', 'JavaScript', '-e', SET_ICON_JXA, app]);
    expect(calls[0].opts).toMatchObject({ timeout: expect.any(Number) });
    expect(calls[0].opts).not.toHaveProperty('shell');
  });

  it("rejects with osascript's answer, never the command line", async () => {
    const failed = fakeExec((done) => done(null, 'setIcon:forFile: failed\n', ''));
    await expect(runSetIcon('/a.app', null, failed.exec)).rejects.toThrow(/^setIcon:forFile: failed$/);
    // execFile's error message is "Command failed: " + the whole command line, script included.
    const cmd = `/usr/bin/osascript -l JavaScript -e ${SET_ICON_JXA} /a.app`;
    const execError = (extra: object) => Object.assign(new Error(`Command failed: ${cmd}`), { cmd }, extra);
    const timedOut = fakeExec((done) => done(execError({ killed: true }), '', ''));
    await expect(runSetIcon('/a.app', null, timedOut.exec)).rejects.toThrow(/^timed out$/);
    const threw = fakeExec((done) => done(execError({ code: 1 }), '', 'execution error: Error: x (-2700)\n'));
    await expect(runSetIcon('/a.app', null, threw.exec)).rejects.toThrow(/^execution error: Error: x \(-2700\)$/);
  });
});

// The real osascript on a scratch folder (no app is touched): catches mistakes in the script text.
const darkIcns = fileURLToPath(new URL('../../resources/icons/icon-dark.icns', import.meta.url));
describe.runIf(process.platform === 'darwin' && existsSync(darkIcns))('runSetIcon on macOS', () => {
  // The icns Finder draws is in Icon\r's resource fork.
  const forkSize = (dir: string) => {
    try {
      return statSync(join(dir, CUSTOM_ICON_FILE, '..namedfork', 'rsrc')).size;
    } catch {
      return 0;
    }
  };

  it('sets and removes a folder custom icon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tape-finder-icon-'));
    try {
      await runSetIcon(dir, darkIcns);
      expect(forkSize(dir)).toBeGreaterThan(0);
      await runSetIcon(dir, null);
      expect(existsSync(join(dir, CUSTOM_ICON_FILE))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets the icon again over a bare Icon\\r (what `xattr -cr` leaves)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tape-finder-icon-'));
    try {
      writeFileSync(join(dir, CUSTOM_ICON_FILE), '');
      expect(forkSize(dir)).toBe(0);
      await runSetIcon(dir, darkIcns);
      expect(forkSize(dir)).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
