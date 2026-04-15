import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { SessionManager } from '../src/services/session-manager.js';
import type { ProcessRow } from '../src/services/session-activity.js';
import type { TaskWorkspaceInfo } from '../src/services/worktree.js';
import type {
  AttachMetadata,
  BackendHealth,
  BackendSessionInfo,
  CreateSessionOpts,
  GetBufferResult,
  SessionBackend,
  SessionRecord,
} from '../src/types/index.js';

class TestSessionManager extends SessionManager {
  constructor(
    db: Db,
    board: BoardService,
    buffers: {
      write(taskId: string, data: string): void;
      has(taskId: string): boolean;
      getBuffer(taskId: string): GetBufferResult;
      subscribeAll(cb: (taskId: string, buffer: GetBufferResult) => void): () => void;
      destroy(taskId: string): void;
    },
    worktrees: {
      prepareTaskWorkspace(taskId: string): TaskWorkspaceInfo;
    },
    private backend: SessionBackend,
  ) {
    super(db, board, worktrees as never, buffers as never);
  }

  override getBackend(): SessionBackend {
    return this.backend;
  }
}

class ProcessTableSessionManager extends TestSessionManager {
  processTableLoads = 0;

  constructor(
    db: Db,
    board: BoardService,
    buffers: {
      write(taskId: string, data: string): void;
      has(taskId: string): boolean;
      getBuffer(taskId: string): GetBufferResult;
      subscribeAll(cb: (taskId: string, buffer: GetBufferResult) => void): () => void;
      destroy(taskId: string): void;
    },
    worktrees: {
      prepareTaskWorkspace(taskId: string): TaskWorkspaceInfo;
    },
    backend: SessionBackend,
    private processRows: ProcessRow[] | null,
  ) {
    super(db, board, buffers, worktrees, backend);
  }

  protected override async loadProcessTableRows(): Promise<ProcessRow[] | null> {
    this.processTableLoads += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    return this.processRows;
  }
}

