import { describe, expect, it } from 'vitest';
import { effectiveRetryAt, hashPin, isValidPin, MAX_WAIT_MS, parsePinRecord, retryAtAfter, SCRYPT_COST, verifyPin, waitAfter } from './pin';

// Cheap parameters keep the tests fast; one test uses the real cost.
const FAST = { N: 1024, r: 8, p: 1 };

describe('PIN hashing', () => {
  it('accepts exactly six characters of any kind', () => {
    for (const ok of ['123456', 'abcDEF', 'p@$$w0', '密码12ab', '١٢٣٤٥٦', '🔒🔑abcd', 'e\u0301abcde']) expect(isValidPin(ok)).toBe(true);
    for (const bad of ['12345', '1234567', ' 12345', 'abc def', 'abc\tde', 'abc\u200bde', 'abcde\n', '\ud800abcde', 123456, null]) expect(isValidPin(bad)).toBe(false);
  });

  it('is case-sensitive and treats NFC-equal PINs as the same', async () => {
    const rec = await hashPin('Caf\u00e9!x', FAST);
    expect(await verifyPin('Cafe\u0301!x', rec)).toBe(true);
    expect(await verifyPin('caf\u00e9!x', rec)).toBe(false);
    expect(await verifyPin('CAF\u00c9!X', rec)).toBe(false);
  });

  it('stores a salted hash, never the PIN', async () => {
    const a = await hashPin('123456', FAST);
    const b = await hashPin('123456', FAST);
    expect(a.algo).toBe('scrypt');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(JSON.stringify(a)).not.toContain('123456');
    expect(Buffer.from(a.hash, 'base64')).toHaveLength(32);
  });

  it('verifies the right PIN only', async () => {
    const rec = await hashPin('482915', FAST);
    expect(await verifyPin('482915', rec)).toBe(true);
    expect(await verifyPin('482916', rec)).toBe(false);
    expect(await verifyPin('48291', rec)).toBe(false);
    expect(await verifyPin('482915', { ...rec, hash: Buffer.alloc(8).toString('base64') })).toBe(false);
  });

  it('uses a real scrypt cost by default', async () => {
    const rec = await hashPin('000000');
    expect(rec).toMatchObject(SCRYPT_COST);
    expect(await verifyPin('000000', rec)).toBe(true);
  });

  it('refuses invalid PINs and malformed records', async () => {
    await expect(hashPin('12 456', FAST)).rejects.toThrow(/6 characters/);
    await expect(hashPin('12345', FAST)).rejects.toThrow(/6 characters/);
    const rec = await hashPin('123456', FAST);
    expect(parsePinRecord(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
    expect(parsePinRecord({ ...rec, N: 1000 })).toBeNull();
    expect(parsePinRecord({ ...rec, N: 1 << 24 })).toBeNull();
    expect(parsePinRecord({ ...rec, algo: 'md5' })).toBeNull();
    expect(parsePinRecord(null)).toBeNull();
  });
});

describe('wrong-PIN backoff', () => {
  it('allows five attempts, then waits 30 s doubling up to 15 min', () => {
    expect([1, 2, 3, 4].map(waitAfter)).toEqual([0, 0, 0, 0]);
    expect(waitAfter(5)).toBe(30_000);
    expect(waitAfter(6)).toBe(60_000);
    expect(waitAfter(7)).toBe(120_000);
    expect(waitAfter(9)).toBe(480_000);
    expect(waitAfter(10)).toBe(MAX_WAIT_MS);
    expect(waitAfter(500)).toBe(MAX_WAIT_MS);
  });

  it('turns failures into a retry time', () => {
    expect(retryAtAfter(4, 1000)).toBeNull();
    expect(retryAtAfter(5, 1000)).toBe(31_000);
  });

  it('expires the retry time and caps it at 15 minutes from now', () => {
    expect(effectiveRetryAt(null, 0)).toBeNull();
    expect(effectiveRetryAt(5000, 5000)).toBeNull();
    expect(effectiveRetryAt(9000, 5000)).toBe(9000);
    // A clock set back by a day must not lock the user out for a day.
    expect(effectiveRetryAt(86_400_000 + 5000, 5000)).toBe(5000 + MAX_WAIT_MS);
  });
});
