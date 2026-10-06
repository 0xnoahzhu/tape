// macOS: the bundle's own icon (Finder, the Applications folder, a Dock tile while Tape is not
// running) follows the resolved theme, as Arc's does. A signed bundle's icon cannot be switched,
// so this sets a Finder custom icon with NSWorkspace setIcon:forFile:options:, run through
// osascript (JXA); no native module. Pure apart from finderIconFor (no Electron; used by
// appearance.ts).
//
//   dark   Tape.app/Icon\r (empty; its resource fork holds icon-dark.icns) + kHasCustomIcon
//          (0x0400) in the bundle's com.apple.FinderInfo
//   light  both removed: build/icon.icns, the bundle icon, is already light
//
// Nothing in Contents/ changes, so `codesign --verify --deep` passes and Tape launches as before;
// while dark, `--strict` reports the Finder info as detritus (Arc's bundle does too).

import { execFile, type ExecFileException } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type FinderIconOp = 'set' | 'remove';

/** The file NSWorkspace writes into a folder for its custom icon (empty; the icns is in its resource fork). */
export const CUSTOM_ICON_FILE = 'Icon\r';
export const DARK_ICNS = 'icon-dark.icns';
/** The first update waits this long after start, off the critical path. */
const START_DELAY_MS = 3_000;
const TIMEOUT_MS = 15_000;

/** <x>.app of the running executable (<x>.app/Contents/MacOS/<exe>), or null. */
export function appBundleDir(exe: string): string | null {
  const macos = dirname(exe);
  const app = dirname(dirname(macos));
  return app.endsWith('.app') && macos === join(app, 'Contents', 'MacOS') ? app : null;
}

export interface SkipOptions {
  platform: string;
  isPackaged: boolean;
  /** False in a second instance, which quits. */
  primary: boolean;
  appDir: string | null;
  home: string;
}

/** Why Tape must not write its bundle's icon, or null when it may (writability is checked at the first write). */
export function finderIconSkipReason(o: SkipOptions): string | null {
  if (o.platform !== 'darwin') return 'not macOS';
  if (!o.isPackaged) return 'not packaged';
  if (!o.primary) return 'second instance';
  if (!o.appDir) return 'not in an app bundle';
  if (o.appDir.includes('/AppTranslocation/')) return 'translocated';
  // Not the DMG (/Volumes/…), Downloads, Desktop or a build folder: some are read-only, others are
  // protected folders where a write could prompt the user.
  const inside = (root: string) => o.appDir!.startsWith(root + '/');
  if (!inside('/Applications') && !inside(join(o.home, 'Applications'))) return 'not in an Applications folder';
  return null;
}

/**
 * What brings the bundle to the wanted icon: null when nothing is needed. Dark always sets (the
 * controller asks once per session and at each switch to dark): Icon\r can outlive the icns in its
 * resource fork and the kHasCustomIcon flag (`xattr -cr`, half of the undo, a set stopped by the
 * timeout), and only setting again, which is idempotent, repairs that. It also replaces a custom icon
 * set with Get Info. Light removes only when Icon\r exists, so the usual light start runs nothing.
 */
export function finderIconOp(dark: boolean, hasCustomIcon: boolean): FinderIconOp | null {
  if (dark) return 'set';
  return hasCustomIcon ? 'remove' : null;
}

// run(argv): argv[0] the target, argv[1] the icns (absent: remove). Paths only ever arrive through
// argv, never in the script text. `$()` is nil, which removes the custom icon; JS `null` would
// bridge to NSNull and throw.
export const SET_ICON_JXA = `ObjC.import('AppKit');
function run(argv) {
  var image = $();
  if (argv.length > 1) {
    image = $.NSImage.alloc.initWithContentsOfFile(argv[1]);
    if (image.isNil()) return 'cannot read ' + argv[1];
  }
  return $.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, argv[0], 0) ? 'ok' : 'setIcon:forFile: failed';
}`;

export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { timeout: number },
  done: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => unknown;

const execFileFn: ExecFileFn = (file, args, opts, done) => execFile(file, args, opts, done);

/**
 * Sets (icon) or removes (null) the custom icon of `target`. Rejects with osascript's own output, never
 * the error's message, which holds the whole command line with the script.
 */
