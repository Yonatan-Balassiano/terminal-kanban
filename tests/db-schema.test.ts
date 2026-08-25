import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CURRENT_SCHEMA_VERSION, openDb, type Db } from '../src/db/index.js';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');

describe('database schema bootstrap', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops legacy tables and recreates the current schema when metadata is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-db-'));
    const dbPath = join(dir, 'agentboard.db');
    tempDirs.push(dir);

    const legacyDb = new BetterSqlite3(dbPath);
    legacyDb.exec(`
      CREATE TABLE legacy_only (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO legacy_only (id, value) VALUES ('legacy-1', 'stale');
    `);
    legacyDb.close();

    const db = openDb(dbPath);
    try {
      const legacyTable = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_only'",
        )
        .get();
      expect(legacyTable).toBeUndefined();

      const versionRow = db
        .prepare<[], { value: string }>(
          "SELECT value FROM _schema_meta WHERE key = 'schema_version'",
        )
        .get();
      expect(versionRow?.value).toBe(CURRENT_SCHEMA_VERSION);

      const taskColumns = db
        .prepare<[], { name: string }>('PRAGMA table_info(tasks)')
        .all()
        .map((column) => column.name);
      expect(taskColumns).toContain('secondary_session_id');

      const sessionColumns = db
        .prepare<[], { name: string }>('PRAGMA table_info(sessions)')
        .all()
        .map((column) => column.name);
      expect(sessionColumns).toContain('slot');
    } finally {
      db.close();
    }
  });

  it('preserves data when the database already matches the current schema version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-db-'));
    const dbPath = join(dir, 'agentboard.db');
    tempDirs.push(dir);

    let db: Db = openDb(dbPath);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, github_url, preferred_ide, ide_command,
          worktree_mode, worktree_root, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'repo-1',
      'Repo',
      '/tmp/repo-1',
      null,
      null,
      'main',
      null,
      'ok',
      null,
      null,
      null,
      'auto',
      null,
      1,
      1,
    );
    db.close();

    db = openDb(dbPath);
    try {
      const repos = db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM repos').get();
      expect(repos.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('adds a table missing from an existing database without dropping the board', () => {
    // Arrange — a database at the current version, holding real rows, that
    // predates a table added later. Dropping and recreating would destroy it,
    // so the additive path has to create the table in place.
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-db-'));
    const dbPath = join(dir, 'agentboard.db');
    tempDirs.push(dir);

    let db: Db = openDb(dbPath);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, default_base_branch, health, worktree_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-1', 'Repo', '/tmp/repo-1', 'main', 'ok', 'auto', 1, 1);
    db.exec('DROP TABLE pr_release_status');
    db.close();

    // Act
    db = openDb(dbPath);

    // Assert
    try {
      const table = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pr_release_status'",
        )
        .get();
      expect(table).toBeDefined();

      // The table's indexes come from the same schema file and are easy to
      // silently miss, since a missing index costs correctness nothing.
      const indexes = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pr_release_status'",
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toContain('idx_pr_release_next_check');
      expect(indexes).toContain('idx_pr_release_task');

      const repos = db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM repos').get();
      expect(repos.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('adds the opening-prompt column to a board that predates it, keeping the cards', () => {
    // Arrange — a database at the current version whose tasks table predates
    // initial_prompt. Bumping the schema version would drop the user's board.
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-db-'));
    const dbPath = join(dir, 'agentboard.db');
    tempDirs.push(dir);

    let db: Db = openDb(dbPath);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, default_base_branch, health, worktree_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-1', 'Repo', '/tmp/repo-1', 'main', 'ok', 'auto', 1, 1);
    db.prepare(
      `INSERT INTO tasks (id, title, repo_id, track_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('task-1', 'Existing card', 'repo-1', 'backlog', 1, 1);
    db.exec('ALTER TABLE tasks DROP COLUMN initial_prompt');
    db.close();

    // Act
    db = openDb(dbPath);

    // Assert
    try {
      const columns = db
        .prepare<[], { name: string }>('PRAGMA table_info(tasks)')
        .all()
        .map((row) => row.name);
      expect(columns).toContain('initial_prompt');

      const tasks = db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM tasks').get();
      expect(tasks.count).toBe(1);
    } finally {
      db.close();
    }
  });
});
