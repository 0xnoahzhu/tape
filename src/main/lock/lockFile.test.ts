import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLockFile, emptyLockData, parseLockData } from './lockFile';
import { hashPin } from './pin';

describe('lock.json', () => {
  let dir: string;
  const errors: string[] = [];
  const open = () => createLockFile(join(dir, 'lock.json'), (m) => errors.push(m));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tape-lock-'));
    errors.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads as "no PIN" when missing', () => {
    expect(open().read()).toEqual(emptyLockData());
    expect(errors).toEqual([]);
  });

  it('round-trips the hash and the failure counter', async () => {
    const pin = await hashPin('123456', { N: 1024, r: 8, p: 1 });
    const f = open();
    f.write({ pin, failures: 6, retryAt: 1_700_000_060_000 });
    expect(open().read()).toEqual({ pin, failures: 6, retryAt: 1_700_000_060_000 });
    expect(readdirSync(dir)).toEqual(['lock.json']);
    expect(readFileSync(join(dir, 'lock.json'), 'utf8')).not.toContain('123456');
  });

  it.skipIf(process.platform === 'win32')('is readable by the owner only', () => {
    writeFileSync(join(dir, 'lock.json'), '{}', { mode: 0o644 });
    open().write(emptyLockData());
    expect(statSync(join(dir, 'lock.json')).mode & 0o777).toBe(0o600);
  });

  // Fails closed: a file that exists but cannot be understood may hold a PIN.
  const unreadable = { pin: null, failures: 0, retryAt: null, unreadable: true };

  it('treats a damaged file as unreadable (not as "no PIN"), reports it and leaves it alone', () => {
    writeFileSync(join(dir, 'lock.json'), '{"v":1,"pin":{"algo":"scrypt","salt":"Ry/');
    const f = open();
    expect(f.read()).toEqual(unreadable);
    expect(errors[0]).toMatch(/not valid JSON/);
    expect(() => f.write(f.read())).toThrow(/not overwritten/);
    expect(readFileSync(join(dir, 'lock.json'), 'utf8')).toContain('Ry/');
  });

  it('treats a PIN record it does not understand as unreadable', async () => {
    const pin = await hashPin('123456', { N: 1024, r: 8, p: 1 });
    writeFileSync(join(dir, 'lock.json'), JSON.stringify({ v: 2, pin: { ...pin, N: 1 << 22 }, failures: 2, retryAt: null }));
    expect(open().read()).toEqual({ ...unreadable, failures: 2 });
    writeFileSync(join(dir, 'lock.json'), JSON.stringify({ v: 2, pin: { algo: 'argon2id', hash: 'x' } }));
    expect(open().read()).toEqual(unreadable);
    writeFileSync(join(dir, 'lock.json'), '[]');
    expect(open().read()).toEqual(unreadable);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('treats a file it may not read as unreadable', async () => {
    open().write({ pin: await hashPin('123456', { N: 1024, r: 8, p: 1 }), failures: 0, retryAt: null });
    chmodSync(join(dir, 'lock.json'), 0o000);
    try {
      expect(open().read()).toEqual(unreadable);
      expect(errors[0]).toMatch(/cannot read/);
    } finally {
      chmodSync(join(dir, 'lock.json'), 0o600);
    }
  });

  it('sanitizes what it reads; only an explicit null PIN means "no PIN"', () => {
    expect(parseLockData({ pin: null, failures: -3, retryAt: 'soon' })).toEqual(emptyLockData());
    expect(parseLockData({ pin: { algo: 'x' }, failures: -3, retryAt: 'soon' })).toEqual(unreadable);
    expect(parseLockData({ failures: 7.5 })).toEqual(unreadable);
    expect(parseLockData({ pin: null, failures: 7.5 }).failures).toBe(0);
    expect(parseLockData({ pin: null, failures: 1e9 }).failures).toBe(1000);
  });
});
