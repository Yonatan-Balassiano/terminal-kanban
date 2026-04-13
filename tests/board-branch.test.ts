import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';

describe('BoardService branch persistence', () => {
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

  it('stores a title-based branch name when creating a task', () => {
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });

    expect(task.branchName).toMatch(/^ab\/friday-thing-\d{4}$/);
  });

  it('defaults new tasks to the backlog track', () => {
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });

    expect(task.trackId).toBe('backlog');
  });

  it('updates the stored branch slug when an unstarted task is renamed', () => {
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });
    const suffix = task.branchName?.match(/(\d{4})$/)?.[1];

    board.renameTask(task.id, 'Better title');

    expect(board.getTask(task.id)?.branchName).toBe(`ab/better-title-${suffix}`);
  });

  it('keeps the stored branch once a session is linked', () => {
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });

    board.linkSession(task.id, 'session-1');
    board.renameTask(task.id, 'Better title');

    expect(board.getTask(task.id)?.branchName).toBe(task.branchName);
  });
});
