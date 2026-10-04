// Daily API log files: naming, retention and the batched writer.

import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

const pad = (n: number) => String(n).padStart(2, '0');

/** "api-20261003.log" for the local day of `t`. */
export function logFileName(t: number | Date): string {
  const d = new Date(t);
  return `api-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.log`;
}

/** Local midnight of the day in "api-YYYYMMDD.log", or null for other file names. */
export function logFileDay(name: string): Date | null {
  const m = /^api-(\d{4})(\d{2})(\d{2})\.log$/.exec(name);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Log files to delete: those whose day is `keepDays` or more days before today
 * (keepDays = 1 keeps only today's file, 7 keeps today and the six days before).
 */
export function expiredLogFiles(names: readonly string[], keepDays: number, now: Date = new Date()): string[] {
  const days = Math.max(1, Math.floor(keepDays));
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
  return names.filter((name) => {
    const day = logFileDay(name);
    return day !== null && day.getTime() < cutoff;
  });
}

// ---------------------------------------------------------------------------
// Batched writer

/** A batch is written this long after its first pending line… */
export const FLUSH_MS = 500;
/** …or as soon as its pending lines reach about this many bytes… */
export const FLUSH_BYTES = 64 * 1024;
/** …or this many lines (the API log ring holds 20,000 frames; a batch must stay well below). */
export const FLUSH_LINES = 4_096;

/** File system calls of the writer (replaced in tests). */
export interface LogFileIo {
  mkdir(dir: string): Promise<unknown>;
  /**
   * Appends `text`, calling `claim()` right before the write is issued (in the same task);
   * when it returns false, writes nothing (flushSync has written the text).
   */
  append(path: string, text: string, claim: () => boolean): Promise<void>;
  mkdirSync(dir: string): void;
  appendSync(path: string, text: string): void;
}

const nodeIo: LogFileIo = {
  mkdir: (dir) => mkdir(dir, { recursive: true }),
  async append(path, text, claim) {
    const file = await open(path, 'a');
    try {
      if (claim()) await file.writeFile(text, 'utf8');
    } finally {
      await file.close();
    }
  },
  mkdirSync: (dir) => void mkdirSync(dir, { recursive: true }),
  appendSync: (path, text) => appendFileSync(path, text, 'utf8'),
};

export interface LogFileWriterOptions {
  /** Folder of the log files, resolved when a batch is written. */
  dir(): string;
  /** Formats the pending lines: calls `line` with each line's time (Unix ms) and text, oldest first. */
  collect(line: (t: number, text: string) => void): void;
  /**
   * Pending lines at which the batch is taken in a microtask: once the current task's
   * synchronous work is done (its last line is complete) and before the next socket read, not
   * after all pending I/O, so back-to-back reads cannot outrun the source (the API log ring
   * overwrites its oldest frames).
   */
  maxPending?: number;
  io?: LogFileIo;
}

export interface LogFileWriter {
  /** One more line of about `bytes` bytes is pending (it is formatted later, by collect). */
  pending(bytes: number): void;
  /** Formats the pending lines now and appends them in the background; resolves once written. */
  flush(): Promise<void>;
  /**
   * Shutdown: formats the pending lines and synchronously appends every chunk whose write has
   * not been issued yet, including one whose append is still opening the file.
   */
  flushSync(): void;
  /** Forgets the pending lines (file logging was turned off). */
  discard(): void;
}

interface Chunk {
  name: string;
  text: string;
}

/**
 * Appends log lines to daily files (api-YYYYMMDD.log, by each line's local day) in batches.
 * Recording a line costs a counter update; lines are formatted when the batch is taken and
 * appended asynchronously one chunk at a time, so the event loop never waits for the disk.
 */
export function createLogFileWriter(opts: LogFileWriterOptions): LogFileWriter {
  const io = opts.io ?? nodeIo;
  const maxPending = opts.maxPending ?? Infinity;
  let lines = 0;
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let immediate: ReturnType<typeof setImmediate> | null = null;
  let takeQueued = false;

  /** Formatted text waiting to be appended, oldest first. */
  const queue: Chunk[] = [];
  /** The chunk being appended until its write is issued (flushSync may take it over). */
  let unclaimed: Chunk | null = null;
  let busy = false;
  let idle: Promise<void> = Promise.resolve();
  let madeDir = '';

  // The file of the current local day, so most lines skip the date math.
  let dayStart = 0;
  let dayEnd = 0;
  let dayName = '';

  function fileFor(t: number): string {
    if (!(t >= dayStart && t < dayEnd)) {
      const d = new Date(t);
      dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      dayName = logFileName(t);
    }
    return dayName;
  }

  function addLine(t: number, text: string): void {
    const name = fileFor(t);
    const last = queue[queue.length - 1];
    if (last && last.name === name) last.text += text + '\n';
    else queue.push({ name, text: text + '\n' });
  }

  function stopTimers(): void {
    if (timer) clearTimeout(timer);
    if (immediate) clearImmediate(immediate);
    timer = null;
    immediate = null;
  }

  /** Moves the pending lines into the queue as text. */
  function take(): void {
    stopTimers();
    if (!lines) return;
    lines = 0;
    bytes = 0;
    try {
      opts.collect(addLine);
    } catch (err) {
      console.error('[apiLog] formatting the log file batch failed:', err);
    }
  }

  async function pump(): Promise<void> {
    try {
      for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
        unclaimed = chunk;
        const claim = (): boolean => {
          if (unclaimed !== chunk) return false; // written by flushSync
          unclaimed = null;
          return true;
        };
        try {
          const dir = opts.dir();
          if (madeDir !== dir) {
            await io.mkdir(dir);
            madeDir = dir;
          }
          await io.append(join(dir, chunk.name), chunk.text, claim);
        } catch (err) {
          madeDir = '';
          console.error('[apiLog] writing the log file failed:', err);
        } finally {
          if (unclaimed === chunk) unclaimed = null;
        }
      }
    } finally {
      busy = false;
    }
  }

  function flush(): Promise<void> {
    take();
    if (!busy && queue.length) {
      busy = true;
      idle = pump();
    }
    return idle;
  }

  function takeNow(): void {
    takeQueued = false;
    void flush();
  }

  return {
    pending(n) {
      lines++;
      bytes += n;
      if (lines >= maxPending) {
        // In a microtask: after the handler, whose frame may not be complete yet (notes, order
        // state), but before the next socket read.
        if (!takeQueued) {
          takeQueued = true;
          queueMicrotask(takeNow);
        }
      } else if (bytes >= FLUSH_BYTES || lines >= FLUSH_LINES) {
        // Never format inside the socket handler: take the batch right after it.
        if (!immediate) immediate = setImmediate(() => void flush());
      } else if (!timer) {
        timer = setTimeout(() => void flush(), FLUSH_MS);
      }
    },
    flush,
    flushSync() {
      take();
      // An append's open, write and close are separate requests, each continued from the event
      // loop, which stops at exit. A chunk whose write is not issued yet is written here (its
      // append then skips it). An issued write is left to the thread pool: it may land after the
      // lines written here, and is lost only if the process exits before a pool thread runs it.
      const rest = queue.splice(0);
      if (unclaimed) {
        rest.unshift(unclaimed);
        unclaimed = null;
      }
      if (!rest.length) return;
      try {
        const dir = opts.dir();
        io.mkdirSync(dir);
        for (const chunk of rest) io.appendSync(join(dir, chunk.name), chunk.text);
      } catch (err) {
        console.error('[apiLog] writing the log file failed:', err);
      }
    },
    discard() {
      stopTimers();
      lines = 0;
      bytes = 0;
    },
  };
}
