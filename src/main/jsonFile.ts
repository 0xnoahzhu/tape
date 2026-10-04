// One JSON document on disk with coalesced, atomic writes.
//
// Writes go to a temporary file that is fsync'ed and renamed over the target, so a crash
// never leaves a half-written file. Changes are coalesced: the first `set` schedules a write
// `delayMs` later and further sets within that window only replace the pending value.
// Writes are synchronous on purpose (the files are small); this keeps `flush()` trivially
// ordered with respect to timer-driven writes.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type LoadStatus = 'ok' | 'missing' | 'corrupt';

export interface JsonFileOptions<T> {
  /** Validates the parsed JSON. Return undefined to treat the file as corrupt. */
  parse(raw: unknown): T | undefined;
  /** Value used when the file is missing or corrupt. */
  fallback(): T;
  /** Indent the output (for files people may open by hand). */
  pretty?: boolean;
  delayMs?: number;
  onError?(message: string, err?: unknown): void;
}

export interface JsonFile<T> {
  readonly path: string;
  /** How the initial load went; a corrupt file has been moved aside as `*.corrupt-<ts>.json`. */
  readonly status: LoadStatus;
  get(): T;
  /** Replaces the value and schedules a write. */
  set(value: T): void;
  /** Writes a pending change now, synchronously. */
  flush(): void;
}

export function openJsonFile<T>(path: string, opts: JsonFileOptions<T>): JsonFile<T> {
  const delayMs = opts.delayMs ?? 300;
  const report = opts.onError ?? ((message, err) => console.error(`[store] ${message}`, ...(err === undefined ? [] : [err])));

  const initial = load();
  let value = initial.value;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function load(): { status: LoadStatus; value: T } {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', value: opts.fallback() };
      report(`cannot read ${path}`, err);
      return { status: 'corrupt', value: opts.fallback() };
    }
    let parsed: T | undefined;
    try {
      parsed = opts.parse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) return { status: 'ok', value: parsed };
    moveAside();
    return { status: 'corrupt', value: opts.fallback() };
  }

  /** Keeps the unreadable file for inspection instead of silently overwriting it. */
  function moveAside(): void {
    const stem = basename(path).replace(/\.json$/, '');
    const backup = join(dirname(path), `${stem}.corrupt-${Date.now()}.json`);
    try {
      renameSync(path, backup);
      report(`${path} is corrupt, moved to ${backup}`);
    } catch (err) {
      report(`cannot back up corrupt ${path}`, err);
    }
  }

  function write(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    const data = JSON.stringify(value, null, opts.pretty ? 2 : undefined) + '\n';
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch (err) {
      report(`cannot write ${path}`, err);
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing to clean up.
      }
    }
  }

  return {
    path,
    status: initial.status,
    get: () => value,
    set(next) {
      value = next;
      dirty = true;
      if (!timer) {
        timer = setTimeout(write, delayMs);
        timer.unref?.();
      }
    },
    flush: write,
  };
}
