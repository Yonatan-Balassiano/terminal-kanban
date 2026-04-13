import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';

describe('BoardService task description', () => {
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

  it('stores and clears a task description', () => {
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });

    board.setTaskDescription(task.id, 'Short task summary');
    expect(board.getTask(task.id)?.description).toBe('Short task summary');

    board.setTaskDescription(task.id, '');
    expect(board.getTask(task.id)?.description).toBeUndefined();
  });
});
