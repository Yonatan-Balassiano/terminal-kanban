import { describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildNewSessionBootstrapCommand,
  type SessionWorkspaceEntry,
} from '../src/services/session-bootstrap.js';

const execFileAsync = promisify(execFile);
const BOOTSTRAP = join(process.cwd(), 'scripts', 'session-bootstrap.sh');

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
        'AGENTBOARD_WORKSPACES="" ' +
        'AGENTBOARD_AGENT_SESSION_ID="" ' +
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
        'AGENTBOARD_WORKSPACES="" ' +
        'AGENTBOARD_AGENT_SESSION_ID="" ' +
        '"/scripts/session-bootstrap.sh"'
    );
  });
});

describe('workspace map encoding', () => {
  const twoWorkspaces: SessionWorkspaceEntry[] = [
    { label: 'monorepo', branch: 'ab/api-0001', path: '/w/api' },
    { label: 'sdk', branch: 'ab/sdk-0002', path: '/w/sdk' },
  ];

  function commandWith(workspaces: readonly SessionWorkspaceEntry[]): string {
    return buildNewSessionBootstrapCommand({
      repoPath: '/repo',
      branch: 'ab/api-0001',
      agentCli: 'claude',
      sessionBootstrapScript: '/s.sh',
      workspaces,
    });
  }

  it('packs every workspace into one env var as tab columns and newline rows', () => {
    // Act
    const command = commandWith(twoWorkspaces);

    // Assert — JSON.stringify is the only escaping involved, so the separators
    // arrive as \t and \n escape sequences rather than raw control characters.
    expect(command).toContain(
      'AGENTBOARD_WORKSPACES="monorepo\\tab/api-0001\\t/w/api\\nsdk\\tab/sdk-0002\\t/w/sdk"'
    );
  });

  it('never emits a raw tab or newline that would break the command line', () => {
    // Arrange — a raw separator would split the env assignment into a new word
    // or a new command, so this is the bug the escaping exists to prevent.
    const command = commandWith(twoWorkspaces);

    // Assert
    expect(command).not.toMatch(/[\t\n]/);
  });

  it('leaves the workspace var empty when the caller resolved no map', () => {
    // Arrange + Act — undefined means "not resolved", not "the card owns none".
    const command = buildNewSessionBootstrapCommand({
      repoPath: '/repo',
      branch: 'ab/api-0001',
      agentCli: 'claude',
      sessionBootstrapScript: '/s.sh',
    });

    // Assert
    expect(command).toContain('AGENTBOARD_WORKSPACES=""');
  });
});

describe('session-bootstrap.sh workspace banner', () => {
  /**
   * Runs the real command line the daemon would emit, through a real shell, with
   * a fake agent on PATH. This is what proves the round trip: nothing but
   * JSON.stringify escapes the map on the way out, and nothing but `printf %b`
   * decodes it on the way in.
   */
  async function runBootstrap(workspaces?: readonly SessionWorkspaceEntry[]): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-workspaces-'));
    try {
      const fake = join(dir, 'claude');
      writeFileSync(fake, '#!/bin/bash\necho AGENT_STARTED\n');
      chmodSync(fake, 0o755);

      const command = buildNewSessionBootstrapCommand({
        repoPath: dir,
        branch: 'ab/api-0001',
        agentCli: 'claude',
        usesWorktree: true,
        cwd: dir,
        sessionBootstrapScript: BOOTSTRAP,
        ...(workspaces ? { workspaces } : {}),
      });

      const { stdout } = await execFileAsync('bash', ['-c', command], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
      });
      return stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('prints every workspace row and still launches the agent', async () => {
    // Act
    const stdout = await runBootstrap([
      { label: 'monorepo', branch: 'ab/api-0001', path: '/w/api' },
      { label: 'sdk', branch: 'ab/sdk-0002', path: '/w/sdk' },
      { label: 'infra', branch: 'ab/infra-0003', path: '/w/infra' },
    ]);

    // Assert — every row, and the agent still starts after the banner.
    expect(stdout).toContain('monorepo');
    expect(stdout).toContain('/w/api');
    expect(stdout).toContain('sdk');
    expect(stdout).toContain('/w/sdk');
    expect(stdout).toContain('infra');
    expect(stdout).toContain('/w/infra');
    expect(stdout).toContain('AGENT_STARTED');
  });

  it('keeps each row on its own line so the columns stay readable', async () => {
    // Arrange — a row separator that survived as a literal "\n" would collapse
    // the whole map onto one line.
    const stdout = await runBootstrap([
      { label: 'monorepo', branch: 'ab/api-0001', path: '/w/api' },
      { label: 'sdk', branch: 'ab/sdk-0002', path: '/w/sdk' },
    ]);

    // Assert
    const rowLines = stdout.split('\n').filter((line) => line.includes('/w/'));
    expect(rowLines).toHaveLength(2);
    expect(stdout).not.toContain('\\t');
    expect(stdout).not.toContain('\\n');
  });

  it('prints no banner and still launches the agent when there is no map', async () => {
    // Act — a single-branch card behaves exactly as it did before the map existed.
    const stdout = await runBootstrap();

    // Assert
    expect(stdout).not.toContain('Workspaces for this card');
    expect(stdout).toContain('AGENT_STARTED');
  });
});

