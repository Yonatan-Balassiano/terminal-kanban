// ============================================================
// AgentBoard — Daemon bootstrap + lifecycle
// ============================================================

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// --------------- ServiceContainer ---------------------------

export interface ServiceContainer {
  board: import('../services/board.js').BoardService;
  workspace: import('../services/workspace.js').WorkspaceService;
  worktrees: import('../services/worktree.js').WorktreeService;
  session: import('../services/session-manager.js').SessionManager;
  git: import('../services/git.js').GitService;
  github: import('../services/github.js').GitHubService;
  sync: import('../services/sync.js').SyncService;
  view: import('../services/view.js').ViewService;
  events: import('../services/events.js').EventLogService;
  doctor: import('../services/doctor.js').DoctorService;
  db: import('../db/index.js').Db;
  dbPath: string;
}

// --------------- PID file helpers ---------------------------

export function writePidFile(pidPath: string): void {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
}

export function readPidFile(pidPath: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removePidFile(pidPath: string): void {
  try {
    fs.unlinkSync(pidPath);
  } catch {
    // Already gone — that's fine.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireDaemonLock(lockPath: string, logFile: string): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), {
        encoding: 'utf8',
        flag: 'wx',
      });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }

      const existingPid = readPidFile(lockPath);
      if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) {
        appendLog(
          logFile,
          `[daemon] duplicate start refused pid=${process.pid} active_pid=${existingPid}`,
        );
        return false;
      }

      removePidFile(lockPath);
    }
  }
}

// --------------- Log helper ---------------------------------

function appendLog(logFile: string, message: string): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // Best-effort logging; never crash the daemon over a log write failure.
  }
}

const BOARD_TRACKS = [
  { id: 'backlog', label: 'Backlog', sortOrder: 0 },
  { id: 'in-progress', label: 'In Progress', sortOrder: 1 },
  { id: 'done', label: 'Done', sortOrder: 2 },
] as const;

function normalizeBoardTracks(
  tracks: Array<{ id: string; label: string }> | undefined,
): Array<{ id: string; label: string; sortOrder: number }> {
  return BOARD_TRACKS.map((track) => ({
    ...track,
    label: tracks?.find((candidate) => candidate.id === track.id)?.label ?? track.label,
  }));
}

// --------------- isDaemonRunning ----------------------------

export async function isDaemonRunning(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    const cleanup = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };

    const timeout = setTimeout(() => cleanup(false), 2000);

    socket.connect(socketPath, () => {
      // Connection established — send a daemonStatus RPC request.
      const req = JSON.stringify({
        id: 'health-check',
        method: 'daemonStatus',
      });
      socket.write(req + '\n');
    });

    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const resp = JSON.parse(trimmed) as { id: string; result?: unknown };
          if (resp.id === 'health-check' && resp.result) {
            clearTimeout(timeout);
            cleanup(true);
            return;
          }
        } catch {
          // Malformed — treat as not running.
        }
        clearTimeout(timeout);
        cleanup(false);
        return;
      }
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      cleanup(false);
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      cleanup(false);
    });
  });
}

// --------------- startDaemon --------------------------------

export interface DaemonOpts {
  configFile: string;
  dbPath: string;
  socketPath: string;
  logFile: string;
  stateDir: string;
}

/**
 * Fork a detached background daemon process.
 * The spawned process must call `runDaemon()` with the same opts.
 * This function returns immediately after forking.
 */
export function startDaemon(opts: DaemonOpts): void {
  // We re-invoke the current entry-point binary with a special
  // `--daemon` flag so the child can detect it should call runDaemon().
  // The caller is responsible for wiring that flag in the CLI entry point.
  const child = spawn(process.execPath, [process.argv[1], '--daemon'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      AGENTBOARD_DAEMON_CONFIG: opts.configFile,
      AGENTBOARD_DAEMON_DB: opts.dbPath,
      AGENTBOARD_DAEMON_SOCKET: opts.socketPath,
      AGENTBOARD_DAEMON_LOG: opts.logFile,
      AGENTBOARD_DAEMON_STATE_DIR: opts.stateDir,
    },
  });

  child.unref();
}

// --------------- runDaemon ----------------------------------

/**
 * The actual daemon body.  This runs inside the forked/background process.
 * It blocks (via the open server handle) until a signal triggers shutdown.
 */
