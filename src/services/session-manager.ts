import type {
  SessionRecord,
  SessionBackend,
  SessionBackendType,
  SessionStatus,
  GetBufferResult,
} from '../types/index.js';
import type { Db } from '../db/index.js';
import type { BoardService } from './board.js';
import { TmuxBackend } from './session-backends/tmux.js';
import { PtyBackend } from './session-backends/pty.js';
import type { TerminalBufferService } from './terminal-buffer.js';
import { resolveTaskBranchName } from './branch-name.js';
import { extractLastOsc7Cwd } from './session-cwd.js';
import type { TaskWorkspaceInfo, WorktreeService } from './worktree.js';
import {
  deriveFallbackSessionActivity,
  deriveSessionActivity,
  hasMeaningfulTerminalOutput,
  loadProcessTable,
  type ProcessRow,
} from './session-activity.js';

// --------------- DB row shape --------------------------------

interface SessionRow {
  id: string;
  task_id: string;
  backend_type: string;
  backend_session_id: string | null;
  attach_command: string | null;
  status: string;
  cwd: string | null;
  branch: string | null;
  last_heartbeat: number | null;
  last_buffer_snapshot: string | null;
  created_at: number;
  updated_at: number;
}

interface TaskRow {
  id: string;
  title: string;
  repo_id: string;
  agent_cli: 'claude' | 'codex' | null;
  branch_name: string | null;
  worktree_path: string | null;
  session_id: string | null;
}

interface RepoRow {
  id: string;
  path: string;
  default_base_branch: string | null;
}

interface PreparedSessionWorkspace extends TaskWorkspaceInfo {
  bootstrapNotice?: string;
}

export interface InspectSessionStateResult {
  activity: import('../types/index.js').SessionActivitySnapshot | null;
  attentionChanged: boolean;
}

const processTableCacheWindowMs = 250;

// --------------- Helpers -------------------------------------

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    backendType: row.backend_type as SessionBackendType,
    backendSessionId: row.backend_session_id ?? undefined,
    attachCommand: row.attach_command ?? undefined,
    status: row.status as SessionStatus,
    cwd: row.cwd ?? undefined,
    branch: row.branch ?? undefined,
    lastHeartbeat: row.last_heartbeat ?? undefined,
    lastBufferSnapshot: row.last_buffer_snapshot ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --------------- SessionManager ------------------------------

export class SessionManager {
  private tmuxBackend?: TmuxBackend;
  private ptyBackend?: PtyBackend;
  private bufferPushInFlight = new Map<string, Promise<void>>();
  private bufferPushQueued = new Set<string>();
  private lastOutputAtByTaskId = new Map<string, number>();
  private lastBusyByTaskId = new Map<string, boolean>();
  private processTableCache?: { rows: ProcessRow[]; loadedAt: number };
  private processTableLoadInFlight?: Promise<ProcessRow[] | null>;

  constructor(
    private db: Db,
    private board: BoardService & {
      linkSession?: (taskId: string, sessionId: string) => Promise<void> | void;
      setTaskBranch?: (taskId: string, branchName: string) => Promise<void> | void;
      setTaskLastSessionCwd?: (taskId: string, cwd: string | null) => Promise<void> | void;
      setTaskSessionAttention?: (taskId: string) => boolean;
      clearTaskSessionAttention?: (taskId: string) => boolean;
    },
    private worktrees: WorktreeService,
    private buffers: TerminalBufferService,
    private onBufferUpdate?: (taskId: string, buffer: GetBufferResult) => void,
    private sessionBootstrapScript = '',
  ) {
    this.buffers.subscribeAll((taskId, buffer) => {
      this.onBufferUpdate?.(taskId, buffer);
    });
  }

  // ---- Backend factory (lazy singletons) -------------------

