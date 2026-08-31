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
  taskLifecycle: import('../services/task-lifecycle.js').TaskLifecycleService;
  session: import('../services/session-manager.js').SessionManager;
  teleport: import('../services/teleport.js').TeleportService;
  git: import('../services/git.js').GitService;
  github: import('../services/github.js').GitHubService;
  sync: import('../services/sync.js').SyncService;
  view: import('../services/view.js').ViewService;
  events: import('../services/events.js').EventLogService;
  doctor: import('../services/doctor.js').DoctorService;
  /** Absent when no artifacts are configured. */
  artifacts?: import('../services/artifacts.js').ArtifactsService;
  /** Absent for the same reason: without a catalog nothing can be resolved. */
  release?: import('../services/release-tracker.js').ReleaseTracker;
  /**
   * Brings the rail up for a list that was empty when the daemon started.
   *
   * Without this the rail could only ever be edited once it already existed,
   * so the very first artifact could not be added from the board at all.
   * Undefined outside the daemon, where partial containers are dispatched
   * against directly.
   */
  enableArtifacts?: (
    names: readonly string[]
  ) => Promise<import('../services/artifacts.js').ArtifactsService | undefined>;
  aiChat: import('../services/ai-chat.js').AIChatService;
  ollama?: import('../services/ollama.js').ManagedOllamaService;
  db: import('../db/index.js').Db;
  dbPath: string;
  logError?: (message: string, error?: unknown) => void;
}

// --------------- Artifacts rail ------------------------------

/** Default MCP endpoint serving the devex tools the rail reads. */
const DEFAULT_MCP_SERVER_URL = 'https://mcp-s.wewix.net/mcp';

/**
 * Builds the artifacts service, or returns undefined when the rail is not
 * configured.
 *
 * Constructing it never performs a login: the OAuth client only reads its cached
 * token, and a missing one surfaces on the snapshot as `needsAuth` so the daemon
 * starts normally whether or not the user has signed in.
 */
async function createArtifactsService(
  cfg: import('../types/index.js').AppConfig,
  dbPath: string,
  // Defaults to what the config held at startup; passed explicitly when the
  // list has just been edited, since the loaded config still has the old one.
  names: readonly string[] = cfg.artifacts?.list ?? []
): Promise<
  | {
      artifacts: import('../services/artifacts.js').ArtifactsService;
      // Handed back so release tracking can reach devex over the same
      // connection rather than opening a second authenticated one.
      client: import('../services/mcp/client.js').McpClient;
    }
  | undefined
> {
  if (names.length === 0) {
    return undefined;
  }

  const { McpOAuthClient } = await import('../services/mcp/oauth.js');
  const { McpClient } = await import('../services/mcp/client.js');
  const { ArtifactsService } = await import('../services/artifacts.js');

  const { CommitOwnership, resolveGithubLogin } = await import('../services/commit-ownership.js');

  // Ownership is optional: without a resolvable GitHub login the footer simply
  // does not claim to know which pending RCs are yours.
  const login = cfg.artifacts?.githubLogin ?? (await resolveGithubLogin());
  const ownership = login ? new CommitOwnership({ login }) : undefined;

  const serverUrl = cfg.artifacts?.mcpServerUrl ?? DEFAULT_MCP_SERVER_URL;
  const auth = new McpOAuthClient({
    serverUrl,
    // Sits beside the database, which is already per-user state.
    credentialsPath: path.join(path.dirname(dbPath), 'mcp-auth.json'),
  });

  const client = new McpClient({ serverUrl, auth });

  return {
    client,
    artifacts: new ArtifactsService({
      client,
      artifactNames: names,
      refreshIntervalMs: cfg.artifacts?.refreshIntervalMs,
      ownership,
    }),
  };
}

// --------------- Release tracking ----------------------------

/**
 * Builds the service that answers "has this card's merged work shipped?".
 *
 * The pull-request lookup is supplied as a function so the tracker is unaware
 * of how a card stores its work — one branch today, several later.
 */
