import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openJsonFile } from './jsonFile';

interface Doc {
  n: number;
}

const parse = (raw: unknown): Doc | undefined =>
  typeof raw === 'object' && raw !== null && typeof (raw as Doc).n === 'number' ? { n: (raw as Doc).n } : undefined;

describe('openJsonFile', () => {
  let dir: string;
  const errors: string[] = [];
  const open = (name = 'doc.json', delayMs = 300) =>
    openJsonFile<Doc>(join(dir, name), { parse, fallback: () => ({ n: 0 }), delayMs, onError: (msg) => errors.push(msg) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tape-json-'));
    errors.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the fallback when the file is missing', () => {
    const f = open();
    expect(f.status).toBe('missing');
    expect(f.get()).toEqual({ n: 0 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('loads a valid file', () => {
    writeFileSync(join(dir, 'doc.json'), '{"n": 5}');
    const f = open();
    expect(f.status).toBe('ok');
    expect(f.get()).toEqual({ n: 5 });
  });

  it('moves a corrupt file aside and falls back', () => {
    writeFileSync(join(dir, 'doc.json'), '{"n": 5');
    const f = open();
    expect(f.status).toBe('corrupt');
    expect(f.get()).toEqual({ n: 0 });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^doc\.corrupt-\d+\.json$/);
    expect(readFileSync(join(dir, files[0]), 'utf8')).toBe('{"n": 5');
  });

  it('treats valid JSON that fails validation as corrupt', () => {
    writeFileSync(join(dir, 'doc.json'), '[1, 2]');
    expect(open().status).toBe('corrupt');
    expect(readdirSync(dir)[0]).toMatch(/corrupt/);
  });

  it('coalesces writes and writes the latest value after the delay', () => {
    vi.useFakeTimers();
    const f = open();
    f.set({ n: 1 });
    f.set({ n: 2 });
    expect(readdirSync(dir)).toEqual([]);
    vi.advanceTimersByTime(299);
    expect(readdirSync(dir)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(JSON.parse(readFileSync(join(dir, 'doc.json'), 'utf8'))).toEqual({ n: 2 });
    // No temporary files are left behind.
    expect(readdirSync(dir)).toEqual(['doc.json']);
  });

  it('flush writes synchronously and cancels the pending timer', () => {
    vi.useFakeTimers();
    const f = open();
    f.set({ n: 7 });
    f.flush();
    expect(JSON.parse(readFileSync(join(dir, 'doc.json'), 'utf8'))).toEqual({ n: 7 });
    writeFileSync(join(dir, 'doc.json'), '{"n": 99}');
    vi.advanceTimersByTime(1000);
    // Nothing was pending any more, so the external change is not overwritten.
    expect(JSON.parse(readFileSync(join(dir, 'doc.json'), 'utf8'))).toEqual({ n: 99 });
  });

  it('flush without changes does not create the file', () => {
    open().flush();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('creates missing directories when writing', () => {
    const f = openJsonFile<Doc>(join(dir, 'a', 'b', 'doc.json'), { parse, fallback: () => ({ n: 0 }) });
    f.set({ n: 3 });
    f.flush();
    expect(JSON.parse(readFileSync(join(dir, 'a', 'b', 'doc.json'), 'utf8'))).toEqual({ n: 3 });
  });

  it('reports write errors instead of throwing', () => {
    writeFileSync(join(dir, 'blocker'), 'x');
    const f = openJsonFile<Doc>(join(dir, 'blocker', 'doc.json'), { parse, fallback: () => ({ n: 0 }), onError: (msg) => errors.push(msg) });
    f.set({ n: 1 });
    expect(() => f.flush()).not.toThrow();
    expect(errors.some((e) => e.startsWith('cannot write'))).toBe(true);
  });
});