export function runSetIcon(target: string, icon: string | null, exec: ExecFileFn = execFileFn): Promise<void> {
  const args = ['-l', 'JavaScript', '-e', SET_ICON_JXA, target, ...(icon ? [icon] : [])];
  return new Promise((resolve, reject) => {
    exec('/usr/bin/osascript', args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      const out = String(stdout).trim();
      if (!error && out === 'ok') return resolve();
      reject(new Error(String(stderr).trim() || out || (error?.killed ? 'timed out' : String(error?.code ?? 'failed'))));
    });
  });
}

export interface FinderIconDeps {
  /** Whether the bundle has a custom icon (Icon\r exists); decides only whether light removes it. */
  hasCustomIcon(): boolean;
  /** Whether this user can write the bundle (asked once, at the first write). */
  writable(): Promise<boolean>;
  run(op: FinderIconOp): Promise<void>;
  /** Resolves when the first update may start. */
  wait(): Promise<void>;
  log(message: string): void;
}

export interface FinderIcon {
  /** The resolved theme changed (or was resolved at startup). */
  want(dark: boolean): void;
  /** Settles when no update is pending (tests). */
  idle(): Promise<void>;
}

/**
 * One update at a time; a burst of switches applies only the last theme. Light without a custom icon
 * starts no process; dark sets once, then only again after a switch to light. The first failure (not
 * writable, or a failed write) is logged and ends updates for the session.
 */
export function createFinderIcon(deps: FinderIconDeps): FinderIcon {
  let wanted: boolean | null = null;
  /** The theme the bundle icon was last brought to. */
  let applied: boolean | null = null;
  let disabled = false;
  let started = false;
  let writable: Promise<boolean> | null = null;
  let running: Promise<void> | null = null;

  function stop(message: string): void {
    disabled = true;
    deps.log(message);
  }

  async function drain(): Promise<void> {
    if (!started) {
      started = true;
      await deps.wait();
    }
    while (!disabled && wanted !== null && wanted !== applied) {
      const dark: boolean = wanted;
      const op = finderIconOp(dark, deps.hasCustomIcon());
      if (op) {
        if (!(await (writable ??= deps.writable()))) return stop('not updated: the app bundle is not writable');
        try {
          await deps.run(op);
        } catch (err) {
          return stop(`${op} failed: ${(err as Error).message}`);
        }
      }
      applied = dark;
    }
  }

  function start(): void {
    if (running || disabled || wanted === null || wanted === applied) return;
    // A want() between the loop's last check and this callback is picked up by start() again.
    running = drain()
      .catch((err: unknown) => stop(`failed: ${String(err)}`))
      .then(() => {
        running = null;
        start();
      });
  }

  return {
    want(dark) {
      if (disabled) return;
      wanted = dark;
      start();
    },
    async idle() {
      while (running) await running;
    },
  };
}

export interface FinderIconEnv {
  platform: string;
  isPackaged: boolean;
  primary: boolean;
  /** app.getPath('exe') */
  exe: string;
  home: string;
  /** Folder with icon-dark.icns (appearance.ts → iconDir). */
  iconDir: string;
}

/** The real wiring; null (the reason logged) when Tape must not write its bundle. */
export function finderIconFor(env: FinderIconEnv): FinderIcon | null {
  const appDir = appBundleDir(env.exe);
  const reason = finderIconSkipReason({ ...env, appDir });
  if (reason || !appDir) {
    console.info(`[appearance] Finder icon not updated: ${reason}`);
    return null;
  }
  const icon = join(env.iconDir, DARK_ICNS);
  return createFinderIcon({
    hasCustomIcon: () => existsSync(join(appDir, CUSTOM_ICON_FILE)),
    // EACCES, or EROFS on a read-only volume.
    writable: () => access(appDir, constants.W_OK).then(() => true, () => false),
    run: (op) => runSetIcon(appDir, op === 'set' ? icon : null),
    wait: () => new Promise((resolve) => setTimeout(resolve, START_DELAY_MS)),
    log: (message) => console.warn(`[appearance] Finder icon: ${message}`),
  });
}