async function createReleaseTracker(deps: {
  db: import('../db/index.js').Db;
  board: import('../services/board.js').BoardService;
  workspace: import('../services/workspace.js').WorkspaceService;
  github: import('../services/github.js').GitHubService;
  client: import('../services/mcp/client.js').McpClient;
  artifacts: import('../services/artifacts.js').ArtifactsService;
}): Promise<import('../services/release-tracker.js').ReleaseTracker> {
  const { ReleaseStatusService } = await import('../services/release-status.js');
  const { ReleaseTracker } = await import('../services/release-tracker.js');

  // Read from the card's branches, not its rolled-up columns: tasks.pr_number is
  // null by design once a card carries more than one pull request, so anything
  // reading it would silently see a multi-repo feature as having no work at all.
  const prsForTask = (taskId: string) =>
    deps.board
      .getTaskBranches(taskId)
      .flatMap((branch) => {
        if (branch.prNumber === undefined) {
          return [];
        }

        const repo = deps.workspace.getRepo(branch.repoId);
        if (!repo?.githubOwner || !repo.githubRepo) {
          return [];
        }

        return [
          {
            repoSlug: `${repo.githubOwner}/${repo.githubRepo}`,
            prNumber: branch.prNumber,
            repoPath: repo.path,
            prState: branch.prState,
            // The merge timestamp is deliberately not passed from the stored
            // epoch: the devex release query filters on GitHub's exact string,
            // and one rebuilt from milliseconds would shift the boundary. The
            // resolver fetches it itself and caches it for the process lifetime.
          },
        ];
      });

  return new ReleaseTracker({
    db: deps.db,
    resolver: new ReleaseStatusService({
      client: deps.client,
      artifacts: deps.artifacts,
      github: deps.github,
    }),
    listTaskPRs: prsForTask,
    // Any card with merged work has something that might have shipped. Archived
    // cards are nobody's pending question.
    listTrackedTaskIds: () =>
      deps.board
        .getTasks()
        .filter((task) => task.prMergedCount > 0)
        .map((task) => task.id),
  });
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

function appendErrorLog(logFile: string, message: string, error: unknown): void {
  if (error instanceof Error) {
    const stack = error.stack?.trim();
    appendLog(
      logFile,
      stack && stack !== error.message ? `${message}: ${error.message}\n${stack}` : `${message}: ${error.message}`,
    );
    return;
  }

  appendLog(logFile, `${message}: ${String(error)}`);
}

export function warmOllamaOnStartup(
  ollama: Pick<import('../services/ollama.js').ManagedOllamaService, 'ensureModelReady'>,
  logFile: string,
): void {
  void ollama.ensureModelReady().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(logFile, `[daemon] Ollama model warmup failed: ${message}`);
  });
}

/**
 * The board's columns.
 *
 * `shipping` exists because merging stopped being the end of the story: a card
 * whose pull requests have all landed but whose artifacts have not reached
 * production is neither in review nor finished, and its worktrees must survive
 * until they are.
 */
const BOARD_TRACKS = [
  { id: 'backlog', label: 'Backlog', sortOrder: 0 },
  { id: 'in-progress', label: 'In Progress', sortOrder: 1 },
  { id: 'pr', label: 'PR', sortOrder: 2 },
  { id: 'shipping', label: 'Shipping', sortOrder: 3 },
  { id: 'done', label: 'Done', sortOrder: 4 },
] as const;

function normalizeBoardTracks(
  tracks: Array<{ id: string; label: string }> | undefined,
): Array<{ id: string; label: string; sortOrder: number }> {
  return BOARD_TRACKS.map((track) => ({
    ...track,
    label: tracks?.find((candidate) => candidate.id === track.id)?.label ?? track.label,
  }));
}

function daemonPidPaths(stateDir: string): { pidFile: string; lockFile: string } {
  return {
    pidFile: path.join(stateDir, 'daemon.pid'),
    lockFile: path.join(stateDir, 'daemon.lock'),
  };
}

function resolveDaemonPid(stateDir: string): number | null {
  const { pidFile, lockFile } = daemonPidPaths(stateDir);
  return readPidFile(pidFile) ?? readPidFile(lockFile);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(100);
  }

  return !isProcessAlive(pid);
}

function removeSocketFile(socketPath: string): void {
  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
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

export interface DaemonPaths {
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

export async function stopDaemon(paths: DaemonPaths): Promise<boolean> {
  const pid = resolveDaemonPid(paths.stateDir);

  if (!pid || !isProcessAlive(pid)) {
    removeSocketFile(paths.socketPath);
    return false;
  }

  appendLog(paths.logFile, `[daemon] stop requested pid=${pid}`);

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw err;
    }
  }

  const exited = await waitForProcessExit(pid, 6500);
  if (!exited) {
    throw new Error(`Daemon pid ${pid} did not exit within 6.5 s`);
  }

  removeSocketFile(paths.socketPath);
  return true;
}

// --------------- runDaemon ----------------------------------

