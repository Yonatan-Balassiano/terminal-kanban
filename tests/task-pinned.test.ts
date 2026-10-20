import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';

describe('BoardService pinned flag', () => {
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

  it('is unpinned for a newly created card', () => {
    const task = board.createTask({ title: 'Plain card', repoId: 'repo-1' });
    expect(board.getTask(task.id)?.pinnedAt).toBeUndefined();
  });

  it('pins and unpins a card', () => {
    const task = board.createTask({ title: 'Card', repoId: 'repo-1' });

    expect(board.setTaskPinned(task.id, true)).toBe(true);
    expect(board.getTask(task.id)?.pinnedAt).toEqual(expect.any(Number));

    expect(board.setTaskPinned(task.id, false)).toBe(true);
    expect(board.getTask(task.id)?.pinnedAt).toBeUndefined();
  });

  it('reports no change for a card that does not exist', () => {
    expect(board.setTaskPinned('missing', true)).toBe(false);
  });
});
