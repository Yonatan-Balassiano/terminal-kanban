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

  it('stores the brief a card was created with as both description and prompt', () => {
    // Arrange + Act
    const task = board.createTask({
      title: 'Add rate limiting',
      repoId: 'repo-1',
      description: 'Cap the API at 100 rps.',
      initialPrompt: 'Cap the API at 100 rps.',
    });

    // Assert — the card shows the brief, and the agent is handed the same text.
    const stored = board.getTask(task.id);
    expect(stored?.description).toBe('Cap the API at 100 rps.');
    expect(stored?.initialPrompt).toBe('Cap the API at 100 rps.');
  });

  it('leaves a card created without a brief carrying neither', () => {
    // Arrange + Act — a card from the TUI, which asks for no context.
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });

    // Assert — an empty description must not become an empty opening prompt.
    const stored = board.getTask(task.id);
    expect(stored?.description).toBeUndefined();
    expect(stored?.initialPrompt).toBeUndefined();
  });
});
