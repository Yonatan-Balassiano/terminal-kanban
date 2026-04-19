import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

import type { Database, Options } from 'better-sqlite3';

export type Db = Database;

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as {
  new (path: string, options?: Options): Database;
};

const SCHEMA_VERSION_KEY = 'schema_version';
export const CURRENT_SCHEMA_VERSION = '2026-04-19-dual-session';

// --------------- ID generator --------------------------------

export function generateId(): string {
  return randomBytes(4).toString('hex');
}

function schemaPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name);
  return row !== undefined;
}

function listUserObjects(db: Db, type: 'table' | 'view'): string[] {
  return db
    .prepare<[string], { name: string }>(
      `SELECT name
         FROM sqlite_master
        WHERE type = ?
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all(type)
    .map((row) => row.name);
}

function currentSchemaVersion(db: Db): string | null {
  if (!tableExists(db, '_schema_meta')) {
    return null;
  }

  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM _schema_meta WHERE key = ?')
    .get(SCHEMA_VERSION_KEY);
  return row?.value ?? null;
}

function recreateSchema(db: Db): void {
  const schemaSql = readFileSync(schemaPath(), 'utf8');
  const viewNames = listUserObjects(db, 'view');
  const tableNames = listUserObjects(db, 'table');

  db.pragma('foreign_keys = OFF');
  try {
    const apply = db.transaction(() => {
      for (const viewName of viewNames) {
        db.exec(`DROP VIEW IF EXISTS ${quoteIdentifier(viewName)}`);
      }

      for (const tableName of tableNames) {
        db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
      }

      db.exec(schemaSql);
      db.prepare<[string, string, number], void>(
        `INSERT INTO _schema_meta (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE
           SET value = excluded.value,
               updated_at = excluded.updated_at`,
      ).run(SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION, Date.now());
    });

    apply();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function ensureCurrentSchema(db: Db): void {
  if (currentSchemaVersion(db) === CURRENT_SCHEMA_VERSION) {
    return;
  }

  recreateSchema(db);
}

// --------------- openDb --------------------------------------

export function openDb(dbPath: string): Db {
  const db = new BetterSqlite3(dbPath) as Db;

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');

  ensureCurrentSchema(db);

  return db;
}
