import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRecord } from '../src/types/index.js';

const mocks = vi.hoisted(() => ({
  ensureRunning: vi.fn(),
  createRPCClient: vi.fn(),
  readPidFile: vi.fn(),
}));

vi.mock('../src/daemon/index.js', () => ({
  ensureRunning: mocks.ensureRunning,
  readPidFile: mocks.readPidFile,
}));

vi.mock('../src/cli/rpc.js', () => ({
  createRPCClient: mocks.createRPCClient,
}));

import { buildCli } from '../src/cli/index.js';

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
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRunning.mockResolvedValue(undefined);
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
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(repo, null, 2));
  });
});
