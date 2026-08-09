import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { WorktreeService } from '../src/services/worktree.js';
import { TransportRegistry } from '../src/services/transport/index.js';
import { TransportUnreachableError } from '../src/services/transport/types.js';

const LOCAL_REPO = '/Users/me/Dev/monorepo';
const REMOTE_REPO = '/home/coder/project/monorepo';

/** Records what happened on the remote host without touching a real one. */
function makeFakeRemote(overrides: { exists?: () => Promise<boolean> } = {}) {
  return {
    id: 'ssh:test.host',
    isRemote: true,
    host: 'test.host',
    exec: vi.fn(async (_argv: readonly string[]) => ({ stdout: '', stderr: '', exitCode: 0 })),
    exists: vi.fn(overrides.exists ?? (async () => false)),
    mkdirp: vi.fn(async () => undefined),
    removeDir: vi.fn(async () => undefined),
    writeFileIfChanged: vi.fn(async () => true),
    reachability: vi.fn(async () => 'ok' as const),
  };
}

function registryWithRemote(remote: ReturnType<typeof makeFakeRemote>): TransportRegistry {
  const registry = new TransportRegistry({ sshHost: 'test.host' });
  vi.spyOn(registry, 'getRemote').mockReturnValue(remote as never);
  return registry;
}

