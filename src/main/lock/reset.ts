// Forgot PIN → "Reset Tape": back to a fresh install, keeping only the language and the theme.
//
// Two phases, so nothing that is still running can write a file again after it was deleted
// (pending JSON writes, window bounds, API log appends, the SQLite worker; Windows also refuses to
// delete open files):
//
// 1. The running app writes the marker `userData/reset-pending` (language and theme inside),
//    relaunches and exits at once (app.exit skips before-quit, so nothing is flushed).
// 2. The new process, holding the single-instance lock and before any service opens a file,
//    deletes Tape's own files (wipeTapeData), writes settings.json with the kept language and
//    theme, clears the renderer storage after ready, and removes the marker last. A crash midway
//    leaves the marker, so the next launch finishes the job.
//
// Only Tape's own files are deleted, never the whole folder: Chromium keeps its own files and the
// single-instance lock there.

import { join } from 'node:path';
import { isResetConfirmation } from '@shared/lock';
import type { Lang, ThemeSetting } from '@shared/types';
import { logFileDay } from '../ib/apiLogFiles';

export const RESET_MARKER = 'reset-pending';

export interface ResetMarker {
  language: Lang;
  theme: ThemeSetting;
  at: number;
}

/** The fs calls the reset uses (node:fs in the app, a fake in tests). */
export interface ResetFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  readdirSync(path: string): string[];
  rmSync(path: string, options: { force: boolean; recursive?: boolean }): void;
  openSync(path: string, flags: string): number;
  writeSync(fd: number, data: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}

const JSON_FILES = ['settings', 'watchlists', 'alerts', 'notifications', 'nav', 'window', 'lock'];

/**
 * Tape's files in userData: the JSON documents, their corrupt backups and temporary files, the
 * database with its WAL / SHM files and moved-aside corrupt copies.
 */
export function isTapeFile(name: string): boolean {
  const stems = JSON_FILES.join('|');
  return (
    new RegExp(`^(${stems})(\\.corrupt-\\d+)?\\.json$`).test(name) ||
    new RegExp(`^(${stems})\\.json\\.\\d+\\.tmp$`).test(name) ||
    /^tape\.db(-wal|-shm)?$/.test(name) ||
    /^tape\.db\.corrupt-\d+(-wal|-shm)?$/.test(name)
  );
}

/** Phase 1: records what to keep. Synced to disk before the app exits. */
export function writeResetMarker(fs: ResetFs, userData: string, marker: ResetMarker): void {
  const fd = fs.openSync(join(userData, RESET_MARKER), 'w');
  try {
    fs.writeSync(fd, JSON.stringify(marker));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** The pending reset, or null. A damaged marker still resets (with English and the system theme). */
export function readResetMarker(fs: ResetFs, userData: string): ResetMarker | null {
  const path = join(userData, RESET_MARKER);
  if (!fs.existsSync(path)) return null;
  const fallback: ResetMarker = { language: 'en', theme: 'system', at: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as Partial<ResetMarker>;
    return {
      language: raw.language === 'zh' ? 'zh' : 'en',
      theme: raw.theme === 'dark' || raw.theme === 'light' ? raw.theme : 'system',
      at: typeof raw.at === 'number' ? raw.at : 0,
    };
  } catch {
    return fallback;
  }
}

export interface WipeResult {
  deleted: string[];
  /** Files that could not be deleted (names relative to their folder). */
  failed: string[];
}

/**
 * Phase 2: deletes Tape's files in userData and the API log files in `logDir`, then writes
 * settings.json with only the kept language and theme. Never throws.
 */
export function wipeTapeData(fs: ResetFs, opts: { userData: string; logDir: string | null; marker: ResetMarker }): WipeResult {
  const result: WipeResult = { deleted: [], failed: [] };
  const remove = (dir: string, name: string) => {
    try {
      fs.rmSync(join(dir, name), { force: true });
      result.deleted.push(name);
    } catch (err) {
      console.error(`[reset] could not delete ${join(dir, name)}:`, err);
      result.failed.push(name);
    }
  };
  const list = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };

  for (const name of list(opts.userData)) if (isTapeFile(name)) remove(opts.userData, name);
  if (opts.logDir) for (const name of list(opts.logDir)) if (logFileDay(name) != null) remove(opts.logDir, name);

  try {
    const settings = { appearance: { language: opts.marker.language, theme: opts.marker.theme } };
    fs.writeFileSync(join(opts.userData, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    console.error('[reset] could not write settings.json:', err);
    result.failed.push('settings.json');
  }
  return result;
}

export function removeResetMarker(fs: ResetFs, userData: string): void {
  try {
    fs.rmSync(join(userData, RESET_MARKER), { force: true });
  } catch (err) {
    console.error('[reset] could not remove the reset marker:', err);
  }
}

// ---------------------------------------------------------------------------
// Phase 1

export interface StartResetDeps {
  fs: ResetFs;
  userData: string;
  /** What survives the reset. */
  keep(): { language: Lang; theme: ThemeSetting };
  /** Closes what holds files open (the IB connection, the database); each gets `settleMs`. */
  teardown: ReadonlyArray<() => Promise<unknown>>;
  /** false in development and capture runs: they exit, and their next launch finishes the reset. */
  relaunch: boolean;
  app: { relaunch(options: { args: string[] }): void; exit(code: number): void };
  argv: readonly string[];
  now?: () => number;
  settleMs?: number;
}

export const RESET_CONFIRMATION_MESSAGE = 'Type RESET to confirm';

/**
 * Phase 1 of a Forgot-PIN reset: checks the typed word, writes the marker, closes the connection
 * and the database (best effort, bounded), then restarts. app.exit skips before-quit, so no pending
 * setting or window bound is written again. Throws, and changes nothing, without the word.
 */
export async function startReset(confirmation: unknown, deps: StartResetDeps): Promise<void> {
  if (!isResetConfirmation(confirmation)) throw new Error(RESET_CONFIRMATION_MESSAGE);
  const { language, theme } = deps.keep();
  writeResetMarker(deps.fs, deps.userData, { language, theme, at: (deps.now ?? Date.now)() });
  const settleMs = deps.settleMs ?? 1500;
  for (const close of deps.teardown) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, settleMs)));
    await Promise.race([
      Promise.resolve()
        .then(close)
        .catch((err: unknown) => console.error('[reset] teardown failed:', err)),
      timeout,
    ]);
    clearTimeout(timer);
  }
  if (deps.relaunch) deps.app.relaunch({ args: deps.argv.slice(1) });
  deps.app.exit(0);
}
