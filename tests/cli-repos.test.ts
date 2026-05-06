import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRecord } from '../src/types/index.js';

const mocks = vi.hoisted(() => ({
  ensureRunning: vi.fn(),
  isDaemonRunning: vi.fn(),
  stopDaemon: vi.fn(),
  createRPCClient: vi.fn(),
  readPidFile: vi.fn(),
  openDb: vi.fn(),
  WorkspaceService: vi.fn(),
  GitService: vi.fn(),
}));

vi.mock('../src/daemon/index.js', () => ({
  ensureRunning: mocks.ensureRunning,
  isDaemonRunning: mocks.isDaemonRunning,
  stopDaemon: mocks.stopDaemon,
  readPidFile: mocks.readPidFile,
}));

vi.mock('../src/cli/rpc.js', () => ({
  createRPCClient: mocks.createRPCClient,
}));

vi.mock('../src/db/index.js', () => ({
  openDb: mocks.openDb,
}));

vi.mock('../src/services/workspace.js', () => ({
  WorkspaceService: mocks.WorkspaceService,
}));

vi.mock('../src/services/git.js', () => ({
  GitService: mocks.GitService,
}));

import { buildCli } from '../src/cli/index.js';

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

function makeRepo(patch: Partial<RepoRecord> = {}): RepoRecord {
  return {
    id: 'repo-1',
    label: 'Repo',
    path: '/repo',
    defaultBaseBranch: 'main',
    worktreeMode: 'auto',
    health: 'ok',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe('agentboard repos set-default-base-branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRunning.mockResolvedValue(undefined);
    mocks.isDaemonRunning.mockResolvedValue(false);
    mocks.stopDaemon.mockResolvedValue(true);
  });

  afterEach(() => {
    logSpy.mockClear();
  });

  it('updates the repo default base branch through RPC', async () => {
    const repo = makeRepo({ defaultBaseBranch: 'master' });
    const call = vi.fn().mockResolvedValue(repo);
    const disconnect = vi.fn();
    mocks.createRPCClient.mockResolvedValue({ call, disconnect });

    await buildCli().parseAsync([
      'node',
      'agentboard',
      'repos',
      'set-default-base-branch',
      'repo-1',
      'master',
    ]);

    expect(call).toHaveBeenCalledWith('updateRepo', {
      id: 'repo-1',
      defaultBaseBranch: 'master',
    });
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(repo, null, 2));
  });

  it('falls back to a direct DB update when an older daemon returns Not implemented', async () => {
    const repo = makeRepo({ defaultBaseBranch: 'master' });
    const call = vi.fn().mockRejectedValue(new Error('Not implemented'));
    const disconnect = vi.fn();
    const close = vi.fn();
    const updateRepo = vi.fn().mockReturnValue(repo);

    mocks.createRPCClient.mockResolvedValue({ call, disconnect });
    mocks.openDb.mockReturnValue({ close });
    mocks.WorkspaceService.mockImplementation(() => ({ updateRepo }));

    await buildCli().parseAsync([
      'node',
      'agentboard',
      'repos',
      'set-default-base-branch',
      'repo-1',
      'master',
    ]);

    expect(call).toHaveBeenCalledWith('updateRepo', {
      id: 'repo-1',
      defaultBaseBranch: 'master',
    });
    expect(mocks.ensureRunning).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.openDb).toHaveBeenCalledTimes(1);
    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      defaultBaseBranch: 'master',
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(repo, null, 2));
  });

  it('falls back to a direct DB update when the daemon socket is unavailable', async () => {
    const repo = makeRepo({ defaultBaseBranch: 'master' });
    const close = vi.fn();
    const updateRepo = vi.fn().mockReturnValue(repo);
    const connectError = Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });

    mocks.createRPCClient.mockRejectedValue(connectError);
    mocks.openDb.mockReturnValue({ close });
    mocks.WorkspaceService.mockImplementation(() => ({ updateRepo }));

    await buildCli().parseAsync([
      'node',
      'agentboard',
      'repos',
      'set-default-base-branch',
      'repo-1',
      'master',
    ]);

    expect(mocks.ensureRunning).not.toHaveBeenCalled();
    expect(mocks.openDb).toHaveBeenCalledTimes(1);
    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      defaultBaseBranch: 'master',
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(repo, null, 2));
  });
});

describe('agentboard repos delete-worktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDaemonRunning.mockResolvedValue(true);
    mocks.stopDaemon.mockResolvedValue(true);
  });

  afterEach(() => {
    logSpy.mockClear();
  });

  it('stops the daemon, removes non-primary worktrees, and clears stored task worktree paths', async () => {
    const repo = makeRepo();
    const close = vi.fn();
    const run = vi
      .fn()
      .mockReturnValueOnce({ changes: 1 })
      .mockReturnValueOnce({ changes: 2 });
    const prepare = vi.fn().mockReturnValue({ run });

    mocks.openDb.mockReturnValue({ close, prepare });
    mocks.WorkspaceService.mockImplementation(() => ({
      listRepos: () => [repo],
    }));

    const pruneWorktrees = vi.fn();
    const listWorktrees = vi.fn().mockReturnValue(['/repo', '/repo-worktrees/a', '/repo-worktrees/b']);
    const removeWorktree = vi.fn();
    mocks.GitService.mockImplementation(() => ({
      pruneWorktrees,
      listWorktrees,
      removeWorktree,
    }));

    await buildCli().parseAsync(['node', 'agentboard', 'repos', 'delete-worktrees']);

    expect(mocks.isDaemonRunning).toHaveBeenCalledTimes(1);
    expect(mocks.stopDaemon).toHaveBeenCalledWith({
      stateDir: expect.any(String),
      socketPath: expect.any(String),
      logFile: expect.any(String),
    });
    expect(pruneWorktrees).toHaveBeenCalledWith('/repo');
    expect(listWorktrees).toHaveBeenCalledWith('/repo');
    expect(removeWorktree).toHaveBeenNthCalledWith(1, '/repo', '/repo-worktrees/a');
    expect(removeWorktree).toHaveBeenNthCalledWith(2, '/repo', '/repo-worktrees/b');
    expect(prepare).toHaveBeenCalledWith(
      'UPDATE tasks SET worktree_path = ?, updated_at = ? WHERE repo_id = ? AND worktree_path = ?',
    );
    expect(run).toHaveBeenNthCalledWith(1, null, expect.any(Number), 'repo-1', '/repo-worktrees/a');
    expect(run).toHaveBeenNthCalledWith(2, null, expect.any(Number), 'repo-1', '/repo-worktrees/b');
    expect(close).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenNthCalledWith(1, 'Daemon stopped for worktree cleanup.');
    expect(logSpy).toHaveBeenNthCalledWith(
      2,
      'Deleted 2 worktree(s); cleared 3 task worktree reference(s).',
    );
  });
});
