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
  SessionBackendType,
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
      subscribeAll(
        cb: (taskId: string, _slot: string, buffer: GetBufferResult) => void
      ): () => void;
      destroy(taskId: string): void;
    },
    worktrees: {
      prepareTaskWorkspace(taskId: string): TaskWorkspaceInfo;
    },
    private backend: SessionBackend
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
      subscribeAll(
        cb: (taskId: string, _slot: string, buffer: GetBufferResult) => void
      ): () => void;
      destroy(taskId: string): void;
    },
    worktrees: {
      prepareTaskWorkspace(taskId: string): TaskWorkspaceInfo;
    },
    backend: SessionBackend,
    private processRows: ProcessRow[] | null
  ) {
    super(db, board, buffers, worktrees, backend);
  }

  protected override async loadProcessTableRows(): Promise<ProcessRow[] | null> {
    this.processTableLoads += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    return this.processRows;
  }
}

class BackendSelectingSessionManager extends SessionManager {
  constructor(
    db: Db,
    board: BoardService,
    buffers: {
      write(taskId: string, slot: string, data: string): void;
      has(taskId: string, slot?: string): boolean;
      getBuffer(taskId: string, slot?: string): GetBufferResult;
      subscribeAll(cb: (taskId: string, slot: string, buffer: GetBufferResult) => void): () => void;
      destroy(taskId: string, slot?: string): void;
      resize(taskId: string, slot: string, cols: number, rows: number): void;
    },
    worktrees: {
      prepareTaskWorkspace(taskId: string): TaskWorkspaceInfo;
    },
    private selectableBackends: Record<SessionBackendType, SessionBackend>,
    sessionBackend: SessionBackendType
  ) {
    super(db, board, worktrees as never, buffers as never, undefined, '', sessionBackend);
  }

