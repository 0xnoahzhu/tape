// Entry of the database worker thread (bundled as out/main/dbWorker.js, next to index.js).
// It must not import modules that the main bundle imports at runtime: the two are separate
// entries and a shared module would turn into a chunk file next to them.

import { parentPort, workerData } from 'node:worker_threads';
import type { DbWorkerData } from './protocol';
import { serve } from './server';

if (!parentPort) throw new Error('The database worker must run in a worker thread');
serve(parentPort, workerData as DbWorkerData);
