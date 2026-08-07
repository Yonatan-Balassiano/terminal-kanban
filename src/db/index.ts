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

// --------------- additive migrations -------------------------

/**
 * Add a column if it is missing.
 *
 * Bumping CURRENT_SCHEMA_VERSION drops and recreates every table, destroying
 * the user's board. Columns that are nullable or carry a default can be added
 * in place instead, so purely additive changes cost no data.
 */
function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  if (!tableExists(db, table)) {
    return;
  }

  const columns = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all();
  if (columns.some((row) => row.name === column)) {
    return;
  }

  db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${column} ${ddl}`);
}

function columnIsNotNull(db: Db, table: string, column: string): boolean {
  const columns = db
    .prepare<[], { name: string; notnull: number }>(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all();
  return columns.some((row) => row.name === column && row.notnull === 1);
}

/** The canonical `CREATE TABLE` statement for one table, taken from schema.sql. */
function schemaCreateStatement(table: string): string {
  const schemaSql = readFileSync(schemaPath(), 'utf8');
  const match = schemaSql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  if (!match) {
    throw new Error(`schema.sql has no CREATE TABLE for "${table}"`);
  }
  return match[0];
}

/**
 * Rebuild a table from its schema.sql definition, carrying over every column the
 * old and new definitions share.
 *
 * `ALTER TABLE` cannot drop a NOT NULL constraint, and bumping the schema
 * version would drop the user's board. This runs the twelve-step rebuild from
 * the SQLite docs instead, so a constraint change costs no data.
 */
function rebuildTableFromSchema(db: Db, table: string): void {
  const tempTable = `${table}_migration_new`;
  const createStatement = schemaCreateStatement(table).replace(
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    `CREATE TABLE ${tempTable} (`,
  );

  const oldColumns = new Set(
    db.prepare<[], { name: string }>(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name),
  );

  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tempTable)}`);
      db.exec(createStatement);

      const newColumns = db
        .prepare<[], { name: string }>(`PRAGMA table_info(${quoteIdentifier(tempTable)})`)
        .all()
        .map((row) => row.name)
        .filter((name) => oldColumns.has(name))
        .map(quoteIdentifier)
        .join(', ');

      db.exec(
        `INSERT INTO ${quoteIdentifier(tempTable)} (${newColumns})
         SELECT ${newColumns} FROM ${quoteIdentifier(table)}`,
      );
      db.exec(`DROP TABLE ${quoteIdentifier(table)}`);
      db.exec(`ALTER TABLE ${quoteIdentifier(tempTable)} RENAME TO ${quoteIdentifier(table)}`);
      // Dropping the table dropped its indexes; schema.sql recreates only what
      // is missing because every statement in it is IF NOT EXISTS.
      db.exec(readFileSync(schemaPath(), 'utf8'));
    })();
  } finally {
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Additive columns applied after the schema check.
 *
 * Keep every entry mirrored in schema.sql so a freshly created database and a
 * migrated one end up identical.
 */
function applyAdditiveMigrations(db: Db): void {
  ensureColumn(db, 'tasks', 'location', "TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, 'tasks', 'kind', "TEXT NOT NULL DEFAULT 'repo'");
  ensureColumn(db, 'repos', 'remote_path', 'TEXT');

  // General tasks belong to no repo, so tasks.repo_id had to become nullable.
  if (tableExists(db, 'tasks') && columnIsNotNull(db, 'tasks', 'repo_id')) {
    rebuildTableFromSchema(db, 'tasks');
  }
}

// --------------- openDb --------------------------------------

export function openDb(dbPath: string): Db {
  const db = new BetterSqlite3(dbPath) as Db;

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');

  ensureCurrentSchema(db);
  applyAdditiveMigrations(db);

  return db;
}
