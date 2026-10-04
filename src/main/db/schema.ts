// Connection settings and schema migrations of tape.db (worker side).
//
// Designed for large tables: bars are clustered by (series, time) in a WITHOUT ROWID table, so a
// range read is one B-tree seek plus a sequential scan however many rows the file holds; the
// executions journal is indexed by time; WAL keeps writes from blocking reads and fsyncs rare.

import type { DatabaseSync } from 'node:sqlite';

/** Page cache per connection (negative = KiB). */
const CACHE_KIB = 16 * 1024;
/** Memory-mapped I/O window: reads of hot pages skip the read() syscall. */
const MMAP_BYTES = 128 * 1024 * 1024;

const MIGRATIONS: readonly string[] = [
  // v1
  `
  CREATE TABLE series (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    intraday INTEGER NOT NULL
  );
  CREATE TABLE bars (
    series_id INTEGER NOT NULL REFERENCES series(id),
    time INTEGER NOT NULL,
    o REAL, h REAL, l REAL, c REAL, v REAL,
    PRIMARY KEY (series_id, time)
  ) WITHOUT ROWID;
  CREATE TABLE kv (
    ns TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (ns, key)
  ) WITHOUT ROWID;
  CREATE TABLE executions (
    exec_id TEXT PRIMARY KEY,
    time INTEGER NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX executions_time ON executions(time);
  CREATE TABLE nav (
    t INTEGER PRIMARY KEY,
    net_liq REAL NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** The file was written by a newer version of Tape: left untouched (the caller falls back to memory). */
export class NewerSchemaError extends Error {}

/** How long a statement waits for another connection's lock (a second instance, a DB tool). */
export const BUSY_TIMEOUT_MS = 5_000;

/** Connection PRAGMAs. Must run before migrate() so auto_vacuum applies to a new file. */
export function configure(db: DatabaseSync): void {
  // First: opening takes locks too (journal mode, migrations, optimize).
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // Only effective on an empty file (WAL writes the first page), and it opens a write
  // transaction: never on an existing file, which another connection may be writing.
  if ((db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count === 0) db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  const mode = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
  if (mode?.journal_mode !== 'wal') throw new Error(`WAL journal mode unavailable (${mode?.journal_mode})`);
  db.exec(`
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -${CACHE_KIB};
    PRAGMA mmap_size = ${MMAP_BYTES};
    PRAGMA analysis_limit = 400;
  `);
}

export function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

function knownVersion(db: DatabaseSync): number {
  const v = schemaVersion(db);
  if (v > SCHEMA_VERSION) throw new NewerSchemaError(`tape.db has schema v${v}; this version of Tape knows v${SCHEMA_VERSION}`);
  return v;
}

/** Applies pending migrations, each in its own transaction. */
export function migrate(db: DatabaseSync): number {
  let v = knownVersion(db);
  while (v < SCHEMA_VERSION) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Read again under the write lock: another connection may have migrated meanwhile.
      v = knownVersion(db);
      if (v < SCHEMA_VERSION) {
        db.exec(MIGRATIONS[v]);
        db.exec(`PRAGMA user_version = ${++v}`);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  // Long-lived connection: let SQLite gather the statistics it is missing (cheap, bounded).
  db.exec('PRAGMA optimize = 0x10002');
  return SCHEMA_VERSION;
}
