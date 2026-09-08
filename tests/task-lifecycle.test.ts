import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { TaskLifecycleService } from '../src/services/task-lifecycle.js';
import { TransportUnreachableError } from '../src/services/transport/types.js';

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

  it("archives an agent's uncommitted work before removing its worktree", async () => {
    // Arrange — the case that nearly cost a real 257-line investigation
    // report: agents write their findings into the worktree they are working
    // in, so removing it was also deleting the agent's output, silently.
    const task = board.createTask({ title: 'Has findings', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-1', branchName: 'ab/has-findings' });
    board.setTaskBranchWorktree(board.getTaskBranches(task.id)[0]!.id, worktreePath);

    const git = {
      removeWorktreeAsync: vi.fn(),
      stageAndCommitWip: vi.fn(async () => 'abc1234'),
      updateRef: vi.fn(),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession: vi.fn(),
      terminateTaskSessions: vi.fn(),
    } as never);

    // Act
    const result = await lifecycle.deleteTask(task.id);

    // Assert — committed, pinned under a ref that outlives the branch, and
    // only then removed. The ref matters: recovery has to survive the branch
    // being deleted too, and stay plain git.
    expect(git.stageAndCommitWip).toHaveBeenCalledWith(
      worktreePath,
      expect.stringContaining('[agentboard archive]'),
    );
    expect(git.updateRef).toHaveBeenCalledWith(
      worktreePath,
      `refs/agentboard/archive/${task.id}`,
      'abc1234',
    );
    expect(git.removeWorktreeAsync).toHaveBeenCalled();
    expect(result.archivedShas).toEqual(['abc1234']);
  });

  it('reports nothing archived when the worktree was already clean', async () => {
    // Arrange — stageAndCommitWip returns null for a clean tree, and a card
    // deleted with nothing outstanding should not claim it saved something.
    const task = board.createTask({ title: 'Clean', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-1', branchName: 'ab/clean' });
    board.setTaskBranchWorktree(board.getTaskBranches(task.id)[0]!.id, worktreePath);

    const git = {
      removeWorktreeAsync: vi.fn(),
      stageAndCommitWip: vi.fn(async () => null),
      updateRef: vi.fn(),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession: vi.fn(),
      terminateTaskSessions: vi.fn(),
    } as never);

    // Act
    const result = await lifecycle.deleteTask(task.id);

    // Assert
    expect(result.archivedShas).toEqual([]);
    expect(git.updateRef).not.toHaveBeenCalled();
  });

  it('destroys uncommitted work only when explicitly purged', async () => {
    // Arrange — `--force` means "do not ask me", not "do not keep it".
    // Conflating those is what made deletion quietly lossy.
    const task = board.createTask({ title: 'Purge me', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-1', branchName: 'ab/purge-me' });
    board.setTaskBranchWorktree(board.getTaskBranches(task.id)[0]!.id, worktreePath);

    const git = {
      removeWorktreeAsync: vi.fn(),
      stageAndCommitWip: vi.fn(async () => 'abc1234'),
      updateRef: vi.fn(),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession: vi.fn(),
      terminateTaskSessions: vi.fn(),
    } as never);

    // Act
    const result = await lifecycle.deleteTask(task.id, { purge: true });

    // Assert
    expect(git.stageAndCommitWip).not.toHaveBeenCalled();
    expect(git.removeWorktreeAsync).toHaveBeenCalled();
    expect(result.archivedShas).toEqual([]);
  });

  it('still deletes a card whose worktree is too broken to archive', async () => {
    // Arrange — a corrupt worktree must never make a card undeletable, which
    // is the same rule the removal path already follows.
    const task = board.createTask({ title: 'Broken', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-1', branchName: 'ab/broken' });
    board.setTaskBranchWorktree(board.getTaskBranches(task.id)[0]!.id, worktreePath);

    const git = {
      removeWorktreeAsync: vi.fn(),
      stageAndCommitWip: vi.fn(async () => {
        throw new Error('not a git repository');
      }),
      updateRef: vi.fn(),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession: vi.fn(),
      terminateTaskSessions: vi.fn(),
    } as never);

    // Act
    const result = await lifecycle.deleteTask(task.id);

    // Assert — the card is gone, and the caller is told nothing was saved
    // rather than being left to assume it was.
    expect(result.archivedShas).toEqual([]);
    expect(git.removeWorktreeAsync).toHaveBeenCalled();
    expect(board.getTask(task.id)).toBeNull();
  });

  it('removes the worktree when archiving a task without an active session', async () => {
    const task = board.createTask({ title: 'Archive me', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);

    const git = {
      removeWorktreeAsync: vi.fn(),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession: vi.fn(),
    } as never);

    await lifecycle.archiveTask(task.id);

    expect(git.removeWorktreeAsync).toHaveBeenCalledWith(repoPath, worktreePath);
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
      removeWorktreeAsync: vi.fn(),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession: vi.fn(),
    } as never);

    await lifecycle.archiveTask(task.id);

    expect(git.removeWorktreeAsync).not.toHaveBeenCalled();
    expect(board.getTask(task.id)?.archivedAt).toBeDefined();
    expect(board.getTask(task.id)?.worktreePath).toBe(worktreePath);
  });

  it('keeps the worktree when archiving a task that still has an active secondary session', async () => {
    const task = board.createTask({ title: 'Dev server still running', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);
    board.linkSession(task.id, 'session-2', 'secondary');

    db.prepare(
      `INSERT INTO sessions
         (id, task_id, slot, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'session-2',
      task.id,
      'secondary',
      'pty',
      'ab_dev_shell',
      null,
      'active',
      worktreePath,
      task.branchName,
      1,
      1,
      1,
    );

    const git = {
      removeWorktreeAsync: vi.fn(),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession: vi.fn(),
    } as never);

    await lifecycle.archiveTask(task.id);

    expect(git.removeWorktreeAsync).not.toHaveBeenCalled();
    expect(board.getTask(task.id)?.archivedAt).toBeDefined();
    expect(board.getTask(task.id)?.worktreePath).toBe(worktreePath);
  });

  it('keeps the archived task intact when archive cleanup fails', async () => {
    const task = board.createTask({ title: 'Archive but keep path', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);

    const git = {
      removeWorktreeAsync: vi.fn(() => {
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
      removeWorktreeAsync: vi.fn(),
    };
    const terminateSession = vi.fn(async () => {});
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession,
    } as never);

    await lifecycle.deleteTask(task.id);

    expect(terminateSession).toHaveBeenCalledWith('session-1');
    expect(git.removeWorktreeAsync).toHaveBeenCalledWith(repoPath, worktreePath);
    expect(board.getTask(task.id)).toBeNull();
  });

  it('aborts deletion when the host is unreachable, so nothing leaks unnoticed', async () => {
    // Arrange — deleting the card anyway would strand a remote worktree and
    // tmux session with nothing left pointing at them. Keeping the card lets
    // the user retry once they are back online.
    const task = board.createTask({ title: 'Delete me carefully', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);
    board.linkSession(task.id, 'session-1');

    const git = {
      removeWorktreeAsync: vi.fn(() => {
        throw new TransportUnreachableError('vpn down');
      }),
    };
    const terminateSession = vi.fn(async () => {});
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession,
    } as never);

    // Act + Assert
    await expect(lifecycle.deleteTask(task.id)).rejects.toBeInstanceOf(TransportUnreachableError);
    expect(terminateSession).toHaveBeenCalledWith('session-1');
    expect(board.getTask(task.id)?.id).toBe(task.id);
  });

  it('still deletes the card when the worktree itself is broken', async () => {
    // Arrange — a corrupt or already-removed worktree must never make a card
    // impossible to delete; the recorded path is kept for a later retry.
    const task = board.createTask({ title: 'Delete me anyway', repoId: 'repo-1' });
    board.setTaskWorktree(task.id, worktreePath);
    board.linkSession(task.id, 'session-1');

    const git = {
      removeWorktreeAsync: vi.fn(() => {
        throw new Error('fatal: not a valid worktree');
      }),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateSession: vi.fn(async () => {}),
    } as never);

    // Act
    await lifecycle.deleteTask(task.id);

    // Assert
    expect(board.getTask(task.id)).toBeNull();
  });
  it('removes every repo\u2019s worktree when a multi-repo card is cleaned up', async () => {
    // Arrange — a feature spanning two repositories. Removing only one would
    // orphan the other, which is exactly what the old single-worktree cleanup did.
    const secondRepoPath = mkdtempSync(join(tmpdir(), 'agentboard-repo2-'));
    const secondWorktree = mkdtempSync(join(tmpdir(), 'agentboard-worktree2-'));
    db.prepare(
      `INSERT INTO repos
         (id, label, path, default_base_branch, health, created_at, updated_at)
       VALUES ('repo-2', 'Other', ?, 'main', 'ok', 1, 1)`,
    ).run(secondRepoPath);

    const task = board.createTask({ title: 'Cross-repo feature', repoId: 'repo-1' });
    board.setTaskBranchWorktree(task.branches[0]!.id, worktreePath);
    const second = board.addTaskBranch({
      taskId: task.id,
      repoId: 'repo-2',
      branchName: task.branchName!,
      worktreePath: secondWorktree,
    });

    const git = { removeWorktreeAsync: vi.fn() };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateTaskSessions: vi.fn(),
      terminateSession: vi.fn(),
    } as never);

    // Act
    await lifecycle.cleanupTaskResources(task.id);

    // Assert
    expect(git.removeWorktreeAsync).toHaveBeenCalledWith(repoPath, worktreePath);
    expect(git.removeWorktreeAsync).toHaveBeenCalledWith(secondRepoPath, secondWorktree);
    expect(board.getTaskBranch(second.id)?.worktreePath).toBeUndefined();

    rmSync(secondRepoPath, { recursive: true, force: true });
    rmSync(secondWorktree, { recursive: true, force: true });
  });

  it('still removes the reachable worktrees when one host is unreachable', async () => {
    // Arrange — one dead remote must not strand the local worktrees beside it.
    const secondRepoPath = mkdtempSync(join(tmpdir(), 'agentboard-repo2-'));
    const secondWorktree = mkdtempSync(join(tmpdir(), 'agentboard-worktree2-'));
    db.prepare(
      `INSERT INTO repos
         (id, label, path, default_base_branch, health, created_at, updated_at)
       VALUES ('repo-2', 'Other', ?, 'main', 'ok', 1, 1)`,
    ).run(secondRepoPath);

    const task = board.createTask({ title: 'Cross-repo feature', repoId: 'repo-1' });
    board.setTaskBranchWorktree(task.branches[0]!.id, worktreePath);
    board.addTaskBranch({
      taskId: task.id,
      repoId: 'repo-2',
      branchName: task.branchName!,
      worktreePath: secondWorktree,
    });

    const git = {
      removeWorktreeAsync: vi.fn().mockImplementation((repo: string) => {
        if (repo === secondRepoPath) {
          throw new TransportUnreachableError('host is asleep');
        }
      }),
    };
    const lifecycle = new TaskLifecycleService(db, board, git as never, {
      terminateTaskSessions: vi.fn(),
      terminateSession: vi.fn(),
    } as never);

    // Act / Assert
    await expect(lifecycle.cleanupTaskResources(task.id)).rejects.toThrow(
      TransportUnreachableError,
    );
    // The reachable one was still attempted and removed.
    expect(git.removeWorktreeAsync).toHaveBeenCalledWith(repoPath, worktreePath);

    rmSync(secondRepoPath, { recursive: true, force: true });
    rmSync(secondWorktree, { recursive: true, force: true });
  });
});
