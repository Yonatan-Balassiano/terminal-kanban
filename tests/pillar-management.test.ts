import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';

describe('BoardService pillar management', () => {
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

  it('creates a pillar with the provided label', () => {
    const pillar = board.createPillar({ label: 'Platform' });

    expect(pillar.id).toHaveLength(8);
    expect(pillar.label).toBe('Platform');
    expect(board.getPillars()).toEqual([
      {
        id: pillar.id,
        label: 'Platform',
        icon: undefined,
        color: undefined,
      },
    ]);
  });

  it('deletes all tasks inside a pillar when the pillar is deleted', () => {
    const pillar = board.createPillar({ label: 'Platform' });
    db.prepare(
      'UPDATE repos SET default_pillar_id = ? WHERE id = ?',
    ).run(pillar.id, 'repo-1');

    const taskInPillar = board.createTask({
      title: 'Inside pillar',
      repoId: 'repo-1',
      pillarId: pillar.id,
    });
    const taskOutsidePillar = board.createTask({
      title: 'Outside pillar',
      repoId: 'repo-1',
    });

    board.deletePillar(pillar.id);

    expect(board.getTask(taskInPillar.id)).toBeNull();
    expect(board.getTask(taskOutsidePillar.id)?.id).toBe(taskOutsidePillar.id);
    expect(board.getPillars()).toEqual([]);
    const repo = db
      .prepare<[string], { default_pillar_id: string | null }>(
        'SELECT default_pillar_id FROM repos WHERE id = ?',
      )
      .get('repo-1');
    expect(repo?.default_pillar_id).toBeNull();
  });
});