  getBackend(type: SessionBackendType): SessionBackend {
    if (type === 'tmux') {
      if (!this.tmuxBackend) {
        this.tmuxBackend = new TmuxBackend((taskId, data) => {
          if (hasMeaningfulTerminalOutput(data)) {
            this.noteSessionOutput(taskId);
          }
          void this.scheduleBufferPush(taskId);
        });
      }
      return this.tmuxBackend;
    }
    if (!this.ptyBackend) {
      this.ptyBackend = new PtyBackend((taskId, data) => {
        if (hasMeaningfulTerminalOutput(data)) {
          this.noteSessionOutput(taskId);
        }
        this.buffers.write(taskId, data);
        const cwd = extractLastOsc7Cwd(data);
        if (cwd) {
          this.board.setTaskLastSessionCwd?.(taskId, cwd);
        }
      });
    }
    return this.ptyBackend;
  }

  private noteSessionOutput(taskId: string): void {
    this.lastOutputAtByTaskId.set(taskId, Date.now());
  }

  private clearTaskAttention(taskId: string): boolean {
    return this.board.clearTaskSessionAttention?.(taskId) ?? false;
  }

  protected async loadProcessTableRows(): Promise<ProcessRow[] | null> {
    return loadProcessTable();
  }

  private async getProcessTableRows(): Promise<ProcessRow[] | null> {
    const now = Date.now();
    if (
      this.processTableCache &&
      now - this.processTableCache.loadedAt <= processTableCacheWindowMs
    ) {
      return this.processTableCache.rows;
    }

    if (this.processTableLoadInFlight) {
      return this.processTableLoadInFlight;
    }

    this.processTableLoadInFlight = this.loadProcessTableRows()
      .then((rows) => {
        if (rows) {
          this.processTableCache = { rows, loadedAt: Date.now() };
        }
        return rows;
      })
      .finally(() => {
        this.processTableLoadInFlight = undefined;
      });

    return this.processTableLoadInFlight;
  }

  private async scheduleBufferPush(taskId: string): Promise<void> {
    const existing = this.bufferPushInFlight.get(taskId);
    if (existing) {
      this.bufferPushQueued.add(taskId);
      await existing;
      return;
    }

    const run = (async () => {
      do {
        this.bufferPushQueued.delete(taskId);
        const buffer = await this.getBuffer(taskId);
        this.onBufferUpdate?.(taskId, buffer);
      } while (this.bufferPushQueued.has(taskId));
    })();

    this.bufferPushInFlight.set(taskId, run);

    try {
      await run;
    } finally {
      this.bufferPushInFlight.delete(taskId);
    }
  }

  private async ensureSessionBranch(
    session: SessionRecord,
    cwd: string,
    branch: string,
    previousBranch?: string,
  ): Promise<void> {
    if (!session.backendSessionId) {
      return;
    }

    const backend = this.getBackend(session.backendType);
    const commands: string[] = [];

    if (previousBranch && previousBranch !== branch) {
      commands.push(`git -C ${JSON.stringify(cwd)} checkout ${previousBranch} 2>/dev/null || true`);
    }

    commands.push(
      `git -C ${JSON.stringify(cwd)} checkout ${branch} 2>/dev/null || ` +
        `git -C ${JSON.stringify(cwd)} checkout -b ${branch}`,
    );
    const checkoutCmd = commands.join('; ');

    await backend.sendInput(session.backendSessionId, checkoutCmd);
    await backend.sendInput(session.backendSessionId, '\r');
    await this.board.setTaskBranch?.(session.taskId, branch);
  }

  private persistSessionBranch(sessionId: string, branch: string): void {
    this.db
      .prepare<[string, number, string], void>(
        'UPDATE sessions SET branch = ?, updated_at = ? WHERE id = ?',
      )
      .run(branch, Date.now(), sessionId);
  }