export async function runDaemon(opts: DaemonOpts): Promise<void> {
  const pidFile = path.join(opts.stateDir, 'daemon.pid');
  const lockFile = path.join(opts.stateDir, 'daemon.lock');

  if (!acquireDaemonLock(lockFile, opts.logFile)) {
    return;
  }

  const cleanupInstanceFiles = () => {
    if (readPidFile(pidFile) === process.pid) {
      removePidFile(pidFile);
    }
    if (readPidFile(lockFile) === process.pid) {
      removePidFile(lockFile);
    }
  };
  process.on('exit', cleanupInstanceFiles);

  // Write PID file.
  writePidFile(pidFile);
  appendLog(opts.logFile, `[daemon] started pid=${process.pid} socket=${opts.socketPath}`);

  // Open the database.
  const { openDb } = await import('../db/index.js');
  const db = openDb(opts.dbPath);

  // ---- Wire up all services -----------------------------------
  const { BoardService } = await import('../services/board.js');
  const { WorkspaceService } = await import('../services/workspace.js');
  const { ViewService } = await import('../services/view.js');
  const { GitService } = await import('../services/git.js');
  const { GitHubService } = await import('../services/github.js');
  const { SyncService } = await import('../services/sync.js');
  const { EventLogService } = await import('../services/events.js');
  const { DoctorService } = await import('../services/doctor.js');
  const { TerminalBufferService } = await import('../services/terminal-buffer.js');
  const { SessionManager } = await import('../services/session-manager.js');
  const { WorktreeService } = await import('../services/worktree.js');
  const { serverEvents, startServer } = await import('./server.js');

  const board = new BoardService(db);
  const workspace = new WorkspaceService(db);
  const view = new ViewService(board);
  const git = new GitService();
  const github = new GitHubService();
  const events = new EventLogService(db);
  const doctor = new DoctorService(db, opts.socketPath);
  const buffers = new TerminalBufferService();
  const worktrees = new WorktreeService(db, board, git);
  const session = new SessionManager(db, board, worktrees, buffers, (taskId, buffer) => {
    serverEvents.emit('event', {
      type: 'session_update',
      payload: { taskId, ...buffer },
    });
  });
  const sync = new SyncService(board, github, git, db);

  // ---- Load config and seed tracks + poll interval -----------
  const { loadConfig } = await import('../config/index.js');
  let pollIntervalMs = 60000;
  try {
    const cfg = loadConfig();
    pollIntervalMs = Math.min(Math.max(cfg.pollIntervalMs, 10_000), 60_000);
    for (const t of normalizeBoardTracks(cfg.tracks)) {
      board.upsertTrack(t.id, t.label, t.sortOrder);
    }
  } catch {
    for (const t of BOARD_TRACKS) {
      board.upsertTrack(t.id, t.label, t.sortOrder);
    }
  }

  const reviewTasks = board
    .getTasks({ includeArchived: true })
    .filter((task) => task.trackId === 'review');
  for (const task of reviewTasks) {
    board.moveTask({ id: task.id, trackId: 'in-progress' });
  }
  board.deleteTrack('review');
  sync.start(pollIntervalMs);

  // ---- Fan sync events to server subscribers -----------------
  sync.syncEvent.on('sync', (event: unknown) => {
    const payload = event as
      | { kind: 'status'; status: 'started' | 'done' }
      | { kind: 'result'; result: { tasksUpdated?: number; errors?: string[] } };

    if (payload.kind === 'status') {
      serverEvents.emit('event', {
        type: 'sync_status',
        payload: { status: payload.status },
      });
      return;
    }

    const syncResult = payload.result;
    if ((syncResult.tasksUpdated ?? 0) === 0 && (syncResult.errors?.length ?? 0) === 0) {
      return;
    }

    serverEvents.emit('event', {
      type: 'board_patch',
      payload: view.getBoardSnapshot(),
    });
  });

  const services: ServiceContainer = { db, dbPath: opts.dbPath, board, workspace, worktrees, session, git, github, sync, view, events, doctor };

  const server = startServer(opts.socketPath, services);

  // Graceful shutdown handler.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    appendLog(opts.logFile, `[daemon] received ${signal}, shutting down`);

    server.close(() => {
      try {
        sync.stop();
      } catch {
        // Ignore stop errors.
      }
      try {
        db.close();
      } catch {
        // Ignore close errors.
      }
      cleanupInstanceFiles();
      try {
        fs.unlinkSync(opts.socketPath);
      } catch {
        // Socket already gone.
      }
      appendLog(opts.logFile, `[daemon] stopped`);
      process.exit(0);
    });

    // Force-kill after 5 s if the server hasn't drained.
    setTimeout(() => {
      appendLog(opts.logFile, `[daemon] force exit after timeout`);
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // Keep the process alive — the open server handle does this automatically,
  // but an explicit wait makes the intent clear.
  await new Promise<void>((resolve) => {
    server.on('close', resolve);
  });
}

// --------------- ensureRunning ------------------------------

/**
 * If the daemon is not already up, fork it and wait up to 5 s for the
 * socket to become available.
 */
export async function ensureRunning(paths: {
  socketPath: string;
  configFile: string;
  dbPath: string;
  logFile: string;
  stateDir: string;
}): Promise<void> {
  const running = await isDaemonRunning(paths.socketPath);
  if (running) return;

  startDaemon(paths);

  // Poll for up to 5 s in 200 ms increments.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isDaemonRunning(paths.socketPath)) return;
  }

  throw new Error(`Daemon did not start within 5 s (socket: ${paths.socketPath})`);
}
