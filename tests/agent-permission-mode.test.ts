import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildSessionBootstrapEnv,
  resolveAgentArgs,
} from '../src/services/session-bootstrap.js';

const execFileAsync = promisify(execFile);
const BOOTSTRAP = join(process.cwd(), 'scripts', 'session-bootstrap.sh');

describe('resolveAgentArgs', () => {
  it('adds no flags in the default mode', () => {
    expect(resolveAgentArgs('claude', 'default')).toEqual([]);
    expect(resolveAgentArgs('claude')).toEqual([]);
  });

  it('bypasses claude permission prompts with the verified flag', () => {
    expect(resolveAgentArgs('claude', 'bypass')).toEqual(['--dangerously-skip-permissions']);
  });

  it('adds no flag for an agent whose bypass flag is unverified', () => {
    // Guessing a flag would make the CLI exit with a usage error instead of
    // starting, which is worse than simply not bypassing.
    expect(resolveAgentArgs('codex', 'bypass')).toEqual([]);
  });

  it('lets config supply arguments for an agent with no built-in flag', () => {
    expect(resolveAgentArgs('codex', 'bypass', { codex: ['--full-auto'] })).toEqual(['--full-auto']);
  });

  it('puts permission flags before configured extras', () => {
    expect(resolveAgentArgs('claude', 'bypass', { claude: ['--verbose'] })).toEqual([
      '--dangerously-skip-permissions',
      '--verbose',
    ]);
  });

  it('names the claude session so it is addressable via SendMessage/ListAgents', () => {
    expect(resolveAgentArgs('claude', 'default', {}, 'Add rate limiting')).toEqual([
      '--name',
      'Add rate limiting',
    ]);
  });

  it('adds no name flag for an agent whose --name is unverified', () => {
    // Same reasoning as the bypass flag: a guessed flag is worse than none.
    expect(resolveAgentArgs('codex', 'default', {}, 'Add rate limiting')).toEqual([]);
  });

  it('puts the name flag between permission flags and configured extras', () => {
    expect(
      resolveAgentArgs('claude', 'bypass', { claude: ['--verbose'] }, 'Add rate limiting'),
    ).toEqual(['--dangerously-skip-permissions', '--name', 'Add rate limiting', '--verbose']);
  });
});

describe('bootstrap settings', () => {
  it('carries the resolved arguments as a shell-quoted env var', () => {
    // Act
    const settings = buildSessionBootstrapEnv({
      repoPath: '/repo',
      branch: 'ab/x-1',
      agentCli: 'claude',
      agentPermissionMode: 'bypass',
    });

    // Assert
    expect(settings).toContain('export AGENTBOARD_AGENT_ARGS=--dangerously-skip-permissions\n');
  });

  it('passes an empty argument list in the default mode', () => {
    const settings = buildSessionBootstrapEnv({
      repoPath: '/repo',
      branch: 'ab/x-1',
      agentCli: 'claude',
    });

    expect(settings).toContain("export AGENTBOARD_AGENT_ARGS=''\n");
  });
});

describe('session-bootstrap.sh argument handling', () => {
  /** Runs the real script with a fake agent that echoes the argv it received. */
  async function runWithFakeAgent(agentArgs: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-bootstrap-'));
    try {
      const fake = join(dir, 'claude');
      writeFileSync(fake, '#!/bin/bash\nfor a in "$@"; do echo "ARG:$a"; done\n');
      chmodSync(fake, 0o755);

      const { stdout } = await execFileAsync('bash', [BOOTSTRAP], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env['PATH']}`,
          // Blanked, not left out: run from inside an AgentBoard card, the test
          // process inherits that card's own values, and a session id adds
          // --session-id to the argv this test counts.
          AGENTBOARD_AGENT_SESSION_ID: '',
          AGENTBOARD_INITIAL_PROMPT_FILE: '',
          AGENTBOARD_RESUME_PROMPT_FILE: '',
          AGENTBOARD_WORKSPACES: '',
          AGENTBOARD_REPO_PATH: dir,
          AGENTBOARD_SESSION_CWD: dir,
          AGENTBOARD_TASK_BRANCH: 'ab/test-1',
          AGENTBOARD_AGENT: 'claude',
          AGENTBOARD_USES_WORKTREE: '1',
          AGENTBOARD_BOOTSTRAP_NOTICE: '',
          AGENTBOARD_AGENT_ARGS: agentArgs,
        },
      });
      return stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes the bypass flag through to the agent', async () => {
    // Act
    const out = await runWithFakeAgent('--dangerously-skip-permissions');

    // Assert
    expect(out).toContain('ARG:--dangerously-skip-permissions');
  });

  it('passes no arguments when the list is empty', async () => {
    // Act
    const out = await runWithFakeAgent('');

    // Assert
    expect(out).not.toContain('ARG:');
  });

  it('keeps a quoted argument containing spaces as one argument', async () => {
    // Act — the daemon shell-quotes the list, so re-splitting must respect it.
    const out = await runWithFakeAgent(`--flag 'two words'`);

    // Assert
    expect(out).toContain('ARG:--flag');
    expect(out).toContain('ARG:two words');
  });
});
