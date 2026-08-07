import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { SessionManager } from '../src/services/session-manager.js';
import { buildBackendSessionName } from '../src/services/session-name.js';
import type { RemoteHostProvider } from '../src/services/remote/index.js';
import {
  TransportRegistry,
  TransportUnreachableError,
  type SshTransport,
  type TransportReachability,
} from '../src/services/transport/index.js';
import type { TaskWorkspaceInfo } from '../src/services/worktree.js';
import type {
  AttachMetadata,
  BackendHealth,
  BackendSessionInfo,
  CreateSessionOpts,
  GetBufferResult,
  RemoteWorkspaceStatus,
  SessionBackend,
  SessionRecord,
} from '../src/types/index.js';

const REMOTE_HOST = 'main.box.owner.coder';

interface FakeBackendOptions {
  /** Null models a remote tmux session that is gone. */
  inspectResult: BackendSessionInfo | null;
  inspectError?: Error;
}

function makeBackend({ inspectResult, inspectError }: FakeBackendOptions) {
  const create = vi.fn<[CreateSessionOpts], Promise<SessionRecord>>(async (opts) => ({
    id: `session-${opts.taskId}`,
    taskId: opts.taskId,
    slot: opts.slot,
    backendType: 'ssh',
    backendSessionId: buildBackendSessionName(opts.taskTitle, opts.taskId, opts.slot),
    attachCommand: 'tmux attach',
    status: 'active',
    cwd: opts.cwd ?? opts.repoPath,
    branch: opts.branch,
    createdAt: 1,
    updatedAt: 1,
  }));

  const inspect = vi.fn<[string], Promise<BackendSessionInfo | null>>(async () => {
    if (inspectError) {
      throw inspectError;
    }
    return inspectResult;
  });

  const resetAttachment = vi.fn<[string], Promise<void>>(async () => {});

  const backend: SessionBackend = {
    create,
    attachMetadata: vi.fn<[string], Promise<AttachMetadata>>(async (id) => ({
      command: `tmux attach -t ${id}`,
    })),
    sendInput: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    list: vi.fn<[], Promise<BackendSessionInfo[]>>(async () => []),
    inspect,
    terminate: vi.fn(async () => {}),
    healthCheck: vi.fn<[], Promise<BackendHealth>>(async () => ({ available: true })),
    resetAttachment,
  };

  return { backend, create, inspect, resetAttachment };
}

/** A registry whose remote side is a stub, so no SSH is ever attempted. */
class FakeTransportRegistry extends TransportRegistry {
  resetRemoteCalls = 0;
  ensureMasterCalls = 0;

  constructor(private remoteReachability: TransportReachability = 'ok') {
    super({ sshHost: REMOTE_HOST });
  }

  override async resetRemote(): Promise<void> {
    this.resetRemoteCalls += 1;
  }

  override getRemote(): SshTransport {
    return {
      host: REMOTE_HOST,
      ensureMaster: async () => {
        this.ensureMasterCalls += 1;
      },
      reachability: async () => this.remoteReachability,
    } as unknown as SshTransport;
  }
}

function makeProvider(status: RemoteWorkspaceStatus, runningAfterStart = true) {
  const start = vi.fn<[], Promise<void>>(async () => {});
  const waitUntilRunning = vi.fn<[], Promise<boolean>>(async () => runningAfterStart);
  const provider: RemoteHostProvider = {
    label: 'owner/box',
    status: vi.fn<[], Promise<RemoteWorkspaceStatus>>(async () => status),
    start,
    waitUntilRunning,
  };
  return { provider, start, waitUntilRunning };
}

