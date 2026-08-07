import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { MissionService } from '../src/services/missions.js';
import { ViewService } from '../src/services/view.js';
import { WorkspaceService } from '../src/services/workspace.js';

describe('board snapshot repo fields', () => {
  let db: Db;
  let view: ViewService;
  let workspace: WorkspaceService;

  beforeEach(() => {
    db = openDb(':memory:');
    const board = new BoardService(db);
    view = new ViewService(board, new MissionService(db, board));
    workspace = new WorkspaceService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, remote_path, default_base_branch, health, worktree_mode,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-1', 'monorepo', '/local/monorepo', '/remote/monorepo', 'master', 'ok', 'auto', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  it('carries remotePath through to the snapshot the TUI renders from', () => {
    // Arrange — the create-task modal decides whether to offer "Remote" purely
    // from this field, so dropping it silently locks every repo to Local.
    // Act
    const snapshot = view.getBoardSnapshot();

    // Assert
    expect(snapshot.repos[0]?.remotePath).toBe('/remote/monorepo');
  });

  it('maps repos identically to the workspace service', () => {
    // Arrange — the snapshot used to hand-roll a second mapper that drifted out
    // of sync with this one. Comparing them keeps any new column in step.
    // Act
    const fromSnapshot = view.getBoardSnapshot().repos[0];
    const fromWorkspace = workspace.getRepo('repo-1');

    // Assert
    expect(fromSnapshot).toEqual(fromWorkspace);
  });

  it('leaves remotePath undefined for a local-only repo', () => {
    // Arrange
    db.prepare(
      `INSERT INTO repos
         (id, label, path, default_base_branch, health, worktree_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-2', 'local-only', '/local/other', 'main', 'ok', 'auto', 1, 1);

    // Act
    const repo = view.getBoardSnapshot().repos.find((r) => r.id === 'repo-2');

    // Assert
    expect(repo?.remotePath).toBeUndefined();
  });
});
