// ============================================================
// AgentBoard — CLI layer (Commander)
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import { fileURLToPath } from 'url';
import {
  configPaths,
  loadConfig,
  ensureDirectories,
  writeDefaultConfig,
  type ConfigPaths,
} from '../config/index.js';
import { ensureRunning, isDaemonRunning, stopDaemon } from '../daemon/index.js';
import { createRPCClient } from './rpc.js';
import { launchWebLayout, openInBrowser, runWebHome, webBoardUrlWithToken } from './web.js';
import { webBoardUrl } from '../daemon/web-token.js';
import { DEFAULT_DELIVERY_BUDGET_MS } from '../services/session-backends/pane-idle.js';
import type {
  AppConfig,
  DoctorCheck,
  DoctorResult,
  TaskRecord,
  RepoRecord,
  DaemonStatus,
  UpdateRepoParams,
} from '../types/index.js';

// ============================================================
// Helpers
// ============================================================

/**
 * Says out loud that the next call blocks for as long as a pane delivery can
 * take, before it starts blocking.
 *
 * Both delivery commands are synchronous on purpose — their answer is a
 * verified outcome ("this text was seen on the pane, then Enter was sent"),
 * which a fire-and-forget "queued" reply would throw away — but a CLI that
 * sits silent for minutes reads as hung, and someone who thinks it hung runs
 * it again. See `pane-idle.ts`'s `deliveryBudgetMs` for where the number
 * comes from.
 */
function announceDeliveryWait(): void {
  const minutes = Math.ceil(DEFAULT_DELIVERY_BUDGET_MS / 60_000);
  console.log(
    `Delivering — waiting for the pane to take it. A busy or still-starting session can hold this up to ~${minutes} min; ` +
      'follow it from another shell with `agentboard fleet` (DELIVERY column).',
  );
}

/**
 * Says which of `redeliverInitialPrompt`'s three failures actually happened.
 *
 * The single message this replaces — "has no live session, or no stored
 * brief" — named two causes and left out the third, so the common case (a
 * delivery ran and its paste never verified) was reported as one of the two
 * things it definitively was not. Someone looking at `agentboard fleet`
 * listing that same session as live reasonably concluded the two views
 * disagreed about whether a session existed.
 */
function explainRedeliverFailure(
  id: string,
  reason: import('../services/session-manager.js').RedeliverFailureReason | undefined,
): string {
  switch (reason) {
    case 'no-session':
      return `Task ${id} has no live session — open one first with \`agentboard attach ${id}\`.`;
    case 'no-brief':
      return `Task ${id} has no stored opening brief, so there is nothing to re-deliver. Use \`agentboard task notify ${id} "..."\` to send it a message instead.`;
    case 'not-verified':
      return (
        `Task ${id}'s brief was delivered to the pane but never confirmed on screen, so nothing was submitted. ` +
        'The pane is most likely still starting up — check it with `agentboard fleet` and run this again once it settles.'
      );
    case 'not-submitted':
      return (
        `Task ${id}'s brief is sitting in the pane's input box — it arrived intact, but no Enter would submit it. ` +
        `Replace the pane with \`agentboard task restart ${id}\`; the input box cannot be cleared or submitted from outside it.`
      );
    default:
      // An older daemon that predates the reason field.
      return `Task ${id}: nothing was delivered.`;
  }
}

/** Map ConfigPaths (dbFile) to the shape expected by DaemonOpts / ensureRunning. */
function daemonOpts(paths: ConfigPaths) {
  return {
    configFile: paths.configFile,
    dbPath: paths.dbFile,
    socketPath: paths.socketPath,
    logFile: paths.logFile,
    stateDir: paths.stateDir,
  };
}

function shouldFallbackToDirectRepoUpdate(error: unknown): boolean {
  if (error instanceof Error && error.message === 'Not implemented') {
    return true;
  }

  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;

  return (
    code === 'ENOENT' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'EPERM' ||
    code === 'EACCES'
  );
}

async function updateRepoWithFallback(
  paths: ConfigPaths,
  params: UpdateRepoParams
): Promise<RepoRecord> {
  try {
    const rpc = await createRPCClient(paths.socketPath);
    try {
      return await rpc.call<RepoRecord>('updateRepo', params);
    } finally {
      rpc.disconnect();
    }
  } catch (error) {
    if (!shouldFallbackToDirectRepoUpdate(error)) {
      throw error;
    }
  }

  const { openDb } = await import('../db/index.js');
  const { WorkspaceService } = await import('../services/workspace.js');
  const db = openDb(paths.dbFile);

  try {
    const workspace = new WorkspaceService(db);
    const { id, ...patch } = params;
    return workspace.updateRepo(id, patch);
  } finally {
    db.close();
  }
}

interface WorktreeCleanupResult {
  daemonStopped: boolean;
  removedWorktrees: string[];
  clearedTaskCount: number;
}

