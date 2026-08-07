import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
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
