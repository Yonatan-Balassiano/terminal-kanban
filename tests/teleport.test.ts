import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { WorktreeService } from '../src/services/worktree.js';
import { GitService } from '../src/services/git.js';
import { TransportRegistry } from '../src/services/transport/index.js';
import { TeleportBlockedError, TeleportService } from '../src/services/teleport.js';
import { claudeTranscriptPath } from '../src/services/claude-transcript.js';
import type { SessionManager } from '../src/services/session-manager.js';
import type { SessionRecord } from '../src/types/index.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, '-c', 'user.email=a@test', '-c', 'user.name=a', 'commit', '-m', message);
}

/** Records what happened on the remote host without touching a real one. */
function makeFakeRemote() {
  const exec = vi.fn(async (argv: readonly string[]) => {
    const joined = argv.join(' ');
    if (joined.includes('command -v')) {
      return { stdout: 'tmux\ngit\nclaude', stderr: '', exitCode: 0 };
    }
    if (joined.includes('CLAUDE_CONFIG_DIR')) {
      return { stdout: '/remote/home/.claude', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  return {
    id: 'ssh:test.host',
    isRemote: true,
    host: 'test.host',
    exec,
    // True only for the repo's `.git` presence check; false for a worktree
    // path, so the worktree-create branch actually runs.
    exists: vi.fn(async (path: string) => path.endsWith('/.git')),
    mkdirp: vi.fn(async () => undefined),
    removeDir: vi.fn(async () => undefined),
    writeFileIfChanged: vi.fn(async () => true),
    reachability: vi.fn(async () => 'ok' as const),
    copyFileTo: vi.fn(async () => undefined),
    copyFileFrom: vi.fn(async () => undefined),
  };
}

const fakeSession: SessionRecord = {
  id: 'session-1',
  taskId: 'task-1',
  slot: 'primary',
  backendType: 'ssh',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
};

function makeFakeSessions(
  overrides: {
    getSession?: SessionManager['getSession'];
    recreateSession?: SessionManager['recreateSession'];
  } = {}
) {
  return {
    getSession: overrides.getSession ?? vi.fn(() => null),
    recreateSession: overrides.recreateSession ?? vi.fn(async () => fakeSession),
  } as unknown as SessionManager;
}

describe('TeleportService.preflight', () => {
  let db: Db;
  let board: BoardService;

  let root: string;
  let localRepo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-teleport-preflight-'));
    const bare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    localRepo = join(root, 'local-repo');
    execFileSync('git', ['clone', bare, localRepo]);
    writeFileSync(join(localRepo, 'README.md'), 'hello\n');
    git(localRepo, 'add', '-A');
    commit(localRepo, 'init');
    git(localRepo, 'push', 'origin', 'main');

    db = openDb(':memory:');
    board = new BoardService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, remote_path, default_base_branch, health, worktree_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('repo-1', 'monorepo', localRepo, '/remote/monorepo', 'main', 'ok', 'always', 1, 1);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeService(registry: TransportRegistry, remote = makeFakeRemote()) {
    vi.spyOn(registry, 'getRemote').mockReturnValue(remote as never);
    const worktrees = new WorktreeService(db, board, new GitService(), registry);
    return new TeleportService(
      db,
      board,
      makeFakeSessions(),
      worktrees,
      new GitService(),
      registry,
      undefined
    );
  }

  /** Gives a task its own worktree first, the way opening a session already would. */
  async function givenTaskHasAWorktree(
    registry: TransportRegistry,
    title: string
  ): Promise<string> {
    const task = board.createTask({ title, repoId: 'repo-1' });
    const worktrees = new WorktreeService(db, board, new GitService(), registry);
    await worktrees.prepareTaskWorkspace(task.id);
    return task.id;
  }

  it('refuses a card spanning more than one repo or branch', async () => {
    // Arrange
    const task = board.createTask({ title: 'Multi', repoId: 'repo-1' });
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-1', branchName: 'second' });
    const service = makeService(new TransportRegistry({ sshHost: 'test.host' }));

    // Act
    const checks = await service.preflight(task.id, 'local-to-remote');

    // Assert
    expect(checks.some((c) => c.status === 'fail' && c.name === 'branches')).toBe(true);
  });

  it('refuses when a secondary session is live', async () => {
    // Arrange
    const task = board.createTask({ title: 'Dual', repoId: 'repo-1' });
    const registry = new TransportRegistry({ sshHost: 'test.host' });
    const service = new TeleportService(
      db,
      board,
      makeFakeSessions({ getSession: vi.fn(() => fakeSession) }),
      new WorktreeService(db, board, {} as never, registry),
      new GitService(),
      registry,
      undefined
    );

    // Act
    const checks = await service.preflight(task.id, 'local-to-remote');

    // Assert
    expect(checks.some((c) => c.status === 'fail' && c.name === 'dual-session')).toBe(true);
  });

  it('refuses a task with no isolated worktree yet', async () => {
    // Arrange — created, but never opened, so it has no worktree of its own.
    const task = board.createTask({ title: 'Never opened', repoId: 'repo-1' });
    const service = makeService(new TransportRegistry({ sshHost: 'test.host' }));

    // Act
    const checks = await service.preflight(task.id, 'local-to-remote');

    // Assert
    expect(checks.some((c) => c.status === 'fail' && c.name === 'worktree')).toBe(true);
  });

  it('refuses local-to-remote when the repo has no remote path', async () => {
    // Arrange
    db.prepare('UPDATE repos SET remote_path = NULL WHERE id = ?').run('repo-1');
    const registry = new TransportRegistry({ sshHost: 'test.host' });
    const taskId = await givenTaskHasAWorktree(registry, 'No remote');
    const service = makeService(registry);

    // Act
    const checks = await service.preflight(taskId, 'local-to-remote');

    // Assert
    expect(checks.some((c) => c.status === 'fail' && c.name === 'remote-path')).toBe(true);
  });

  it('refuses a direction that does not match where the task already is', async () => {
    // Arrange
    const task = board.createTask({
      title: 'Already remote',
      repoId: 'repo-1',
      location: 'remote',
    });
    const service = makeService(new TransportRegistry({ sshHost: 'test.host' }));

    // Act
    const checks = await service.preflight(task.id, 'local-to-remote');

    // Assert
    expect(checks.some((c) => c.status === 'fail' && c.name === 'location')).toBe(true);
  });

  it('passes every check for a healthy local-to-remote candidate', async () => {
    // Arrange
    const registry = new TransportRegistry({ sshHost: 'test.host' });
    const taskId = await givenTaskHasAWorktree(registry, 'Healthy');
    const service = makeService(registry);

    // Act
    const checks = await service.preflight(taskId, 'local-to-remote');

    // Assert
    expect(checks.every((c) => c.status !== 'fail')).toBe(true);
  });
});

describe('TeleportService.run', () => {
  let db: Db;
  let board: BoardService;
  let root: string;
  let bare: string;
  let localRepo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-teleport-'));
    bare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);

    localRepo = join(root, 'local-repo');
    execFileSync('git', ['clone', bare, localRepo]);
    writeFileSync(join(localRepo, 'README.md'), 'hello\n');
    git(localRepo, 'add', '-A');
    commit(localRepo, 'init');
    git(localRepo, 'push', 'origin', 'main');

    db = openDb(':memory:');
    board = new BoardService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, remote_path, default_base_branch, health, worktree_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('repo-1', 'monorepo', localRepo, '/remote/monorepo', 'main', 'ok', 'always', 1, 1);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function buildService(
    remote: ReturnType<typeof makeFakeRemote>,
    sessions: ReturnType<typeof makeFakeSessions>
  ) {
    const registry = new TransportRegistry({ sshHost: 'test.host' });
    vi.spyOn(registry, 'getRemote').mockReturnValue(remote as never);
    const worktrees = new WorktreeService(db, board, new GitService(), registry);
    return new TeleportService(
      db,
      board,
      sessions,
      worktrees,
      new GitService(),
      registry,
      undefined
    );
  }

  /** Mirrors what a real session open already did: an isolated worktree on the task's own branch. */
  async function givenTaskHasAWorktree(
    registry: TransportRegistry,
    title: string
  ): Promise<{ taskId: string; branchName: string; worktreePath: string }> {
    const task = board.createTask({ title, repoId: 'repo-1' });
    const worktrees = new WorktreeService(db, board, new GitService(), registry);
    const workspace = await worktrees.prepareTaskWorkspace(task.id);
    return { taskId: task.id, branchName: task.branchName!, worktreePath: workspace.path };
  }

  it('commits, pushes, flips location, creates the destination worktree, and cuts over', async () => {
    // Arrange — a task already isolated in its own worktree, with an uncommitted change.
    const registry = new TransportRegistry({ sshHost: 'test.host' });
    const { taskId, branchName, worktreePath } = await givenTaskHasAWorktree(
      registry,
      'Teleport me'
    );
    writeFileSync(join(worktreePath, 'notes.txt'), 'work in progress\n');

    const remote = makeFakeRemote();
    vi.spyOn(registry, 'getRemote').mockReturnValue(remote as never);
    const worktrees = new WorktreeService(db, board, {} as never, registry);
    const sessions = makeFakeSessions();
    const service = new TeleportService(
      db,
      board,
      sessions,
      worktrees,
      new GitService(),
      registry,
      undefined
    );

    // Act
    const result = await service.run(taskId, 'local-to-remote');

    // Assert
    expect(result.wipCommitted).toBe(true);
    expect(result.transcriptCopied).toBe(false); // no prior session to resume
    expect(board.getTask(taskId)!.location).toBe('remote');

    const originLog = git(bare, 'log', '--oneline', '-1', 'refs/heads/' + branchName);
    expect(originLog).toContain('teleport wip');

    const remoteCommands = remote.exec.mock.calls.map((call) => call[0].join(' '));
    expect(remoteCommands.some((c) => c.includes('worktree add'))).toBe(true);

    // The source worktree was pruned once the destination was confirmed live.
    expect(git(localRepo, 'worktree', 'list', '--porcelain')).not.toContain(worktreePath);
    expect(sessions.recreateSession).toHaveBeenCalledWith(taskId, 'primary');
  });

  it('copies the conversation transcript to the newly created destination worktree', async () => {
    // Arrange
    const claudeConfigDir = mkdtempSync(join(tmpdir(), 'agentboard-claude-'));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    try {
      const registry = new TransportRegistry({ sshHost: 'test.host' });
      const { taskId, worktreePath } = await givenTaskHasAWorktree(registry, 'Resume me');

      const agentSessionId = 'a1b2c3d4-0000-4000-8000-000000000000';
      const now = Date.now();
      db.prepare(
        `INSERT INTO sessions (id, task_id, slot, backend_type, status, agent_session_id, created_at, updated_at)
         VALUES (?, ?, 'primary', 'tmux', 'active', ?, ?, ?)`
      ).run('session-x', taskId, agentSessionId, now, now);
      board.linkSession(taskId, 'session-x', 'primary');

      // Land the transcript exactly where the Claude CLI itself would.
      const sourceTranscriptPath = claudeTranscriptPath(
        claudeConfigDir,
        worktreePath,
        agentSessionId
      );
      mkdirSync(dirname(sourceTranscriptPath), { recursive: true });
      writeFileSync(sourceTranscriptPath, '{"type":"user"}\n');

      const remote = makeFakeRemote();
      vi.spyOn(registry, 'getRemote').mockReturnValue(remote as never);
      const worktrees = new WorktreeService(db, board, {} as never, registry);
      const sessions = makeFakeSessions();
      const service = new TeleportService(
        db,
        board,
        sessions,
        worktrees,
        new GitService(),
        registry,
        undefined
      );

      // Act
      const result = await service.run(taskId, 'local-to-remote');

      // Assert — the destination path is derived from the worktree teleport just
      // created, not the (by then stale) source worktree path.
      expect(result.transcriptCopied).toBe(true);
      const destWorktreePath = board.getTask(taskId)!.worktreePath!;
      expect(destWorktreePath).not.toBe(worktreePath);
      const expectedDestPath = claudeTranscriptPath(
        '/remote/home/.claude',
        destWorktreePath,
        agentSessionId
      );
      expect(remote.copyFileTo).toHaveBeenCalledWith(sourceTranscriptPath, expectedDestPath);
    } finally {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      rmSync(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it('rolls back the WIP commit, the push, and the location flip when cutover fails', async () => {
    // Arrange
    const registry = new TransportRegistry({ sshHost: 'test.host' });
    const { taskId, branchName, worktreePath } = await givenTaskHasAWorktree(
      registry,
      'Fails late'
    );
    writeFileSync(join(worktreePath, 'notes.txt'), 'work in progress\n');
    const beforeHead = git(worktreePath, 'rev-parse', 'HEAD');

    const remote = makeFakeRemote();
    vi.spyOn(registry, 'getRemote').mockReturnValue(remote as never);
    const worktrees = new WorktreeService(db, board, {} as never, registry);
    const sessions = makeFakeSessions({
      recreateSession: vi.fn(async () => {
        throw new Error('remote host went away');
      }),
    });
    const service = new TeleportService(
      db,
      board,
      sessions,
      worktrees,
      new GitService(),
      registry,
      undefined
    );

    // Act + Assert
    await expect(service.run(taskId, 'local-to-remote')).rejects.toThrow('remote host went away');

    expect(git(worktreePath, 'rev-parse', 'HEAD')).toBe(beforeHead);
    expect(git(bare, 'rev-parse', 'refs/heads/' + branchName)).toBe(beforeHead);
    expect(board.getTask(taskId)!.location).toBe('local');
    // The destination-worktree step clears worktree_path before recomputing it;
    // rollback must put back the still-valid local one, not leave it null.
    expect(board.getTask(taskId)!.worktreePath).toBe(worktreePath);
  });

  it('throws TeleportBlockedError without doing anything when preflight fails', async () => {
    // Arrange
    const task = board.createTask({ title: 'Blocked', repoId: 'repo-1' });
    board.addTaskBranch({ taskId: task.id, repoId: 'repo-1', branchName: 'second' });
    const beforeHead = git(localRepo, 'rev-parse', 'HEAD');
    const remote = makeFakeRemote();
    const sessions = makeFakeSessions();
    const service = buildService(remote, sessions);

    // Act + Assert
    await expect(service.run(task.id, 'local-to-remote')).rejects.toBeInstanceOf(
      TeleportBlockedError
    );
    expect(git(localRepo, 'rev-parse', 'HEAD')).toBe(beforeHead);
    expect(remote.exec).not.toHaveBeenCalled();
  });
});
