import { execFile } from 'child_process';
import * as fs from 'fs';
import type * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../src/daemon/index.js';
import {
  handleRemoteRequest,
  isCallerOrDescendant,
  RemoteCallerTokens,
  restrictRemoteRequest,
  startRemoteRpcServer,
} from '../src/daemon/remote-rpc.js';

const execFileAsync = promisify(execFile);
const CLI = path.join(process.cwd(), 'scripts', 'agentboard-remote.py');

/** parent → child → grandchild, plus an unrelated card. */
const TASKS: Record<string, { id: string; parentTaskId?: string }> = {
  parent: { id: 'parent' },
  child: { id: 'child', parentTaskId: 'parent' },
  grandchild: { id: 'grandchild', parentTaskId: 'child' },
  other: { id: 'other' },
};
const board = { getTask: (id: string) => TASKS[id] ?? null };

function makeServices() {
  const created: Record<string, { id: string; parentTaskId?: string }> = {};
  return {
    dbPath: '/db',
    board: {
      getTask: (id: string) => created[id] ?? board.getTask(id),
      createTask: vi.fn((params: Record<string, unknown>) => {
        const task = {
          id: 'new1',
          title: params['title'],
          agentCli: 'claude',
          location: params['location'],
          parentTaskId: params['parentTaskId'] as string | undefined,
          repoId: params['repoId'],
        };
        created[task.id] = task;
        return task;
      }),
    },
    view: {
      getBoardSnapshot: () => ({
        tasks: [
          { id: 'parent', title: 'Parent', trackId: 'in-progress', prState: 'none', ciState: 'none', kind: 'repo', repoId: 'r1', branches: [] },
          { id: 'other', title: 'Other', trackId: 'backlog', prState: 'none', ciState: 'none', kind: 'repo', repoId: 'r1', branches: [] },
        ],
        repos: [{ id: 'r1', label: 'kanban', remotePath: '/home/coder/kanban', githubOwner: 'acme', githubRepo: 'kanban' }],
        tracks: [{ id: 'backlog' }, { id: 'in-progress' }],
        pillars: [],
      }),
    },
    session: {
      notifyTaskSession: vi.fn(async () => ({ delivered: true, queued: false })),
      openSession: vi.fn(async () => ({ id: 's1' })),
      getFleetStatus: vi.fn(async () => []),
    },
    taskLifecycle: { deleteTask: vi.fn() },
  } as unknown as ServiceContainer;
}