  private async prepareWorkspaceForSession(
    taskId: string,
    repoPath: string,
  ): Promise<PreparedSessionWorkspace> {
    try {
      return this.worktrees.prepareTaskWorkspace(taskId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.board.setTaskLastSessionCwd?.(taskId, repoPath);
      return {
        taskId,
        path: repoPath,
        repoPath,
        usedWorktree: false,
        bootstrapNotice:
          `${detail}\n\n` +
          'Worktree setup failed. Opened a shell in the repo checkout so you can handle it manually.',
      };
    }
  }

  // ---- openSession -----------------------------------------

  async openSession(taskId: string): Promise<SessionRecord> {
    return this.openSessionWithPreferredBackend(taskId);
  }

  private async openSessionWithPreferredBackend(
    taskId: string,
    preferredBackend?: SessionBackendType,
  ): Promise<SessionRecord> {
    // 1. Load task
    const taskRow = this.db
      .prepare<[string], TaskRow>(
        'SELECT id, title, repo_id, agent_cli, branch_name, worktree_path, session_id FROM tasks WHERE id = ?',
      )
      .get(taskId);

    if (!taskRow) throw new Error(`Task not found: ${taskId}`);

    // 2. Load repo
    const repoRow = this.db
      .prepare<[string], RepoRow>('SELECT id, path, default_base_branch FROM repos WHERE id = ?')
      .get(taskRow.repo_id);

    if (!repoRow) throw new Error(`Repo not found for task ${taskId} (repoId=${taskRow.repo_id})`);

    // 3. Check for a live session already linked to this task
    if (taskRow.session_id) {
      const existingRow = this.db
        .prepare<[string], SessionRow>(
          `SELECT * FROM sessions WHERE id = ? AND status IN ('active','idle')`,
        )
        .get(taskRow.session_id);

      if (existingRow) {
        const existing = rowToRecord(existingRow);
        if (preferredBackend && existing.backendType !== preferredBackend) {
          await this.terminateSession(existing.id);
          this.db
            .prepare<[string | null, number, string], void>(
              'UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?',
            )
            .run(null, Date.now(), taskId);
        } else if (existing.backendSessionId) {
          const backend = this.getBackend(existing.backendType);
          const info = await backend.inspect(existing.backendSessionId);
          if (info) {
            if (backend instanceof TmuxBackend) {
              backend.ensureStreaming(existing.taskId, existing.backendSessionId);
            }
            // Still alive — reattach
            const currentBranch = resolveTaskBranchName(
              taskRow.title,
              taskRow.id,
              taskRow.branch_name ?? existing.branch,
            );
            const previousBranch =
              taskRow.branch_name && taskRow.branch_name !== currentBranch
                ? taskRow.branch_name
                : existing.branch && existing.branch !== currentBranch
                  ? existing.branch
                  : undefined;
            const shouldResetBranch =
              previousBranch !== undefined ||
              existing.branch == null ||
              existing.branch !== currentBranch;
            if (shouldResetBranch) {
              await this.ensureSessionBranch(
                existing,
                taskRow.worktree_path ?? repoRow.path,
                currentBranch,
                previousBranch,
              );
              this.persistSessionBranch(existing.id, currentBranch);
            }
            this.clearTaskAttention(taskId);
            return { ...existing, branch: currentBranch };
          }
        }
      }
    }

    // 4. Determine branch
    const branch = resolveTaskBranchName(taskRow.title, taskRow.id, taskRow.branch_name ?? undefined);

    // 5. Pick backend — prefer PTY for low-latency interactive sessions.
    let backendType: SessionBackendType = 'pty';
    if (preferredBackend) {
      const preferredHealth = await this.getBackend(preferredBackend).healthCheck();
      if (!preferredHealth.available) {
        throw new Error(
          `Preferred backend unavailable: ${preferredHealth.error ?? 'unavailable'}`,
        );
      }
      backendType = preferredBackend;
    } else {
      const ptyHealth = await this.getBackend('pty').healthCheck();
      if (!ptyHealth.available) {
        const tmuxHealth = await this.getBackend('tmux').healthCheck();
        if (!tmuxHealth.available) {
          throw new Error(
            `No session backend available (pty: ${ptyHealth.error ?? 'unavailable'}, tmux: ${tmuxHealth.error ?? 'unavailable'})`,
          );
        }
        backendType = 'tmux';
      }
    }

    const backend = this.getBackend(backendType);
    const workspace = await this.prepareWorkspaceForSession(taskId, repoRow.path);

    const sessionRecord = await backend.create({
      taskId,
      taskTitle: taskRow.title,
      repoPath: repoRow.path,
      branch,
      agentCli: taskRow.agent_cli ?? 'claude',
      cwd: workspace.path,
      baseBranch: repoRow.default_base_branch ?? 'main',
      usesWorktree: workspace.usedWorktree,
      bootstrapNotice: workspace.bootstrapNotice,
      sessionBootstrapScript: this.sessionBootstrapScript,
    });

    // 6. Persist to DB
    await this.board.setTaskBranch?.(taskId, branch);

    const now = Date.now();
    this.db
      .prepare<[string, string, string, string | null, string | null, string, string | null, string | null, number, number, number], void>(
        `INSERT INTO sessions
           (id, task_id, backend_type, backend_session_id, attach_command,
            status, cwd, branch, last_heartbeat, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionRecord.id,
        taskId,
        sessionRecord.backendType,
        sessionRecord.backendSessionId ?? null,
        sessionRecord.attachCommand ?? null,
        sessionRecord.status,
        sessionRecord.cwd ?? null,
        sessionRecord.branch ?? null,
        now,
        now,
        now,
      );

    // 7. Link session to task
    await this.board.linkSession?.(taskId, sessionRecord.id);
    this.clearTaskAttention(taskId);

    return sessionRecord;
  }

  // ---- getSession ------------------------------------------

  getSession(taskId: string): SessionRecord | null {
    const row = this.db
      .prepare<[string], SessionRow>(
        `SELECT s.* FROM sessions s
         JOIN tasks t ON t.session_id = s.id
         WHERE t.id = ?
         ORDER BY s.created_at DESC
         LIMIT 1`,
      )
      .get(taskId);

    return row ? rowToRecord(row) : null;
  }

  // ---- sendInput -------------------------------------------

  async sendInput(taskId: string, data: string): Promise<boolean> {
    const session = this.getSession(taskId);
    if (!session) throw new Error(`No active session for task: ${taskId}`);
    if (!session.backendSessionId) throw new Error(`Session has no backend ID: ${session.id}`);

    const backend = this.getBackend(session.backendType);
    await backend.sendInput(session.backendSessionId, data);
    return this.clearTaskAttention(taskId);
  }

  acknowledgeSessionAttention(taskId: string): boolean {
    return this.clearTaskAttention(taskId);
  }

  async resizeSession(taskId: string, cols: number, rows: number): Promise<void> {
    const session = this.getSession(taskId);
    if (!session?.backendSessionId) {
      return;
    }

    if (session.backendType === 'pty') {
      this.buffers.resize(taskId, cols, rows);
    }

    const backend = this.getBackend(session.backendType);
    await backend.resize(session.backendSessionId, cols, rows);
  }

  // ---- getBuffer -------------------------------------------

  async getBuffer(taskId: string): Promise<GetBufferResult> {
    const session = this.getSession(taskId);
    if (!session) {
      return this.buffers.getBuffer(taskId);
    }

    if (session.backendType === 'tmux' && session.backendSessionId) {
      const backend = this.getBackend('tmux');
      if (backend instanceof TmuxBackend) {
        return backend.capture(session.backendSessionId);
      }
    }

    return this.buffers.getBuffer(taskId);
  }

  async inspectSessionState(taskId: string): Promise<InspectSessionStateResult> {
    const session = this.getSession(taskId);
    if (!session) {
      this.lastBusyByTaskId.delete(taskId);
      return { activity: null, attentionChanged: false };
    }

    let activity: import('../types/index.js').SessionActivitySnapshot | null;
    if (!session.backendSessionId) {
      activity = deriveFallbackSessionActivity(taskId, session.id, session.status);
    } else {
      const backend = this.getBackend(session.backendType);
      const info = await backend.inspect(session.backendSessionId);
      if (!info) {
        activity = {
          taskId,
          sessionId: session.id,
          sessionStatus: 'orphaned',
          isBusy: false,
          updatedAt: Date.now(),
        };
      } else {
        const lastOutputAt = this.lastOutputAtByTaskId.get(taskId);
        if (info.status !== 'active' || info.shellPid === undefined || info.shellPid <= 0) {
          activity = deriveFallbackSessionActivity(
            taskId,
            session.id,
            info.status,
            lastOutputAt,
            info.currentCommand,
          );
        } else {
          const processRows = await this.getProcessTableRows();
          activity = processRows
            ? deriveSessionActivity(
                taskId,
                session.id,
                info.status,
                processRows,
                info.shellPid,
                lastOutputAt,
                info.currentCommand,
              )
            : deriveFallbackSessionActivity(
                taskId,
                session.id,
                info.status,
                lastOutputAt,
                info.currentCommand,
              );
        }
      }
    }

    let attentionChanged = false;
    const previousBusy = this.lastBusyByTaskId.get(taskId) ?? false;
    if (activity.sessionStatus === 'active') {
      if (activity.isBusy) {
        attentionChanged = this.clearTaskAttention(taskId);
      } else if (previousBusy) {
        attentionChanged = this.board.setTaskSessionAttention?.(taskId) ?? false;
      }
      this.lastBusyByTaskId.set(taskId, activity.isBusy);
    } else {
      this.lastBusyByTaskId.delete(taskId);
    }

    return { activity, attentionChanged };
  }

  async inspectSession(taskId: string): Promise<import('../types/index.js').SessionActivitySnapshot | null> {
    const result = await this.inspectSessionState(taskId);
    return result.activity;
  }

  // ---- terminateSession ------------------------------------

  async terminateSession(sessionId: string): Promise<void> {
    const row = this.db
      .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId);

    if (!row) return;

    const session = rowToRecord(row);
    if (session.backendSessionId) {
      const backend = this.getBackend(session.backendType);
      await backend.terminate(session.backendSessionId);
    }

    this.buffers.destroy(session.taskId);
    this.lastOutputAtByTaskId.delete(session.taskId);
    this.lastBusyByTaskId.delete(session.taskId);

    this.db
      .prepare<[string, number, string], void>(
        'UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?',
      )
      .run('terminated', Date.now(), sessionId);
  }

  async recreateSession(taskId: string): Promise<SessionRecord> {
    return this.recreateSessionWithPreferredBackend(taskId);
  }

  private async recreateSessionWithPreferredBackend(
    taskId: string,
    preferredBackend?: SessionBackendType,
  ): Promise<SessionRecord> {
    const existing = this.getSession(taskId);
    if (existing) {
      await this.terminateSession(existing.id);
    }

    this.db
      .prepare<[string | null, number, string], void>(
        'UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(null, Date.now(), taskId);

    return this.openSessionWithPreferredBackend(taskId, preferredBackend);
  }

  // ---- reconcile -------------------------------------------

  async reconcile(): Promise<void> {
    const rows = this.db
      .prepare<[], SessionRow>(
        `SELECT * FROM sessions WHERE status IN ('active','idle')`,
      )
      .all();

    for (const row of rows) {
      const session = rowToRecord(row);
      if (!session.backendSessionId) continue;

      try {
        const backend = this.getBackend(session.backendType);
        const info = await backend.inspect(session.backendSessionId);
        if (!info) {
          this.db
            .prepare<[string, number, string], void>(
              'UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?',
            )
            .run('orphaned', Date.now(), session.id);
        }
      } catch {
        // On error, mark orphaned conservatively
        this.db
          .prepare<[string, number, string], void>(
            'UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?',
          )
          .run('orphaned', Date.now(), session.id);
      }
    }
  }

  // ---- heartbeat -------------------------------------------

  heartbeat(sessionId: string): void {
    const now = Date.now();
    this.db
      .prepare<[number, number, string], void>(
        'UPDATE sessions SET last_heartbeat = ?, updated_at = ? WHERE id = ?',
      )
      .run(now, now, sessionId);
  }
}