describe('session-bootstrap.sh agent session resume', () => {
  const SESSION_ID = '5f3a1c2e-9b47-4d80-a1f6-2c8e7d4b0913';

  /**
   * Runs the real bootstrap through a real shell with a fake agent that reports
   * the arguments it was handed, against a throwaway claude config directory.
   *
   * `existingConversation` seeds that directory the way claude does once a
   * conversation has been written, which is what decides resume vs. fresh.
   */
  async function runBootstrap({
    agentCli = 'claude' as const,
    agentSessionId,
    existingConversation = false,
  }: {
    agentCli?: 'claude' | 'codex';
    agentSessionId?: string;
    existingConversation?: boolean;
  }): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-resume-'));
    try {
      const fake = join(dir, agentCli);
      writeFileSync(fake, '#!/bin/bash\necho "AGENT_ARGS:$*"\n');
      chmodSync(fake, 0o755);

      const claudeConfig = join(dir, 'claude-config');
      if (existingConversation) {
        const project = join(claudeConfig, 'projects', '-some-checkout');
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, `${agentSessionId}.jsonl`), '{}\n');
      }

      const command = buildNewSessionBootstrapCommand({
        repoPath: dir,
        branch: 'ab/api-0001',
        agentCli,
        usesWorktree: true,
        cwd: dir,
        sessionBootstrapScript: BOOTSTRAP,
        ...(agentSessionId ? { agentSessionId } : {}),
      });

      const { stdout } = await execFileAsync('bash', ['-c', command], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          CLAUDE_CONFIG_DIR: claudeConfig,
        },
      });
      return stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('resumes the conversation the card already has', async () => {
    // Act
    const stdout = await runBootstrap({ agentSessionId: SESSION_ID, existingConversation: true });

    // Assert
    expect(stdout).toContain(`AGENT_ARGS:--resume ${SESSION_ID}`);
  });

  it('starts the conversation under the card id when there is nothing to resume', async () => {
    // Arrange + Act — a card opened and abandoned never wrote a conversation, so
    // resuming it would fail; claiming the id keeps the next reopen resumable.
    const stdout = await runBootstrap({ agentSessionId: SESSION_ID });

    // Assert
    expect(stdout).toContain(`AGENT_ARGS:--session-id ${SESSION_ID}`);
  });

  it('leaves agents other than claude launching as they always did', async () => {
    // Act
    const stdout = await runBootstrap({ agentCli: 'codex', agentSessionId: SESSION_ID });

    // Assert
    expect(stdout).toContain('AGENT_ARGS:');
    expect(stdout).not.toContain(SESSION_ID);
  });

  it('passes no session flags when the daemon supplied no id', async () => {
    // Act
    const stdout = await runBootstrap({});

    // Assert
    expect(stdout).toContain('AGENT_ARGS:');
    expect(stdout).not.toContain('--session-id');
    expect(stdout).not.toContain('--resume');
  });
});
