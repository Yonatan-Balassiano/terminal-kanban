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
import { ensureRunning, stopDaemon } from '../daemon/index.js';
import { createRPCClient } from './rpc.js';
import type {
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
  params: UpdateRepoParams,
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

function statusSymbol(status: DoctorCheck['status']): string {
  switch (status) {
    case 'pass': return '✓ pass';
    case 'warn': return '⚠ warn';
    case 'fail': return '✗ fail';
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
  const rows = tasks.map((t) => [
    t.id,
    t.title,
    t.trackId,
    t.prState,
    t.ciState,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(fmt(row.map(String)));
  }
}

function filterListedTasks(tasks: TaskRecord[], archivedOnly: boolean): TaskRecord[] {
  if (!archivedOnly) {
    return tasks;
  }

  return tasks.filter((task) => task.archivedAt !== undefined);
}

function printRepoTable(repos: RepoRecord[]): void {
  if (repos.length === 0) {
    console.log('No repos registered.');
    return;
  }
  const header = ['ID', 'Label', 'Path', 'Base', 'Health'];
  const rows = repos.map((r) => [r.id, r.label, r.path, r.defaultBaseBranch, r.health]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join('  ');
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

function launchGoTUI(socketPath: string): void {
  const binary = resolveGoTUIBinary();
  if (!binary) {
    throw new Error('Go TUI binary not found. Run `npm run build:go` or `npm run build` first.');
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
  program.action(async () => {
    try {
      const paths = configPaths();
      await ensureRunning(daemonOpts(paths));
      launchGoTUI(paths.socketPath);
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
        const doctor = new DoctorService(db, paths.socketPath);
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
        const session = await rpc.call<import('../types/index.js').SessionRecord>(
          'openSession',
          { taskId: task },
        );
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
    .option('--archived', 'List archived tasks only')
    .option('--json', 'Output as JSON')
    .action(async (opts: { repo?: string; archived?: boolean; json?: boolean }) => {
      try {
        const paths = configPaths();
        await ensureRunning(daemonOpts(paths));
        const rpc = await createRPCClient(paths.socketPath);
        const board = await rpc.call<import('../types/index.js').BoardSnapshot>(
          'getBoard',
          {
            ...(opts.repo ? { repoId: opts.repo } : {}),
            ...(opts.archived ? { filter: { includeArchived: true } } : {}),
          },
        );
        rpc.disconnect();

        const tasks = filterListedTasks(board.tasks, opts.archived === true);

        if (opts.json) {
          console.log(JSON.stringify(tasks, null, 2));
        } else {
          printTaskTable(tasks, opts.archived ? 'No archived tasks found.' : 'No tasks found.');
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ----------------------------------------------------------
  // repos
  // ----------------------------------------------------------
  const repos = program
    .command('repos')
    .description('Manage repositories');

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
  const daemon = program
    .command('daemon')
    .description('Manage the AgentBoard background daemon');

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
