import { describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
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
      'AGENTBOARD_TASK_ID="" ' +
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
        'AGENTBOARD_INITIAL_PROMPT_FILE="" ' +
        'AGENTBOARD_RESUME_PROMPT_FILE="" ' +
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
      'AGENTBOARD_TASK_ID="" ' +
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
        'AGENTBOARD_INITIAL_PROMPT_FILE="" ' +
        'AGENTBOARD_RESUME_PROMPT_FILE="" ' +
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

describe('session-bootstrap.sh initial brief', () => {
  const SESSION_ID = '5f3a1c2e-9b47-4d80-a1f6-2c8e7d4b0913';

  /**
   * Runs the real bootstrap with a fake agent that writes every argument it
   * received to a file, so the brief can be compared byte-for-byte rather than
   * through a shell echo that would normalise its whitespace.
   */
  async function runWithBrief({
    brief,
    existingConversation = false,
  }: {
    brief?: string;
    existingConversation?: boolean;
  }): Promise<{ args: string[]; briefFile: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-brief-'));
    try {
      const argsFile = join(dir, 'received-args');
      const fake = join(dir, 'claude');
      // printf '%s\0' keeps arguments separable even when one contains newlines.
      writeFileSync(fake, `#!/bin/bash\nprintf '%s\\0' "$@" > ${JSON.stringify(argsFile)}\n`);
      chmodSync(fake, 0o755);

      const claudeConfig = join(dir, 'claude-config');
      if (existingConversation) {
        const project = join(claudeConfig, 'projects', '-some-checkout');
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, `${SESSION_ID}.jsonl`), '{}\n');
      }

      const briefFile = join(dir, 'brief.txt');
      if (brief !== undefined) {
        writeFileSync(briefFile, brief);
      }

      const command = buildNewSessionBootstrapCommand({
        repoPath: dir,
        branch: 'ab/api-0001',
        agentCli: 'claude',
        usesWorktree: true,
        cwd: dir,
        sessionBootstrapScript: BOOTSTRAP,
        agentSessionId: SESSION_ID,
        ...(brief !== undefined ? { initialPromptFile: briefFile } : {}),
      });

      await execFileAsync('bash', ['-c', command], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          CLAUDE_CONFIG_DIR: claudeConfig,
        },
      });

      const raw = readFileSync(argsFile, 'utf8');
      // Trailing empty element from the final NUL separator.
      const args = raw.split('\0').slice(0, -1);
      return { args, briefFile };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('hands the brief to the agent as a single argument, byte for byte', async () => {
    // Arrange — everything a pasted brief used to mangle: blank lines (which
    // tmux rewrote to carriage returns), quotes, $VARS and backticks.
    const brief = 'Fix the thing.\n\n- a "quoted" $VAR and `backticks`\n- second bullet\n';

    // Act
    const { args } = await runWithBrief({ brief });

    // Assert — one argument, not several, and unexpanded.
    expect(args[args.length - 1]).toBe(brief.replace(/\n+$/, ''));
  });

  it('carries a brief far larger than the pane input limit', async () => {
    // Arrange — the ~4 KB pane-input truncation that originally forced the
    // brief off the command line only ever applied to what is typed into the
    // pane. The contents travel in a file, so size stops mattering.
    const brief = `Start.\n${'x'.repeat(40_000)}\nEnd.`;

    // Act
    const { args } = await runWithBrief({ brief });

    // Assert
    expect(args[args.length - 1]).toBe(brief);
  });

  it('does not replay the brief into a resumed conversation', async () => {
    // Arrange + Act — the agent already did this work.
    const { args } = await runWithBrief({ brief: 'Do the thing.', existingConversation: true });

    // Assert
    expect(args).toContain('--resume');
    expect(args.some((arg) => arg.includes('Do the thing.'))).toBe(false);
  });

  it('removes the brief file either way, so a reopen cannot re-read it', async () => {
    // Act
    const { briefFile } = await runWithBrief({ brief: 'Do the thing.' });

    // Assert
    expect(existsSync(briefFile)).toBe(false);
  });

});