async function cleanupAllRepoWorktrees(paths: ConfigPaths): Promise<WorktreeCleanupResult> {
  let daemonStopped = false;

  if (await isDaemonRunning(paths.socketPath)) {
    daemonStopped = await stopDaemon({
      stateDir: paths.stateDir,
      socketPath: paths.socketPath,
      logFile: paths.logFile,
    });
  }

  const { openDb } = await import('../db/index.js');
  const { WorkspaceService } = await import('../services/workspace.js');
  const { GitService } = await import('../services/git.js');
  const db = openDb(paths.dbFile);

  try {
    const workspace = new WorkspaceService(db);
    const git = new GitService(db);
    const repos = workspace.listRepos();
    const removedWorktrees: string[] = [];
    let clearedTaskCount = 0;

    for (const repo of repos) {
      git.pruneWorktrees(repo.path);
      const repoRoot = path.resolve(repo.path);
      const worktrees = git
        .listWorktrees(repo.path)
        .map((worktreePath) => path.resolve(worktreePath))
        .filter((worktreePath) => worktreePath !== repoRoot);

      for (const worktreePath of worktrees) {
        git.removeWorktree(repo.path, worktreePath);
        removedWorktrees.push(worktreePath);
        const result = db
          .prepare<[string | null, number, string, string], { changes: number }>(
            'UPDATE tasks SET worktree_path = ?, updated_at = ? WHERE repo_id = ? AND worktree_path = ?',
          )
          .run(null, Date.now(), repo.id, worktreePath);
        clearedTaskCount += result.changes;
      }
    }

    return {
      daemonStopped,
      removedWorktrees,
      clearedTaskCount,
    };
  } finally {
    db.close();
  }
}

function statusSymbol(status: DoctorCheck['status']): string {
  switch (status) {
    case 'pass':
      return '✓ pass';
    case 'warn':
      return '⚠ warn';
    case 'fail':
      return '✗ fail';
  }
}

function printDoctorChecks(checks: DoctorResult): void {
  for (const check of checks) {
    const symbol = statusSymbol(check.status);
    const detail = check.message ? `: ${check.message}` : '';
    console.log(`${symbol} — ${check.name}${detail}`);
    if (check.remediation) {
      console.log(`       remediation: ${check.remediation}`);
    }
  }
}

function printTaskTable(tasks: TaskRecord[], emptyMessage = 'No tasks found.'): void {
  if (tasks.length === 0) {
    console.log(emptyMessage);
    return;
  }
  const header = ['ID', 'Title', 'Track', 'PR', 'CI'];
  const rows = tasks.map((t) => [t.id, t.title, t.trackId, t.prState, t.ciState]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(fmt(row.map(String)));
  }
}

/**
 * Renders `getFleetStatus`'s rows the way `printTaskTable` renders tasks —
 * one table, no need to poke each live session's pane by hand to see what
 * state it's actually in.
 */
