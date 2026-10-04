// Persistent caches: SQLite (userData/tape.db) on a worker thread, memory as the fallback.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { app } from 'electron';
import type { MainContext } from '../context';
import { createSqliteClient, type DbTransport } from './client';
import { createMemoryDatabase } from './memory';
import type { DbWorkerData } from './protocol';
import type { Database } from './types';

/** The worker bundle, built next to the main bundle (see the dbWorker entry in vite.electron.config.ts). */
const WORKER_FILE = 'dbWorker.js';

export function createDatabase(_ctx: MainContext): Database {
  const file = join(app.getPath('userData'), 'tape.db');
  return openDatabase(file, join(dirname(fileURLToPath(import.meta.url)), WORKER_FILE));
}

export function openDatabase(file: string, workerFile: string): Database {
  const closed = new Int32Array(new SharedArrayBuffer(4));
  let worker: Worker;
  try {
    worker = new Worker(workerFile, { name: 'tape-db', workerData: { file, closed } satisfies DbWorkerData });
  } catch (err) {
    console.warn('[db] could not start the database worker, caches are kept in memory:', err);
    return createMemoryDatabase();
  }
  // The worker never keeps the app alive; close() ends it on quit.
  worker.unref();
  const transport: DbTransport = {
    post: (req, transfer) => worker.postMessage(req, transfer),
    listen(onMessage, onFailure) {
      worker.on('message', onMessage);
      worker.on('error', onFailure);
      worker.on('messageerror', onFailure);
      worker.on('exit', (code) => onFailure(new Error(`database worker exited with code ${code}`)));
    },
    terminate: () => worker.terminate().then(() => undefined),
    waitClosed: (ms) => Atomics.wait(closed, 0, 0, ms) !== 'timed-out',
  };
  return createSqliteClient(transport);
}
