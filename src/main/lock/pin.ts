// PIN hashing and the wrong-PIN backoff. Pure apart from node:crypto, so it is unit tested.
//
// A 6-character PIN is short (and often all digits), so the hash alone cannot protect it against
// someone who can read lock.json; scrypt makes each guess cost ~50 ms of CPU and 32 MiB of memory,
// and the backoff (persisted next to the hash) limits guesses through the app itself.

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { isValidPin, normalizePin, PIN_LENGTH } from '@shared/lock';

export { isValidPin, PIN_LENGTH };

/** Error of a PIN that breaks the rule (the renderer never sends one; this is the backstop). */
export const PIN_RULE_MESSAGE = `The PIN must be ${PIN_LENGTH} characters without spaces or control characters`;

/** What lock.json stores for the PIN: never the PIN itself. */
export interface PinRecord {
  algo: 'scrypt';
  /** base64 */
  salt: string;
  /** base64 */
  hash: string;
  N: number;
  r: number;
  p: number;
}

/** 2^15 × 8 × 128 B = 32 MiB per hash; about 50–100 ms on current machines. */
export const SCRYPT_COST = { N: 1 << 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(pin: string, salt: Buffer, cost: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: cost.N, r: cost.r, p: cost.p, maxmem: 128 * cost.N * cost.r * cost.p + 16 * 1024 * 1024 };
  return new Promise((resolve, reject) => scrypt(normalizePin(pin), salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPin(pin: string, cost: { N: number; r: number; p: number } = SCRYPT_COST): Promise<PinRecord> {
  if (!isValidPin(pin)) throw new Error(PIN_RULE_MESSAGE);
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(pin, salt, cost);
  return { algo: 'scrypt', salt: salt.toString('base64'), hash: hash.toString('base64'), N: cost.N, r: cost.r, p: cost.p };
}

/** Constant-time comparison of the derived key; false for malformed input or records. */
export async function verifyPin(pin: string, record: PinRecord): Promise<boolean> {
  if (!isValidPin(pin)) return false;
  const expected = Buffer.from(record.hash, 'base64');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(pin, Buffer.from(record.salt, 'base64'), record);
  return timingSafeEqual(actual, expected);
}

/** Validates a record read from disk (its cost parameters bound the work a tampered file can cause). */
export function parsePinRecord(raw: unknown): PinRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const pow2 = (n: unknown) => Number.isInteger(n) && (n as number) >= 1024 && (n as number) <= 1 << 20 && ((n as number) & ((n as number) - 1)) === 0;
  const small = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 16;
  if (r.algo !== 'scrypt' || typeof r.salt !== 'string' || typeof r.hash !== 'string') return null;
  if (!pow2(r.N) || !small(r.r) || !small(r.p)) return null;
  return { algo: 'scrypt', salt: r.salt, hash: r.hash, N: r.N as number, r: r.r as number, p: r.p as number };
}

// ---------------------------------------------------------------------------
// Backoff after wrong PINs

/** Wrong PINs allowed before attempts are refused for a while. */
export const FREE_ATTEMPTS = 5;
const FIRST_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 15 * 60_000;

/** Wait after the `failures`-th consecutive wrong PIN: 0 for the first four, then 30 s doubling up to 15 min. */
export function waitAfter(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** Math.min(20, failures - FREE_ATTEMPTS));
}

/** Time of the next allowed attempt after `failures` wrong PINs, or null when there is no wait. */
export function retryAtAfter(failures: number, now: number): number | null {
  const wait = waitAfter(failures);
  return wait > 0 ? now + wait : null;
}

/**
 * The persisted retry time as of `now`: null once it has passed; capped at now + 15 min so a clock
 * that was set back (or a hand-edited file) cannot lock the user out for longer.
 */
export function effectiveRetryAt(retryAt: number | null, now: number): number | null {
  if (retryAt == null || !Number.isFinite(retryAt) || retryAt <= now) return null;
  return Math.min(retryAt, now + MAX_WAIT_MS);
}