describe('SessionManager branch fallback', () => {
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

  it('derives and persists a title-based branch when a legacy task has none stored', async () => {
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });
    db.prepare('UPDATE tasks SET branch_name = NULL WHERE id = ?').run(task.id);

    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: 'session-1',
      taskId: opts.taskId,
      backendType: 'tmux',
      backendSessionId: 'ab_friday_thing_1234',
      attachCommand: 'tmux attach -t ab_friday_thing_1234',
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));

    const backend: SessionBackend = {
      create,
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({
        command: 'tmux attach -t ab_friday_thing_1234',
      })),
      sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
      terminate: vi.fn<[string], Promise<void>>(async () => {}),
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
    };

    const manager = new TestSessionManager(
      db,
      board,
      {
        write() {},
        has() {
          return false;
        },
        getBuffer() {
          return { lines: [], ansiLines: [], cursorX: 0, cursorY: 0 };
        },
        subscribeAll() {
          return () => {};
        },
        destroy() {},
      },
      {
        prepareTaskWorkspace(taskId) {
          return { taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false };
        },
      },
      backend,
    );

    const session = await manager.openSession(task.id);

    expect(session.branch).toMatch(/^ab\/friday-thing-\d{4}$/);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        taskTitle: 'Friday thing',
        branch: expect.stringMatching(/^ab\/friday-thing-\d{4}$/),
      }),
    );
    expect(board.getTask(task.id)?.branchName).toBe(session.branch);
  });

  it('migrates a stored legacy branch to the title-based format on reattach', async () => {
    const task = board.createTask({ title: 'RL noes', repoId: 'repo-1' });
    board.setTaskBranch(task.id, `ab/${task.id}`);
    board.linkSession(task.id, 'session-1');

    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'session-1',
      task.id,
      'tmux',
      'ab_task_1',
      'tmux attach -t ab_task_1',
      'active',
      '/tmp/repo-1',
      `ab/${task.id}`,
      1,
      1,
      1,
    );

    const sendInput = vi.fn<[string, string], Promise<void>>(async () => {});
    const backend: SessionBackend = {
      create: vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async () => {
        throw new Error('should not create a new session');
      }),
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({
        command: 'tmux attach -t ab_task_1',
      })),
      sendInput,
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => ({
        backendSessionId: 'ab_task_1',
        status: 'active',
      })),
      terminate: vi.fn<[string], Promise<void>>(async () => {}),
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
    };

    const manager = new TestSessionManager(
      db,
      board,
      {
        write() {},
        has() {
          return false;
        },
        getBuffer() {
          return { lines: [], ansiLines: [], cursorX: 0, cursorY: 0 };
        },
        subscribeAll() {
          return () => {};
        },
        destroy() {},
      },
      {
        prepareTaskWorkspace(taskId) {
          return { taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false };
        },
      },
      backend,
    );

    const session = await manager.openSession(task.id);

    expect(session.branch).toMatch(/^ab\/rl-noes-\d{4}$/);
    expect(board.getTask(task.id)?.branchName).toBe(session.branch);
    expect(sendInput).toHaveBeenNthCalledWith(
      1,
      'ab_task_1',
      expect.stringContaining(`git -C ${JSON.stringify('/tmp/repo-1')} checkout ab/${task.id}`),
    );
    expect(sendInput).toHaveBeenNthCalledWith(1, 'ab_task_1', expect.stringContaining(session.branch!));
    expect(sendInput).toHaveBeenNthCalledWith(2, 'ab_task_1', '\r');
  });

  it('does not rerun branch setup when reattaching to a live session already on the task branch', async () => {
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });
    board.linkSession(task.id, 'session-1');

    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'session-1',
      task.id,
      'tmux',
      'ab_friday_thing_1234',
      'tmux attach -t ab_friday_thing_1234',
      'active',
      '/tmp/repo-1',
      task.branchName,
      1,
      1,
      1,
    );

    const sendInput = vi.fn<[string, string], Promise<void>>(async () => {});
    const backend: SessionBackend = {
      create: vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async () => {
        throw new Error('should not create a new session');
      }),
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({
        command: 'tmux attach -t ab_friday_thing_1234',
      })),
      sendInput,
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => ({
        backendSessionId: 'ab_friday_thing_1234',
        status: 'active',
      })),
      terminate: vi.fn<[string], Promise<void>>(async () => {}),
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
    };

    const manager = new TestSessionManager(
      db,
      board,
      {
        write() {},
        has() {
          return false;
        },
        getBuffer() {
          return { lines: [], ansiLines: [], cursorX: 0, cursorY: 0 };
        },
        subscribeAll() {
          return () => {};
        },
        destroy() {},
      },
      {
        prepareTaskWorkspace(taskId) {
          return { taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false };
        },
      },
      backend,
    );

    const session = await manager.openSession(task.id);

    expect(session.branch).toBe(task.branchName);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('recreates a task session by terminating the old one and opening a new session', async () => {
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });
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
      'ab_old_session',
      null,
      'active',
      '/tmp/repo-1',
      task.branchName,
      1,
      1,
      1,
    );

    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: 'session-2',
      taskId: opts.taskId,
      backendType: 'pty',
      backendSessionId: 'ab_new_session',
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 2,
      updatedAt: 2,
    }));
    const terminate = vi.fn<[string], Promise<void>>(async () => {});
    const backend: SessionBackend = {
      create,
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({
        command: '(embedded PTY — attach not supported)',
      })),
      sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
      terminate,
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
    };

    const destroy = vi.fn<[string], void>(() => {});
    const manager = new TestSessionManager(
      db,
      board,
      {
        write() {},
        has() {
          return false;
        },
        getBuffer() {
          return { lines: [], ansiLines: [], cursorX: 0, cursorY: 0 };
        },
        subscribeAll() {
          return () => {};
        },
        destroy,
      },
      {
        prepareTaskWorkspace(taskId) {
          return { taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false };
        },
      },
      backend,
    );

    const session = await manager.recreateSession(task.id);

    expect(terminate).toHaveBeenCalledWith('ab_old_session');
    expect(destroy).toHaveBeenCalledWith(task.id);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        taskTitle: task.title,
      }),
    );
    expect(session.id).toBe('session-2');
    expect(board.getTask(task.id)?.sessionId).toBe('session-2');
  });

  it('marks attention when an active session transitions from busy to idle', async () => {
    const task = board.createTask({ title: 'Watch me finish', repoId: 'repo-1' });
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
      null,
      null,
      'active',
      '/tmp/repo-1',
      task.branchName,
      1,
      1,
      1,
    );

    const backend: SessionBackend = {
      create: vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async () => {
        throw new Error('should not create a new session');
      }),
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({
        command: '(embedded PTY — attach not supported)',
      })),
      sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
      terminate: vi.fn<[string], Promise<void>>(async () => {}),
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
    };

    const manager = new TestSessionManager(
      db,
      board,
      {
        write() {},
        has() {
          return false;
        },
        getBuffer() {
          return { lines: [], ansiLines: [], cursorX: 0, cursorY: 0 };
        },
        subscribeAll() {
          return () => {};
        },
        destroy() {},
      },
      {
        prepareTaskWorkspace(taskId) {
          return { taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false };
        },
      },
      backend,
    );

    (manager as { lastBusyByTaskId: Map<string, boolean> }).lastBusyByTaskId.set(task.id, true);

    const result = await manager.inspectSessionState(task.id);

    expect(result.activity?.isBusy).toBe(false);
    expect(result.attentionChanged).toBe(true);
    expect(board.getTask(task.id)?.sessionAttentionNeeded).toBe(true);
  });

  it('clears attention when opening a new session', async () => {
    const task = board.createTask({ title: 'Resume me', repoId: 'repo-1' });
    board.setTaskSessionAttention(task.id);

    const backend: SessionBackend = {
      create: vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
        id: 'session-1',
        taskId: opts.taskId,
        backendType: 'pty',
        backendSessionId: 'ab_resume_me',
        status: 'active',
        cwd: opts.cwd ?? opts.repoPath,
        branch: opts.branch,
        createdAt: 1,
        updatedAt: 1,
      })),
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({
        command: '(embedded PTY — attach not supported)',
      })),
      sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
      terminate: vi.fn<[string], Promise<void>>(async () => {}),
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
    };

    const manager = new TestSessionManager(
      db,
      board,
      {
        write() {},
        has() {
          return false;
        },
        getBuffer() {
          return { lines: [], ansiLines: [], cursorX: 0, cursorY: 0 };
        },
        subscribeAll() {
          return () => {};
        },
        destroy() {},
      },
      {
        prepareTaskWorkspace(taskId) {
          return { taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false };
        },
      },
      backend,
    );

    await manager.openSession(task.id);

    expect(board.getTask(task.id)?.sessionAttentionNeeded).toBe(false);
  });

  it('clears attention when sending input back into a session', async () => {
    const task = board.createTask({ title: 'Continue me', repoId: 'repo-1' });
    board.setTaskSessionAttention(task.id);
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
      'ab_continue_me',
      null,
      'active',
      '/tmp/repo-1',
      task.branchName,
      1,
      1,
      1,
    );

    const sendInput = vi.fn<[string, string], Promise<void>>(async () => {});
    const backend: SessionBackend = {
      create: vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async () => {
        throw new Error('should not create a new session');
      }),
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({
        command: '(embedded PTY — attach not supported)',
      })),
      sendInput,
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
      terminate: vi.fn<[string], Promise<void>>(async () => {}),
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
    };

    const manager = new TestSessionManager(
      db,
      board,
      {
        write() {},
        has() {
          return false;
        },
        getBuffer() {
          return { lines: [], ansiLines: [], cursorX: 0, cursorY: 0 };
        },
        subscribeAll() {
          return () => {};
        },
        destroy() {},
      },
      {
        prepareTaskWorkspace(taskId) {
          return { taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false };
        },
      },
      backend,
    );

    const attentionChanged = await manager.sendInput(task.id, "continue\n");

    expect(attentionChanged).toBe(true);
    expect(sendInput).toHaveBeenCalledWith('ab_continue_me', "continue\n");
    expect(board.getTask(task.id)?.sessionAttentionNeeded).toBe(false);
  });

  it('shares one async process-table load across concurrent session inspections', async () => {
    const first = board.createTask({ title: 'First session', repoId: 'repo-1' });
    const second = board.createTask({ title: 'Second session', repoId: 'repo-1' });
    board.linkSession(first.id, 'session-1');
    board.linkSession(second.id, 'session-2');

    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'session-1',
      first.id,
      'pty',
      'ab_first_session',
      null,
      'active',
      '/tmp/repo-1',
      first.branchName,
      1,
      1,
      1,
    );
    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'session-2',
      second.id,
      'pty',
      'ab_second_session',
      null,
      'active',
      '/tmp/repo-1',
      second.branchName,
      1,
      1,
      1,
    );

    const inspect = vi.fn<[string], Promise<BackendSessionInfo | null>>(async (backendSessionId) => {
      if (backendSessionId === 'ab_first_session') {
        return {
          backendSessionId,
          status: 'active',
          shellPid: 100,
          currentCommand: 'zsh',
        };
      }

      return {
        backendSessionId,
        status: 'active',
        shellPid: 200,
        currentCommand: 'zsh',
      };
    });

    const backend: SessionBackend = {
      create: vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async () => {
        throw new Error('should not create a new session');
      }),
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({
        command: '(embedded PTY — attach not supported)',
      })),
      sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect,
      terminate: vi.fn<[string], Promise<void>>(async () => {}),
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
    };

    const manager = new ProcessTableSessionManager(
      db,
      board,
      {
        write() {},
        has() {
          return false;
        },
        getBuffer() {
          return { lines: [], ansiLines: [], cursorX: 0, cursorY: 0 };
        },
        subscribeAll() {
          return () => {};
        },
        destroy() {},
      },
      {
        prepareTaskWorkspace(taskId) {
          return { taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false };
        },
      },
      backend,
      [
        {
          pid: 100,
          ppid: 1,
          stat: 'Ss',
          command: '/bin/zsh',
          args: '-zsh',
        },
        {
          pid: 101,
          ppid: 100,
          stat: 'S+',
          command: 'npm',
          args: 'npm test',
        },
        {
          pid: 200,
          ppid: 1,
          stat: 'Ss',
          command: '/bin/zsh',
          args: '-zsh',
        },
        {
          pid: 201,
          ppid: 200,
          stat: 'S+',
          command: 'node',
          args: 'node server.js',
        },
      ],
    );

    const [firstResult, secondResult] = await Promise.all([
      manager.inspectSessionState(first.id),
      manager.inspectSessionState(second.id),
    ]);

    expect(manager.processTableLoads).toBe(1);
    expect(firstResult.activity?.isBusy).toBe(true);
    expect(secondResult.activity?.isBusy).toBe(true);
    expect(inspect).toHaveBeenCalledTimes(2);
  });
});
