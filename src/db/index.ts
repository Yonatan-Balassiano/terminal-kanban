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
/** Marks the one-time seeding of task_branches from the pre-multi-branch columns. */
const TASK_BRANCHES_BACKFILL_KEY = 'task_branches_backfill';
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

/**
 * Create a table, and its indexes, if the database predates it.
 *
 * Bumping CURRENT_SCHEMA_VERSION drops and recreates everything, so a table
 * added later has to be created in place instead. Only the named table is
 * touched — replaying the whole of schema.sql would try to index columns that
 * the additive column migrations below have not added yet.
 */
function ensureTableFromSchema(db: Db, table: string): void {
  if (tableExists(db, table)) {
    return;
  }

  const schemaSql = readFileSync(schemaPath(), 'utf8');
  const indexes = schemaSql.match(
    new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \\w+ ON ${table}\\([^)]*\\);`, 'g'),
  );

  db.transaction(() => {
    db.exec(schemaCreateStatement(table));
    for (const statement of indexes ?? []) {
      db.exec(statement);
    }
  })();
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

  ensureColumn(db, 'tasks', 'active_branch_id', 'TEXT');
  ensureColumn(db, 'tasks', 'pr_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tasks', 'pr_open_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tasks', 'pr_merged_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'sessions', 'agent_session_id', 'TEXT');
  ensureColumn(db, 'tasks', 'initial_prompt', 'TEXT');
  ensureColumn(db, 'tasks', 'parent_task_id', 'TEXT');
  ensureColumn(db, 'tasks', 'child_pr_alert_task_id', 'TEXT');
  ensureColumn(db, 'tasks', 'session_name', 'TEXT');
  // Tri-state: NULL = no delivery attempt yet, 1 = verified and submitted,
  // 0 = pasted but never verified (see pane-idle.ts's pasteAndVerify).
  ensureColumn(db, 'sessions', 'initial_prompt_delivered', 'INTEGER');

  // Run after the column migrations: both tables have foreign keys into tasks,
  // which the rebuild above may have just replaced.
  ensureTableFromSchema(db, 'task_branches');
  ensureTableFromSchema(db, 'pr_release_status');
  ensureTableFromSchema(db, 'pending_messages');
  backfillTaskBranches(db);
}

/**
 * Give every existing card the branch row it always implicitly had.
 *
 * Cards predating the multi-branch model keep their state in columns on `tasks`;
 * copying it across once means the rollup that now feeds those same columns
 * starts from exactly what was already there, so nothing on the board moves.
 *
 * Guarded by a marker as well as the unique index: without it, a branch the user
 * deliberately removed would reappear on the next start.
 */
function backfillTaskBranches(db: Db): void {
  const done = db
    .prepare<[string], { value: string }>('SELECT value FROM _schema_meta WHERE key = ?')
    .get(TASK_BRANCHES_BACKFILL_KEY);
  if (done) {
    return;
  }

  db.transaction(() => {
    db.exec(`
      INSERT OR IGNORE INTO task_branches (
        id, task_id, repo_id, branch_name, base_branch, worktree_path, sort_key,
        pr_number, pr_url, pr_state, pr_draft,
        ci_state, ci_summary, failing_check_name,
        ci_required_total, ci_required_passed, ci_required_failed, ci_required_pending,
        review_state, review_summary, unresolved_thread_count,
        git_state, git_ahead_count, git_behind_count, has_untracked, has_conflicts,
        github_sync_status, github_sync_error, github_last_synced_at,
        created_at, updated_at)
      SELECT
        -- Matches generateId()'s shape, so migrated ids are indistinguishable
        -- from ones the application minted.
        lower(hex(randomblob(4))), t.id, t.repo_id, t.branch_name,
        r.default_base_branch, t.worktree_path, 0,
        t.pr_number, t.pr_url, t.pr_state, t.pr_draft,
        t.ci_state, t.ci_summary, t.failing_check_name,
        t.ci_required_total, t.ci_required_passed, t.ci_required_failed, t.ci_required_pending,
        t.review_state, t.review_summary, t.unresolved_thread_count,
        t.git_state, t.git_ahead_count, t.git_behind_count, t.has_untracked, t.has_conflicts,
        t.github_sync_status, t.github_sync_error, t.github_last_synced_at,
        t.created_at, t.updated_at
      FROM tasks t
      JOIN repos r ON r.id = t.repo_id
      WHERE t.repo_id IS NOT NULL
        AND t.branch_name IS NOT NULL
        AND COALESCE(t.kind, 'repo') <> 'general';

      UPDATE tasks SET
        active_branch_id =
          (SELECT b.id FROM task_branches b WHERE b.task_id = tasks.id ORDER BY b.sort_key LIMIT 1),
        pr_count =
          (SELECT COUNT(*) FROM task_branches b WHERE b.task_id = tasks.id AND b.pr_number IS NOT NULL),
        pr_open_count =
          (SELECT COUNT(*) FROM task_branches b WHERE b.task_id = tasks.id AND b.pr_state IN ('open','draft')),
        pr_merged_count =
          (SELECT COUNT(*) FROM task_branches b WHERE b.task_id = tasks.id AND b.pr_state = 'merged');
    `);

    db.prepare<[string, string, number], void>(
      `INSERT INTO _schema_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(TASK_BRANCHES_BACKFILL_KEY, '1', Date.now());
  })();
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
