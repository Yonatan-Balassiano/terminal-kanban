import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetSessionStatus } from '../src/types/index.js';

const mocks = vi.hoisted(() => ({
  ensureRunning: vi.fn(),
  isDaemonRunning: vi.fn(),
  stopDaemon: vi.fn(),
  readPidFile: vi.fn(),
  createRPCClient: vi.fn(),
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
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

class ExitError extends Error {}
const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new ExitError(`exit ${code}`);
}) as never);

function makeSession(patch: Partial<FleetSessionStatus> = {}): FleetSessionStatus {
  return {
    taskId: 'task-1',
    taskTitle: 'Some card',
    slot: 'primary',
    backendType: 'tmux',
    sessionStatus: 'active',
    isBusy: true,
    attentionNeeded: false,
    trustPromptShowing: false,
    createdAt: Date.now() - 60_000,
    ...patch,
  };
}

function stubRpc(sessions: FleetSessionStatus[]) {
  const call = vi.fn(async (method: string) => {
    if (method === 'getFleetStatus') return { sessions };
    throw new Error(`unexpected RPC: ${method}`);
  });
  const disconnect = vi.fn();
  mocks.createRPCClient.mockResolvedValue({ call, disconnect });
  return { call, disconnect };
}

function run(...args: string[]): Promise<unknown> {
  return buildCli().parseAsync(['node', 'agentboard', 'fleet', ...args]);
}

describe('agentboard fleet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRunning.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();
  });

  it('prints a table naming every live session and its state', async () => {
    // Arrange
    stubRpc([makeSession({ taskId: 'task-1', taskTitle: 'Add rate limiting' })]);

    // Act
    await run();

    // Assert
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('task-1');
    expect(output).toContain('Add rate limiting');
  });

  it('calls out sessions stuck on the trust prompt', async () => {
    // Arrange
    stubRpc([
      makeSession({ taskId: 'task-1', taskTitle: 'Stuck one', trustPromptShowing: true, isBusy: false }),
    ]);

    // Act
    await run();

    // Assert
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('STUCK');
    expect(output).toContain('stuck on the trust prompt');
  });

  it('reports when nothing is live', async () => {
    // Arrange
    stubRpc([]);

    // Act
    await run();

    // Assert
    expect(logSpy).toHaveBeenCalledWith('No live sessions.');
  });

  it('supports --json', async () => {
    // Arrange
    const sessions = [makeSession()];
    stubRpc(sessions);

    // Act
    await run('--json');

    // Assert
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(sessions, null, 2));
  });
});