  protected override createBackend(backendType: SessionBackendType): SessionBackend {
    return this.selectableBackends[backendType];
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      backendType: 'pty',
      backendSessionId: 'ab_friday_thing_1234',
      attachCommand: undefined,
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));

    const backend: SessionBackend = {
      create,
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
      backend
    );

    const session = await manager.openSession(task.id);

    expect(session.branch).toMatch(/^ab\/friday-thing-\d{4}$/);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        taskTitle: 'Friday thing',
        branch: expect.stringMatching(/^ab\/friday-thing-\d{4}$/),
      })
    );
    expect(board.getTask(task.id)?.branchName).toBe(session.branch);
    expect(board.getTask(task.id)?.trackId).toBe('in-progress');
  });

  it('passes the stored task agent into new session creation', async () => {
    const task = board.createTask({ title: 'Use codex', repoId: 'repo-1', agentCli: 'codex' });

    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: 'session-1',
      taskId: opts.taskId,
      backendType: 'pty',
      backendSessionId: 'ab_use_codex_1234',
      attachCommand: undefined,
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));

    const backend: SessionBackend = {
      create,
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
      backend
    );

    await manager.openSession(task.id);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        agentCli: 'codex',
      })
    );
  });

  it('hands the card brief to the backend as the session opening prompt', async () => {
    // Arrange — a card created with context, the way `task create` makes one.
    const task = board.createTask({
      title: 'Add rate limiting',
      repoId: 'repo-1',
      description: 'Cap the API at 100 rps.',
      initialPrompt: 'Cap the API at 100 rps.',
    });

    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: 'session-1',
      taskId: opts.taskId,
      backendType: 'pty',
      backendSessionId: 'ab_add_rate_limiting_1234',
      attachCommand: undefined,
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));

    const backend: SessionBackend = {
      create,
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
      backend
    );

    // Act
    await manager.openSession(task.id);

    // Assert
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ initialPrompt: 'Cap the API at 100 rps.' })
    );
  });

  it('opens a session with no opening prompt for a card that has no brief', async () => {
    // Arrange — a card made in the TUI, which never asks for context.
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });

    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: 'session-1',
      taskId: opts.taskId,
      backendType: 'pty',
      backendSessionId: 'ab_friday_thing_1234',
      attachCommand: undefined,
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));

    const backend: SessionBackend = {
      create,
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
      backend
    );

    // Act
    await manager.openSession(task.id);

    // Assert
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ initialPrompt: undefined })
    );
  });

  it('passes the stored repo default base branch into new session creation', async () => {
    db.prepare('UPDATE repos SET default_base_branch = ? WHERE id = ?').run('master', 'repo-1');
    const task = board.createTask({ title: 'Use master', repoId: 'repo-1' });

    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: 'session-1',
      taskId: opts.taskId,
      backendType: 'pty',
      backendSessionId: 'ab_use_master_1234',
      attachCommand: undefined,
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));

    const backend: SessionBackend = {
      create,
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
      backend
    );

    await manager.openSession(task.id);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        baseBranch: 'master',
      })
    );
  });

  it('selects the configured tmux backend for new sessions', async () => {
    const task = board.createTask({ title: 'Use tmux', repoId: 'repo-1' });

    const tmuxCreate = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: 'session-tmux',
      taskId: opts.taskId,
      slot: opts.slot,
      backendType: 'tmux',
      backendSessionId: 'ab_use_tmux_1234_p',
      attachCommand: 'env -u TMUX tmux attach-session -t ab_use_tmux_1234_p',
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));
    const ptyCreate = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async () => {
      throw new Error('pty backend should not be selected');
    });

    const backends: Record<SessionBackendType, SessionBackend> = {
      tmux: {
        create: tmuxCreate,
        attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async (id) => ({
          command: `env -u TMUX tmux attach-session -t ${id}`,
        })),
        sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
        resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
        list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
        inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
        terminate: vi.fn<[string], Promise<void>>(async () => {}),
        healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
      },
      pty: {
        create: ptyCreate,
        attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({
          command: '(embedded PTY — attach not supported)',
        })),
        sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
        resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
        list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
        inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
        terminate: vi.fn<[string], Promise<void>>(async () => {}),
        healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
      },
    };

    const manager = new BackendSelectingSessionManager(
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
        resize() {},
      },
      {
        prepareTaskWorkspace(taskId) {
          return { taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false };
        },
      },
      backends,
      'tmux'
    );

    const session = await manager.openSession(task.id);

    expect(session.backendType).toBe('tmux');
    expect(tmuxCreate).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id }));
    expect(ptyCreate).not.toHaveBeenCalled();
    expect(board.getTask(task.id)?.sessionId).toBe('session-tmux');
  });

  it('deduplicates concurrent opens for the same tmux task slot', async () => {
    const task = board.createTask({ title: 'Fast click tmux', repoId: 'repo-1' });

    let createCalls = 0;
    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => {
      createCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        id: 'session-tmux',
        taskId: opts.taskId,
        slot: opts.slot,
        backendType: 'tmux',
        backendSessionId: 'ab_fast_click_tmux_1234_p',
        attachCommand: 'env -u TMUX tmux attach-session -t ab_fast_click_tmux_1234_p',
        status: 'active',
        cwd: opts.cwd ?? opts.repoPath,
        branch: opts.branch,
        createdAt: 1,
        updatedAt: 1,
      };
    });

    const backend: SessionBackend = {
      create,
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async (id) => ({
        command: `env -u TMUX tmux attach-session -t ${id}`,
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
      backend
    );

    const [first, second] = await Promise.all([
      manager.openSession(task.id),
      manager.openSession(task.id),
    ]);

    expect(first).toEqual(second);
    expect(createCalls).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(board.getTask(task.id)?.sessionId).toBe('session-tmux');
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
  });

  it('keeps existing tmux task sessions alive when opening a different task', async () => {
    const first = board.createTask({ title: 'First tmux', repoId: 'repo-1' });
    const second = board.createTask({ title: 'Second tmux', repoId: 'repo-1' });
    board.linkSession(first.id, 'session-old');

    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'session-old',
      first.id,
      'tmux',
      'ab_first_tmux_1111_p',
      'env -u TMUX tmux attach-session -t ab_first_tmux_1111_p',
      'active',
      '/tmp/repo-1',
      first.branchName,
      1,
      1,
      1
    );

    const terminate = vi.fn<[string], Promise<void>>(async () => {});
    const tmuxBackend: SessionBackend = {
      create: vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
        id: 'session-new',
        taskId: opts.taskId,
        slot: opts.slot,
        backendType: 'tmux',
        backendSessionId: 'ab_second_tmux_2222_p',
        attachCommand: 'env -u TMUX tmux attach-session -t ab_second_tmux_2222_p',
        status: 'active',
        cwd: opts.cwd ?? opts.repoPath,
        branch: opts.branch,
        createdAt: 2,
        updatedAt: 2,
      })),
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async (id) => ({
        command: `env -u TMUX tmux attach-session -t ${id}`,
      })),
      sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
      terminate,
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
    };

    const manager = new BackendSelectingSessionManager(
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
        resize() {},
      },
      {
        prepareTaskWorkspace(taskId) {
          return { taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false };
        },
      },
      {
        tmux: tmuxBackend,
        pty: tmuxBackend,
      },
      'tmux'
    );

    const session = await manager.openSession(second.id);
    const oldSession = db
      .prepare<[string], { status: string }>('SELECT status FROM sessions WHERE id = ?')
      .get('session-old');

    expect(session.id).toBe('session-new');
    expect(terminate).not.toHaveBeenCalled();
    expect(oldSession?.status).toBe('active');
    expect(board.getTask(first.id)?.sessionId).toBe('session-old');
    expect(board.getTask(second.id)?.sessionId).toBe('session-new');
  });

  it('reattaches live tmux session rows instead of treating them as legacy orphaned rows', async () => {
    const task = board.createTask({ title: 'Resume tmux', repoId: 'repo-1' });
    board.linkSession(task.id, 'session-1');

    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'session-1',
      task.id,
      'tmux',
      'ab_resume_tmux_1234_p',
      'env -u TMUX tmux attach-session -t ab_resume_tmux_1234_p',
      'active',
      '/tmp/repo-1',
      task.branchName,
      1,
      1,
      1
    );

    const inspect = vi.fn<[string], Promise<BackendSessionInfo | null>>(
      async (backendSessionId) => ({
        backendSessionId,
        status: 'active',
      })
    );
    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async () => {
      throw new Error('should reattach existing tmux session');
    });
    const terminate = vi.fn<[string], Promise<void>>(async () => {});

    const tmuxBackend: SessionBackend = {
      create,
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async (id) => ({
        command: `env -u TMUX tmux attach-session -t ${id}`,
      })),
      sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect,
      terminate,
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
    };

    const manager = new BackendSelectingSessionManager(
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
        resize() {},
      },
      {
        prepareTaskWorkspace(taskId) {
          return { taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false };
        },
      },
      {
        tmux: tmuxBackend,
        pty: tmuxBackend,
      },
      'tmux'
    );

    const session = await manager.openSession(task.id);
    const activity = await manager.inspectSession(task.id);

    expect(session.id).toBe('session-1');
    expect(session.backendType).toBe('tmux');
    expect(create).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledWith('ab_resume_tmux_1234_p');
    expect(activity?.sessionStatus).toBe('active');
  });

  it('migrates a stored legacy branch to the title-based format on reattach', async () => {
    const task = board.createTask({ title: 'RL noes', repoId: 'repo-1' });
    board.setTaskBranch(task.id, `ab/${task.id}`);
    board.linkSession(task.id, 'session-1');

    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'session-1',
      task.id,
      'pty',
      'ab_task_1',
      null,
      'active',
      '/tmp/repo-1',
      `ab/${task.id}`,
      1,
      1,
      1
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
      backend
    );

    const session = await manager.openSession(task.id);

    expect(session.branch).toMatch(/^ab\/rl-noes-\d{4}$/);
    expect(board.getTask(task.id)?.branchName).toBe(session.branch);
    expect(sendInput).toHaveBeenNthCalledWith(
      1,
      'ab_task_1',
      expect.stringContaining(`git -C ${JSON.stringify('/tmp/repo-1')} checkout ab/${task.id}`)
    );
    expect(sendInput).toHaveBeenNthCalledWith(
      1,
      'ab_task_1',
      expect.stringContaining(session.branch!)
    );
    expect(sendInput).toHaveBeenNthCalledWith(2, 'ab_task_1', '\r');
  });

  it('does not rerun branch setup when reattaching to a live session already on the task branch', async () => {
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });
    board.linkSession(task.id, 'session-1');

    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'session-1',
      task.id,
      'pty',
      'ab_friday_thing_1234',
      null,
      'active',
      '/tmp/repo-1',
      task.branchName,
      1,
      1,
      1
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
      backend
    );

    const session = await manager.openSession(task.id);

    expect(session.branch).toBe(task.branchName);
    expect(board.getTask(task.id)?.trackId).toBe('backlog');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('recreates a task session by terminating the old one and opening a new session', async () => {
    const task = board.createTask({ title: 'Friday thing', repoId: 'repo-1' });
    board.linkSession(task.id, 'session-1');

    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      1
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
      backend
    );

    const session = await manager.recreateSession(task.id);

    expect(terminate).toHaveBeenCalledWith('ab_old_session');
    expect(destroy).toHaveBeenCalledWith(task.id, 'primary');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        taskTitle: task.title,
      })
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      1
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
      backend
    );

    (
      manager as {
        lastBusyBySessionKey: Map<string, boolean>;
        sessionKey(taskId: string, slot: 'primary' | 'secondary'): string;
      }
    ).lastBusyBySessionKey.set(
      (manager as { sessionKey(taskId: string, slot: 'primary' | 'secondary'): string }).sessionKey(
        task.id,
        'primary'
      ),
      true
    );

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
      backend
    );

    await manager.openSession(task.id);

    expect(board.getTask(task.id)?.sessionAttentionNeeded).toBe(false);
  });

  it('opens a fallback repo shell when worktree setup fails', async () => {
    const task = board.createTask({ title: 'Recover me', repoId: 'repo-1' });

    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: 'session-1',
      taskId: opts.taskId,
      backendType: 'pty',
      backendSessionId: 'ab_recover_me',
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));

    const backend: SessionBackend = {
      create,
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
        prepareTaskWorkspace() {
          throw new Error('Git command failed: git worktree add -b "ab/recover-me-1234"');
        },
      },
      backend
    );

    const session = await manager.openSession(task.id);

    expect(session.id).toBe('session-1');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/tmp/repo-1',
        cwd: '/tmp/repo-1',
        usesWorktree: false,
        bootstrapNotice: expect.stringContaining('Git command failed: git worktree add'),
      })
    );
    expect(board.getTask(task.id)?.sessionId).toBe('session-1');
    expect(board.getTask(task.id)?.lastSessionCwd).toBe('/tmp/repo-1');
  });

  it('clears attention when sending input back into a session', async () => {
    const task = board.createTask({ title: 'Continue me', repoId: 'repo-1' });
    board.setTaskSessionAttention(task.id);
    board.linkSession(task.id, 'session-1');

    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      1
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
      backend
    );

    const attentionChanged = await manager.sendInput(task.id, 'continue\n');

    expect(attentionChanged).toBe(true);
    expect(sendInput).toHaveBeenCalledWith('ab_continue_me', 'continue\n');
    expect(board.getTask(task.id)?.sessionAttentionNeeded).toBe(false);
  });

  it('clears attention when a session is acknowledged without sending input', () => {
    const task = board.createTask({ title: 'Seen it', repoId: 'repo-1' });
    board.setTaskSessionAttention(task.id);

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
      backend
    );

    const attentionChanged = manager.acknowledgeSessionAttention(task.id);

    expect(attentionChanged).toBe(true);
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      1
    );
    db.prepare(
      `INSERT INTO sessions
         (id, task_id, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      1
    );

    const inspect = vi.fn<[string], Promise<BackendSessionInfo | null>>(
      async (backendSessionId) => {
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
      }
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
      ]
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

  it('enables dual session mode by linking a secondary shell without replacing the primary shell', async () => {
    const task = board.createTask({ title: 'Dual me', repoId: 'repo-1' });

    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: opts.slot === 'secondary' ? 'session-2' : 'session-1',
      taskId: opts.taskId,
      slot: opts.slot,
      backendType: 'pty',
      backendSessionId: opts.slot === 'secondary' ? 'ab_dual_me_2e30_s' : 'ab_dual_me_2e30_p',
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));

    const backend: SessionBackend = {
      create,
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
      backend
    );

    await manager.setDualSessionMode(task.id, true);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ taskId: task.id, slot: 'primary' })
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ taskId: task.id, slot: 'secondary' })
    );
    expect(board.getTask(task.id)?.sessionId).toBe('session-1');
    expect(board.getTask(task.id)?.secondarySessionId).toBe('session-2');
  });

  it('opens primary and secondary tmux sessions without terminating either slot', async () => {
    const task = board.createTask({ title: 'Dual tmux', repoId: 'repo-1' });

    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: opts.slot === 'secondary' ? 'session-2' : 'session-1',
      taskId: opts.taskId,
      slot: opts.slot,
      backendType: 'tmux',
      backendSessionId: opts.slot === 'secondary' ? 'ab_dual_tmux_2e30_s' : 'ab_dual_tmux_2e30_p',
      attachCommand:
        opts.slot === 'secondary'
          ? 'env -u TMUX tmux attach-session -t ab_dual_tmux_2e30_s'
          : 'env -u TMUX tmux attach-session -t ab_dual_tmux_2e30_p',
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));
    const terminate = vi.fn<[string], Promise<void>>(async () => {});

    const backend: SessionBackend = {
      create,
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async (id) => ({
        command: `env -u TMUX tmux attach-session -t ${id}`,
      })),
      sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
      terminate,
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
      backend
    );

    await manager.setDualSessionMode(task.id, true);

    expect(create).toHaveBeenCalledTimes(2);
    expect(terminate).not.toHaveBeenCalled();
    expect(board.getTask(task.id)?.sessionId).toBe('session-1');
    expect(board.getTask(task.id)?.secondarySessionId).toBe('session-2');
  });
});

describe('SessionManager session revival', () => {
  let db: Db;
  let board: BoardService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('repo-1', 'Repo', '/tmp/repo-1', null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  function makeBuffers() {
    return {
      write: vi.fn(),
      has: vi.fn(() => false),
      getBuffer: vi.fn(() => ({ lines: [], ansiLines: [], cursorX: 0, cursorY: 0 })),
      subscribeAll: vi.fn(() => () => {}),
      destroy: vi.fn(),
      resize: vi.fn(),
    };
  }

  it('lets the backend repair the attachment every time a live session is reopened', async () => {
    // Arrange — a session that is still alive on its backend. For the ssh
    // backend attachMetadata() is what rebuilds the local wrapper a dropped
    // connection destroyed, so skipping it makes remote sessions unrevivable.
    const task = board.createTask({ title: 'Revive me', repoId: 'repo-1' });
    board.linkSession(task.id, 'session-1');
    db.prepare(
      `INSERT INTO sessions
         (id, task_id, slot, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'session-1',
      task.id,
      'primary',
      'tmux',
      'ab_revive_me_0001_p',
      'tmux attach -t ab_revive_me_0001_p',
      'active',
      '/tmp/repo-1',
      task.branchName,
      1,
      1,
      1
    );

    const attachMetadata = vi.fn(
      async (): Promise<AttachMetadata> => ({ command: 'tmux attach -t ab_revive_me_0001_p' })
    );
    const backend: SessionBackend = {
      create: vi.fn(),
      attachMetadata,
      sendInput: vi.fn(),
      resize: vi.fn(),
      list: vi.fn(async () => []),
      inspect: vi.fn(
        async (id: string): Promise<BackendSessionInfo> => ({ backendSessionId: id, status: 'active' })
      ),
      terminate: vi.fn(),
      healthCheck: vi.fn(async (): Promise<BackendHealth> => ({ available: true })),
    } as unknown as SessionBackend;

    const manager = new TestSessionManager(
      db,
      board,
      makeBuffers() as never,
      { prepareTaskWorkspace: () => ({ taskId: task.id, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false }) },
      backend
    );

    // Act
    const reopened = await manager.openSession(task.id);

    // Assert
    expect(attachMetadata).toHaveBeenCalledWith('ab_revive_me_0001_p');
    expect(backend.create).not.toHaveBeenCalled();
    expect(reopened.id).toBe('session-1');
  });
});

