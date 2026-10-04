import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { HelloTimers, HelperChild, WindowsHelloDeps } from './windowsHello';
import { createWindowsHelloProvider, hwndOf, powershellPath, windowsBuild } from './windowsHello';
import { HELPER_ARGS, HELPER_BOOTSTRAP, HELPER_END, HELPER_SCRIPT } from './windowsHelloScript';

// ---- fakes ---------------------------------------------------------------------------------------

class FakeStdin extends EventEmitter {
  chunks: string[] = [];
  ended = false;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

/** A helper process that never runs anything: the test plays the helper's side of the protocol. */
class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.exit(null);
    return true;
  }
  exit(code: number | null): void {
    if (this.exitCode !== null || this.listenerCount('exit') === 0) return;
    this.exitCode = code ?? 1;
    this.emit('exit', code);
  }
  say(line: string): void {
    this.stdout.emit('data', Buffer.from(`${line}\n`));
  }
  /** Lines written after the script, i.e. the requests. */
  get requests(): string[] {
    const lines = this.stdin.chunks.join('').split('\n');
    return lines.slice(lines.indexOf(HELPER_END) + 1).filter(Boolean);
  }
}

function fakeClock() {
  let now = 0;
  let timers: { at: number; fn: () => void }[] = [];
  const api: HelloTimers = {
    setTimeout(fn, ms) {
      const handle = { at: now + ms, fn };
      timers.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      timers = timers.filter((t) => t !== handle);
    },
  };
  return {
    timers: api,
    now: () => now,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = end;
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const HWND = 0x1234567890abcdefn;

function fakeWindow(opts: { minimized?: boolean; handle?: Buffer } = {}) {
  const handle = opts.handle ?? Buffer.alloc(8);
  if (!opts.handle) handle.writeBigUInt64LE(HWND);
  const win = {
    isDestroyed: () => false,
    isMinimized: () => opts.minimized ?? false,
    isVisible: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    getNativeWindowHandle: () => handle,
  };
  return { win, bw: win as unknown as BrowserWindow };
}

function setup(overrides: Partial<WindowsHelloDeps> = {}) {
  const clock = fakeClock();
  const children: FakeChild[] = [];
  const spawned: { command: string; args: string[] }[] = [];
  const logs: string[] = [];
  const provider = createWindowsHelloProvider({
    platform: 'win32',
    env: { SystemRoot: 'C:\\WINDOWS' },
    osRelease: () => '10.0.22631',
    timers: clock.timers,
    now: clock.now,
    log: (m) => logs.push(m),
    spawn: (command, args): HelperChild => {
      spawned.push({ command, args: [...args] });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    ...overrides,
  });
  const child = (i = children.length - 1): FakeChild => {
    const c = children[i];
    if (!c) throw new Error(`no helper #${i}`);
    return c;
  };
  return { provider, clock, children, spawned, logs, child };
}

/** Starts a request, lets the helper report ready, and returns the request line it received. */
async function started<T>(s: ReturnType<typeof setup>, call: () => Promise<T>): Promise<{ result: Promise<T>; line: string }> {
  const result = call();
  await flush();
  const c = s.child();
  if (!c.requests.length && !c.stdout.listenerCount('data')) throw new Error('helper not spawned');
  c.say('ready 10.0.22631 64');
  await flush();
  return { result, line: c.requests.at(-1) ?? '' };
}

// ---- process launch ------------------------------------------------------------------------------

describe('windows hello helper launch', () => {
  it('starts the in-box PowerShell by absolute path with a plain command line', async () => {
    const s = setup();
    s.provider.prepare?.();
    expect(s.spawned).toHaveLength(1);
    const { command, args } = s.spawned[0]!;
    expect(command).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', HELPER_BOOTSTRAP]);
    const flat = args.join(' ').toLowerCase();
    for (const flag of ['-encodedcommand', '-enc ', '-executionpolicy', '-windowstyle', '-file']) expect(flat).not.toContain(flag);
    // The script goes over stdin, terminated by the end marker.
    expect(s.child().stdin.chunks[0]).toBe(`${HELPER_SCRIPT}\n${HELPER_END}\n`);
  });

  it('builds the PowerShell path from SystemRoot, then windir, never from PATH', () => {
    expect(powershellPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(powershellPath({ windir: 'E:\\W' })).toBe('E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(powershellPath({ SystemRoot: 'relative', PATH: 'C:\\evil' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('reads the Windows build from os.release()', () => {
    expect(windowsBuild('10.0.22631')).toBe(22631);
    expect(windowsBuild('10.0.19045')).toBe(19045);
    expect(windowsBuild('6.3.9600')).toBe(0);
    expect(windowsBuild('garbage')).toBe(0);
  });

  it('passes the HWND as an unsigned decimal of the little-endian handle buffer', () => {
    expect(hwndOf(fakeWindow().win)).toBe(HWND.toString());
    const small = Buffer.alloc(4);
    small.writeUInt32LE(0x00a1b2c3);
    expect(hwndOf(fakeWindow({ handle: small }).win)).toBe(String(0x00a1b2c3));
  });
});

// ---- availability --------------------------------------------------------------------------------

describe('windows hello availability', () => {
  it.each([
    ['Available', { kind: 'windowsHello', available: true }],
    ['DeviceBusy', { kind: 'windowsHello', available: true }],
    ['DeviceNotPresent', { kind: 'windowsHello', available: false, reason: 'noHardware' }],
    ['NotConfiguredForUser', { kind: 'windowsHello', available: false, reason: 'notEnrolled' }],
    ['DisabledByPolicy', { kind: 'windowsHello', available: false, reason: 'disabledByPolicy' }],
    ['Unknown7', { kind: 'windowsHello', available: false, reason: 'error', detail: 'unexpected availability Unknown7' }],
  ])('maps %s', async (value, expected) => {
    const s = setup();
    const { result, line } = await started(s, () => s.provider.availability());
    expect(line).toBe('check 1');
    s.child().say(`check 1 ${value}`);
    expect(await result).toEqual(expected);
  });

  it('tolerates a BOM and CRLF line endings', async () => {
    const s = setup();
    const result = s.provider.availability();
    await flush();
    s.child().stdout.emit('data', Buffer.from('\uFEFFready 10.0.22631 64\r\n'));
    await flush();
    s.child().stdout.emit('data', 'check 1 Avail');
    s.child().stdout.emit('data', 'able\r\n');
    expect(await result).toEqual({ kind: 'windowsHello', available: true });
  });

  it('reports a missing WinRT class as unsupported and does not start PowerShell again', async () => {
    const s = setup();
    const { result } = await started(s, () => s.provider.availability());
    s.child().say('error 1 0x80040154 RoGetActivationFactory');
    expect(await result).toMatchObject({ available: false, reason: 'unsupported' });
    expect(await s.provider.availability()).toMatchObject({ available: false, reason: 'unsupported' });
    expect(s.spawned).toHaveLength(1);
  });

  it('reports E_NOINTERFACE (no interop on this build) as unsupported', async () => {
    const s = setup();
    const { result } = await started(s, () => s.provider.availability());
    s.child().say('error 1 0x80004002 RoGetActivationFactory');
    expect(await result).toMatchObject({ available: false, reason: 'unsupported', detail: expect.stringContaining('0x80004002') });
  });

  it('reports Constrained Language Mode (exit 3) as disabled by policy, once per session', async () => {
    const s = setup();
    const result = s.provider.availability();
    await flush();
    s.child().exit(3);
    expect(await result).toMatchObject({ available: false, reason: 'disabledByPolicy', detail: expect.stringContaining('Constrained') });
    expect(await s.provider.availability()).toMatchObject({ reason: 'disabledByPolicy' });
    s.provider.prepare?.();
    expect(s.spawned).toHaveLength(1);
  });

  it('reports a script blocked by AMSI as disabled by policy', async () => {
    const s = setup();
    const result = s.provider.availability();
    await flush();
    s.child().stderr.emit('data', Buffer.from('At line:1 char:1\r\n+ FullyQualifiedErrorId : ScriptContainedMaliciousContent\r\n'));
    s.child().exit(1);
    expect(await result).toMatchObject({ available: false, reason: 'disabledByPolicy', detail: expect.stringContaining('antivirus') });
  });

  it('reports a compile error with its error number, once per session', async () => {
    const s = setup();
    const result = s.provider.availability();
    await flush();
    s.child().say('fatal compile CS0103 line 42');
    s.child().exit(4);
    expect(await result).toMatchObject({ available: false, reason: 'error', detail: expect.stringContaining('CS0103 line 42') });
    await s.provider.availability();
    expect(s.spawned).toHaveLength(1);
  });

  it('reports a missing powershell.exe (ENOENT) as unsupported', async () => {
    const s = setup();
    const result = s.provider.availability();
    s.child().emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    expect(await result).toMatchObject({ available: false, reason: 'unsupported', detail: 'Windows PowerShell not found' });
  });

  it('reports a synchronous spawn failure (blocked executable) as disabled by policy', async () => {
    const s = setup({
      spawn: () => {
        throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
      },
    });
    expect(await s.provider.availability()).toMatchObject({ available: false, reason: 'disabledByPolicy' });
  });

  it('reports a spawn refused by AppLocker / Defender (libuv UNKNOWN) as disabled by policy, once per session', async () => {
    let calls = 0;
    const s = setup({
      spawn: () => {
        calls++;
        throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN', errno: -4094 });
      },
    });
    expect(await s.provider.availability()).toMatchObject({
      available: false,
      reason: 'disabledByPolicy',
      detail: 'Windows PowerShell may not be started',
    });
    expect(await s.provider.availability()).toMatchObject({ reason: 'disabledByPolicy' });
    s.provider.prepare?.();
    expect(await s.provider.verify('Unlock', fakeWindow().bw)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(calls).toBe(1);
  });

  it('keeps transient spawn failures (EMFILE) retryable', async () => {
    let calls = 0;
    const s = setup({
      spawn: () => {
        calls++;
        throw Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' });
      },
    });
    expect(await s.provider.availability()).toMatchObject({ available: false, reason: 'error' });
    await s.provider.availability();
    expect(calls).toBe(2);
  });

  it('gives up when the helper does not start in time, and kills it', async () => {
    const s = setup();
    const result = s.provider.availability();
    await flush();
    s.clock.advance(30_000);
    expect(await result).toMatchObject({ available: false, reason: 'error', detail: expect.stringContaining('did not start') });
    expect(s.child().killed).toBe(true);
    // Transient: the next check starts a new helper.
    void s.provider.availability();
    await flush();
    expect(s.spawned).toHaveLength(2);
  });

  it('times out a check that never answers', async () => {
    const s = setup();
    const { result } = await started(s, () => s.provider.availability());
    s.clock.advance(15_000);
    expect(await result).toMatchObject({ available: false, reason: 'error', detail: 'check timed out' });
  });

  it('closes a helper started only for a check after a minute of idle time', async () => {
    const s = setup();
    const { result } = await started(s, () => s.provider.availability());
    s.child().say('check 1 Available');
    await result;
    s.clock.advance(59_000);
    expect(s.child().stdin.ended).toBe(false);
    s.clock.advance(1_000);
    expect(s.child().stdin.ended).toBe(true);
    s.child().exit(0);
    expect(s.child().killed).toBe(false);
  });

  it('reuses one helper for repeated checks', async () => {
    const s = setup();
    const first = await started(s, () => s.provider.availability());
    s.child().say('check 1 Available');
    await first.result;
    const second = s.provider.availability();
    await flush();
    expect(s.child().requests).toEqual(['check 1', 'check 2']);
    s.child().say('check 2 NotConfiguredForUser');
    expect(await second).toMatchObject({ reason: 'notEnrolled' });
    expect(s.spawned).toHaveLength(1);
  });
});

// ---- verify --------------------------------------------------------------------------------------

describe('windows hello verify', () => {
  it('sends the HWND and the base64 UTF-8 message, and brings the window forward', async () => {
    const s = setup();
    const { win, bw } = fakeWindow({ minimized: true });
    const reason = '解锁 Tape';
    const { result, line } = await started(s, () => s.provider.verify(reason, bw));
    const [op, id, hwnd, message] = line.split(' ');
    expect([op, id, hwnd]).toEqual(['verify', '1', HWND.toString()]);
    expect(Buffer.from(message!, 'base64').toString('utf8')).toBe(reason);
    expect(win.restore).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    s.child().say('verify 1 Verified');
    expect(await result).toEqual({ ok: true });
    // The prompt text is never logged.
    expect(s.logs.join('\n')).not.toContain(reason);
    expect(s.logs.join('\n')).not.toContain(message);
  });

  it('keeps the message on one line and falls back to a default text', async () => {
    const s = setup();
    const { result, line } = await started(s, () => s.provider.verify('  \n ', fakeWindow().bw));
    expect(Buffer.from(line.split(' ')[3]!, 'base64').toString('utf8')).toBe('Unlock Tape');
    s.child().say('verify 1 Canceled');
    await result;
    const next = s.provider.verify('a\nb'.repeat(500), fakeWindow().bw);
    await flush();
    const text = Buffer.from(s.child().requests.at(-1)!.split(' ')[3]!, 'base64').toString('utf8');
    expect(text).not.toContain('\n');
    expect(text.length).toBe(200);
    s.child().say('verify 2 Canceled');
    await next;
  });

  it.each([
    ['verify 1 Verified', { ok: true }],
    ['verify 1 Canceled', { ok: false, reason: 'canceled' }],
    ['verify 1 RetriesExhausted', { ok: false, reason: 'failed' }],
    ['verify 1 DeviceBusy', { ok: false, reason: 'busy' }],
    ['verify 1 DeviceNotPresent', { ok: false, reason: 'unavailable', detail: 'DeviceNotPresent' }],
    ['verify 1 NotConfiguredForUser', { ok: false, reason: 'unavailable', detail: 'NotConfiguredForUser' }],
    ['verify 1 DisabledByPolicy', { ok: false, reason: 'unavailable', detail: 'DisabledByPolicy' }],
    ['verify 1 Unknown9', { ok: false, reason: 'error', detail: 'unexpected result Unknown9' }],
    ['busy 1', { ok: false, reason: 'busy' }],
    ['error 1 0x800704C7 operation', { ok: false, reason: 'canceled' }],
    ['error 1 0x80070578 hwnd', { ok: false, reason: 'error', detail: 'hwnd failed with 0x80070578' }],
    ['error 1 0x80004002 RoGetActivationFactory', { ok: false, reason: 'unavailable', detail: 'Windows Hello API not available (0x80004002)' }],
  ])('maps "%s"', async (reply, expected) => {
    const s = setup();
    const { result } = await started(s, () => s.provider.verify('Unlock', fakeWindow().bw));
    s.child().say(reply);
    expect(await result).toEqual(expected);
  });

  it('allows one prompt at a time', async () => {
    const s = setup();
    const { result } = await started(s, () => s.provider.verify('Unlock', fakeWindow().bw));
    expect(await s.provider.verify('Unlock', fakeWindow().bw)).toEqual({ ok: false, reason: 'busy' });
    expect(s.child().requests).toEqual([expect.stringMatching(/^verify 1 /)]);
    s.child().say('verify 1 Verified');
    expect(await result).toEqual({ ok: true });
    // Free again afterwards.
    const again = s.provider.verify('Unlock', fakeWindow().bw);
    await flush();
    s.child().say('verify 2 Canceled');
    expect(await again).toEqual({ ok: false, reason: 'canceled' });
  });

  it('times out after two minutes, cancels the prompt and ends the helper', async () => {
    const s = setup();
    const { result } = await started(s, () => s.provider.verify('Unlock', fakeWindow().bw));
    s.clock.advance(119_000);
    s.clock.advance(1_000);
    expect(await result).toEqual({ ok: false, reason: 'timeout' });
    const c = s.child();
    expect(c.requests.at(-1)).toBe('cancel 1');
    expect(c.stdin.ended).toBe(true);
    s.clock.advance(5_000); // did not exit on its own
    expect(c.killed).toBe(true);
    // A late answer is ignored and the next verify starts a fresh helper.
    c.say('verify 1 Verified');
    void s.provider.verify('Unlock', fakeWindow().bw);
    await flush();
    expect(s.spawned).toHaveLength(2);
  });

  it('reports a helper crash during the prompt as an error and recovers on the next call', async () => {
    const s = setup();
    const { result } = await started(s, () => s.provider.verify('Unlock', fakeWindow().bw));
    s.child().stderr.emit('data', 'Unhandled exception\r\nat somewhere\r\n');
    s.child().exit(-1073741819);
    expect(await result).toEqual({ ok: false, reason: 'error', detail: 'helper exited with code -1073741819: Unhandled exception' });
    expect(s.logs.some((l) => l.includes('-1073741819'))).toBe(true);
    void s.provider.availability();
    await flush();
    expect(s.spawned).toHaveLength(2);
  });

  it('resolves canceled when disposed during the prompt (unlocked with the PIN, or quit)', async () => {
    const s = setup();
    s.provider.prepare?.();
    const { result } = await started(s, () => s.provider.verify('Unlock', fakeWindow().bw));
    s.provider.dispose?.();
    expect(await result).toEqual({ ok: false, reason: 'canceled' });
    expect(s.child().stdin.ended).toBe(true);
  });

  it('needs a live window', async () => {
    const s = setup();
    expect(await s.provider.verify('Unlock', null)).toEqual({ ok: false, reason: 'error', detail: 'no window' });
    const destroyed = { ...fakeWindow().win, isDestroyed: () => true } as unknown as BrowserWindow;
    expect(await s.provider.verify('Unlock', destroyed)).toEqual({ ok: false, reason: 'error', detail: 'no window' });
    expect(s.spawned).toHaveLength(0);
  });

  it('waits for a helper that is still starting', async () => {
    const s = setup();
    s.provider.prepare?.();
    const result = s.provider.verify('Unlock', fakeWindow().bw);
    await flush();
    expect(s.child().requests).toEqual([]);
    s.child().say('ready 10.0.22631 64');
    await flush();
    expect(s.child().requests).toEqual([expect.stringMatching(/^verify 1 /)]);
    s.child().say('verify 1 Verified');
    expect(await result).toEqual({ ok: true });
    expect(s.spawned).toHaveLength(1);
  });
});

// ---- lifecycle -----------------------------------------------------------------------------------

describe('windows hello lifecycle', () => {
  it('prepare() keeps a warm helper until dispose()', async () => {
    const s = setup();
    s.provider.prepare?.();
    s.provider.prepare?.();
    expect(s.spawned).toHaveLength(1);
    const { result } = await started(s, () => s.provider.availability());
    s.child().say('check 1 Available');
    await result;
    s.clock.advance(10 * 60_000);
    expect(s.child().stdin.ended).toBe(false); // no idle exit while locked
    s.provider.dispose?.();
    expect(s.child().stdin.ended).toBe(true);
    s.child().exit(0); // exits on its own after stdin EOF
    s.clock.advance(5_000);
    expect(s.child().killed).toBe(false);
  });

  it('kills a helper that does not exit after dispose()', async () => {
    const s = setup();
    s.provider.prepare?.();
    s.provider.dispose?.();
    s.clock.advance(4_999);
    expect(s.child().killed).toBe(false);
    s.clock.advance(1);
    expect(s.child().killed).toBe(true);
  });

  it('dispose() without a helper is a no-op', () => {
    const s = setup();
    s.provider.dispose?.();
    expect(s.spawned).toHaveLength(0);
  });
});

describe('windows hello on other platforms', () => {
  it('is unsupported and never spawns anything outside Windows', async () => {
    const s = setup({ platform: 'darwin' });
    expect(await s.provider.availability()).toEqual({ kind: 'windowsHello', available: false, reason: 'unsupported', detail: 'Windows only' });
    expect(await s.provider.verify('Unlock', fakeWindow().bw)).toEqual({ ok: false, reason: 'unavailable', detail: 'Windows only' });
    s.provider.prepare?.();
    s.provider.dispose?.();
    expect(s.spawned).toHaveLength(0);
  });

  it('is unsupported below the build pre-filter (Windows 10 1709)', async () => {
    const s = setup({ osRelease: () => '10.0.15063' });
    expect(await s.provider.availability()).toMatchObject({ available: false, reason: 'unsupported', detail: 'Windows build 15063' });
    s.provider.prepare?.();
    expect(s.spawned).toHaveLength(0);
  });
});

// ---- helper script -------------------------------------------------------------------------------

/** WinRT parameterized interface IID: SHA-1 name-based UUID over the pinterface namespace. */
function piid(signature: string): string {
  const ns = Buffer.from('11f47ad57b7342c0abae878b1e16adee', 'hex');
  const h = createHash('sha1').update(Buffer.concat([ns, Buffer.from(signature, 'utf8')])).digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString('hex').toUpperCase();
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const IASYNC_OPERATION = '{9fc2b0bb-e446-44e2-aa61-9cab8f636af2}';
const asyncOp = (t: string) => piid(`pinterface(${IASYNC_OPERATION};${t})`);
const csharp = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf("@'") + 2, HELPER_SCRIPT.indexOf("'@"));

describe('windows hello helper script', () => {
  it('computes known parameterized IIDs', () => {
    expect(asyncOp('b1')).toBe('CDB5EFB3-5788-509D-9BE1-71CCB8A3362A'); // IAsyncOperation<Boolean>
    expect(piid('pinterface({faa585ea-6214-4217-afda-7f46de5869b3};string)')).toBe('E2FCC7C1-3BFC-5A0B-B2B0-72E769D1CB7E'); // IIterable<String>
  });

  it('uses the IIDs of IAsyncOperation<UserConsentVerificationResult> and <UserConsentVerifierAvailability>', () => {
    expect(csharp).toContain(asyncOp('enum(Windows.Security.Credentials.UI.UserConsentVerificationResult;i4)'));
    expect(csharp).toContain(asyncOp('enum(Windows.Security.Credentials.UI.UserConsentVerifierAvailability;i4)'));
  });

  it('uses the documented interface IIDs and class name', () => {
    expect(csharp).toContain('"39E050C3-4E74-441A-8DC0-B81104DF949C"'); // IUserConsentVerifierInterop
    expect(csharp).toContain('"AF4F3F91-564C-4DDC-B8B5-973447627C65"'); // IUserConsentVerifierStatics
    expect(csharp).toContain('"00000036-0000-0000-C000-000000000046"'); // IAsyncInfo
    expect(csharp).toContain('"Windows.Security.Credentials.UI.UserConsentVerifier"');
  });

  it('activates the interop that verify uses during the availability check', () => {
    // Without this probe a build lacking IUserConsentVerifierInterop (documented from 22000) would
    // report Windows Hello as available and fail with E_NOINTERFACE on the first click.
    const check = csharp.slice(csharp.indexOf('static int CheckAvailability()'), csharp.indexOf('static int Verify('));
    const probe = check.indexOf('GetFactory(IidInterop');
    expect(probe).toBeGreaterThan(0);
    expect(probe).toBeLessThan(check.indexOf('GetFactory(IidStatics'));
    expect(check).toContain('Marshal.Release(GetFactory(IidInterop');
  });

  it('names results in enum order', () => {
    expect(csharp).toContain('{ "Verified", "DeviceNotPresent", "NotConfiguredForUser", "DisabledByPolicy", "DeviceBusy", "RetriesExhausted", "Canceled" }');
    expect(csharp).toContain('{ "Available", "DeviceNotPresent", "NotConfiguredForUser", "DisabledByPolicy", "DeviceBusy" }');
  });

  it('is ASCII, has no early end marker and keeps the bootstrap free of double quotes', () => {
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(HELPER_SCRIPT)).toBe(true);
    expect(HELPER_SCRIPT.split('\n')).not.toContain(HELPER_END);
    expect(HELPER_BOOTSTRAP).not.toContain('"');
    expect(HELPER_ARGS.at(-1)).toBe(HELPER_BOOTSTRAP);
  });

  it('keeps the C# within C# 5 and inside the here-string', () => {
    // The in-box csc of .NET Framework 4.x compiles C# 5: no interpolation, ?., nameof or => members.
    expect(csharp).not.toMatch(/\$"|\?\.|nameof\(|=>/);
    // A line starting with '@ would end the PowerShell here-string early.
    expect(csharp.split('\n').some((l) => l.startsWith("'@"))).toBe(false);
    let depth = 0;
    for (const ch of csharp.replace(/"(?:[^"\\]|\\.)*"/g, '""')) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
