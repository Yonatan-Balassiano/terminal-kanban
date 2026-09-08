import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { PtyBackend } from '../src/services/session-backends/pty.js';
import { localBriefPath } from '../src/services/session-brief.js';
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

/**
 * A pty session's brief now arrives the same way every other backend's does:
 * written to a file whose path rides the bootstrap command, and read from there
 * into the agent CLI's argv by session-bootstrap.sh.
 *
 * This replaces the headless `claude --print` seeding this backend used to do.
 * That existed only because a pty cannot paste into itself, and it was a bad
 * trade: `--print` runs with tool access, so the seed executed the mission
 * rather than merely receiving it, unsupervised, before the interactive pane
 * ever opened.
 */
describe('PtyBackend initial brief', () => {
  it('leaves the brief on disk for the bootstrap script, not in the command line', async () => {
    // Arrange
    const brief = 'Do the thing, please.\n\nWith a second paragraph.';
    const backend = new PtyBackend();

    // Act
    const session = await backend.create(
      baseOpts({ agentSessionId: 'session-uuid-1', initialPrompt: brief }),
    );

    try {
      // Assert — the file the bootstrap script will read holds the brief
      // verbatim. Its contents never travel through the command line, which is
      // what used to truncate briefs past ~4 KB.
      expect(readFileSync(localBriefPath('abc12345', 'primary'), 'utf8')).toBe(brief);
    } finally {
      await backend.terminate(session.backendSessionId);
    }
  });

  it('opens the interactive pty itself, with nothing running ahead of it', async () => {
    // Arrange — the seeded version ran a whole headless agent turn first, so a
    // card could sit with no visible session for minutes. Creation is now just
    // the spawn.
    const backend = new PtyBackend();

    // Act
    const started = Date.now();
    const session = await backend.create(
      baseOpts({ agentSessionId: 'session-uuid-2', initialPrompt: 'Do the thing.' }),
    );

    try {
      // Assert
      expect(session.backendType).toBe('pty');
      expect(session.status).toBe('active');
      expect(await backend.inspect(session.backendSessionId)).not.toBeNull();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await backend.terminate(session.backendSessionId);
    }
  });
});
