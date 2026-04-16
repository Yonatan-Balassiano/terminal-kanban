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

      const missionTaskColumns = db
        .prepare<[], { name: string }>('PRAGMA table_info(mission_tasks)')
        .all()
        .map((column) => column.name);
      expect(missionTaskColumns).toContain('released_to_board');
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
});
