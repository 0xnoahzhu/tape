import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLUSH_BYTES, FLUSH_LINES, FLUSH_MS, createLogFileWriter, logFileName, type LogFileIo } from './apiLogFiles';

/** File system calls recorded in order; async appends finish when the test resolves them. */
function fakeIo() {
  const calls: string[] = [];
  /** Appends opening their file: `claim()` issues the write, `done()` / `fail()` settle them. */
  const pending: Array<{ path: string; text: string; claim: () => boolean; done: () => void; fail: (e: Error) => void }> = [];
  const io: LogFileIo = {
    mkdir: async (dir) => void calls.push(`mkdir ${dir}`),
    append: (path, text, claim) =>
      new Promise<void>((resolve, reject) => {
        calls.push(`append ${path} ${text.split('\n').length - 1}`);
        pending.push({ path, text, claim, done: resolve, fail: reject });
      }),
    mkdirSync: (dir) => void calls.push(`mkdirSync ${dir}`),
    appendSync: (path, text) => void calls.push(`appendSync ${path} ${text}`),
  };
  /** Finishes the oldest append in flight (it writes) and lets the writer continue. */
  const finish = async () => {
    const append = pending.shift();
    append?.claim();
    append?.done();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { io, calls, pending, finish };
}

const T0 = new Date(2026, 9, 4, 10, 0, 0).getTime();
const FILE = `/logs/${logFileName(T0)}`;

function setup(maxPending?: number) {
  const fs = fakeIo();
  /** Lines waiting to be formatted: [time, text]. */
  let source: Array<[number, string]> = [];
  const collect = vi.fn((line: (t: number, text: string) => void) => {
    for (const [t, text] of source) line(t, text);
    source = [];
  });
  const writer = createLogFileWriter({ dir: () => '/logs', collect, maxPending, io: fs.io });
  const add = (text: string, t = T0, bytes = 100) => {
    source.push([t, text]);
    writer.pending(bytes);
  };
  return { writer, collect, add, ...fs };
}

describe('log file writer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('formats lazily and writes a batch 500 ms after its first line', async () => {
    const { add, collect, calls, pending } = setup();
    add('a');
    await vi.advanceTimersByTimeAsync(200);
    add('b');
    add('c');
    await vi.advanceTimersByTimeAsync(FLUSH_MS - 201);
    expect(collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['mkdir /logs', `append ${FILE} 3`]);
    expect(pending[0].text).toBe('a\nb\nc\n');
  });

  it('takes the batch right after the current task at 64 KB or 4,096 lines', async () => {
    const big = setup();
    big.add('x', T0, FLUSH_BYTES - 1);
    expect(big.collect).not.toHaveBeenCalled();
    big.add('y', T0, 1);
    expect(big.collect).not.toHaveBeenCalled(); // never inside the socket handler
    await vi.advanceTimersByTimeAsync(0);
    expect(big.collect).toHaveBeenCalledTimes(1);

    const many = setup();
    for (let i = 0; i < FLUSH_LINES; i++) many.add(`l${i}`, T0, 1);
    expect(many.collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(many.collect).toHaveBeenCalledTimes(1);
    expect(many.pending[0].text.split('\n')).toHaveLength(FLUSH_LINES + 1);
  });

  it('takes the batch at maxPending right after the current synchronous work, before any I/O', async () => {
    const { add, collect, pending } = setup(3);
    add('a');
    add('b');
    add('c');
    add('d'); // same task: still part of this batch
    expect(collect).not.toHaveBeenCalled(); // the last line may not be complete yet
    await Promise.resolve();
    expect(collect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); // neither the 500 ms timer nor setImmediate was needed
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.map((p) => p.text)).toEqual(['a\nb\nc\nd\n']);
    add('e');
    add('f');
    add('g');
    await Promise.resolve();
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('splits a batch by local day', async () => {
    const { add, pending, finish } = setup();
    const midnight = new Date(2026, 9, 5).getTime();
    add('before', midnight - 1);
    add('after', midnight);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(pending.map((p) => [p.path, p.text])).toEqual([[`/logs/${logFileName(midnight - 1)}`, 'before\n']]);
    await finish();
    expect(pending.map((p) => [p.path, p.text])).toEqual([['/logs/api-20261005.log', 'after\n']]);
  });

  it('appends one chunk at a time, in order', async () => {
    const { writer, add, calls, pending, finish } = setup();
    add('first');
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    add('second');
    add('third');
    void writer.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1); // the second batch waits for the first append
    await finish();
    expect(pending.map((p) => p.text)).toEqual(['second\nthird\n']);
    await finish();
    expect(calls).toEqual(['mkdir /logs', `append ${FILE} 1`, `append ${FILE} 2`]);
  });

  it('flushes synchronously on quit, including a chunk whose write is not issued yet', async () => {
    const { writer, add, calls, pending } = setup();
    add('one');
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(pending).toHaveLength(1); // "one" is being appended: its file is still opening
    add('two');
    add('three');
    writer.flushSync(); // the process may exit before the append continues
    expect(calls.slice(2)).toEqual(['mkdirSync /logs', `appendSync ${FILE} one\n`, `appendSync ${FILE} two\nthree\n`]);
    // If the event loop goes on, the append writes nothing and nothing is sent again.
    expect(pending[0].claim()).toBe(false);
    pending[0].done();
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(calls).toHaveLength(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves an issued write to the OS on quit: no line twice', async () => {
    const { writer, add, calls, pending } = setup();
    add('one');
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(pending[0].claim()).toBe(true); // the write of "one" is issued
    add('two');
    writer.flushSync();
    expect(calls).toEqual(['mkdir /logs', `append ${FILE} 1`, 'mkdirSync /logs', `appendSync ${FILE} two\n`]);
  });

  it('forgets pending lines when discarded', async () => {
    const { writer, add, collect } = setup();
    add('a');
    writer.discard();
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 2);
    expect(collect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps going after a failed append', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { add, calls, pending, finish } = setup();
    add('lost');
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    pending.shift()?.fail(new Error('disk full'));
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledTimes(1);
    add('next');
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(pending.map((p) => p.text)).toEqual(['next\n']);
    await finish();
    // The folder is created again after a failure.
    expect(calls.filter((c) => c.startsWith('mkdir'))).toHaveLength(2);
  });

  it('survives a failing formatter', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const writer = createLogFileWriter({
      dir: () => '/logs',
      collect: () => {
        throw new Error('bad frame');
      },
      io: fakeIo().io,
    });
    writer.pending(10);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