/**
 * The actual daemon body.  This runs inside the forked/background process.
 * It blocks (via the open server handle) until a signal triggers shutdown.
 */
export async function runDaemon(opts: DaemonOpts): Promise<void> {
  const { pidFile, lockFile } = daemonPidPaths(opts.stateDir);

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
  const { TaskLifecycleService } = await import('../services/task-lifecycle.js');
  const { AIChatService } = await import('../services/ai-chat.js');
  const { ManagedOllamaService } = await import('../services/ollama.js');
  const { serverEvents, startServer } = await import('./server.js');
  const { shouldEmitSessionUpdate } = await import('./session-update-watch.js');
  const { loadConfig, defaultConfig } = await import('../config/index.js');

  let cfg = defaultConfig();
  try {
    cfg = loadConfig();
  } catch {
    // Fall back to defaults when config loading fails.
  }

  const { TransportRegistry } = await import('../services/transport/index.js');

  const { createRemoteProvider } = await import('../services/remote/index.js');

  // One registry for the whole daemon: the remote connection is created lazily,
  // so a board with no remote tasks never opens an SSH connection.
  const transports = new TransportRegistry(cfg.remote);

  // Null unless a provider is configured; reconnect then works against a host
  // that is already up, but cannot power one on.
  const remoteProvider = createRemoteProvider(cfg.remote);

  const board = new BoardService(db);
  const workspace = new WorkspaceService(db);
  const view = new ViewService(board);
  const git = new GitService();
  const github = new GitHubService();
  const events = new EventLogService(db);
  const doctor = new DoctorService(db, opts.socketPath, cfg.remote);

  // The artifacts rail is optional: with no configured list there is nothing to
  // show, so no MCP client and no OAuth are created at all.
  const artifactsSetup = await createArtifactsService(cfg, opts.dbPath);
  const artifacts = artifactsSetup?.artifacts;
  const buffers = new TerminalBufferService();
  const worktrees = new WorktreeService(db, board, git, transports);
  const session = new SessionManager(
    db,
    board,
    worktrees,
    buffers,
    (taskId, slot, buffer) => {
      if (!shouldEmitSessionUpdate(taskId)) {
        return;
      }
      serverEvents.emit('event', {
        type: 'session_update',
        payload: { taskId, slot, ...buffer },
      });
    },
    cfg.sessionBootstrapScript,
    cfg.sessionBackend,
    transports,
    cfg.agentPermissionMode,
    cfg.agentArgs,
    remoteProvider,
  );
  const { TeleportService } = await import('../services/teleport.js');
  const teleport = new TeleportService(db, board, session, worktrees, git, transports, cfg.remote);
  // A remote host can take minutes to wake, long after the reconnect RPC has
  // answered. This is how the finished result reaches the board.
  session.onSessionsChanged = () => {
    serverEvents.emit('event', {
      type: 'board_patch',
      payload: view.getBoardSnapshot(),
    });
  };
  // Release tracking rides the artifacts rail's connection, so it exists only
  // when that rail does — without a devex catalog there is nothing to resolve
  // a commit against.
  const release = artifactsSetup
    ? await createReleaseTracker({
        db,
        board,
        workspace,
        github,
        client: artifactsSetup.client,
        artifacts: artifactsSetup.artifacts,
      })
    : undefined;

  if (release) {
    view.releaseSummaryFor = (taskId) => release.getSummary(taskId);
  }

  const taskLifecycle = new TaskLifecycleService(db, board, git, session, transports);
  const sync = new SyncService(board, github, git, db);
  sync.transports = transports;
  // Fires on reaching done, not on a merge: a card whose pull requests have
  // landed but whose change has not shipped still needs its worktrees.
  sync.onTaskMergedOrClosed = (taskId) => taskLifecycle.cleanupTaskResources(taskId);
  // A subtask's PR is news for whichever card spawned it — deliver it straight
  // into the parent's live session when it has one; board.setChildPrAlert
  // (called alongside this) is the durable fallback for when it does not.
  sync.notifyParentOfSubtaskPR = async (parentTaskId, childTask, prNumber, prUrl) => {
    await session.notifyTaskSession(
      parentTaskId,
      `[agentboard] Automated notice, not from the user: the subtask "${childTask.title}" ` +
        `you spawned from this card just opened PR #${prNumber} (${prUrl}). Review it now — ` +
        `\`gh pr diff ${prNumber}\` / \`gh pr view ${prNumber}\` — and leave feedback with ` +
        `\`gh pr review\` if anything needs fixing, or report back what you found.`,
    );
  };
  if (release) {
    sync.isFullyReleased = (taskId) => release.isFullyReleased(taskId);
  }
  const ollama = new ManagedOllamaService(cfg.aiChat);
  const aiChat = new AIChatService({
    board,
    workspace,
    worktrees,
    session,
    sync,
    github,
    git,
    view,
    events,
    config: cfg.aiChat,
    ollama,
  });

  // ---- Load config and seed tracks + poll interval -----------
  let pollIntervalMs = 60000;
  try {
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
    board.moveTask({ id: task.id, trackId: 'pr' });
  }
  board.deleteTrack('review');

  // Sessions outlive the daemon, but ones that died while it was down would
  // otherwise keep status 'active' forever and block worktree cleanup on
  // archive. Reconciling here settles them once, off the startup path.
  void session.reconcile().catch(() => {
    // A backend that cannot answer right now is retried on the next start.
  });

  sync.start(pollIntervalMs);
  artifacts?.start();
  release?.start();

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

  const services: ServiceContainer = {
    db,
    dbPath: opts.dbPath,
    logError: (message, error) => appendErrorLog(opts.logFile, `[daemon] ${message}`, error),
    board,
    workspace,
    worktrees,
    taskLifecycle,
    session,
    teleport,
    git,
    github,
    sync,
    view,
    events,
    doctor,
    artifacts,
    release,
    aiChat,
    ollama,
  };

  // Everything the startup path wires when a list is already configured, done
  // once the first artifact arrives instead. Release tracking is included: it
  // rides the same connection, so a rail brought up here without it would
  // leave every merged card reading "nothing tracked ships this" until the
  // next restart — the very confusion the list editor exists to end.
  const buildArtifactsRail = async (
    names: readonly string[]
  ): Promise<import('../services/artifacts.js').ArtifactsService | undefined> => {
    const setup = await createArtifactsService(cfg, opts.dbPath, names);
    if (!setup) {
      return undefined;
    }

    const tracker = await createReleaseTracker({
      db,
      board,
      workspace,
      github,
      client: setup.client,
      artifacts: setup.artifacts,
    });

    services.artifacts = setup.artifacts;
    services.release = tracker;
    view.releaseSummaryFor = (taskId) => tracker.getSummary(taskId);
    sync.isFullyReleased = (taskId) => tracker.isFullyReleased(taskId);

    setup.artifacts.start();
    tracker.start();
    return setup.artifacts;
  };

  let enablingArtifacts: Promise<
    import('../services/artifacts.js').ArtifactsService | undefined
  > | null = null;

  services.enableArtifacts = (names) => {
    if (services.artifacts) {
      return Promise.resolve(services.artifacts);
    }
    // Two edits arriving together must not each build a rail: the loser would
    // be orphaned yet still polling devex on its own timer forever.
    enablingArtifacts ??= buildArtifactsRail(names).finally(() => {
      enablingArtifacts = null;
    });
    return enablingArtifacts;
  };

  const server = startServer(opts.socketPath, services);
  warmOllamaOnStartup(ollama, opts.logFile);

  // Graceful shutdown handler.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    appendLog(opts.logFile, `[daemon] received ${signal}, shutting down`);

    server.close(() => {
      void (async () => {
        try {
          sync.stop();
        } catch {
          // Ignore stop errors.
        }
        try {
          await ollama.shutdown();
        } catch {
          // Ignore Ollama shutdown errors.
        }
        try {
          db.close();
        } catch {
          // Ignore close errors.
        }
        try {
          // Remove the socket path before releasing the lock so a fast restart
          // cannot have its fresh socket unlinked by this older daemon.
          removeSocketFile(opts.socketPath);
        } catch {
          // Socket already gone.
        }
        cleanupInstanceFiles();
        appendLog(opts.logFile, `[daemon] stopped`);
        process.exit(0);
      })();
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

  const existingPid = resolveDaemonPid(paths.stateDir);
  if (existingPid && isProcessAlive(existingPid)) {
    appendLog(
      paths.logFile,
      `[daemon] unhealthy pid=${existingPid} detected during startup; attempting recovery`,
    );
    await stopDaemon(paths);
  } else {
    removeSocketFile(paths.socketPath);
  }

  startDaemon(paths);

  // Poll for up to 5 s in 200 ms increments.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isDaemonRunning(paths.socketPath)) return;
  }

  throw new Error(`Daemon did not start within 5 s (socket: ${paths.socketPath}, log: ${paths.logFile})`);
}
