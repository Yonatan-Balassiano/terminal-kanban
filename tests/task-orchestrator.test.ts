import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';

describe('BoardService orchestrator flag', () => {
  let db: Db;
  let board: BoardService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-1', 'Repo', '/tmp/repo-1', null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  it('is off for a newly created card', () => {
    // Act
    const task = board.createTask({ title: 'Plain card', repoId: 'repo-1' });

    // Assert
    expect(board.getTask(task.id)?.isOrchestrator).toBe(false);
  });

  it('marks and unmarks a card', () => {
    // Arrange
    const task = board.createTask({ title: 'Lead card', repoId: 'repo-1' });

    // Act + Assert
    expect(board.setTaskOrchestrator(task.id, true)).toBe(true);
    expect(board.getTask(task.id)?.isOrchestrator).toBe(true);

    expect(board.setTaskOrchestrator(task.id, false)).toBe(true);
    expect(board.getTask(task.id)?.isOrchestrator).toBe(false);
  });

  it('reports no change for a card that does not exist', () => {
    expect(board.setTaskOrchestrator('missing', true)).toBe(false);
  });
});
