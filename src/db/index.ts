import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

import type { Database, Options } from 'better-sqlite3';

export type Db = Database;

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as {
  new (path: string, options?: Options): Database;
};

// --------------- ID generator --------------------------------

export function generateId(): string {
  return randomBytes(4).toString('hex');
}

// --------------- Migration runner ----------------------------

function runMigrations(db: Db): void {
  // Ensure the migrations tracking table exists before anything else.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      ran_at INTEGER NOT NULL
    )
  `);

  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort();
  } catch {
    // No migrations directory — nothing to run.
    return;
  }

  const ranStmt = db.prepare<[], { name: string }>('SELECT name FROM _migrations');
  const ran = new Set(ranStmt.all().map((r) => r.name));

  const insertStmt = db.prepare<[string, number], void>(
    'INSERT INTO _migrations (name, ran_at) VALUES (?, ?)',
  );

  for (const file of files) {
    if (ran.has(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    const applyMigration = db.transaction(() => {
      db.exec(sql);
      insertStmt.run(file, Date.now());
    });

    applyMigration();
  }
}

// --------------- openDb --------------------------------------

export function openDb(dbPath: string): Db {
  const db = new BetterSqlite3(dbPath) as Db;

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');

  runMigrations(db);

  return db;
}