describe('session-bootstrap.sh queued messages', () => {
  const SESSION_ID = '5f3a1c2e-9b47-4d80-a1f6-2c8e7d4b0913';

  /**
   * Runs the real bootstrap with both prompt files present and reports what
   * the agent was actually handed, plus which files survived.
   *
   * Both are always written by the daemon; only session-bootstrap.sh knows
   * whether this open is a fresh start or a resume, so it is what picks.
   */
  async function run({ existingConversation }: { existingConversation: boolean }): Promise<{
    args: string[];
    briefLeft: boolean;
    noticeLeft: boolean;
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-queued-'));
    try {
      const argsFile = join(dir, 'received-args');
      const fake = join(dir, 'claude');
      writeFileSync(fake, `#!/bin/bash\nprintf '%s\\0' "$@" > ${JSON.stringify(argsFile)}\n`);
      chmodSync(fake, 0o755);

      const claudeConfig = join(dir, 'claude-config');
      if (existingConversation) {
        const project = join(claudeConfig, 'projects', '-some-checkout');
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, `${SESSION_ID}.jsonl`), '{}\n');
      }

      const briefFile = join(dir, 'brief.txt');
      writeFileSync(briefFile, 'THE ORIGINAL BRIEF');
      const noticeFile = join(dir, 'notice.txt');
      writeFileSync(noticeFile, 'THE QUEUED MESSAGE');

      const command = buildNewSessionBootstrapCommand({
        repoPath: dir,
        branch: 'ab/api-0001',
        agentCli: 'claude',
        usesWorktree: true,
        cwd: dir,
        sessionBootstrapScript: BOOTSTRAP,
        agentSessionId: SESSION_ID,
        initialPromptFile: briefFile,
        resumeNoticeFile: noticeFile,
      });

      await execFileAsync('bash', ['-c', command], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          CLAUDE_CONFIG_DIR: claudeConfig,
        },
      });

      return {
        args: readFileSync(argsFile, 'utf8').split('\0').slice(0, -1),
        briefLeft: existsSync(briefFile),
        noticeLeft: existsSync(noticeFile),
        receipt: existsSync(`${noticeFile}.read`),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('delivers queued messages when the card resumes, and never the brief', async () => {
    // Arrange + Act — the card has spoken to its agent before, so replaying
    // the brief would hand it work it has already done; the message that
    // arrived while it was closed is the only thing it has not seen.
    const { args } = await run({ existingConversation: true });

    // Assert
    expect(args).toContain('--resume');
    expect(args[args.length - 1]).toBe('THE QUEUED MESSAGE');
    expect(args.some((arg) => arg.includes('THE ORIGINAL BRIEF'))).toBe(false);
  });

  // The queued message used to be dropped here. The branch that read it was
  // gated on resuming, the `rm -f` that deleted it was not, and both this
  // script and session-manager.ts claimed the daemon folded queued messages
  // into the brief for a fresh start. Nothing did. Issue #46 §2.
  it('delivers the brief and the queued messages together when the card starts fresh', async () => {
    // Arrange + Act — a card opened for the first time, with a message that
    // arrived before it ever had a session. Both are news to this agent.
    const { args } = await run({ existingConversation: false });

    // Assert — one positional argument, because the agent CLI takes one.
    expect(args).toContain('--session-id');
    const prompt = args[args.length - 1] ?? '';
    expect(prompt).toContain('THE ORIGINAL BRIEF');
    expect(prompt).toContain('THE QUEUED MESSAGE');
    expect(prompt.indexOf('THE ORIGINAL BRIEF')).toBeLessThan(prompt.indexOf('THE QUEUED MESSAGE'));
  });

  // Issue #46 §2. The daemon holds the messages in its own queue until it sees
  // this receipt, and re-delivers them if it never appears — so a pane that
  // dies before this point no longer takes them with it. Absence of the notice
  // file cannot carry that signal: it is deleted on every path the script
  // takes, and a backend that found the session already running writes none.
  it('leaves a receipt naming the queued messages it actually delivered', async () => {
    const resumed = await run({ existingConversation: true });
    const fresh = await run({ existingConversation: false });

    expect(resumed.receipt).toBe(true);
    expect(fresh.receipt).toBe(true);
  });

  it('removes both files either way, so nothing is delivered twice', async () => {
    // Act
    const resumed = await run({ existingConversation: true });
    const fresh = await run({ existingConversation: false });

    // Assert — the unused file is consumed too; leaving it would make the
    // next open replay it.
    expect(resumed).toMatchObject({ briefLeft: false, noticeLeft: false });
    expect(fresh).toMatchObject({ briefLeft: false, noticeLeft: false });
  });
});

