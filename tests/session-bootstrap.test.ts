import { describe, expect, it } from 'vitest';
import { buildNewSessionBootstrapCommand } from '../src/services/session-bootstrap.js';

describe('buildNewSessionBootstrapCommand', () => {
  it('runs the configured bootstrap script with claude task context', () => {
    expect(
      buildNewSessionBootstrapCommand({
        repoPath: '/repo',
        branch: 'ab/task-1234',
        agentCli: 'claude',
        sessionBootstrapScript: '/scripts/session-bootstrap.sh',
      })
    ).toBe(
      'AGENTBOARD_TASK_KIND="repo" ' +
        'AGENTBOARD_REPO_PATH="/repo" ' +
        'AGENTBOARD_TASK_BRANCH="ab/task-1234" ' +
        'AGENTBOARD_BASE_BRANCH="main" ' +
        'AGENTBOARD_SESSION_CWD="/repo" ' +
        'AGENTBOARD_AGENT="claude" ' +
        'AGENTBOARD_USES_WORKTREE="0" ' +
        'AGENTBOARD_BOOTSTRAP_NOTICE="" ' +
        'AGENTBOARD_AGENT_ARGS="" ' +
        '"/scripts/session-bootstrap.sh"'
    );
  });

  it('passes codex agent selection and bootstrap notice through to the script', () => {
    expect(
      buildNewSessionBootstrapCommand({
        repoPath: '/repo',
        branch: 'ab/task-1234',
        baseBranch: 'master',
        agentCli: 'codex',
        usesWorktree: true,
        cwd: '/repo/worktree',
        bootstrapNotice: 'Git command failed: git worktree add',
        sessionBootstrapScript: '/scripts/session-bootstrap.sh',
      })
    ).toBe(
      'AGENTBOARD_TASK_KIND="repo" ' +
        'AGENTBOARD_REPO_PATH="/repo" ' +
        'AGENTBOARD_TASK_BRANCH="ab/task-1234" ' +
        'AGENTBOARD_BASE_BRANCH="master" ' +
        'AGENTBOARD_SESSION_CWD="/repo/worktree" ' +
        'AGENTBOARD_AGENT="codex" ' +
        'AGENTBOARD_USES_WORKTREE="1" ' +
        'AGENTBOARD_BOOTSTRAP_NOTICE="Git command failed: git worktree add" ' +
        'AGENTBOARD_AGENT_ARGS="" ' +
        '"/scripts/session-bootstrap.sh"'
    );
  });
});
