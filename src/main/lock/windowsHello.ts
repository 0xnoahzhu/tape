// Windows Hello provider. Electron has no Windows Hello API, so a helper process calls
// UserConsentVerifier through IUserConsentVerifierInterop with Tape's own window handle (the Windows
// Security dialog is then owned by Tape and opens in front of it). The helper runs in the in-box
// Windows PowerShell 5.1 and is described in windowsHelloScript.ts, together with its line protocol.
//
// Lifecycle: prepare() (the app locked) starts the helper and keeps it warm, so the prompt opens at
// once on the first click; dispose() (unlock, quit) closes its stdin, which makes it cancel an open
// prompt and exit, and kills it if it has not exited a few seconds later. A helper started only for
// an availability check exits after a minute of idle time. The helper also exits on its own when
// Tape dies, because the write end of its stdin closes with the Tape process.
//
// Like Touch ID, the result is a yes / no from the OS, not a key: the PIN stays the real secret.
// Nothing here logs the prompt text.

import { spawn as nodeSpawn } from 'node:child_process';
import { release } from 'node:os';
import { win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { BrowserWindow } from 'electron';
import type { BiometricAvailability, BiometricProvider, BiometricResult, BiometricUnavailableReason } from './types';
import { HELPER_ARGS, HELPER_END, HELPER_SCRIPT } from './windowsHelloScript';

const START_TIMEOUT_MS = 30_000; // PowerShell start + in-memory compile, slow under AV scanning
const CHECK_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 120_000;
const IDLE_EXIT_MS = 60_000;
const KILL_GRACE_MS = 5_000; // after stdin EOF the helper cancels an open prompt (up to 3 s) and exits
/**
 * Cheap pre-filter only (userconsentverifierinterop.h guards the interop with NTDDI_WIN10_RS3).
 * Microsoft documents the interop from build 22000; the helper's availability check activates it,
 * so a build without it is reported unsupported before Settings offers Windows Hello.
 */
const MIN_BUILD = 16299;
const MAX_MESSAGE_CHARS = 200;
const DEFAULT_MESSAGE = 'Unlock Tape';
const MAX_LINE = 4096;

// HRESULTs as the helper prints them.
const E_NOINTERFACE = '0x80004002';
const REGDB_E_CLASSNOTREG = '0x80040154';
const CLASS_E_CLASSNOTAVAILABLE = '0x80040111';
const ERROR_CANCELLED = '0x800704C7';
const UNSUPPORTED_HRESULTS = new Set([E_NOINTERFACE, REGDB_E_CLASSNOTREG, CLASS_E_CLASSNOTAVAILABLE]);

/** The part of a ChildProcess the helper uses (a fake in tests). */
export interface HelperChild {
  readonly stdin: {
    write(chunk: string): unknown;
    end(): unknown;
    on(event: 'error', listener: (err: Error) => void): unknown;
  };
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  readonly exitCode: number | null;
  kill(): unknown;
  on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
}

export type SpawnHelper = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => HelperChild;

export interface HelloTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WindowsHelloDeps {
  spawn?: SpawnHelper;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** os.release(): "10.0.<build>" on Windows. */
  osRelease?: () => string;
  timers?: HelloTimers;
  log?: (message: string) => void;
  now?: () => number;
}

const defaultSpawn: SpawnHelper = (command, args, env) =>
  nodeSpawn(command, [...args], { env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

const defaultTimers: HelloTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** Absolute path of the in-box Windows PowerShell 5.1, never looked up through PATH. */
export function powershellPath(env: NodeJS.ProcessEnv): string {
  const root = [env.SystemRoot, env.windir].find((dir) => dir !== undefined && win32.isAbsolute(dir)) ?? 'C:\\Windows';
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** HWND as an unsigned decimal: getNativeWindowHandle() is the pointer-sized little-endian HWND. */
export function hwndOf(win: Pick<BrowserWindow, 'getNativeWindowHandle'>): string {
  const buf = win.getNativeWindowHandle();
  return (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString();
}

/** Windows build number from os.release(), 0 when it cannot be read. */
export function windowsBuild(osRelease: string): number {
  const [major, , build] = osRelease.split('.').map(Number);
  return major !== undefined && major >= 10 && build !== undefined && Number.isFinite(build) ? build : 0;
}

type FailureKind =
  | 'notFound' // powershell.exe missing
  | 'blocked' // powershell.exe may not be started (EACCES / EPERM / UNKNOWN)
  | 'languageMode' // Constrained Language Mode (exit 3)
  | 'antivirus' // AMSI blocked the script
  | 'compile' // the C# did not compile (exit 4)
  | 'startTimeout'
  | 'exited' // the helper exited unexpectedly
  | 'disposed'
  | 'timeout' // a request timed out
  | 'hresult'; // a WinRT call failed (`hr`, `where`)

class HelperError extends Error {
  readonly kind: FailureKind;
  readonly hr: string | undefined;
  constructor(kind: FailureKind, message: string, hr?: string) {
    super(message);
    this.kind = kind;
    this.hr = hr;
  }
}

interface Unavailable {
  reason: BiometricUnavailableReason;
  detail: string;
  /** Will not change while Tape runs: no point in starting PowerShell again. */
  permanent: boolean;
}

function classify(err: unknown): Unavailable {
  const e = err instanceof HelperError ? err : new HelperError('exited', String(err));
  switch (e.kind) {
    case 'notFound':
      return { reason: 'unsupported', detail: 'Windows PowerShell not found', permanent: true };
    case 'blocked':
      return { reason: 'disabledByPolicy', detail: 'Windows PowerShell may not be started', permanent: true };
    case 'languageMode':
      return { reason: 'disabledByPolicy', detail: 'PowerShell runs in Constrained Language Mode', permanent: true };
    case 'antivirus':
      return { reason: 'disabledByPolicy', detail: 'the helper script was blocked by antivirus', permanent: true };
    case 'compile':
      return { reason: 'error', detail: e.message, permanent: true };
    case 'hresult':
      if (e.hr !== undefined && UNSUPPORTED_HRESULTS.has(e.hr))
        return { reason: 'unsupported', detail: `Windows Hello API not available (${e.hr})`, permanent: true };
      return { reason: 'error', detail: e.message, permanent: false };
    default:
      return { reason: 'error', detail: e.message, permanent: false };
  }
}

interface Pending {
  resolve: (tokens: string[]) => void;
  reject: (err: HelperError) => void;
  timer: unknown;
}

interface HelperEnv {
  spawn: SpawnHelper;
  env: NodeJS.ProcessEnv;
  timers: HelloTimers;
  log: (message: string) => void;
  now: () => number;
  onFail: (helper: HelloHelper, err: HelperError) => void;
}

/** One PowerShell helper process and the requests in flight on it. */
class HelloHelper {
  readonly ready: Promise<void>;
  private readonly child: HelperChild | null;
  private readonly deps: HelperEnv;
  private readonly startedAt: number;
  private readonly pending = new Map<string, Pending>();
  private readonly decoder = new StringDecoder('utf8');
  private nextId = 1;
  private stdout = '';
  private stderr = '';
  private fatal = '';
  private failure: HelperError | null = null;
  private exited = false;
  private startTimer: unknown;
  private killTimer: unknown = null;
  private markReady: () => void = () => {};
  private failReady: (err: HelperError) => void = () => {};

  constructor(deps: HelperEnv) {
    this.deps = deps;
    this.startedAt = deps.now();
    this.ready = new Promise<void>((resolve, reject) => {
      this.markReady = resolve;
      this.failReady = reject;
    });
    this.ready.catch(() => {}); // observed through request()
    this.startTimer = deps.timers.setTimeout(() => {
      this.fail(new HelperError('startTimeout', 'helper did not start in time'));
      this.kill();
    }, START_TIMEOUT_MS);
    void this.ready.then(
      () => deps.timers.clearTimeout(this.startTimer),
      () => deps.timers.clearTimeout(this.startTimer),
    );

    let child: HelperChild | null = null;
    try {
      child = deps.spawn(powershellPath(deps.env), HELPER_ARGS, deps.env);
    } catch (err) {
      // Node throws synchronously for spawn errors other than ENOENT / EACCES / EAGAIN / EMFILE / ENFILE.
      this.exited = true;
      this.onSpawnError(err as NodeJS.ErrnoException);
    }
    this.child = child;
    if (!child) return;
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    child.stdin.on('error', () => {}); // EPIPE once the helper has gone; 'exit' reports it
    child.on('error', (err) => this.onSpawnError(err));
    child.on('exit', (code) => this.onExit(code));
    child.stdin.write(`${HELPER_SCRIPT}\n${HELPER_END}\n`);
  }

  get alive(): boolean {
    return this.failure === null;
  }

  async request(op: 'check' | 'verify', args: string[], timeoutMs: number): Promise<string[]> {
    await this.ready;
    if (this.failure) throw this.failure;
    const id = String(this.nextId++);
    return new Promise<string[]>((resolve, reject) => {
      const timer = this.deps.timers.setTimeout(() => {
        this.pending.delete(id);
        this.send(`cancel ${id}`);
        reject(new HelperError('timeout', `${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send([op, id, ...args].join(' '));
    });
  }

  /** Closes stdin (the helper cancels an open prompt and exits), then kills it if it lingers. */
  dispose(): void {
    this.fail(new HelperError('disposed', 'helper disposed'));
    if (this.exited || !this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      // already closed
    }
    if (this.killTimer === null) this.killTimer = this.deps.timers.setTimeout(() => this.kill(), KILL_GRACE_MS);
  }

  private kill(): void {
    if (this.exited || !this.child) return;
    try {
      this.child.kill();
    } catch {
      // already gone
    }
  }

  private send(line: string): void {
    if (this.failure || this.exited || !this.child) return;
    try {
      this.child.stdin.write(`${line}\n`);
    } catch {
      // the 'exit' handler fails the requests
    }
  }

  private onData(chunk: Buffer | string): void {
    this.stdout += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    for (let nl = this.stdout.indexOf('\n'); nl >= 0; nl = this.stdout.indexOf('\n')) {
      const line = this.stdout.slice(0, nl).replace(/^\uFEFF/, '').trim();
      this.stdout = this.stdout.slice(nl + 1);
      if (line) this.onLine(line.split(/\s+/));
    }
    if (this.stdout.length > MAX_LINE) this.stdout = ''; // not our protocol
  }

  private onLine(tokens: string[]): void {
    const [kind, id] = tokens;
    if (kind === 'ready') {
      const ms = this.deps.now() - this.startedAt;
      this.deps.log(`helper ready in ${ms} ms (Windows ${tokens[1] ?? '?'}, ${tokens[2] ?? '?'}-bit)`);
      this.markReady();
      return;
    }
    if (kind === 'fatal') {
      this.fatal = tokens.slice(1).join(' ').slice(0, 200);
      return;
    }
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return; // timed out or canceled meanwhile
    this.pending.delete(id);
    this.deps.timers.clearTimeout(pending.timer);
    if (kind === 'error') {
      const hr = tokens[2] ?? '?';
      pending.reject(new HelperError('hresult', `${tokens[3] ?? 'call'} failed with ${hr}`, hr));
    } else {
      pending.resolve(tokens);
    }
  }

  private onSpawnError(err: NodeJS.ErrnoException): void {
    if (err.code === 'ENOENT') this.fail(new HelperError('notFound', 'Windows PowerShell not found'));
    // UNKNOWN: libuv has no mapping for ERROR_ACCESS_DISABLED_BY_POLICY (AppLocker / SRP exe rules)
    // or ERROR_VIRUS_INFECTED (Defender), and the path is the absolute in-box one, so treat it as
    // blocked for the session instead of spawning the blocked binary again on every refresh.
    else if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'UNKNOWN')
      this.fail(new HelperError('blocked', `cannot start Windows PowerShell (${err.code})`));
    else this.fail(new HelperError('exited', `cannot start Windows PowerShell (${err.code ?? 'error'})`));
  }

  private onExit(code: number | null): void {
    this.exited = true;
    if (this.killTimer !== null) this.deps.timers.clearTimeout(this.killTimer);
    if (this.failure) return; // disposed, timed out or failed to spawn: expected
    let err: HelperError;
    if (code === 3) err = new HelperError('languageMode', 'PowerShell runs in Constrained Language Mode');
    else if (this.stderr.includes('ScriptContainedMaliciousContent'))
      err = new HelperError('antivirus', 'the helper script was blocked by antivirus');
    else if (code === 4) err = new HelperError('compile', `helper failed to compile (${this.fatal || 'no detail'})`);
    else {
      const firstLine = this.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? '';
      err = new HelperError('exited', `helper exited with code ${code ?? 'null'}${firstLine ? `: ${firstLine}` : ''}`);
    }
    this.deps.log(err.message);
    this.fail(err);
  }

  private fail(err: HelperError): void {
    if (this.failure) return;
    this.failure = err;
    this.failReady(err);
    for (const p of this.pending.values()) {
      this.deps.timers.clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.deps.onFail(this, err);
  }
}

const unavailable = (reason: BiometricUnavailableReason, detail?: string): BiometricAvailability =>
  detail === undefined
    ? { kind: 'windowsHello', available: false, reason }
    : { kind: 'windowsHello', available: false, reason, detail };

function availabilityFrom(value: string | undefined): BiometricAvailability {
  switch (value) {
    case 'Available':
    case 'DeviceBusy': // set up and usable; the prompt itself reports the busy sensor
      return { kind: 'windowsHello', available: true };
    case 'DeviceNotPresent':
      return unavailable('noHardware');
    case 'NotConfiguredForUser':
      return unavailable('notEnrolled');
    case 'DisabledByPolicy':
      return unavailable('disabledByPolicy');
    default:
      return unavailable('error', `unexpected availability ${value ?? 'none'}`);
  }
}

function resultFrom(tokens: string[]): BiometricResult {
  const [kind, , value] = tokens;
  if (kind === 'busy') return { ok: false, reason: 'busy' };
  switch (value) {
    case 'Verified':
      return { ok: true };
    case 'Canceled':
      return { ok: false, reason: 'canceled' };
    case 'RetriesExhausted':
      return { ok: false, reason: 'failed' };
    case 'DeviceBusy':
      return { ok: false, reason: 'busy' };
    case 'DeviceNotPresent':
    case 'NotConfiguredForUser':
    case 'DisabledByPolicy':
      return { ok: false, reason: 'unavailable', detail: value };
    default:
      return { ok: false, reason: 'error', detail: `unexpected result ${value ?? 'none'}` };
  }
}

/** Keeps the OS prompt text short and on one protocol line (it travels as base64). */
function promptMessage(reason: string): string {
  const text = reason.replace(/\s+/g, ' ').trim();
  return Array.from(text || DEFAULT_MESSAGE)
    .slice(0, MAX_MESSAGE_CHARS)
    .join('');
}

export function createWindowsHelloProvider(deps: WindowsHelloDeps = {}): BiometricProvider {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const timers = deps.timers ?? defaultTimers;
  const log = deps.log ?? ((message: string) => console.log(`[windows-hello] ${message}`));
  const now = deps.now ?? Date.now;
  const spawn = deps.spawn ?? defaultSpawn;

  let helper: HelloHelper | null = null;
  let warm = false; // prepare() was called: keep the helper until dispose()
  let idleTimer: unknown = null;
  let verifying = false;
  let permanent: BiometricAvailability | null = null;

  const unsupported = (): BiometricAvailability | null => {
    if (permanent) return permanent;
    if (platform !== 'win32') return unavailable('unsupported', 'Windows only');
    const build = windowsBuild((deps.osRelease ?? release)());
    if (build < MIN_BUILD) return unavailable('unsupported', `Windows build ${build || 'unknown'}`);
    return null;
  };

  const remember = (err: unknown): Unavailable => {
    const u = classify(err);
    if (u.permanent && !permanent) {
      permanent = unavailable(u.reason, u.detail);
      log(`unavailable for this session: ${u.detail}`);
    }
    return u;
  };

  const clearIdle = (): void => {
    if (idleTimer !== null) timers.clearTimeout(idleTimer);
    idleTimer = null;
  };

  const current = (): HelloHelper => {
    clearIdle();
    if (!helper || !helper.alive) {
      helper = new HelloHelper({
        spawn,
        env,
        timers,
        log,
        now,
        onFail: (failed, err) => {
          if (helper === failed) helper = null;
          if (err.kind !== 'disposed' && err.kind !== 'timeout') remember(err);
        },
      });
    }
    return helper;
  };

  const closeHelper = (): void => {
    clearIdle();
    const h = helper;
    helper = null;
    h?.dispose();
  };

  const scheduleIdleExit = (): void => {
    if (warm || verifying || !helper) return;
    clearIdle();
    idleTimer = timers.setTimeout(() => {
      idleTimer = null;
      if (!warm && !verifying) closeHelper();
    }, IDLE_EXIT_MS);
  };

  return {
    kind: 'windowsHello',

    async availability(): Promise<BiometricAvailability> {
      const blocked = unsupported();
      if (blocked) return blocked;
      try {
        const tokens = await current().request('check', [], CHECK_TIMEOUT_MS);
        return availabilityFrom(tokens[2]);
      } catch (err) {
        const u = remember(err);
        return unavailable(u.reason, u.detail);
      } finally {
        scheduleIdleExit();
      }
    },

    async verify(reason: string, win: BrowserWindow | null): Promise<BiometricResult> {
      if (verifying) return { ok: false, reason: 'busy' };
      const blocked = unsupported();
      if (blocked && !blocked.available) return { ok: false, reason: 'unavailable', detail: blocked.detail ?? blocked.reason };
      if (!win || win.isDestroyed()) return { ok: false, reason: 'error', detail: 'no window' };
      verifying = true;
      try {
        // The dialog is owned by this window, and face / fingerprint only start while it has the
        // foreground, so bring Tape forward first (verify runs from a click on the lock screen).
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.focus();
        const message = Buffer.from(promptMessage(reason), 'utf8').toString('base64');
        const h = current();
        try {
          return resultFrom(await h.request('verify', [hwndOf(win), message], VERIFY_TIMEOUT_MS));
        } catch (err) {
          if (err instanceof HelperError && err.kind === 'timeout') {
            // Nobody answered: close the prompt by ending the helper (killed if it does not exit).
            if (helper === h) helper = null;
            h.dispose();
            return { ok: false, reason: 'timeout' };
          }
          throw err;
        }
      } catch (err) {
        if (err instanceof HelperError && err.kind === 'disposed') return { ok: false, reason: 'canceled' };
        if (err instanceof HelperError && err.hr === ERROR_CANCELLED) return { ok: false, reason: 'canceled' };
        const u = remember(err);
        return u.reason === 'error' ? { ok: false, reason: 'error', detail: u.detail } : { ok: false, reason: 'unavailable', detail: u.detail };
      } finally {
        verifying = false;
        scheduleIdleExit();
      }
    },

    prepare(): void {
      if (unsupported()) return;
      warm = true;
      current();
    },

    dispose(): void {
      warm = false;
      closeHelper();
    },
  };
}
