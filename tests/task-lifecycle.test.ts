import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { TaskLifecycleService } from '../src/services/task-lifecycle.js';

describe('TaskLifecycleService', () => {
  let db: Db;
  let board: BoardService;
  let repoPath: string;
  let worktreePath: string;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    repoPath = mkdtempSync(join(tmpdir(), 'agentboard-repo-'));
    worktreePath = mkdtempSync(join(tmpdir(), 'agentboard-worktree-'));
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-1', 'Repo', repoPath, null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('removes the worktree when archiving a task without an active session', async () => {
    const task = board.createTask({ title: 'Archive me', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);

    const git = {
      removeWorktree: vi.fn(),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession: vi.fn(),
    } as never);

    await lifecycle.archiveTask(task.id);

    expect(git.removeWorktree).toHaveBeenCalledWith(repoPath, worktreePath);
    expect(board.getTask(task.id)?.archivedAt).toBeDefined();
    expect(board.getTask(task.id)?.worktreePath).toBeUndefined();
  });

  it('keeps the worktree when archiving a task that still has an active session', async () => {
    const task = board.createTask({ title: 'Still running', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);
    board.linkSession(task.id, 'session-1');

    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'session-1',
      task.id,
      'pty',
      'ab_running',
      null,
      'active',
      worktreePath,
      task.branchName,
      1,
      1,
      1,
    );

    const git = {
      removeWorktree: vi.fn(),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession: vi.fn(),
    } as never);

    await lifecycle.archiveTask(task.id);

    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(board.getTask(task.id)?.archivedAt).toBeDefined();
    expect(board.getTask(task.id)?.worktreePath).toBe(worktreePath);
  });

  it('keeps the archived task intact when archive cleanup fails', async () => {
    const task = board.createTask({ title: 'Archive but keep path', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);

    const git = {
      removeWorktree: vi.fn(() => {
        throw new Error('remove failed');
      }),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession: vi.fn(),
    } as never);

    await lifecycle.archiveTask(task.id);

    expect(board.getTask(task.id)?.archivedAt).toBeDefined();
    expect(board.getTask(task.id)?.worktreePath).toBe(worktreePath);
  });

  it('terminates the session and deletes the worktree before deleting the task', async () => {
    const task = board.createTask({ title: 'Delete me', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);
    board.linkSession(task.id, 'session-1');

    const git = {
      removeWorktree: vi.fn(),
    };
    const terminateSession = vi.fn(async () => {});
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession,
    } as never);

    await lifecycle.deleteTask(task.id);

    expect(terminateSession).toHaveBeenCalledWith('session-1');
    expect(git.removeWorktree).toHaveBeenCalledWith(repoPath, worktreePath);
    expect(board.getTask(task.id)).toBeNull();
  });

  it('aborts deletion when worktree cleanup fails', async () => {
    const task = board.createTask({ title: 'Delete me carefully', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);
    board.linkSession(task.id, 'session-1');

    const git = {
      removeWorktree: vi.fn(() => {
        throw new Error('remove failed');
      }),
    };
    const terminateSession = vi.fn(async () => {});
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession,
    } as never);

    await expect(lifecycle.deleteTask(task.id)).rejects.toThrow('remove failed');
    expect(terminateSession).toHaveBeenCalledWith('session-1');
    expect(board.getTask(task.id)?.id).toBe(task.id);
  });
});
