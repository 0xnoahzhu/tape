// Tape's own updates: checks the project's GitHub Releases at launch and every few hours. With
// automatic updates on (Settings › About) a new version downloads in the background; with them off
// it is only reported (`available`: a dot on the top bar's Settings button) until the user
// downloads it. A downloaded version installs when Tape quits, or at once after the user confirms a
// restart in the renderer. Pure (no Electron): updaterBackend.ts adapts electron-updater.
//
// Nothing installs while Tape runs: a restart is always the user's choice, so a session with TWS /
// IB Gateway is never cut by an update.

import type { UpdateState } from '@shared/types';

/** The part of electron-updater's AppUpdater that Tape uses (with its own autoDownload off). */
export interface UpdaterBackend {
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): unknown;
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  /** Downloads the version the last check found. */
  downloadUpdate(): Promise<unknown>;
  /** Quits, installs the downloaded version and starts it. */
  quitAndInstall(): void;
}

export interface UpdaterDeps {
  /** Null: this build does not update itself (state `off`). */
  backend: UpdaterBackend | null;
  /** Settings › About › Automatic updates: download a new version by itself. */
  auto(): boolean;
  emit(state: UpdateState): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  setRepeat?: (fn: () => void, ms: number) => unknown;
}

export interface Updater {
  getState(): UpdateState;
  /** Starts the checks: the first shortly after launch, then every CHECK_EVERY_MS. */
  start(): void;
  /** Checks now (Settings › About, the menu); resolves with the state once the check has ended. */
  check(): Promise<UpdateState>;
  /** Downloads the `available` version. Refused unless one is. */
  download(): void;
  /** Automatic updates were turned on or off: on, an `available` version starts downloading. */
  autoChanged(): void;
  /** Restarts into the downloaded version. Refused unless one is ready. */
  install(): void;
}

/** The first check waits for the launch to settle (the window, the connection to IB). */
export const FIRST_CHECK_MS = 30_000;
export const CHECK_EVERY_MS = 4 * 60 * 60_000;
export const NOT_READY_MESSAGE = 'No update has been downloaded';
export const NOT_AVAILABLE_MESSAGE = 'No new version to download';

/** electron-updater's messages can carry a whole HTTP response: its first line, at most 200 characters. */
export function shortError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line = text.split('\n', 1)[0].trim() || 'Update failed';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const { backend, emit } = deps;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  const setRepeat = deps.setRepeat ?? ((fn, ms) => setInterval(fn, ms).unref());

  let state: UpdateState = backend ? { status: 'idle', checkedAt: null } : { status: 'off' };
  const set = (next: UpdateState) => {
    state = next;
    emit(next);
  };
  let checkedAt: number | null = null;
  let running: Promise<UpdateState> | null = null;
  /** The version found by the last check, also while the next check runs. */
  let found: string | null = null;

  const fail = (err: unknown) => set({ status: 'error', message: shortError(err), checkedAt });

  function startDownload(version: string): void {
    if (!backend) return;
    set({ status: 'downloading', version, percent: 0 });
    // A failure is also reported through 'error'; a rejection before any event is not.
    backend.downloadUpdate().catch((err: unknown) => {
      if (state.status === 'downloading') fail(err);
    });
  }

  if (backend) {
    backend.on('checking-for-update', () => {
      if (state.status !== 'downloading' && state.status !== 'ready') set({ status: 'checking' });
    });
    backend.on('update-not-available', () => {
      checkedAt = now();
      found = null;
      set({ status: 'idle', checkedAt });
    });
    backend.on('update-available', (info) => {
      checkedAt = now();
      found = info.version;
      if (deps.auto()) startDownload(info.version);
      else set({ status: 'available', version: info.version });
    });
    backend.on('download-progress', (p) => {
      if (state.status !== 'downloading') return;
      // One event per whole percent: electron-updater reports many more.
      const percent = Math.max(0, Math.min(100, Math.floor(p.percent)));
      if (percent !== state.percent) set({ ...state, percent });
    });
    backend.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }));
    backend.on('error', (err) => {
      // A downloaded update stays ready: a later check failing (offline) changes nothing about it.
      if (state.status === 'ready') return;
      fail(err);
    });
  }

  function check(): Promise<UpdateState> {
    if (!backend || state.status === 'ready' || state.status === 'downloading') return Promise.resolve(state);
    if (running) return running;
    running = backend
      .checkForUpdates()
      .catch((err: unknown) => {
        // Usually already reported through 'error'; a rejection before any event is not.
        if (state.status === 'checking' || state.status === 'idle') fail(err);
      })
      .then(() => state)
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    getState: () => state,
    start() {
      if (!backend) return;
      setTimer(() => void check(), FIRST_CHECK_MS);
      setRepeat(() => void check(), CHECK_EVERY_MS);
    },
    check,
    download() {
      if (!backend || state.status !== 'available') throw new Error(NOT_AVAILABLE_MESSAGE);
      startDownload(state.version);
    },
    autoChanged() {
      if (state.status === 'available' && found && deps.auto()) startDownload(state.version);
    },
    install() {
      if (!backend || state.status !== 'ready') throw new Error(NOT_READY_MESSAGE);
      backend.quitAndInstall();
    },
  };
}