describe('RemoteCallerTokens', () => {
  const tokens = new RemoteCallerTokens(Buffer.alloc(32, 7));

  it('verifies a token back to the card it was minted for', () => {
    expect(tokens.verify(tokens.mint('parent'))).toBe('parent');
  });

  it('refuses a token re-pointed at another card, a forgery and junk', () => {
    const signature = tokens.mint('parent').split('.')[1];
    expect(tokens.verify(`other.${signature}`)).toBeNull();
    expect(tokens.verify(new RemoteCallerTokens(Buffer.alloc(32, 8)).mint('parent'))).toBeNull();
    expect(tokens.verify('parent')).toBeNull();
    expect(tokens.verify(undefined)).toBeNull();
  });

  it('keeps verifying across a daemon restart, from the same secret file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-tokens-'));
    try {
      const minted = RemoteCallerTokens.loadOrCreate(dir).mint('parent');
      expect(RemoteCallerTokens.loadOrCreate(dir).verify(minted)).toBe('parent');
      expect(fs.statSync(path.join(dir, 'remote-cli-secret')).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('restrictRemoteRequest', () => {
  it('walks the family downwards only', () => {
    expect(isCallerOrDescendant(board, 'parent', 'grandchild')).toBe(true);
    expect(isCallerOrDescendant(board, 'child', 'parent')).toBe(false);
    expect(isCallerOrDescendant(board, 'parent', 'other')).toBe(false);
  });

  it('always sends a message as the caller', () => {
    const req = restrictRemoteRequest(
      { id: '1', method: 'notifyTaskSession', params: { taskId: 'other', message: 'hi', fromTaskId: 'other' } },
      'parent',
      board,
    );
    expect(req.params).toMatchObject({ taskId: 'other', fromTaskId: 'parent' });
  });

  it('creates a subtask under the caller by default, and never under someone else', () => {
    const req = restrictRemoteRequest({ id: '1', method: 'createTask', params: { title: 't' } }, 'parent', board);
    expect(req.params).toMatchObject({ parentTaskId: 'parent' });
    expect(() =>
      restrictRemoteRequest({ id: '1', method: 'createTask', params: { parentTaskId: 'other' } }, 'parent', board),
    ).toThrow(/only create subtasks under itself or its own subtasks/);
  });

  it('opens sessions and attaches PRs only within the caller family', () => {
    expect(() =>
      restrictRemoteRequest({ id: '1', method: 'openSession', params: { taskId: 'grandchild' } }, 'parent', board),
    ).not.toThrow();
    expect(() =>
      restrictRemoteRequest({ id: '1', method: 'openSession', params: { taskId: 'other' } }, 'parent', board),
    ).toThrow();
    expect(() =>
      restrictRemoteRequest({ id: '1', method: 'addTaskBranch', params: { taskId: 'other', prNumber: 1 } }, 'parent', board),
    ).toThrow();
  });
});

describe('handleRemoteRequest', () => {
  const tokens = new RemoteCallerTokens(Buffer.alloc(32, 7));

  it('refuses a method outside the remote surface, token or not', async () => {
    const services = makeServices();
    const response = await handleRemoteRequest(
      JSON.stringify({ id: '1', method: 'deleteTask', params: { id: 'other' }, token: tokens.mint('parent') }),
      services,
      tokens,
      '/main.sock',
    );
    expect(response.error?.message).toMatch(/not available to a remote card/);
    expect(services.taskLifecycle.deleteTask).not.toHaveBeenCalled();
  });

  it('refuses a call without a valid token, and answers daemonStatus without one', async () => {
    const services = makeServices();
    const denied = await handleRemoteRequest(
      JSON.stringify({ id: '1', method: 'getBoard', token: 'parent.bogus' }),
      services,
      tokens,
      '/main.sock',
    );
    expect(denied.error?.message).toMatch(/Not authorized/);

    const status = await handleRemoteRequest(JSON.stringify({ id: '2', method: 'daemonStatus' }), services, tokens, '/main.sock');
    expect(status.result).toMatchObject({ pid: process.pid });
  });

  it('refuses the token of a card that has since been deleted', async () => {
    const response = await handleRemoteRequest(
      JSON.stringify({ id: '1', method: 'getBoard', token: tokens.mint('gone') }),
      makeServices(),
      tokens,
      '/main.sock',
    );
    expect(response.error?.message).toMatch(/Not authorized/);
  });
});

describe('the remote CLI against a real remote socket', () => {
  const tokens = new RemoteCallerTokens(Buffer.alloc(32, 7));
  let dir: string;
  let socketPath: string;
  let server: net.Server;
  let services: ServiceContainer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-rrpc-'));
    socketPath = path.join(dir, 'run', 'rpc.sock');
    services = makeServices();
    server = startRemoteRpcServer({ socketPath, mainSocketPath: '/main.sock', services, tokens });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function cli(args: string[], env: Record<string, string> = {}, cwd = dir) {
    return execFileAsync('python3', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: dir, AGENTBOARD_REMOTE_SOCKET: socketPath, ...env },
    });
  }

  it('listens in a directory only this user can enter', () => {
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
  });

  it('lists the board as the card whose token it carries', async () => {
    const { stdout } = await cli(['ls'], { AGENTBOARD_RPC_TOKEN: tokens.mint('parent') });
    expect(stdout).toContain('parent');
    expect(stdout).toContain('Other');
  });

  it('finds the token in the worktree when the environment lost it', async () => {
    // A sandboxed Bash call that did not inherit the session's environment.
    const nested = path.join(dir, 'wt', 'src');
    fs.mkdirSync(path.join(dir, 'wt', '.agentboard'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(dir, 'wt', '.agentboard', 'rpc-token'), tokens.mint('parent'));

    const { stdout } = await cli(['ping'], {}, nested);
    expect(stdout).toMatch(/^ok pid=\d+ card=parent/);
  });

  it('creates a subtask linked under the calling card, and starts it', async () => {
    const { stdout } = await cli(['task', 'create', 'Follow-up', '--repo', 'kanban', '--description', 'do it', '--start'], {
      AGENTBOARD_RPC_TOKEN: tokens.mint('parent'),
    });
    expect(services.board.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Follow-up', parentTaskId: 'parent', location: 'remote', initialPrompt: 'do it' }),
    );
    expect(services.session.openSession).toHaveBeenCalledWith('new1', undefined);
    expect(stdout).toContain('subtask of parent');
  });

  it('cannot send a message as another card, whatever the environment claims', async () => {
    await cli(['task', 'notify', 'other', 'hello'], {
      AGENTBOARD_RPC_TOKEN: tokens.mint('parent'),
      AGENTBOARD_TASK_ID: 'other',
    });
    expect(services.session.notifyTaskSession).toHaveBeenCalledWith('other', 'hello', undefined, {
      fromTaskId: 'parent',
    });
  });

  it('fails clearly with no token', async () => {
    await expect(cli(['ls'])).rejects.toMatchObject({ stderr: expect.stringContaining('No AgentBoard card token') });
  });

  it('turns away commands that only exist on the Mac', async () => {
    await expect(cli(['task', 'delete', 'other'], { AGENTBOARD_RPC_TOKEN: tokens.mint('parent') })).rejects.toMatchObject({
      code: 2,
    });
  });
});
