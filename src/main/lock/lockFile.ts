// userData/lock.json: the PIN hash and the wrong-PIN counter. Main-only: it never reaches the
// renderer and is not part of Settings (which updateSettings could patch).
//
// Written synchronously and atomically (temporary file, fsync, rename) with mode 0600, so other
// local users cannot read the hash. Writes are rare (PIN change, wrong PIN, successful unlock).

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { parsePinRecord, type PinRecord } from './pin';

export const LOCK_FILE = 'lock.json';

export interface LockData {
  pin: PinRecord | null;
  /** Consecutive wrong PINs. */
  failures: number;
  /** Unix ms before which attempts are refused. */
  retryAt: number | null;
  /**
   * lock.json exists but could not be read or understood (permissions, a damaged file, a record of
   * a newer version). A PIN may exist, so Tape fails closed: it stays locked, no PIN is accepted,
   * and the file is never overwritten; Forgot PIN (which deletes it) is the way out.
   */
  unreadable?: true;
}

/** Storage of LockData; the lock service only sees this (tests use an in-memory one). */
export interface LockStore {
  read(): LockData;
  write(data: LockData): void;
}

export const emptyLockData = (): LockData => ({ pin: null, failures: 0, retryAt: null });

const unreadableLockData = (): LockData => ({ pin: null, failures: 0, retryAt: null, unreadable: true });

/**
 * Only a file whose `pin` is explicitly null means "no PIN". Anything else that is not a valid
 * record (not an object, no `pin` field, an unknown or out-of-range record) is unreadable.
 */
export function parseLockData(raw: unknown): LockData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return unreadableLockData();
  const r = raw as Record<string, unknown>;
  const failures = Number.isInteger(r.failures) && (r.failures as number) > 0 ? Math.min(r.failures as number, 1000) : 0;
  const retryAt = typeof r.retryAt === 'number' && Number.isFinite(r.retryAt) ? r.retryAt : null;
  if (r.pin === null) return { pin: null, failures, retryAt };
  const pin = parsePinRecord(r.pin);
  return pin ? { pin, failures, retryAt } : { ...unreadableLockData(), failures, retryAt };
}

/** Read errors worth another try (Windows: antivirus or the indexer holding the file). */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE', 'EIO']);
const READ_ATTEMPTS = 3;
const RETRY_DELAY_MS = 50;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function createLockFile(path: string, onError: (message: string, err?: unknown) => void = (m, e) => console.error(`[lock] ${m}`, e ?? '')): LockStore {
  return {
    read() {
      let text: string | null = null;
      for (let attempt = 1; text == null; attempt++) {
        try {
          text = readFileSync(path, 'utf8');
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return emptyLockData();
          if (attempt >= READ_ATTEMPTS || !TRANSIENT.has(code ?? '')) {
            onError(`cannot read ${path}; staying locked`, err);
            return unreadableLockData();
          }
          sleepSync(RETRY_DELAY_MS);
        }
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        onError(`${path} is not valid JSON; staying locked`, err);
        return unreadableLockData();
      }
      const data = parseLockData(raw);
      if (data.unreadable) onError(`${path} holds no PIN record Tape understands; staying locked`);
      return data;
    },
    write(data) {
      if (data.unreadable) throw new Error('lock.json is unreadable; it is not overwritten');
      const tmp = `${path}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(path), { recursive: true });
        const fd = openSync(tmp, 'w', 0o600);
        try {
          writeSync(fd, JSON.stringify({ v: 1, pin: data.pin, failures: data.failures, retryAt: data.retryAt }) + '\n');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, path);
        // rename keeps the temporary file's mode; make sure an older file's mode does not linger.
        if (process.platform !== 'win32') chmodSync(path, 0o600);
      } catch (err) {
        onError(`cannot write ${path}`, err);
        try {
          unlinkSync(tmp);
        } catch {
          // Nothing to clean up.
        }
        throw err;
      }
    },
  };
}

export function memoryLockStore(initial: LockData = emptyLockData()): LockStore & { data: LockData } {
  const store = {
    data: structuredClone(initial),
    read: () => structuredClone(store.data),
    write: (d: LockData) => void (store.data = structuredClone(d)),
  };
  return store;
}
