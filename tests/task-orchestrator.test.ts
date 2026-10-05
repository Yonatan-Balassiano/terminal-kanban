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

  it('marks a top-level card when it gets its first subtask', () => {
    // Arrange
    const parent = board.createTask({ title: 'Lead card', repoId: 'repo-1' });

    // Act
    const child = board.createTask({ title: 'Child', repoId: 'repo-1', parentTaskId: parent.id });

    // Assert
    expect(board.getTask(parent.id)?.isOrchestrator).toBe(true);
    expect(board.getTask(child.id)?.isOrchestrator).toBe(false);
  });

  it('does not mark a subtask that gets subtasks of its own', () => {
    // Arrange
    const parent = board.createTask({ title: 'Lead card', repoId: 'repo-1' });
    const child = board.createTask({ title: 'Child', repoId: 'repo-1', parentTaskId: parent.id });

    // Act
    board.createTask({ title: 'Grandchild', repoId: 'repo-1', parentTaskId: child.id });

    // Assert
    expect(board.getTask(child.id)?.isOrchestrator).toBe(false);
  });

  it('leaves a card unmarked by hand alone when it gets another subtask', () => {
    // Arrange
    const parent = board.createTask({ title: 'Lead card', repoId: 'repo-1' });
    board.createTask({ title: 'First', repoId: 'repo-1', parentTaskId: parent.id });
    board.setTaskOrchestrator(parent.id, false);

    // Act
    board.createTask({ title: 'Second', repoId: 'repo-1', parentTaskId: parent.id });

    // Assert
    expect(board.getTask(parent.id)?.isOrchestrator).toBe(false);
  });
});