class TestSessionManager extends SessionManager {
  constructor(
    db: Db,
    board: BoardService,
    private backend: SessionBackend,
    transports: TransportRegistry,
    provider: RemoteHostProvider | null
  ) {
    super(
      db,
      board,
      {
        prepareTaskWorkspace(taskId: string): TaskWorkspaceInfo {
          return { taskId, path: '/remote/repo', repoPath: '/remote/repo', usedWorktree: false };
        },
      } as never,
      {
        write() {},
        has: () => false,
        getBuffer: (): GetBufferResult => ({ lines: [], ansiLines: [], cursorX: 0, cursorY: 0 }),
        subscribeAll: () => () => {},
        destroy() {},
      } as never,
      undefined,
      '',
      'tmux',
      transports,
      'default',
      {},
      provider
    );
  }

  protected override getBackend(): SessionBackend {
    return this.backend;
  }
}

describe('SessionManager.reconnectSession', () => {
  let db: Db;
  let board: BoardService;

  function createRemoteTask(title: string): string {
    const task = board.createTask({ title, repoId: 'repo-1' });
    db.prepare(`UPDATE tasks SET location = 'remote' WHERE id = ?`).run(task.id);
    return task.id;
  }

  /** A card that has already been opened once, which is what reconnect repairs. */
  function linkSessionRow(taskId: string, backendSessionId: string, id = 'live-1'): void {
    db.prepare(
      `INSERT INTO sessions
         (id, task_id, slot, backend_type, backend_session_id, attach_command,
          status, cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, 'primary', 'ssh', ?, ?, 'active', ?, ?, ?, ?, ?)`
    ).run(id, taskId, backendSessionId, 'tmux attach', '/remote/repo', 'ab/x', 1, 1, 1);
    db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run(id, taskId);
  }

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, remote_path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('repo-1', 'Repo', '/local/repo', '/remote/repo', null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  it('reattaches to a remote session that is still running instead of creating one', async () => {
    const taskId = createRemoteTask('Rate limit service');
    const backendSessionId = buildBackendSessionName('Rate limit service', taskId, 'primary');
    linkSessionRow(taskId, backendSessionId);
    const { backend, create } = makeBackend({
      inspectResult: { backendSessionId, status: 'active' },
    });
    const transports = new FakeTransportRegistry();
    const manager = new TestSessionManager(db, board, backend, transports, null);

    const result = await manager.reconnectSession(taskId);

    expect(result.state).toBe('attached');
    expect(result.session?.backendSessionId).toBe(backendSessionId);
    expect(create).not.toHaveBeenCalled();
    // The dead ControlMaster has to go before anything probes the host.
    expect(transports.resetRemoteCalls).toBe(1);
  });

  it('clears the local plumbing before reopening, so a dead wrapper cannot block revival', async () => {
    const taskId = createRemoteTask('Stale wrapper');
    const backendSessionId = buildBackendSessionName('Stale wrapper', taskId, 'primary');
    linkSessionRow(taskId, backendSessionId);
    const { backend, resetAttachment } = makeBackend({
      inspectResult: { backendSessionId, status: 'active' },
    });
    const manager = new TestSessionManager(db, board, backend, new FakeTransportRegistry(), null);

    await manager.reconnectSession(taskId);

    expect(resetAttachment).toHaveBeenCalledWith(backendSessionId);
  });

  it('does not clear the local plumbing when the host cannot be reached', async () => {
    const taskId = createRemoteTask('Still offline');
    const backendSessionId = buildBackendSessionName('Still offline', taskId, 'primary');
    linkSessionRow(taskId, backendSessionId);
    const { backend, resetAttachment } = makeBackend({
      inspectResult: { backendSessionId, status: 'active' },
    });
    const manager = new TestSessionManager(
      db,
      board,
      backend,
      new FakeTransportRegistry('unreachable'),
      null
    );

    await manager.reconnectSession(taskId);

    // Tearing the wrapper down while the host is unreachable would strand the
    // card with no plumbing and nothing able to rebuild it.
    expect(resetAttachment).not.toHaveBeenCalled();
  });

  it('rebuilds the local wrapper on every reattach, not only when it is missing', async () => {
    const taskId = createRemoteTask('Wrapper rebuild');
    const backendSessionId = buildBackendSessionName('Wrapper rebuild', taskId, 'primary');
    linkSessionRow(taskId, backendSessionId);
    const { backend } = makeBackend({ inspectResult: { backendSessionId, status: 'active' } });
    const manager = new TestSessionManager(db, board, backend, new FakeTransportRegistry(), null);

    await manager.reconnectSession(taskId);

    // attachMetadata is where the ssh backend rebuilds the wrapper pane a dropped
    // connection destroyed; skipping it would leave the card unattachable.
    expect(backend.attachMetadata).toHaveBeenCalledWith(backendSessionId);
  });

  it('starts a fresh session when the host is up but its session is gone', async () => {
    const taskId = createRemoteTask('Prompt manager');
    const { backend, create } = makeBackend({ inspectResult: null });
    const manager = new TestSessionManager(db, board, backend, new FakeTransportRegistry(), null);

    const result = await manager.reconnectSession(taskId);

    expect(result.state).toBe('recreated');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('answers immediately and starts the workspace in the background when it is off', async () => {
    const taskId = createRemoteTask('Sleepy box');
    const backendSessionId = buildBackendSessionName('Sleepy box', taskId, 'primary');
    const { backend } = makeBackend({ inspectResult: { backendSessionId, status: 'active' } });
    const { provider, start, waitUntilRunning } = makeProvider('stopped');
    const manager = new TestSessionManager(
      db,
      board,
      backend,
      new FakeTransportRegistry(),
      provider
    );

    const settled = new Promise<void>((resolve) => {
      manager.onSessionsChanged = resolve;
    });

    const result = await manager.reconnectSession(taskId);

    expect(result.state).toBe('starting');
    expect(result.session).toBeUndefined();

    await settled;
    expect(start).toHaveBeenCalledTimes(1);
    expect(waitUntilRunning).toHaveBeenCalledTimes(1);
  });

  it('waits on a workspace that is already starting without starting it again', async () => {
    const taskId = createRemoteTask('Already waking');
    const { backend } = makeBackend({ inspectResult: null });
    const { provider, start, waitUntilRunning } = makeProvider('starting');
    const manager = new TestSessionManager(
      db,
      board,
      backend,
      new FakeTransportRegistry(),
      provider
    );

    const settled = new Promise<void>((resolve) => {
      manager.onSessionsChanged = resolve;
    });

    const result = await manager.reconnectSession(taskId);

    expect(result.state).toBe('starting');
    await settled;
    expect(start).not.toHaveBeenCalled();
    expect(waitUntilRunning).toHaveBeenCalledTimes(1);
  });

  it('reports a failed workspace rather than attempting to connect', async () => {
    const taskId = createRemoteTask('Broken build');
    const { backend, inspect } = makeBackend({ inspectResult: null });
    const { provider } = makeProvider('failed');
    const manager = new TestSessionManager(
      db,
      board,
      backend,
      new FakeTransportRegistry(),
      provider
    );

    const result = await manager.reconnectSession(taskId);

    expect(result.state).toBe('unreachable');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('reports an unreachable host without discarding the session row', async () => {
    const taskId = createRemoteTask('Vpn is down');
    const backendSessionId = buildBackendSessionName('Vpn is down', taskId, 'primary');
    const { backend, create } = makeBackend({
      inspectResult: { backendSessionId, status: 'active' },
    });
    const manager = new TestSessionManager(
      db,
      board,
      backend,
      new FakeTransportRegistry('unreachable'),
      null
    );

    const result = await manager.reconnectSession(taskId);

    expect(result.state).toBe('unreachable');
    expect(result.message).toContain(REMOTE_HOST);
    expect(create).not.toHaveBeenCalled();
  });

  it('surfaces an unreachable host discovered mid-inspect', async () => {
    const taskId = createRemoteTask('Drops mid probe');
    const { backend, create } = makeBackend({
      inspectResult: null,
      inspectError: new TransportUnreachableError(`ssh ${REMOTE_HOST} timed out`),
    });
    const manager = new TestSessionManager(db, board, backend, new FakeTransportRegistry(), null);

    const result = await manager.reconnectSession(taskId);

    expect(result.state).toBe('unreachable');
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to reconnect a local task', async () => {
    const task = board.createTask({ title: 'Local work', repoId: 'repo-1' });
    const { backend } = makeBackend({ inspectResult: null });
    const manager = new TestSessionManager(db, board, backend, new FakeTransportRegistry(), null);

    await expect(manager.reconnectSession(task.id)).rejects.toThrow(/remote tasks only/i);
  });
});

describe('SessionManager session adoption', () => {
  let db: Db;
  let board: BoardService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, remote_path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('repo-1', 'Repo', '/local/repo', '/remote/repo', null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  function insertOrphanedRow(taskId: string, backendSessionId: string, id = 'orphan-1'): void {
    db.prepare(
      `INSERT INTO sessions
         (id, task_id, slot, backend_type, backend_session_id, attach_command,
          status, cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, 'primary', 'ssh', ?, ?, 'orphaned', ?, ?, ?, ?, ?)`
    ).run(id, taskId, backendSessionId, 'tmux attach', '/remote/repo', 'ab/x', 1, 1, 1);
  }

  it('revives an orphaned row whose backend session is still alive', async () => {
    const task = board.createTask({ title: 'Lost link', repoId: 'repo-1' });
    db.prepare(`UPDATE tasks SET location = 'remote', session_id = NULL WHERE id = ?`).run(task.id);
    const backendSessionId = buildBackendSessionName('Lost link', task.id, 'primary');
    insertOrphanedRow(task.id, backendSessionId);

    const { backend, create } = makeBackend({
      inspectResult: { backendSessionId, status: 'active' },
    });
    const manager = new TestSessionManager(db, board, backend, new FakeTransportRegistry(), null);

    const session = await manager.openSession(task.id);

    expect(session.id).toBe('orphan-1');
    expect(create).not.toHaveBeenCalled();
    const rows = db
      .prepare<[string], { count: number }>('SELECT COUNT(*) as count FROM sessions WHERE task_id = ?')
      .get(task.id);
    expect(rows?.count).toBe(1);
  });

  it('creates a new session when the orphaned row points at a dead backend session', async () => {
    const task = board.createTask({ title: 'Really gone', repoId: 'repo-1' });
    db.prepare(`UPDATE tasks SET location = 'remote', session_id = NULL WHERE id = ?`).run(task.id);
    insertOrphanedRow(task.id, buildBackendSessionName('Really gone', task.id, 'primary'));

    const { backend, create } = makeBackend({ inspectResult: null });
    const manager = new TestSessionManager(db, board, backend, new FakeTransportRegistry(), null);

    await manager.openSession(task.id);

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('collapses orphaned twins that share a live row backend session on reconcile', async () => {
    const task = board.createTask({ title: 'Twin rows', repoId: 'repo-1' });
    db.prepare(`UPDATE tasks SET location = 'remote' WHERE id = ?`).run(task.id);
    const backendSessionId = buildBackendSessionName('Twin rows', task.id, 'primary');

    insertOrphanedRow(task.id, backendSessionId, 'orphan-1');
    db.prepare(
      `INSERT INTO sessions
         (id, task_id, slot, backend_type, backend_session_id, attach_command,
          status, cwd, branch, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, 'primary', 'ssh', ?, ?, 'active', ?, ?, ?, ?, ?)`
    ).run('live-1', task.id, backendSessionId, 'tmux attach', '/remote/repo', 'ab/x', 1, 1, 1);
    db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run('live-1', task.id);

    const { backend } = makeBackend({ inspectResult: { backendSessionId, status: 'active' } });
    const manager = new TestSessionManager(db, board, backend, new FakeTransportRegistry(), null);

    await manager.reconcile();

    const remaining = db
      .prepare<[string], { id: string }>('SELECT id FROM sessions WHERE task_id = ?')
      .all(task.id);
    expect(remaining.map((row) => row.id)).toEqual(['live-1']);
  });
});