function printFleetTable(sessions: import('../types/index.js').FleetSessionStatus[]): void {
  if (sessions.length === 0) {
    console.log('No live sessions.');
    return;
  }

  const header = [
    'TASK',
    'TITLE',
    'SLOT',
    'BACKEND',
    'STATUS',
    'BUSY',
    'ATTENTION',
    'TRUST-PROMPT',
    'DELIVERY',
    'PANE',
    'AGE',
  ];
  const rows = sessions.map((s) => [
    s.taskId,
    s.taskTitle,
    s.slot,
    s.backendType,
    s.sessionStatus,
    s.isBusy ? 'yes' : 'no',
    s.attentionNeeded ? 'yes' : 'no',
    s.trustPromptShowing ? 'STUCK' : '-',
    s.delivered === null ? '-' : s.delivered ? 'verified' : 'UNSUBMITTED',
    // Stable for the pane's life, unlike a window index — `tmux ... -t %42`
    // addresses this card and only this card.
    s.paneId ?? '-',
    formatFleetAge(Date.now() - s.createdAt),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(fmt(row.map(String)));
  }

  const stuck = sessions.filter((s) => s.trustPromptShowing);
  if (stuck.length > 0) {
    console.log(
      `\n${stuck.length} session(s) stuck on the trust prompt — this should self-resolve; if it doesn't, attach and accept it by hand.`,
    );
  }

  const undelivered = sessions.filter((s) => s.delivered === false);
  if (undelivered.length > 0) {
    console.log(
      `\n${undelivered.length} session(s) have an unsubmitted brief — run \`agentboard task redeliver-prompt <id>\` to nudge them.`,
    );
  }
}

/** Renders `getAttentionItems`'s rows — one line per card, one reason each. */
function printAttentionTable(items: import('../types/index.js').AttentionItem[]): void {
  if (items.length === 0) {
    console.log('Nothing needs you right now.');
    return;
  }

  const header = ['TASK', 'WHY'];
  const rows = items.map((item) => [item.taskTitle, item.reason]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(fmt(row));
  }
  console.log(`\n${items.length} card(s) need you.`);
}

function formatFleetAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes}m`;
}

// --------------- task create helpers ------------------------

/**
 * Finds the task id session-bootstrap.sh dropped in this worktree, by walking
 * up from `startDir` — a stand-in for `AGENTBOARD_TASK_ID` when it did not
 * make it into this process's environment (a Bash tool call the agent makes
 * can run through a sandbox that does not forward the parent shell's env vars,
 * even though it still runs with the right cwd). Absent for a general task's
 * session, which never writes this file (see session-bootstrap.sh).
 */
function findParentTaskIdFromWorktree(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 50; depth += 1) {
    const markerPath = path.join(dir, '.agentboard', 'task-id');
    if (fs.existsSync(markerPath)) {
      const id = fs.readFileSync(markerPath, 'utf8').trim();
      if (id) {
        return id;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve a repo or pillar the way a person refers to one: by id, or by the
 * label they see on the board.
 *
 * Ambiguity is an error rather than a coin flip — creating the card against the
 * wrong repo is only noticed once the agent is already running in it.
 */
function resolveRef<T extends { id: string; label: string }>(
  candidates: T[],
  ref: string,
  kind: string,
): T {
  const byId = candidates.find((candidate) => candidate.id === ref);
  if (byId) {
    return byId;
  }

  const needle = ref.trim().toLowerCase();
  const byLabel = candidates.filter((candidate) => candidate.label.toLowerCase() === needle);
  if (byLabel.length === 1) {
    return byLabel[0]!;
  }

  const known = candidates.map((candidate) => `${candidate.id} (${candidate.label})`).join(', ');
  if (byLabel.length > 1) {
    throw new Error(`Ambiguous ${kind} "${ref}" — more than one matches. Use an id: ${known}`);
  }
  throw new Error(`Unknown ${kind} "${ref}". Known ${kind}s: ${known || 'none'}`);
}

/**
 * The brief the card carries: what shows on the card, and what the agent is
 * handed as its opening prompt.
 *
 * The context is passed through verbatim. A plan URL is the one thing that gets
 * words wrapped around it, because a bare URL on its own is not an instruction —
 * and the agent, not AgentBoard, is what fetches it.
 */
export function composeTaskBrief({
  description,
  contextFile,
  planUrl,
}: {
  description?: string;
  contextFile?: string;
  planUrl?: string;
}): string | undefined {
  const parts: string[] = [];

  if (description) {
    parts.push(description.trim());
  }

  if (contextFile) {
    if (!fs.existsSync(contextFile)) {
      throw new Error(`Context file not found: ${contextFile}`);
    }
    const contents = fs.readFileSync(contextFile, 'utf8').trim();
    if (contents) {
      parts.push(contents);
    }
  }

  if (planUrl) {
    parts.push(
      parts.length === 0
        ? `Read the plan at ${planUrl} and execute it.`
        : `Plan: ${planUrl}`,
    );
  }

  const brief = parts.join('\n\n').trim();
  return brief.length > 0 ? brief : undefined;
}

function printRepoTable(repos: RepoRecord[]): void {
  if (repos.length === 0) {
    console.log('No repos registered.');
    return;
  }
  const header = ['ID', 'Label', 'Path', 'Base', 'Health'];
  const rows = repos.map((r) => [r.id, r.label, r.path, r.defaultBaseBranch, r.health]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(fmt(row.map(String)));
  }
}

function resolveGoTUIBinary(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, '../../dist-go/agentboard-tui'),
    path.resolve(moduleDir, '../../dist-go/agentboard-tui.exe'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shouldLaunchManagedTmux(config: AppConfig): boolean {
  return (
    config.sessionBackend === 'tmux' &&
    config.tmux.autoLayout &&
    !process.env['TMUX'] &&
    process.env['AGENTBOARD_TMUX_MANAGED'] !== '1'
  );
}

function launchManagedTmux(binary: string, socketPath: string, config: AppConfig): void {
  const command =
    `AGENTBOARD_SOCKET_PATH=${shellQuote(socketPath)} ` +
    `AGENTBOARD_TMUX_MANAGED=1 ${shellQuote(binary)}`;
  const env = {
    ...process.env,
    AGENTBOARD_SOCKET_PATH: socketPath,
    AGENTBOARD_TMUX_MANAGED: '1',
  };
  const layoutSessionName = config.tmux.layoutSessionName;

  const existing = spawnSync('tmux', ['has-session', '-t', layoutSessionName], {
    stdio: 'ignore',
    env,
  });
  handleTmuxSpawnError(existing);
  if (existing.status === 0) {
    const killed = spawnSync('tmux', ['kill-session', '-t', layoutSessionName], {
      stdio: 'ignore',
      env,
    });
    handleTmuxSpawnError(killed);
    if (typeof killed.status === 'number' && killed.status !== 0) {
      throw new Error(`Failed to replace existing tmux layout session: ${layoutSessionName}`);
    }
  }

  const result = spawnSync('tmux', ['new-session', '-s', layoutSessionName, command], {
    stdio: 'inherit',
    env,
  });

  handleTmuxSpawnError(result);

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

function handleTmuxSpawnError(result: ReturnType<typeof spawnSync>): void {
  if (!result.error) {
    return;
  }
  if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(
      'tmux not found. Install tmux or set "sessionBackend": "pty" in AgentBoard config.'
    );
  }
  throw result.error;
}

function launchGoTUI(socketPath: string, config: AppConfig): void {
  const binary = resolveGoTUIBinary();
  if (!binary) {
    throw new Error('Go TUI binary not found. Run `npm run build:go` or `npm run build` first.');
  }

  if (shouldLaunchManagedTmux(config)) {
    launchManagedTmux(binary, socketPath, config);
    return;
  }

  const result = spawnSync(binary, [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENTBOARD_SOCKET_PATH: socketPath,
    },
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

// ============================================================
// buildCli
// ============================================================

export function buildCli(): Command {
  const program = new Command();

  program
    .name('agentboard')
    .description('Terminal-native Kanban board for AI coding sessions')
    .version('0.1.0');

  // ----------------------------------------------------------
  // Default action — launch TUI
  // ----------------------------------------------------------
  program.option('--ui <mode>', 'Board to show: "tui" (default) or "web"');

  program.action(async (opts: { ui?: string }) => {
    try {
      const paths = configPaths();
      const config = loadConfig();
      const ui = opts.ui ?? config.ui ?? 'tui';
      if (ui !== 'tui' && ui !== 'web') {
        throw new Error(`Unknown --ui "${ui}". Use "tui" or "web".`);
      }
      await ensureRunning(daemonOpts(paths));
      if (ui === 'web') {
        const url = webBoardUrlWithToken(config, paths.stateDir);
        openInBrowser(url);
        if (config.sessionBackend === 'pty') {
          console.log(`Web board: ${url}`);
          console.log('PTY sessions can only be shown by the TUI; set "sessionBackend": "tmux".');
          return;
        }
        if (launchWebLayout(config) === 'here') {
          await runWebHome(webBoardUrl(config.web.port));
        }
        return;
      }
      launchGoTUI(paths.socketPath, config);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

  // ----------------------------------------------------------
  // web
  // ----------------------------------------------------------
  program
    .command('web')
    .description(
      'Open the web board in the browser (clicking a card shows its session in the web tmux layout)'
    )
    .option('--print', 'Print the sign-in URL instead of opening the browser')
    .option('--home', 'Run the placeholder pane of the web tmux layout (internal)')
    .action(async (opts: { print?: boolean; home?: boolean }) => {
      try {
        const paths = configPaths();
        const config = loadConfig();
        if (opts.home) {
          await runWebHome(webBoardUrl(config.web.port));
          return;
        }
        await ensureRunning(daemonOpts(paths));
        const url = webBoardUrlWithToken(config, paths.stateDir);
        if (opts.print || !openInBrowser(url)) {
          console.log(url);
          return;
        }
        console.log(`Opened ${webBoardUrl(config.web.port)}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // init
  // ----------------------------------------------------------
  program
    .command('init')
    .description('Initialise AgentBoard directories and default config')
    .action(() => {
      try {
        ensureDirectories();
        writeDefaultConfig();
        const paths = configPaths();
        console.log(`AgentBoard initialized. Edit config at: ${paths.configFile}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // doctor
  // ----------------------------------------------------------
  program
    .command('doctor')
    .description('Run environment health checks')
    .option('--json', 'Output results as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const paths = configPaths();

        // Best-effort: try to ensure the daemon is running for a live DB check.
        try {
          await ensureRunning(daemonOpts(paths));
        } catch {
          // Not fatal — doctor still runs with whatever is available.
        }

        const { openDb } = await import('../db/index.js');
        const db = openDb(paths.dbFile);
        const { DoctorService } = await import('../services/doctor.js');
        const { loadConfig } = await import('../config/index.js');
        let remoteConfig;
        try {
          remoteConfig = loadConfig().remote;
        } catch {
          // Doctor still reports the local checks when the config is unreadable.
        }
        const doctor = new DoctorService(db, paths.socketPath, remoteConfig);
        const results = await doctor.run();

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          printDoctorChecks(results);
        }

        db.close();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // attach <task>
  // ----------------------------------------------------------
  program
    .command('attach <task>')
    .description('Open a session for a task and print its attach command')
    .action(async (task: string) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        const session = await rpc.call<import('../types/index.js').SessionRecord>('openSession', {
          taskId: task,
        });
        rpc.disconnect();
        if (session.attachCommand) {
          console.log(session.attachCommand);
        } else {
          console.log(`Session created: ${session.id}`);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // ls
  // ----------------------------------------------------------
  program
    .command('ls')
    .description('List tasks on the board')
    .option('--repo <id>', 'Filter by repo ID')
    .option('--json', 'Output as JSON')
    .action(async (opts: { repo?: string; json?: boolean }) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        const board = await rpc.call<import('../types/index.js').BoardSnapshot>('getBoard', {
          ...(opts.repo ? { repoId: opts.repo } : {}),
        });
        rpc.disconnect();

        const tasks = board.tasks;

        if (opts.json) {
          console.log(JSON.stringify(tasks, null, 2));
        } else {
          printTaskTable(tasks, 'No tasks found.');
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // fleet
  // ----------------------------------------------------------
  program
    .command('fleet')
    .description(
      'List every live session and its state at a glance — replaces checking N concurrent sessions by poking N tmux panes by hand',
    )
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        const { sessions } = await rpc.call<{
          sessions: import('../types/index.js').FleetSessionStatus[];
        }>('getFleetStatus');
        rpc.disconnect();

        if (opts.json) {
          console.log(JSON.stringify(sessions, null, 2));
        } else {
          printFleetTable(sessions);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // attention
  // ----------------------------------------------------------
  program
    .command('attention')
    .description(
      'List every card that wants a human right now, and why — replaces checking the badge, the PR picker, and fleet separately',
    )
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        const { items } = await rpc.call<{
          items: import('../types/index.js').AttentionItem[];
        }>('getAttentionItems');
        rpc.disconnect();

        if (opts.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          printAttentionTable(items);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // set-branch
  // ----------------------------------------------------------
  program
    .command('set-branch <task> <branch>')
    .description('Change the tracked branch for a task, clearing stale PR/CI state and re-syncing')
    .action(async (task: string, branch: string) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        await rpc.call('setTaskBranch', { id: task, branchName: branch });
        rpc.disconnect();
        console.log(`Branch updated to "${branch}" for task ${task}. Sync triggered.`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // task
  // ----------------------------------------------------------
  const task = program.command('task').description('Manage tasks on the board');

  task
    .command('create <title>')
    .description('Create a task, optionally starting its agent on the context you give it')
    .option('--repo <ref>', 'Repo id or label the task belongs to')
    .option('--general', 'Create a task that belongs to no repo')
    .option(
      '--parent <id>',
      'Mark this as a subtask of an existing card (defaults to the running session’s own task, if any)',
    )
    .option(
      '--session-name <name>',
      'Name for the new session (SendMessage/ListAgents); defaults to the title, prefixed with the parent’s own session name for a subtask',
    )
    .option('--pillar <ref>', "Pillar id or label (defaults to the repo's default pillar)")
    .option('--agent <cli>', 'Agent CLI to run: claude or codex', 'claude')
    .option('--location <where>', 'Where the session runs: local or remote', 'local')
    .option('--track <id>', 'Board column to create the card in', 'backlog')
    .option('--description <text>', 'Context for the task, shown on the card')
    .option('--context-file <path>', 'Read the context from a file')
    .option('--plan-url <url>', 'URL holding the plan for the agent to read and execute')
    .option('--start', 'Open a session and hand the context to the agent as its first prompt')
    .option('--json', 'Output as JSON')
    .action(
      async (
        title: string,
        opts: {
          repo?: string;
          general?: boolean;
          parent?: string;
          sessionName?: string;
          pillar?: string;
          agent?: string;
          location?: string;
          track?: string;
          description?: string;
          contextFile?: string;
          planUrl?: string;
          start?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          if (opts.general && opts.repo) {
            throw new Error('--general takes no --repo: a general task belongs to no repo.');
          }
          if (opts.agent !== 'claude' && opts.agent !== 'codex') {
            throw new Error(`Unsupported --agent "${opts.agent}". Use claude or codex.`);
          }
          if (opts.location !== 'local' && opts.location !== 'remote') {
            throw new Error(`Unsupported --location "${opts.location}". Use local or remote.`);
          }
          if (opts.general && opts.location === 'remote') {
            throw new Error('A general task has no checkout to run remotely; use --location local.');
          }

          // Read the context before touching the daemon, so a bad --context-file
          // fails without leaving a half-set-up card on the board.
          const brief = composeTaskBrief({
            description: opts.description,
            contextFile: opts.contextFile,
            planUrl: opts.planUrl,
          });

          const paths = configPaths();
          await ensureRunning(daemonOpts(paths));
          const rpc = await createRPCClient(paths.socketPath);

          try {
            const board = await rpc.call<import('../types/index.js').BoardSnapshot>('getBoard');

            if (!board.tracks.some((track) => track.id === opts.track)) {
              throw new Error(
                `Unknown --track "${opts.track}". Known tracks: ${board.tracks
                  .map((track) => track.id)
                  .join(', ')}`,
              );
            }

            // Falls back to whichever card this command is itself running
            // inside — set by the session bootstrap script — so a card spun off
            // from a running session is marked as its subtask with no extra
            // flag. The env var is tried first (no filesystem walk needed);
            // the worktree marker file catches it when a sandboxed Bash tool
            // call dropped the env var but still runs with the right cwd.
            const autoDetectedParentId =
              (process.env['AGENTBOARD_TASK_ID'] || undefined) ??
              findParentTaskIdFromWorktree(process.cwd());
            let parentTaskId = opts.parent ?? autoDetectedParentId;
            if (parentTaskId && !board.tasks.some((task) => task.id === parentTaskId)) {
              if (opts.parent) {
                throw new Error(`Unknown --parent "${parentTaskId}". No card with that id exists.`);
              }
              // Auto-detected from a stale marker (e.g. the parent card was
              // since deleted): drop the link rather than blocking creation
              // over a bonus feature the user made no explicit claim about.
              parentTaskId = undefined;
            }

            let repo: RepoRecord | undefined;
            if (!opts.general) {
              if (opts.repo) {
                repo = resolveRef(board.repos, opts.repo, 'repo');
              } else if (board.repos.length === 1) {
                // Unambiguous: there is nothing else the card could belong to.
                repo = board.repos[0];
              } else {
                throw new Error(
                  'Pass --repo <id|label>, or --general for a task with no repo. ' +
                    `Known repos: ${board.repos.map((r) => `${r.id} (${r.label})`).join(', ') || 'none'}`,
                );
              }

              if (opts.location === 'remote' && !repo!.remotePath) {
                throw new Error(
                  `Repo ${repo!.id} has no remotePath configured, so it cannot run remotely. ` +
                    'Set "remotePath" for the repo, or use --location local.',
                );
              }
            }

            const pillarId = opts.pillar
              ? resolveRef(board.pillars, opts.pillar, 'pillar').id
              : repo?.defaultPillarId;

            const created = await rpc.call<TaskRecord>('createTask', {
              title,
              kind: opts.general ? 'general' : 'repo',
              parentTaskId,
              sessionName: opts.sessionName,
              repoId: repo?.id,
              pillarId,
              agentCli: opts.agent,
              location: opts.location,
              trackId: opts.track,
              description: brief,
              initialPrompt: brief,
            });

            // Opening the session is what starts the agent on the brief, and it
            // also walks the card out of the backlog.
            const session = opts.start
              ? await rpc.call<import('../types/index.js').SessionRecord>('openSession', {
                  taskId: created.id,
                })
              : null;

            if (opts.json) {
              console.log(JSON.stringify({ task: created, session }, null, 2));
              return;
            }

            console.log(`Created task ${created.id}: ${created.title}`);
            // Labelled `task`, matching the `repo` line below it: both are bare
            // ids in the same shape, printed a few lines apart, and the repo id
            // was being picked up and passed to commands that wanted this one.
            console.log(`  task    ${created.id}`);
            if (created.branchName) {
              console.log(`  branch  ${created.branchName}`);
            }
            console.log(`  repo    ${created.repoId ?? '(general)'}`);
            console.log(`  agent   ${created.agentCli} (${created.location})`);
            if (created.sessionName) {
              console.log(`  session ${created.sessionName}`);
            }
            if (created.parentTaskId) {
              console.log(`  subtask of ${created.parentTaskId}`);
            }
            if (brief) {
              console.log(`  brief   ${brief.split('\n')[0]}`);
            }
            if (session) {
              console.log(
                session.attachCommand
                  ? `Session started. Attach with: ${session.attachCommand}`
                  : `Session started: ${session.id}`,
              );
            } else {
              console.log(`Start it with: agentboard attach ${created.id}`);
            }
          } finally {
            rpc.disconnect();
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  task
    .command('notify <id> <message>')
    .description(
      "Type a message into another card's live session — e.g. ping a subtask to address PR comments",
    )
    .action(async (id: string, message: string) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);

        try {
          const board = await rpc.call<import('../types/index.js').BoardSnapshot>('getBoard');
          if (!board.tasks.some((t) => t.id === id)) {
            throw new Error(`Unknown task "${id}". No card with that id exists.`);
          }

          announceDeliveryWait();
          const outcome = await rpc.call<{
            delivered: boolean;
            queued: boolean;
            landedUnsubmitted?: boolean;
          }>(
            'notifyTaskSession',
            {
              taskId: id,
              message,
              // Same two-path detection `task create` uses for subtask
              // linking, so a queued message can name the card that sent it.
              fromTaskId:
                (process.env['AGENTBOARD_TASK_ID'] || undefined) ??
                findParentTaskIdFromWorktree(process.cwd()),
            },
          );

          if (outcome.delivered) {
            console.log(`Delivered to ${id}'s live session.`);
          } else if (outcome.queued) {
            // Not a failure: the message is stored and handed to the agent on
            // its own argv the next time the card's session opens.
            console.log(
              `Queued for ${id} — it will be delivered when that card's session next opens.`,
            );
          } else if (outcome.landedUnsubmitted) {
            // Distinct from queued on purpose: the text is on the pane, so it
            // is not waiting anywhere and must not be re-sent — that would
            // stack a second copy under the first. See issue #46.
            console.log(
              `Task ${id}: the message reached the pane's input box but was never submitted. ` +
                `Do not re-send it — that stacks a second copy. Replace the pane with \`agentboard task restart ${id}\`, ` +
                'which keeps the card, its branch, its worktree and its conversation.',
            );
            process.exitCode = 1;
          } else {
            console.log(`Task ${id}: nothing was delivered.`);
            process.exitCode = 1;
          }
        } finally {
          rpc.disconnect();
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  task
    .command('redeliver-prompt <id>')
    .description(
      "Re-send a card's opening brief into its live session — rarely needed, since the brief now reaches the agent on its own argv at launch",
    )
    .action(async (id: string) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);

        try {
          const board = await rpc.call<import('../types/index.js').BoardSnapshot>('getBoard');
          if (!board.tasks.some((t) => t.id === id)) {
            throw new Error(`Unknown task "${id}". No card with that id exists.`);
          }

          announceDeliveryWait();
          const outcome = await rpc.call<{
            delivered: boolean;
            reason?: import('../services/session-manager.js').RedeliverFailureReason;
          }>('redeliverInitialPrompt', { taskId: id });

          if (outcome.delivered) {
            console.log(`Re-delivered ${id}'s brief to its live session.`);
          } else {
            console.log(explainRedeliverFailure(id, outcome.reason));
            process.exitCode = 1;
          }
        } finally {
          rpc.disconnect();
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  task
    .command('attach-pr <task> <prNumber>')
    .description(
      "Manually attach a pull request auto-discovery missed, by its number — resolves the branch itself",
    )
    .option('--repo <ref>', "Repo the PR is in (defaults to the card's own repo)")
    .option('--base <branch>', "Base branch for the PR, if not the repo's default")
    .action(async (taskId: string, prNumberArg: string, opts: { repo?: string; base?: string }) => {
      try {
        const prNumber = Number.parseInt(prNumberArg, 10);
        if (!Number.isFinite(prNumber) || prNumber <= 0) {
          throw new Error(`Invalid PR number "${prNumberArg}".`);
        }

        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);

        try {
          const board = await rpc.call<import('../types/index.js').BoardSnapshot>('getBoard');
          const task = board.tasks.find((t) => t.id === taskId);
          if (!task) {
            throw new Error(`Unknown task "${taskId}". No card with that id exists.`);
          }
          if (task.kind === 'general') {
            throw new Error(`Task ${taskId} is a general card — it has no repo to attach a PR to.`);
          }

          const repo = opts.repo
            ? resolveRef(board.repos, opts.repo, 'repo')
            : board.repos.find((r) => r.id === task.repoId);
          if (!repo) {
            throw new Error(
              'Pass --repo <id|label> — this card has no repo of its own to default to.',
            );
          }

          await rpc.call('addTaskBranch', {
            taskId,
            repoId: repo.id,
            prNumber,
            ...(opts.base ? { baseBranch: opts.base } : {}),
          });

          console.log(
            `Attached PR #${prNumber} from ${repo.label} to task ${taskId}. Sync will fill in its state shortly.`,
          );
        } finally {
          rpc.disconnect();
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  task
    .command('restart <task>')
    .description(
      "Restart a card's session in place — keeps the card id, its branch, its worktree and its conversation",
    )
    .option('--slot <slot>', "Which session to restart ('primary' or 'secondary')", 'primary')
    .action(async (taskId: string, opts: { slot?: string }) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);

        try {
          const board = await rpc.call<import('../types/index.js').BoardSnapshot>('getBoard');
          const task = board.tasks.find((t) => t.id === taskId);
          if (!task) {
            throw new Error(`Unknown task "${taskId}". No card with that id exists.`);
          }

          const slot = opts.slot === 'secondary' ? 'secondary' : 'primary';
          const session = await rpc.call<import('../types/index.js').SessionRecord>(
            'recreateSession',
            { taskId, slot },
          );

          console.log(`Restarted ${taskId}: ${task.title}`);
          console.log(`  task    ${taskId}`);
          if (task.branchName) {
            console.log(`  branch  ${task.branchName}`);
          }
          // The point of the command: nothing about the card is thrown away,
          // which is what made delete-and-recreate such an expensive way to
          // get a working pane back.
          console.log(`  agent   resumes the conversation it already had`);
          if (session.attachCommand) {
            console.log(`Attach with: ${session.attachCommand}`);
          }
        } finally {
          rpc.disconnect();
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  task
    .command('orchestrator [task]')
    .description(
      "Mark a card as an orchestrator — pinned to the top of its column with a distinct background. Defaults to the calling session's own card. A top-level card is marked automatically on its first subtask",
    )
    .option('--off', 'Unmark the card instead')
    .action(async (taskArg: string | undefined, opts: { off?: boolean }) => {
      try {
        // Same two-path self-detection `task create` uses for subtask linking,
        // so an agent can mark its own card without knowing its id.
        const taskId =
          taskArg ??
          (process.env['AGENTBOARD_TASK_ID'] || undefined) ??
          findParentTaskIdFromWorktree(process.cwd());
        if (!taskId) {
          throw new Error(
            'No task id given, and this is not running inside a card\'s session. Pass the card id explicitly.',
          );
        }

        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);

        try {
          const board = await rpc.call<import('../types/index.js').BoardSnapshot>('getBoard');
          const task = board.tasks.find((t) => t.id === taskId);
          if (!task) {
            throw new Error(`Unknown task "${taskId}". No card with that id exists.`);
          }

          const orchestrator = !opts.off;
          await rpc.call('setTaskOrchestrator', { taskId, orchestrator });
          console.log(
            orchestrator
              ? `Marked ${taskId} (${task.title}) as an orchestrator.`
              : `Unmarked ${taskId} (${task.title}) as an orchestrator.`,
          );
        } finally {
          rpc.disconnect();
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  task
    .command('delete <task>')
    .description(
      "Delete a card — terminates its session(s) and removes its worktree(s), archiving any uncommitted work first",
    )
    .option('--force', 'Skip the confirmation and delete immediately')
    .option(
      '--purge',
      'Also destroy uncommitted work instead of archiving it to a git ref (not reversible)',
    )
    .action(async (taskId: string, opts: { force?: boolean; purge?: boolean }) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);

        try {
          const board = await rpc.call<import('../types/index.js').BoardSnapshot>('getBoard');
          const task = board.tasks.find((t) => t.id === taskId);
          if (!task) {
            throw new Error(`Unknown task "${taskId}". No card with that id exists.`);
          }

          const dirty =
            task.hasUntracked ||
            task.hasConflicts ||
            task.gitState === 'dirty' ||
            task.gitState === 'untracked' ||
            task.gitState === 'conflicted';

          if (!opts.force) {
            console.log(`About to delete task ${task.id}: ${task.title}`);
            if (task.worktreePath) {
              console.log(`  worktree ${task.worktreePath}`);
            }
            if (dirty) {
              console.log(
                opts.purge
                  ? '  ⚠ this worktree has uncommitted changes, and --purge will destroy them.'
                  : '  · this worktree has uncommitted changes — they will be committed and kept.',
              );
            }
            console.log('This terminates its session(s) and removes its worktree(s).');
            console.log('Re-run with --force to actually delete it.');
            process.exitCode = 1;
            return;
          }

          const outcome = await rpc.call<{ archivedShas: string[]; archiveRef: string }>(
            'deleteTask',
            { id: taskId, purge: opts.purge === true },
          );
          console.log(`Deleted task ${taskId}: ${task.title}`);
          // Says where the work went. Agents write their findings into the
          // worktree they are working in, so deleting a card used to mean
          // deleting the agent's output with nothing said about it.
          if (outcome.archivedShas.length > 0) {
            console.log(
              `  kept    uncommitted work as ${outcome.archivedShas.join(', ')} (${outcome.archiveRef})`,
            );
            console.log(`  recover git log -p ${outcome.archiveRef}`);
          } else if (opts.purge && dirty) {
            console.log('  purged  uncommitted work, as requested');
          }
        } finally {
          rpc.disconnect();
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // repos
  // ----------------------------------------------------------
  const repos = program.command('repos').description('Manage repositories');

  repos
    .command('add <path>')
    .description('Register a repository with AgentBoard')
    .option('--label <label>', 'Human-readable label for the repo')
    .action(async (repoPath: string, opts: { label?: string }) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        const repo = await rpc.call<RepoRecord>('addRepo', {
          path: repoPath,
          label: opts.label,
        });
        rpc.disconnect();
        console.log(JSON.stringify(repo, null, 2));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  repos
    .command('ls')
    .description('List registered repositories')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        const repoList = await rpc.call<RepoRecord[]>('listRepos');
        rpc.disconnect();

        if (opts.json) {
          console.log(JSON.stringify(repoList, null, 2));
        } else {
          printRepoTable(repoList);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  repos
    .command('set-default-base-branch <id> <branch>')
    .description("Update a repository's default base branch")
    .action(async (id: string, branch: string) => {
      try {
        const paths = configPaths();
        const repo = await updateRepoWithFallback(paths, {
          id,
          defaultBaseBranch: branch,
        });
        console.log(JSON.stringify(repo, null, 2));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  repos
    .command('rm <id>')
    .description('Remove a registered repository')
    .action(async (id: string) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        await rpc.call('removeRepo', { id });
        rpc.disconnect();
        console.log(`Repo ${id} removed.`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  repos
    .command('delete-worktrees')
    .description('Delete every registered git worktree and clear stored task worktree paths')
    .action(async () => {
      try {
        const paths = configPaths();
        const result = await cleanupAllRepoWorktrees(paths);

        if (result.daemonStopped) {
          console.log('Daemon stopped for worktree cleanup.');
        }

        if (result.removedWorktrees.length === 0) {
          console.log('No worktrees found.');
          return;
        }

        console.log(
          `Deleted ${result.removedWorktrees.length} worktree(s); cleared ${result.clearedTaskCount} task worktree reference(s).`,
        );
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // mcp — sign in to the server backing the artifacts rail
  // ----------------------------------------------------------
  const mcp = program.command('mcp').description('Manage the MCP connection used by the artifacts rail');

  mcp
    .command('login')
    .description('Sign in to the MCP server in your browser')
    .action(async () => {
      try {
        const paths = configPaths();
        const config = loadConfig();
        const serverUrl = config.artifacts?.mcpServerUrl ?? 'https://mcp-s.wewix.net/mcp';

        const { McpOAuthClient } = await import('../services/mcp/oauth.js');
        const auth = new McpOAuthClient({
          serverUrl,
          credentialsPath: paths.mcpCredentialsFile,
        });

        console.log(`Signing in to ${serverUrl} ...`);
        await auth.login((url) => {
          console.log('If your browser did not open, visit:\n' + url);
        });
        console.log('Signed in. Restart the daemon to pick it up: agentboard daemon stop && agentboard daemon start');
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  mcp
    .command('status')
    .description('Show whether the artifacts rail can reach its MCP server')
    .action(async () => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        const snapshot = await rpc.call<import('../types/index.js').ArtifactsSnapshot>('getArtifacts');
        rpc.disconnect();

        if (snapshot.needsAuth) {
          console.log('Not signed in. Run: agentboard mcp login');
        } else if (snapshot.refreshedAt === 0) {
          console.log('No artifacts loaded yet.');
        } else {
          const age = Math.round((Date.now() - snapshot.refreshedAt) / 1000);
          console.log(
            `${snapshot.artifacts.length} artifact(s), refreshed ${age}s ago${snapshot.stale ? ' (stale)' : ''}`
          );
        }
        if (snapshot.error) {
          console.log(`Last error: ${snapshot.error}`);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  mcp
    .command('logout')
    .description('Forget the cached MCP tokens')
    .action(async () => {
      const paths = configPaths();
      const config = loadConfig();
      const { McpOAuthClient } = await import('../services/mcp/oauth.js');
      new McpOAuthClient({
        serverUrl: config.artifacts?.mcpServerUrl ?? 'https://mcp-s.wewix.net/mcp',
        credentialsPath: paths.mcpCredentialsFile,
      }).logout();
      console.log('Signed out.');
    });

  // ----------------------------------------------------------
  // sync
  // ----------------------------------------------------------
  program
    .command('sync')
    .description('Trigger a GitHub sync')
    .action(async () => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        const result = await rpc.call<import('../types/index.js').SyncResult>('triggerSync');
        rpc.disconnect();
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // gc
  // ----------------------------------------------------------
  program
    .command('gc')
    .description('Garbage-collect old data (not yet implemented)')
    .action(() => {
      console.log('gc not yet implemented');
    });

  // ----------------------------------------------------------
  // daemon
  // ----------------------------------------------------------
  const daemon = program.command('daemon').description('Manage the AgentBoard background daemon');

  daemon
    .command('start')
    .description('Start the daemon if it is not already running')
    .action(async () => {
      try {
        const paths = configPaths();
        const { isDaemonRunning } = await import('../daemon/index.js');
        if (await isDaemonRunning(paths.socketPath)) {
          console.log('Daemon already running.');
          return;
        }

        await ensureRunning(daemonOpts(paths));
        console.log('Daemon started.');
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  daemon
    .command('stop')
    .description('Stop the daemon')
    .action(async () => {
      try {
        const paths = configPaths();
        const stopped = await stopDaemon({
          stateDir: paths.stateDir,
          socketPath: paths.socketPath,
          logFile: paths.logFile,
        });
        if (!stopped) {
          console.log('Daemon is not running.');
          return;
        }
        console.log('Daemon stopped.');
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  daemon
    .command('status')
    .description('Show daemon status')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        const status = await rpc.call<DaemonStatus>('daemonStatus');
        rpc.disconnect();

        if (opts.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          const rows: Array<[string, string | number]> = [
            ['version', status.version],
            ['pid', status.pid],
            ['uptime (s)', Math.round(status.uptime / 1000)],
            ['db', status.dbPath],
            ['socket', status.socketPath],
          ];
          const labelWidth = Math.max(...rows.map(([k]) => k.length));
          for (const [k, v] of rows) {
            console.log(`${k.padEnd(labelWidth)}  ${v}`);
          }
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // Suppress Commander's allowUnknownOption so unrecognised flags surface
  // as proper errors rather than silently passing through.
  program.allowUnknownOption(false);

  // loadConfig is available for commands that need runtime config.
  void loadConfig;

  return program;
}