describe('session-bootstrap.sh worktree marker file', () => {
  /**
   * Runs the real bootstrap through a real shell, with a fake agent that does
   * nothing but exit — the point of this block is what the script leaves on
   * disk before it ever gets to launching an agent.
   */
  async function runBootstrap({
    taskId,
    taskKind,
    initGit = false,
  }: {
    taskId?: string;
    taskKind?: 'repo' | 'general';
    initGit?: boolean;
  }): Promise<{ dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-marker-'));
    const fake = join(dir, 'claude');
    writeFileSync(fake, '#!/bin/bash\nexit 0\n');
    chmodSync(fake, 0o755);

    if (initGit) {
      await execFileAsync('git', ['init', '-q', dir]);
    }

    const command = buildNewSessionBootstrapCommand({
      taskId,
      taskKind,
      repoPath: dir,
      branch: 'ab/api-0001',
      agentCli: 'claude',
      usesWorktree: true,
      cwd: dir,
      sessionBootstrapScript: BOOTSTRAP,
    });

    await execFileAsync('bash', ['-c', command], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
    });
    return { dir };
  }

  it("drops the card's id in its worktree", async () => {
    // Act
    const { dir } = await runBootstrap({ taskId: 'task-1234' });

    // Assert
    const markerPath = join(dir, '.agentboard', 'task-id');
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, 'utf8')).toBe('task-1234');
    rmSync(dir, { recursive: true, force: true });
  });

  it('excludes the marker from the worktree\'s own git history without touching .gitignore', async () => {
    // Act — a real repo, so the script's git-dir lookup actually resolves.
    const { dir } = await runBootstrap({ taskId: 'task-1234', initGit: true });

    // Assert
    const excludePath = join(dir, '.git', 'info', 'exclude');
    expect(readFileSync(excludePath, 'utf8')).toContain('.agentboard/');
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes no marker for a general task, whose sessions all share $HOME as cwd', async () => {
    // Act
    const { dir } = await runBootstrap({ taskId: 'task-1234', taskKind: 'general' });

    // Assert
    expect(existsSync(join(dir, '.agentboard'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('session-bootstrap.sh opening prompt', () => {
  const SESSION_ID = '7c1d9a44-3e21-4b6f-9c05-8ad2e1f36b70';

  /**
   * Runs the real command line through a real shell, with a fake agent that
   * writes each argument it was handed on its own line.
   *
   * One argument per line is the point: a brief that arrived split across
   * several arguments, or with its `$` and backticks expanded by the shell, is
   * exactly the corruption that reading it from a file avoids.
   */
  async function runBootstrap({
    initialPrompt,
    agentSessionId,
    existingConversation = false,
    agentCli = 'claude' as const,
  }: {
    initialPrompt?: string;
    agentSessionId?: string;
    existingConversation?: boolean;
    agentCli?: 'claude' | 'codex';
  }): Promise<{ stdout: string; briefFileExists: boolean }> {
    const dir = mkdtempSync(join(tmpdir(), 'agentboard-prompt-'));
    try {
      const fake = join(dir, agentCli);
      writeFileSync(fake, '#!/bin/bash\nfor a in "$@"; do printf "ARG<%s>\\n" "$a"; done\n');
      chmodSync(fake, 0o755);

      let initialPromptFile: string | undefined;
      if (initialPrompt !== undefined) {
        initialPromptFile = join(dir, 'brief.txt');
        writeFileSync(initialPromptFile, initialPrompt, 'utf8');
      }

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
        ...(initialPromptFile ? { initialPromptFile } : {}),
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
      return {
        stdout,
        briefFileExists: initialPromptFile !== undefined && existsSync(initialPromptFile),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes the brief by path, never by value', () => {
    // Arrange
    const command = buildNewSessionBootstrapCommand({
      repoPath: '/repo',
      branch: 'ab/api-0001',
      agentCli: 'claude',
      sessionBootstrapScript: '/s.sh',
      initialPromptFile: '/tmp/agentboard/briefs/task-1-primary.txt',
    });

    // Assert
    expect(command).toContain(
      'AGENTBOARD_INITIAL_PROMPT_FILE="/tmp/agentboard/briefs/task-1-primary.txt"'
    );
  });

  it('keeps the command line short no matter how long the brief is', () => {
    // Arrange — the whole command is typed into the session's pane, which drops
    // everything past roughly 4 KB and leaves the shell hanging on an
    // unterminated quote. A brief has no length ceiling, so it must not be able
    // to push the command anywhere near that.
    const command = buildNewSessionBootstrapCommand({
      repoPath: '/repo',
      branch: 'ab/api-0001',
      agentCli: 'claude',
      sessionBootstrapScript: '/s.sh',
      initialPromptFile: '/tmp/agentboard/briefs/task-1-primary.txt',
    });

    // Assert — a generous ceiling; the real line is a few hundred bytes.
    expect(command.length).toBeLessThan(1024);
  });

  it('hands the brief to the agent unexpanded, however unruly its contents', async () => {
    // Arrange — quotes, `$`, backticks and a newline all in one brief, plus
    // enough bulk that it could never have ridden the command line itself.
    // Only the file's path travels through argv construction; the contents are
    // read by the script, so the shell never gets a chance to expand them.
    const prompt = `Fix $HOME "now" and \`date\`\nsecond line\n${'x'.repeat(8000)}`;

    // Act
    const { stdout, briefFileExists } = await runBootstrap({ initialPrompt: prompt });

    // Assert — reaches the agent verbatim, with $HOME and `date` untouched.
    expect(stdout).toContain('ARG<Fix $HOME "now" and `date`');
    // Consumed, so a reopen of this card cannot replay it.
    expect(briefFileExists).toBe(false);
  });

  it('passes the brief alongside the session flag when claiming a fresh conversation id', async () => {
    // Act
    const { stdout, briefFileExists } = await runBootstrap({
      initialPrompt: 'Ship the thing',
      agentSessionId: SESSION_ID,
    });

    // Assert — both ride argv: the flag pins the conversation, the brief opens it.
    expect(stdout).toContain(`ARG<--session-id>`);
    expect(stdout).toContain('ARG<Ship the thing>');
    expect(briefFileExists).toBe(false);
  });

  it('never replays the brief into a resumed conversation', async () => {
    // Arrange + Act — the agent already did this work; replaying the brief would
    // start it over.
    const { stdout, briefFileExists } = await runBootstrap({
      initialPrompt: 'Ship the thing',
      agentSessionId: SESSION_ID,
      existingConversation: true,
    });

    // Assert
    expect(stdout).toContain('ARG<--resume>');
    expect(stdout).not.toContain('ARG<Ship the thing>');
    expect(briefFileExists).toBe(false);
  });

  it('launches exactly as before when the card carries no brief', async () => {
    // Act
    const { stdout } = await runBootstrap({});

    // Assert — the agent runs, and receives no arguments at all.
    expect(stdout).not.toContain('ARG<');
  });
});
