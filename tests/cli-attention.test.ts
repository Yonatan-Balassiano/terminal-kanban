import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '../src/types/index.js';

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

function stubRpc(items: AttentionItem[]) {
  const call = vi.fn(async (method: string) => {
    if (method === 'getAttentionItems') return { items };
    throw new Error(`unexpected RPC: ${method}`);
  });
  const disconnect = vi.fn();
  mocks.createRPCClient.mockResolvedValue({ call, disconnect });
  return { call, disconnect };
}

function run(...args: string[]): Promise<unknown> {
  return buildCli().parseAsync(['node', 'agentboard', 'attention', ...args]);
}

describe('agentboard attention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRunning.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();
  });

  it('prints a table with one row per card and its reason', async () => {
    // Arrange
    stubRpc([
      { taskId: 'task-1', taskTitle: 'Editorial gate', reason: 'finished, waiting on you' },
      { taskId: 'task-2', taskTitle: 'BO image gallery', reason: 'delivery unsubmitted' },
    ]);

    // Act
    await run();

    // Assert
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('Editorial gate');
    expect(printed).toContain('finished, waiting on you');
    expect(printed).toContain('BO image gallery');
    expect(printed).toContain('delivery unsubmitted');
    expect(printed).toContain('2 card(s) need you.');
  });

  it('prints a plain message rather than an empty table when nothing needs attention', async () => {
    // Arrange
    stubRpc([]);

    // Act
    await run();

    // Assert
    expect(logSpy).toHaveBeenCalledWith('Nothing needs you right now.');
  });

  it('outputs raw JSON with --json', async () => {
    // Arrange
    const items: AttentionItem[] = [
      { taskId: 'task-1', taskTitle: 'Editorial gate', reason: 'finished, waiting on you' },
    ];
    stubRpc(items);

    // Act
    await run('--json');

    // Assert
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(items, null, 2));
  });

  it('disconnects the RPC client after printing', async () => {
    // Arrange
    const { disconnect } = stubRpc([]);

    // Act
    await run();

    // Assert
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