describe('SessionManager duplicate session rows', () => {
  let db: Db;
  let board: BoardService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('repo-1', 'Repo', '/tmp/repo-1', null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  function insertSession(id: string, taskId: string, backendSessionId: string, status: string) {
    db.prepare(
      `INSERT INTO sessions
         (id, task_id, slot, backend_type, backend_session_id, attach_command, status,
          cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, 'primary', 'tmux', ?, null, ?, null, null, 1, 1, 1)`
    ).run(id, taskId, backendSessionId, status);
  }

  function makeManager() {
    const backend: SessionBackend = {
      create: vi.fn(),
      attachMetadata: vi.fn(async () => ({ command: 'x' })),
      sendInput: vi.fn(),
      resize: vi.fn(),
      list: vi.fn(async () => []),
      inspect: vi.fn(async (id: string) => ({ backendSessionId: id, status: 'active' as const })),
      terminate: vi.fn(),
      healthCheck: vi.fn(async () => ({ available: true })),
    } as unknown as SessionBackend;

    const manager = new TestSessionManager(
      db,
      board,
      {
        write: vi.fn(),
        has: vi.fn(() => false),
        getBuffer: vi.fn(() => ({ lines: [], ansiLines: [], cursorX: 0, cursorY: 0 })),
        subscribeAll: vi.fn(() => () => {}),
        destroy: vi.fn(),
        resize: vi.fn(),
      } as never,
      { prepareTaskWorkspace: (taskId: string) => ({ taskId, path: '/tmp/repo-1', repoPath: '/tmp/repo-1', usedWorktree: false }) },
      backend
    );
    return { manager, backend };
  }

  it('drops duplicate rows describing the same backend session as the live one', async () => {
    // Arrange — two rows for one task sharing a backend session name, which is
    // how the board ends up with several "active" sessions for one card.
    const task = board.createTask({ title: 'Dup', repoId: 'repo-1' });
    insertSession('sess-old', task.id, 'ab_dup_p', 'active');
    insertSession('sess-new', task.id, 'ab_dup_p', 'active');
    board.linkSession(task.id, 'sess-new');
    const { manager, backend } = makeManager();

    // Act
    await manager.reconcile();

    // Assert — the stale row described nothing the live row does not, so it is
    // removed outright rather than left behind as a permanent orphan.
    const rows = db
      .prepare('SELECT id, status FROM sessions WHERE task_id = ?')
      .all(task.id) as Array<{ id: string; status: string }>;
    expect(rows).toEqual([{ id: 'sess-new', status: 'active' }]);
    // Both rows shared a backend session, so killing the stale one would have
    // taken down the session that is still running.
    expect(backend.terminate).not.toHaveBeenCalled();
  });

  it('does not probe a backend for rows it is about to retire', async () => {
    // Arrange
    const task = board.createTask({ title: 'Dup2', repoId: 'repo-1' });
    insertSession('sess-old', task.id, 'ab_dup2_p', 'active');
    insertSession('sess-new', task.id, 'ab_dup2_p', 'active');
    board.linkSession(task.id, 'sess-new');
    const { manager, backend } = makeManager();

    // Act
    await manager.reconcile();

    // Assert — one live row left, so exactly one inspect.
    expect((backend.inspect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('leaves a single linked session untouched', async () => {
    // Arrange
    const task = board.createTask({ title: 'Solo', repoId: 'repo-1' });
    insertSession('sess-1', task.id, 'ab_solo_p', 'active');
    board.linkSession(task.id, 'sess-1');
    const { manager } = makeManager();

    // Act
    await manager.reconcile();

    // Assert
    const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get('sess-1') as { status: string };
    expect(row.status).toBe('active');
  });
});

describe('SessionManager agent conversation id', () => {
  let db: Db;
  let board: BoardService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('repo-1', 'Repo', '/tmp/repo-1', null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  /** A backend whose sessions are always dead by the time they are looked at. */
  function makeManager() {
    let created = 0;
    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => {
      created += 1;
      return {
        id: `session-${created}`,
        taskId: opts.taskId,
        backendType: 'pty',
        backendSessionId: `ab_session_${created}`,
        status: 'active',
        cwd: opts.cwd ?? opts.repoPath,
        branch: opts.branch,
        createdAt: created,
        updatedAt: created,
      };
    });

    const backend: SessionBackend = {
      create,
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({ command: '' })),
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
      backend
    );

    return { manager, create };
  }

  it('hands the agent a uuid it can be relaunched under, and stores it', async () => {
    // Arrange
    const task = board.createTask({ title: 'Move config', repoId: 'repo-1' });
    const { manager, create } = makeManager();

    // Act
    const session = await manager.openSession(task.id);

    // Assert — claude only accepts a uuid for --session-id.
    expect(session.agentSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(create.mock.calls[0]?.[0].agentSessionId).toBe(session.agentSessionId);
    const row = db
      .prepare('SELECT agent_session_id FROM sessions WHERE id = ?')
      .get(session.id) as { agent_session_id: string };
    expect(row.agent_session_id).toBe(session.agentSessionId);
  });

  it('reopens a card whose pane died on the same conversation', async () => {
    // Arrange — the backend reports every session dead, so reopening rebuilds it.
    const task = board.createTask({ title: 'Move config', repoId: 'repo-1' });
    const { manager, create } = makeManager();
    const first = await manager.openSession(task.id);

    // Act
    const second = await manager.openSession(task.id);

    // Assert — a new backend session, still the same conversation.
    expect(second.id).not.toBe(first.id);
    expect(second.agentSessionId).toBe(first.agentSessionId);
    expect(create.mock.calls[1]?.[0].agentSessionId).toBe(first.agentSessionId);
  });

  it('keeps the conversation across an explicit recreate', async () => {
    // Arrange
    const task = board.createTask({ title: 'Move config', repoId: 'repo-1' });
    const { manager } = makeManager();
    const first = await manager.openSession(task.id);

    // Act
    const recreated = await manager.recreateSession(task.id);

    // Assert
    expect(recreated.agentSessionId).toBe(first.agentSessionId);
  });

  it('gives a second pane on the same card its own conversation', async () => {
    // Arrange — both slots share a checkout, so only the id tells them apart.
    const task = board.createTask({ title: 'Move config', repoId: 'repo-1' });
    const { manager } = makeManager();

    // Act
    const primary = await manager.openSession(task.id, 'primary');
    const secondary = await manager.openSession(task.id, 'secondary');

    // Assert
    expect(secondary.agentSessionId).not.toBe(primary.agentSessionId);
  });
});

describe('SessionManager.redeliverInitialPrompt', () => {
  let db: Db;
  let board: BoardService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('repo-1', 'Repo', '/tmp/repo-1', null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  function makeManager(backendOverrides: Partial<SessionBackend> = {}) {
    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: 'session-1',
      taskId: opts.taskId,
      backendType: 'tmux',
      backendSessionId: 'ab_task_1234',
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));

    const backend: SessionBackend = {
      create,
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({ command: '' })),
      sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
      terminate: vi.fn<[string], Promise<void>>(async () => {}),
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
      ...backendOverrides,
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
      backend
    );

    return { manager, backend };
  }

  it('re-delivers the stored brief to the live session via the backend', async () => {
    // Arrange
    const redeliverPrompt = vi.fn<
      [string, 'primary' | 'secondary', string, string, string?],
      Promise<boolean>
    >(async () => true);
    const task = board.createTask({
      title: 'Needs a nudge',
      repoId: 'repo-1',
      initialPrompt: 'Fix the flaky test.',
    });
    const { manager } = makeManager({ redeliverPrompt });
    await manager.openSession(task.id);

    // Act
    const delivered = await manager.redeliverInitialPrompt(task.id);

    // Assert
    expect(delivered).toBe(true);
    expect(redeliverPrompt).toHaveBeenCalledWith(
      task.id,
      'primary',
      'ab_task_1234',
      'Fix the flaky test.',
      'claude',
    );
  });

  it('propagates false from the backend when the paste never verified', async () => {
    // Arrange — the backend actually tried, but the paste never rendered, so
    // nothing was submitted. The method's own return value must say so
    // honestly, not paper over it with a hardcoded true.
    const redeliverPrompt = vi.fn<
      [string, 'primary' | 'secondary', string, string, string?],
      Promise<boolean>
    >(async () => false);
    const task = board.createTask({
      title: 'Needs a nudge',
      repoId: 'repo-1',
      initialPrompt: 'Fix the flaky test.',
    });
    const { manager } = makeManager({ redeliverPrompt });
    await manager.openSession(task.id);

    // Act
    const delivered = await manager.redeliverInitialPrompt(task.id);

    // Assert
    expect(delivered).toBe(false);
    expect(redeliverPrompt).toHaveBeenCalled();
  });

  it('returns false without calling the backend when the task has no session', async () => {
    // Arrange
    const redeliverPrompt = vi.fn<
      [string, 'primary' | 'secondary', string, string, string?],
      Promise<boolean>
    >(async () => true);
    const task = board.createTask({
      title: 'Never opened',
      repoId: 'repo-1',
      initialPrompt: 'Fix the flaky test.',
    });
    const { manager } = makeManager({ redeliverPrompt });

    // Act
    const delivered = await manager.redeliverInitialPrompt(task.id);

    // Assert
    expect(delivered).toBe(false);
    expect(redeliverPrompt).not.toHaveBeenCalled();
  });

  it('returns false without calling the backend when the task never had a brief', async () => {
    // Arrange
    const redeliverPrompt = vi.fn<
      [string, 'primary' | 'secondary', string, string, string?],
      Promise<boolean>
    >(async () => true);
    const task = board.createTask({ title: 'No brief', repoId: 'repo-1' });
    const { manager } = makeManager({ redeliverPrompt });
    await manager.openSession(task.id);

    // Act
    const delivered = await manager.redeliverInitialPrompt(task.id);

    // Assert
    expect(delivered).toBe(false);
    expect(redeliverPrompt).not.toHaveBeenCalled();
  });

  it('throws when the session backend does not support redelivery', async () => {
    // Arrange
    const task = board.createTask({
      title: 'PTY only',
      repoId: 'repo-1',
      initialPrompt: 'Fix the flaky test.',
    });
    const { manager } = makeManager(); // no redeliverPrompt override — backend lacks it
    await manager.openSession(task.id);

    // Act + Assert
    await expect(manager.redeliverInitialPrompt(task.id)).rejects.toThrow(
      /do not support re-delivering/
    );
  });
});

describe('SessionManager.notifyTaskSession', () => {
  let db: Db;
  let board: BoardService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('repo-1', 'Repo', '/tmp/repo-1', null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  function makeManager(backendOverrides: Partial<SessionBackend> = {}) {
    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: 'session-1',
      taskId: opts.taskId,
      backendType: 'tmux',
      backendSessionId: 'ab_task_1234',
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));

    const backend: SessionBackend = {
      create,
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({ command: '' })),
      sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
      terminate: vi.fn<[string], Promise<void>>(async () => {}),
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
      ...backendOverrides,
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
      backend
    );

    return { manager, backend };
  }

  it('delivers the message via the hardened redeliverPrompt machinery, not raw sendInput', async () => {
    // Arrange
    const redeliverPrompt = vi.fn<
      [string, 'primary' | 'secondary', string, string, string?],
      Promise<boolean>
    >(async () => true);
    const sendInput = vi.fn<[string, string], Promise<void>>(async () => {});
    const task = board.createTask({ title: 'Notify me', repoId: 'repo-1' });
    const { manager } = makeManager({ redeliverPrompt, sendInput });
    await manager.openSession(task.id);

    // Act
    const delivered = await manager.notifyTaskSession(task.id, 'A subtask PR just opened.');

    // Assert — went through redeliverPrompt, and the boolean it resolved
    // flows straight through as this method's own return value.
    expect(delivered).toBe(true);
    expect(redeliverPrompt).toHaveBeenCalledWith(
      task.id,
      'primary',
      'ab_task_1234',
      'A subtask PR just opened.',
      'claude',
    );
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('returns false honestly when the paste never verified, instead of a hardcoded true', async () => {
    // Arrange — the backend actually attempted delivery but the message text
    // never rendered on the pane, so nothing was submitted.
    const redeliverPrompt = vi.fn<
      [string, 'primary' | 'secondary', string, string, string?],
      Promise<boolean>
    >(async () => false);
    const task = board.createTask({ title: 'Notify me', repoId: 'repo-1' });
    const { manager } = makeManager({ redeliverPrompt });
    await manager.openSession(task.id);

    // Act
    const delivered = await manager.notifyTaskSession(task.id, 'A subtask PR just opened.');

    // Assert
    expect(delivered).toBe(false);
    expect(redeliverPrompt).toHaveBeenCalled();
  });

  it('returns false without calling the backend when the task has no live session', async () => {
    // Arrange
    const redeliverPrompt = vi.fn<
      [string, 'primary' | 'secondary', string, string, string?],
      Promise<boolean>
    >(async () => true);
    const task = board.createTask({ title: 'Never opened', repoId: 'repo-1' });
    const { manager } = makeManager({ redeliverPrompt });

    // Act
    const delivered = await manager.notifyTaskSession(task.id, 'A subtask PR just opened.');

    // Assert
    expect(delivered).toBe(false);
    expect(redeliverPrompt).not.toHaveBeenCalled();
  });

  it('throws when the session backend does not support redelivery', async () => {
    // Arrange
    const task = board.createTask({ title: 'PTY only', repoId: 'repo-1' });
    const { manager } = makeManager(); // no redeliverPrompt override — backend lacks it
    await manager.openSession(task.id);

    // Act + Assert
    await expect(
      manager.notifyTaskSession(task.id, 'A subtask PR just opened.')
    ).rejects.toThrow(/do not support notifying/);
  });
});

describe('SessionManager.getFleetStatus', () => {
  let db: Db;
  let board: BoardService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('repo-1', 'Repo', '/tmp/repo-1', null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  function makeManager(backendOverrides: Partial<SessionBackend> = {}) {
    const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
      id: 'session-1',
      taskId: opts.taskId,
      backendType: 'tmux',
      backendSessionId: `ab_${opts.taskId}_p`,
      status: 'active',
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));

    const backend: SessionBackend = {
      create,
      attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async () => ({ command: '' })),
      sendInput: vi.fn<[string, string], Promise<void>>(async () => {}),
      resize: vi.fn<[string, number, number], Promise<void>>(async () => {}),
      list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
      inspect: vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => null),
      terminate: vi.fn<[string], Promise<void>>(async () => {}),
      healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
      ...backendOverrides,
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
      backend
    );

    return { manager, backend };
  }

  it('rolls up title, attention, and trust-prompt state for every live session', async () => {
    // Arrange — the mock backend's inspect() returns null (no info), so
    // sessionStatus reads as 'orphaned' deterministically without needing to
    // fake a process table; this test is about getFleetStatus's own new
    // rollup logic, not activity derivation, which is covered elsewhere.
    const peekPane = vi.fn<[string], Promise<string>>(
      async () => 'Quick safety check\n❯ Yes, I trust this folder'
    );
    const task = board.createTask({ title: 'Stuck on trust', repoId: 'repo-1' });
    const { manager } = makeManager({ peekPane });
    await manager.openSession(task.id);
    // openSession clears attention as a side effect of opening fresh, so it
    // has to be set after — this test is asserting the flag is read
    // correctly, not that opening a session preserves it.
    board.setTaskSessionAttention(task.id);

    // Act
    const fleet = await manager.getFleetStatus();

    // Assert
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({
      taskId: task.id,
      taskTitle: 'Stuck on trust',
      slot: 'primary',
      backendType: 'tmux',
      sessionStatus: 'orphaned',
      isBusy: false,
      attentionNeeded: true,
      trustPromptShowing: true,
    });
    expect(peekPane).toHaveBeenCalledWith(`ab_${task.id}_p`);
  });

  it('reports trustPromptShowing false when the backend has no peekPane support', async () => {
    // Arrange — no peekPane override: the default mock backend lacks it, the
    // same as PTY sessions in production.
    const task = board.createTask({ title: 'Normal session', repoId: 'repo-1' });
    const { manager } = makeManager();
    await manager.openSession(task.id);

    // Act
    const fleet = await manager.getFleetStatus();

    // Assert
    expect(fleet[0]?.trustPromptShowing).toBe(false);
  });

  it('returns an empty list when nothing is live', async () => {
    // Arrange
    board.createTask({ title: 'Never opened', repoId: 'repo-1' });
    const { manager } = makeManager();

    // Act
    const fleet = await manager.getFleetStatus();

    // Assert
    expect(fleet).toEqual([]);
  });
});