describe('WorktreeService remote task resolution', () => {
  let db: Db;
  let board: BoardService;
  let localRepoDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    localRepoDir = mkdtempSync(join(tmpdir(), 'agentboard-repo-'));
    db.prepare(
      `INSERT INTO repos
         (id, label, path, remote_path, default_base_branch, health, worktree_mode,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-1', 'monorepo', LOCAL_REPO, REMOTE_REPO, 'master', 'ok', 'auto', 1, 1);
  });

  afterEach(() => {
    db.close();
    rmSync(localRepoDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createRemoteTask(title = 'Remote work') {
    const task = board.createTask({ title, repoId: 'repo-1', location: 'remote' });
    return task;
  }

  it('creates the worktree on the remote host, beside the remote checkout', async () => {
    // Arrange
    const remote = makeFakeRemote();
    const service = new WorktreeService(db, board, {} as never, registryWithRemote(remote));
    const task = createRemoteTask();

    // Act
    const workspace = await service.prepareTaskWorkspace(task.id);

    // Assert — the git work must be issued to the remote host, not locally.
    expect(workspace.usedWorktree).toBe(true);
    expect(workspace.repoPath).toBe(REMOTE_REPO);
    expect(workspace.path.startsWith('/home/coder/project/.monorepo-worktrees/')).toBe(true);

    const commands = remote.exec.mock.calls.map((call) => call[0].join(' '));
    const worktreeAdd = commands.find((command) => command.includes('worktree add'));
    expect(worktreeAdd).toBeDefined();
    expect(worktreeAdd).toContain(`-C ${REMOTE_REPO}`);
    expect(worktreeAdd).toContain(workspace.path);
    expect(worktreeAdd).toContain(task.branchName);
  });

  it('never touches the local repo path for a remote task', async () => {
    // Arrange
    const remote = makeFakeRemote();
    const git = { createWorktreeAsync: vi.fn(async () => undefined) };
    const service = new WorktreeService(db, board, git as never, registryWithRemote(remote));

    // Act
    const workspace = await service.prepareTaskWorkspace(createRemoteTask().id);

    // Assert
    expect(workspace.path).not.toContain(LOCAL_REPO);
    expect(workspace.repoPath).not.toBe(LOCAL_REPO);
  });

  it('always isolates a remote task in its own worktree', async () => {
    // Arrange — remote agents share one checkout and would fight over the branch,
    // so the local "first task skips the worktree" heuristic must not apply.
    const remote = makeFakeRemote();
    const git = { createWorktreeAsync: vi.fn(async () => undefined) };
    const service = new WorktreeService(db, board, git as never, registryWithRemote(remote));

    // Act
    const workspace = await service.prepareTaskWorkspace(createRemoteTask('Only task').id);

    // Assert
    expect(workspace.usedWorktree).toBe(true);
  });

  it('reuses an existing remote worktree instead of recreating it', async () => {
    // Arrange
    const remote = makeFakeRemote({ exists: async () => true });
    const service = new WorktreeService(db, board, {} as never, registryWithRemote(remote));

    // Act
    await service.prepareTaskWorkspace(createRemoteTask().id);

    // Assert
    const commands = remote.exec.mock.calls.map((call) => call[0].join(' '));
    expect(commands.some((command) => command.includes('worktree add'))).toBe(false);
  });

  it('propagates an unreachable host instead of treating it as a missing worktree', async () => {
    // Arrange — swallowing this would recreate a worktree that already exists.
    const remote = makeFakeRemote({
      exists: async () => {
        throw new TransportUnreachableError('vpn down');
      },
    });
    const service = new WorktreeService(db, board, {} as never, registryWithRemote(remote));

    // Act + Assert
    await expect(
      service.prepareTaskWorkspace(createRemoteTask().id),
    ).rejects.toBeInstanceOf(TransportUnreachableError);
    const commands = remote.exec.mock.calls.map((call) => call[0].join(' '));
    expect(commands.some((command) => command.includes('worktree add'))).toBe(false);
  });

  it('fails with an actionable message when the repo has no remote path', async () => {
    // Arrange
    db.prepare('UPDATE repos SET remote_path = NULL WHERE id = ?').run('repo-1');
    const service = new WorktreeService(
      db,
      board,
      {} as never,
      registryWithRemote(makeFakeRemote()),
    );

    // Act + Assert
    await expect(service.prepareTaskWorkspace(createRemoteTask().id)).rejects.toThrow(/remote/i);
  });

  it('leaves local tasks on the local host', async () => {
    // Arrange
    db.prepare('UPDATE repos SET path = ? WHERE id = ?').run(localRepoDir, 'repo-1');
    const remote = makeFakeRemote();
    const git = { createWorktreeAsync: vi.fn(async () => undefined) };
    const service = new WorktreeService(db, board, git as never, registryWithRemote(remote));
    const task = board.createTask({ title: 'Local work', repoId: 'repo-1' });

    // Act
    const workspace = await service.prepareTaskWorkspace(task.id);

    // Assert
    expect(workspace.repoPath).toBe(localRepoDir);
    expect(remote.exists).not.toHaveBeenCalled();
  });
});

describe('WorktreeService multi-branch cards', () => {
  let db: Db;
  let board: BoardService;
  let root: string;

  /** Two real repo checkouts on disk, so the local transport can stat them. */
  let repoA: string;
  let repoB: string;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    root = mkdtempSync(join(tmpdir(), 'agentboard-multi-'));
    repoA = join(root, 'monorepo');
    repoB = join(root, 'sdk');
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });

    // Different default_base_branch per repo: the whole point of joining each
    // branch row to its own repo row.
    insertRepo(db, { id: 'repo-a', label: 'monorepo', path: repoA, baseBranch: 'master' });
    insertRepo(db, { id: 'repo-b', label: 'sdk', path: repoB, baseBranch: 'develop' });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function insertRepo(
    database: Db,
    repo: { id: string; label: string; path: string; baseBranch: string },
  ): void {
    database
      .prepare(
        `INSERT INTO repos
           (id, label, path, default_base_branch, health, worktree_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ok', 'auto', 1, 1)`,
      )
      .run(repo.id, repo.label, repo.path, repo.baseBranch);
  }

  /** Records every worktree git was asked to create, without running git. */
  function makeGit() {
    return {
      createWorktreeAsync: vi.fn(
        async (_repoPath: string, _worktreePath: string, _branch: string, _base: string) =>
          undefined,
      ),
    };
  }

  it('resolves one plan per branch, each with its own repo base branch', async () => {
    // Arrange — one card, two repos, the long-lived feature case.
    const task = board.createTask({ title: 'Cross repo feature', repoId: 'repo-a' });
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-b', branchName: 'ab/sdk-side-0002' });
    const git = makeGit();
    const service = new WorktreeService(db, board, git as never);

    // Act
    await service.prepareTaskWorkspace(task.id);

    // Assert — each branch was created from its OWN repo's base branch.
    const calls = git.createWorktreeAsync.mock.calls.map((call) => ({
      repoPath: call[0],
      branch: call[2],
      baseBranch: call[3],
    }));
    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({
      repoPath: repoA,
      branch: task.branchName,
      baseBranch: 'master',
    });
    expect(calls).toContainEqual({
      repoPath: repoB,
      branch: 'ab/sdk-side-0002',
      baseBranch: 'develop',
    });
  });

  it('isolates two branches of one card in the same repo instead of letting them stomp', async () => {
    // Arrange — the latent bug: sibling *tasks* are counted, and two branches of
    // the SAME card see zero siblings, so both used to take the bare checkout.
    const task = board.createTask({ title: 'Stacked work', repoId: 'repo-a' });
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-a', branchName: 'ab/stacked-top-0002' });
    const git = makeGit();
    const service = new WorktreeService(db, board, git as never);

    // Act
    const workspace = await service.prepareTaskWorkspace(task.id);

    // Assert
    expect(workspace.usedWorktree).toBe(true);
    const created = git.createWorktreeAsync.mock.calls.map((call) => call[1]);
    expect(created).toHaveLength(2);
    expect(new Set(created).size).toBe(2);
    expect(created).not.toContain(repoA);
  });

  it('writes each branch its own worktree path back to the board', async () => {
    // Arrange
    const task = board.createTask({ title: 'Cross repo feature', repoId: 'repo-a' });
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-b', branchName: 'ab/sdk-side-0002' });
    const service = new WorktreeService(db, board, makeGit() as never);

    // Act
    await service.prepareTaskWorkspace(task.id);

    // Assert
    const branches = board.getTaskBranches(task.id);
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.worktreePath).toBeTruthy();
    }
    expect(new Set(branches.map((branch) => branch.worktreePath)).size).toBe(2);
  });

  it('mirrors only the active branch onto the card so reveal-workspace still opens something', async () => {
    // Arrange
    const task = board.createTask({ title: 'Cross repo feature', repoId: 'repo-a' });
    const second = board.addTaskBranch({
      taskId: task.id,
      repoId: 'repo-b',
      branchName: 'ab/sdk-side-0002',
    });
    board.setActiveTaskBranch(task.id, second.id);
    const service = new WorktreeService(db, board, makeGit() as never);

    // Act
    const workspace = await service.prepareTaskWorkspace(task.id);

    // Assert — the session sits in the ACTIVE branch's repo, not the first one.
    expect(workspace.repoPath).toBe(repoB);
    expect(board.getTask(task.id)?.worktreePath).toBe(workspace.path);
  });

  it('reopens a session in whichever of the card worktrees it was last used in', async () => {
    // Arrange — the bug: testing only the active branch's root snapped a session
    // that was last used in repo B back to repo A.
    const task = board.createTask({ title: 'Cross repo feature', repoId: 'repo-a' });
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-b', branchName: 'ab/sdk-side-0002' });
    const service = new WorktreeService(db, board, makeGit() as never);
    const first = await service.prepareTaskWorkspace(task.id);
    const other = board
      .getTaskBranches(task.id)
      .map((branch) => branch.worktreePath!)
      .find((path) => path !== first.path)!;
    mkdirSync(other, { recursive: true });
    board.setTaskLastSessionCwd(task.id, other);

    // Act
    const reopened = await service.prepareTaskWorkspace(task.id);

    // Assert
    expect(reopened.path).toBe(other);
  });

  it('leaves a single-branch card in the bare checkout exactly as before', async () => {
    // Arrange — the multi-branch rule must not change the one-branch heuristic:
    // no live sibling task, auto mode, so no worktree at all.
    const task = board.createTask({ title: 'Just one branch', repoId: 'repo-a' });
    const git = makeGit();
    const service = new WorktreeService(db, board, git as never);

    // Act
    const workspace = await service.prepareTaskWorkspace(task.id);

    // Assert
    expect(workspace.usedWorktree).toBe(false);
    expect(workspace.path).toBe(repoA);
    expect(workspace.repoPath).toBe(repoA);
    expect(git.createWorktreeAsync).not.toHaveBeenCalled();
    expect(board.getTaskBranches(task.id)[0]?.worktreePath).toBeUndefined();
  });
});
