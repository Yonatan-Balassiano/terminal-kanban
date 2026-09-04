import { describe, expect, it } from 'vitest';
import { tmpdir } from 'os';
import { PtyBackend, type PtySeedOptions } from '../src/services/session-backends/pty.js';
import type { CreateSessionOpts } from '../src/types/index.js';

function baseOpts(overrides: Partial<CreateSessionOpts> = {}): CreateSessionOpts {
  return {
    taskId: 'abc12345',
    taskTitle: 'Test Task',
    slot: 'primary',
    repoPath: tmpdir(),
    branch: 'ab/test-task-abc1',
    agentCli: 'claude',
    cwd: tmpdir(),
    baseBranch: 'main',
    usesWorktree: false,
    sessionBootstrapScript: '/tmp/nonexistent-bootstrap.sh',
    ...overrides,
  };
}

describe('PtyBackend headless seeding', () => {
  it('seeds via stdin when initialPrompt is set', async () => {
    const calls: PtySeedOptions[] = [];
    const backend = new PtyBackend(undefined, async (opts) => {
      calls.push(opts);
    });

    const session = await backend.create(
      baseOpts({
        agentSessionId: 'session-uuid-1',
        initialPrompt: 'Do the thing, please.',
      })
    );

    try {
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        agentSessionId: 'session-uuid-1',
        cwd: tmpdir(),
        prompt: 'Do the thing, please.',
      });
      expect(session.backendType).toBe('pty');
      expect(session.status).toBe('active');
    } finally {
      await backend.terminate(session.backendSessionId);
    }
  });

  it('skips seeding when initialPrompt is not set', async () => {
    let called = false;
    const backend = new PtyBackend(undefined, async () => {
      called = true;
    });

    const session = await backend.create(
      baseOpts({
        agentSessionId: 'session-uuid-2',
        // No initialPrompt.
      })
    );

    try {
      expect(called).toBe(false);
    } finally {
      await backend.terminate(session.backendSessionId);
    }
  });

  it('still opens the interactive pty even if the headless seed fails', async () => {
    const backend = new PtyBackend(undefined, async () => {
      throw new Error('claude --print seed exited with code 1');
    });

    const session = await backend.create(
      baseOpts({
        agentSessionId: 'session-uuid-3',
        initialPrompt: 'Do the thing, please.',
      })
    );

    try {
      expect(session.backendType).toBe('pty');
      expect(session.status).toBe('active');
      const listed = await backend.list();
      expect(listed.some((s) => s.backendSessionId === session.backendSessionId)).toBe(true);
    } finally {
      await backend.terminate(session.backendSessionId);
    }
  });
});
