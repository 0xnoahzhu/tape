// Auto-lock: locks once the system has had no keyboard or mouse input for the configured time.
//
// System-wide idle (powerMonitor.getSystemIdleTime) rather than activity inside Tape: someone
// working in another app is at the machine and is not locked out of Tape, while an unattended
// machine still locks. Sleep needs care: the key press or lid opening that wakes the machine
// resets the system idle time, so a tick that runs late (its timer was frozen while asleep) counts
// the time since the previous tick as idle, on top of the idle time seen then.

export const IDLE_TICK_MS = 15_000;

export interface IdleDeps {
  /** Seconds since the last system-wide input (powerMonitor.getSystemIdleTime). */
  idleSeconds(): number;
  now(): number;
  /** Idle time that locks, or null when auto-lock is off (Never, no PIN, already locked). */
  limitMs(): number | null;
  onIdle(): void;
}

export interface IdleWatcher {
  start(): void;
  stop(): void;
  /** Runs one check now (also used on resume from sleep and before suspend). */
  check(): void;
}

export function createIdleWatcher(deps: IdleDeps, tickMs = IDLE_TICK_MS): IdleWatcher {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastCheck = deps.now();
  let lastIdleMs = 0;

  function check(): void {
    const now = deps.now();
    let idleMs = 0;
    try {
      idleMs = Math.max(0, deps.idleSeconds() * 1000);
    } catch {
      // Not available (e.g. before ready): treat as active.
    }
    const gap = now - lastCheck;
    const asleep = gap > 2 * tickMs ? lastIdleMs + gap : 0;
    lastCheck = now;
    lastIdleMs = idleMs;
    const limit = deps.limitMs();
    if (limit != null && Math.max(idleMs, asleep) >= limit) deps.onIdle();
  }

  return {
    start() {
      if (timer) return;
      lastCheck = deps.now();
      timer = setInterval(check, tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    check,
  };
}

/** The configured auto-lock time in ms, or null for Never. */
export function autoLockMs(lock: { autoLock: '15' | '30' | '60' | 'custom' | 'never'; customMinutes: number }): number | null {
  if (lock.autoLock === 'never') return null;
  const minutes = lock.autoLock === 'custom' ? lock.customMinutes : Number(lock.autoLock);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null;
}
