import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { allBranchesResolved, rollupBranches } from '../src/services/task-branches.js';
import type { TaskBranchRecord } from '../src/types/index.js';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');

function branch(over: Partial<TaskBranchRecord> = {}): TaskBranchRecord {
  return {
    id: 'b1',
    taskId: 'task-1',
    repoId: 'repo-1',
    branchName: 'ab/feature-0001',
    sortKey: 0,
    prState: 'none',
    prDraft: false,
    ciState: 'none',
    ciRequiredTotal: 0,
    ciRequiredPassed: 0,
    ciRequiredFailed: 0,
    ciRequiredPending: 0,
    reviewState: 'none',
    unresolvedThreadCount: 0,
    gitState: 'unknown',
    gitAheadCount: 0,
    gitBehindCount: 0,
    hasUntracked: false,
    hasConflicts: false,
    githubSyncStatus: 'idle',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('rollupBranches', () => {
  it('is merged only when every pull request merged', () => {
    expect(
      rollupBranches([branch({ prState: 'merged' }), branch({ id: 'b2', prState: 'merged' })])
        .prState,
    ).toBe('merged');

    expect(
      rollupBranches([branch({ prState: 'merged' }), branch({ id: 'b2', prState: 'open' })])
        .prState,
    ).toBe('open');
  });

  it('holds a card open when one pull request closed unmerged', () => {
    // Closing without merging is unfinished business, not completion.
    const rollup = rollupBranches([
      branch({ prState: 'merged' }),
      branch({ id: 'b2', prState: 'closed' }),
    ]);

    expect(rollup.prState).toBe('closed');
    expect(rollup.prMergedCount).toBe(1);
  });

  it('lets a single failing build fail the card', () => {
    const rollup = rollupBranches([
      branch({ ciState: 'passed' }),
      branch({ id: 'b2', branchName: 'ab/other-0002', ciState: 'failed', ciSummary: 'lint' }),
    ]);

    expect(rollup.ciState).toBe('failed');
    // Named, or a multi-repo card gives no clue which repository broke.
    expect(rollup.ciSummary).toBe('ab/other-0002: lint');
  });

  it('approves only when every open pull request is approved', () => {
    expect(
      rollupBranches([
        branch({ prState: 'open', reviewState: 'approved' }),
        branch({ id: 'b2', prState: 'open', reviewState: 'none' }),
      ]).reviewState,
    ).toBe('none');

    expect(
      rollupBranches([
        branch({ prState: 'open', reviewState: 'approved' }),
        branch({ id: 'b2', prState: 'open', reviewState: 'approved' }),
      ]).reviewState,
    ).toBe('approved');
  });

  it('lets changes requested anywhere win', () => {
    expect(
      rollupBranches([
        branch({ prState: 'open', reviewState: 'approved' }),
        branch({ id: 'b2', prState: 'open', reviewState: 'changes_requested' }),
      ]).reviewState,
    ).toBe('changes_requested');
  });

  it('sums the check counts so the card reads at feature scale', () => {
    const rollup = rollupBranches([
      branch({ ciRequiredTotal: 5, ciRequiredPassed: 5 }),
      branch({ id: 'b2', ciRequiredTotal: 10, ciRequiredPassed: 7, ciRequiredPending: 3 }),
    ]);

    expect(rollup.ciRequiredTotal).toBe(15);
    expect(rollup.ciRequiredPassed).toBe(12);
    expect(rollup.ciRequiredPending).toBe(3);
  });

  it('names no single pull request once the card has several', () => {
    // There is no honest answer, and inventing one would let the merge and
    // comment actions operate on an arbitrary branch.
    const one = rollupBranches([branch({ prNumber: 10, prUrl: 'u' })]);
    const many = rollupBranches([
      branch({ prNumber: 10, prUrl: 'u' }),
      branch({ id: 'b2', prNumber: 11, prUrl: 'v' }),
    ]);

    expect(one.prNumber).toBe(10);
    expect(many.prNumber).toBeUndefined();
    expect(many.prUrl).toBeUndefined();
    expect(many.prCount).toBe(2);
  });

  it('surfaces the failing repo when one of several cannot sync', () => {
    const rollup = rollupBranches([
      branch({ githubSyncStatus: 'ok' }),
      branch({
        id: 'b2',
        branchName: 'ab/other-0002',
        githubSyncStatus: 'error',
        githubSyncError: 'rate limited',
      }),
    ]);

    expect(rollup.githubSyncStatus).toBe('error');
    expect(rollup.githubSyncError).toBe('ab/other-0002: rate limited');
  });

  it('keeps the worst git state', () => {
    expect(
      rollupBranches([branch({ gitState: 'clean' }), branch({ id: 'b2', gitState: 'conflicted' })])
        .gitState,
    ).toBe('conflicted');
  });

  it('is a draft only while nothing in it is ready', () => {
    expect(
      rollupBranches([branch({ prDraft: true }), branch({ id: 'b2', prDraft: false })]).prDraft,
    ).toBe(false);
  });
});

describe('allBranchesResolved', () => {
  it('is false while any pull request is still open', () => {
    expect(
      allBranchesResolved([branch({ prState: 'merged' }), branch({ id: 'b2', prState: 'open' })]),
    ).toBe(false);
  });

  it('is true once every pull request merged or closed', () => {
    expect(
      allBranchesResolved([branch({ prState: 'merged' }), branch({ id: 'b2', prState: 'closed' })]),
    ).toBe(true);
  });

  it('is false for a card with no pull requests at all', () => {
    expect(allBranchesResolved([branch()])).toBe(false);
  });
});

describe('BoardService branch storage', () => {
  const dirs: string[] = [];
  const dbs: Db[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) {
      db.close();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function newBoard() {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-branches-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'agentboard.db'));
    dbs.push(db);
    db.prepare(
      `INSERT INTO repos (id, label, path, default_base_branch, health, worktree_mode, created_at, updated_at)
       VALUES ('repo-1', 'Repo', '/tmp/repo-1', 'main', 'ok', 'auto', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO repos (id, label, path, default_base_branch, health, worktree_mode, created_at, updated_at)
       VALUES ('repo-2', 'Other', '/tmp/repo-2', 'main', 'ok', 'auto', 1, 1)`,
    ).run();
    return { db, board: new BoardService(db) };
  }

  it('gives a new card the branch it was created for', () => {
    const { board } = newBoard();

    const task = board.createTask({ title: 'Feature', repoId: 'repo-1' });

    expect(task.branches).toHaveLength(1);
    expect(task.branches[0]?.branchName).toBe(task.branchName);
    expect(task.activeBranchId).toBe(task.branches[0]?.id);
  });

  it('gives a general card no branches', () => {
    const { board } = newBoard();

    const task = board.createTask({ title: 'Think', kind: 'general' });

    expect(task.branches).toEqual([]);
  });

  it('adds a second repo to a card without duplicating on re-discovery', () => {
    // Arrange
    const { board } = newBoard();
    const task = board.createTask({ title: 'Feature', repoId: 'repo-1' });

    // Act — sync finding the same branch twice must not create two rows.
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-2', branchName: 'ab/feature-0001' });
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-2', branchName: 'ab/feature-0001' });

    // Assert
    expect(board.getTaskBranches(task.id)).toHaveLength(2);
  });

  it('rewrites the card from its branches when one syncs', () => {
    // Arrange
    const { board } = newBoard();
    const task = board.createTask({ title: 'Feature', repoId: 'repo-1' });
    const second = board.addTaskBranch({
      taskId: task.id,
      repoId: 'repo-2',
      branchName: 'ab/feature-0001',
    });

    // Act
    board.updateTaskBranchSync(task.branches[0]!.id, { prState: 'merged', prNumber: 10 });
    board.updateTaskBranchSync(second.id, { prState: 'open', prNumber: 11, ciState: 'failed' });

    // Assert — the card reads as the sum of its parts, not the last write.
    const updated = board.getTask(task.id)!;
    expect(updated.prState).toBe('open');
    expect(updated.ciState).toBe('failed');
    expect(updated.prCount).toBe(2);
    expect(updated.prMergedCount).toBe(1);
    expect(updated.prNumber).toBeUndefined();
  });

  it('hands the session to a surviving branch when the active one is removed', () => {
    // Arrange
    const { board } = newBoard();
    const task = board.createTask({ title: 'Feature', repoId: 'repo-1' });
    const second = board.addTaskBranch({
      taskId: task.id,
      repoId: 'repo-2',
      branchName: 'ab/feature-0001',
    });

    // Act
    board.removeTaskBranch(task.branches[0]!.id);

    // Assert
    expect(board.getTask(task.id)?.activeBranchId).toBe(second.id);
  });

  it('moves the repo with the branch when the active one changes', () => {
    // Arrange — a cross-repo card. If repo_id stayed behind, the card would
    // pair one repository's identity with another's branch, and the session
    // would be built from the wrong base branch and the wrong checkout.
    const { board } = newBoard();
    const task = board.createTask({ title: 'Feature', repoId: 'repo-1' });
    const second = board.addTaskBranch({
      taskId: task.id,
      repoId: 'repo-2',
      branchName: 'ab/other-0002',
      worktreePath: '/tmp/wt-2',
    });

    // Act
    board.setActiveTaskBranch(task.id, second.id);

    // Assert
    const updated = board.getTask(task.id)!;
    expect(updated.activeBranchId).toBe(second.id);
    expect(updated.repoId).toBe('repo-2');
    expect(updated.branchName).toBe('ab/other-0002');
    expect(updated.worktreePath).toBe('/tmp/wt-2');
  });

  it('refuses to activate a branch belonging to another card', () => {
    const { board } = newBoard();
    const mine = board.createTask({ title: 'Mine', repoId: 'repo-1' });
    const theirs = board.createTask({ title: 'Theirs', repoId: 'repo-2' });

    expect(() => board.setActiveTaskBranch(mine.id, theirs.branches[0]!.id)).toThrow();
  });

  it('stops renaming branches once a card has more than one', () => {
    // Arrange — with several branches there is no non-arbitrary one to rename.
    const { board } = newBoard();
    const task = board.createTask({ title: 'Feature', repoId: 'repo-1' });
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-2', branchName: 'ab/feature-0001' });

    // Act
    board.renameTask(task.id, 'Renamed feature');

    // Assert
    const updated = board.getTask(task.id)!;
    expect(updated.title).toBe('Renamed feature');
    expect(updated.branchName).toBe(task.branchName);
  });

  it('keeps the single branch in step with a rename', () => {
    const { board } = newBoard();
    const task = board.createTask({ title: 'Feature', repoId: 'repo-1' });

    board.renameTask(task.id, 'Renamed feature');

    const updated = board.getTask(task.id)!;
    expect(updated.branches[0]?.branchName).toBe(updated.branchName);
  });
});

describe('task_branches backfill', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives every existing card the branch row it implicitly had', () => {
    // Arrange — a board written before branches existed.
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-backfill-'));
    dirs.push(dir);
    const dbPath = join(dir, 'agentboard.db');

    let db: Db = openDb(dbPath);
    db.prepare(
      `INSERT INTO repos (id, label, path, default_base_branch, health, worktree_mode, created_at, updated_at)
       VALUES ('repo-1', 'Repo', '/tmp/repo-1', 'main', 'ok', 'auto', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, kind, repo_id, track_id, branch_name, worktree_path,
                          sort_key, pr_number, pr_state, ci_state, created_at, updated_at)
       VALUES ('task-1', 'Old card', 'repo', 'repo-1', 'pr', 'ab/old-0001', '/tmp/wt',
               0, 42, 'open', 'passed', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, kind, track_id, sort_key, created_at, updated_at)
       VALUES ('task-2', 'General', 'general', 'backlog', 1, 1, 1)`,
    ).run();
    // Undo the backfill that ran when this database was created, to stand in
    // for a database that predates the table entirely.
    db.exec('DELETE FROM task_branches');
    db.prepare("DELETE FROM _schema_meta WHERE key = 'task_branches_backfill'").run();
    db.close();

    // Act
    db = openDb(dbPath);

    // Assert
    try {
      const board = new BoardService(db);
      const migrated = board.getTask('task-1')!;

      expect(migrated.branches).toHaveLength(1);
      expect(migrated.branches[0]).toMatchObject({
        branchName: 'ab/old-0001',
        worktreePath: '/tmp/wt',
        prNumber: 42,
        prState: 'open',
        ciState: 'passed',
        baseBranch: 'main',
      });
      expect(migrated.activeBranchId).toBe(migrated.branches[0]?.id);
      expect(migrated.prOpenCount).toBe(1);

      // A general card has no repo and so no branch.
      expect(board.getTask('task-2')?.branches).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('does not resurrect a branch the user removed', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-backfill-'));
    dirs.push(dir);
    const dbPath = join(dir, 'agentboard.db');

    let db: Db = openDb(dbPath);
    db.prepare(
      `INSERT INTO repos (id, label, path, default_base_branch, health, worktree_mode, created_at, updated_at)
       VALUES ('repo-1', 'Repo', '/tmp/repo-1', 'main', 'ok', 'auto', 1, 1)`,
    ).run();
    const board = new BoardService(db);
    const task = board.createTask({ title: 'Feature', repoId: 'repo-1' });
    board.removeTaskBranch(task.branches[0]!.id);
    db.close();

    // Act
    db = openDb(dbPath);

    // Assert
    try {
      expect(new BoardService(db).getTaskBranches(task.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('leaves a legacy database untouched apart from adding rows', () => {
    // Arrange — the destructive-migration guard, at branch level.
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-backfill-'));
    dirs.push(dir);
    const dbPath = join(dir, 'agentboard.db');

    const legacy = new BetterSqlite3(dbPath);
    legacy.close();

    // Act
    const db = openDb(dbPath);

    // Assert
    try {
      const tables = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_branches'",
        )
        .get();
      expect(tables).toBeDefined();
    } finally {
      db.close();
    }
  });
});
