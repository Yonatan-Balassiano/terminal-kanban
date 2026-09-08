import { randomUUID } from 'crypto';
import { homedir } from 'os';
import type {
  AgentCLI,
  AgentPermissionMode,
  AttentionItem,
  BackendSessionInfo,
  FleetSessionStatus,
  SessionRecord,
  SessionBackend,
  SessionBackendType,
  SessionStatus,
  SessionSlot,
  TaskLocation,
  GetBufferResult,
  ReconnectSessionResult,
  CreateSessionOpts,
} from '../types/index.js';
import type { Db } from '../db/index.js';
import type { BoardService } from './board.js';
import { PtyBackend } from './session-backends/pty.js';
import { TmuxBackend } from './session-backends/tmux.js';
import { SshTmuxBackend } from './session-backends/ssh.js';
import { looksLikeTrustPrompt } from './session-backends/pane-idle.js';
import {
  LOCAL_TRANSPORT_ID,
  TransportRegistry,
  TransportUnreachableError,
  type ExecTransport,
} from './transport/index.js';
import type { RemoteHostProvider } from './remote/index.js';
import { buildBackendSessionName } from './session-name.js';
import type { TerminalBufferService } from './terminal-buffer.js';
import { resolveTaskBranchName } from './branch-name.js';
import { extractLastOsc7Cwd } from './session-cwd.js';
import type { TaskWorkspaceInfo, WorktreeService } from './worktree.js';
import type { SessionWorkspaceEntry } from './session-bootstrap.js';
import { readTranscriptActivity, transcriptHasUserMessage } from './session-transcript.js';
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
  slot: SessionSlot;
  backend_type: string;
  backend_session_id: string | null;
  attach_command: string | null;
  agent_session_id: string | null;
  status: string;
  cwd: string | null;
  branch: string | null;
  last_heartbeat: number | null;
  last_buffer_snapshot: string | null;
  initial_prompt_delivered: number | null;
  created_at: number;
  updated_at: number;
}

interface TaskRow {
  id: string;
  title: string;
  kind: string | null;
  repo_id: string | null;
  agent_cli: 'claude' | 'codex' | null;
  location: string | null;
  track_id: string;
  branch_name: string | null;
  worktree_path: string | null;
  session_id: string | null;
  secondary_session_id: string | null;
  initial_prompt: string | null;
  session_name: string | null;
}

interface RepoRow {
  id: string;
  path: string;
  remote_path: string | null;
  default_base_branch: string | null;
}

/** A general task has no repo, branch, or worktree — only a session. */
function isGeneralTaskRow(task: Pick<TaskRow, 'kind'>): boolean {
  return task.kind === 'general';
}

interface PreparedSessionWorkspace extends TaskWorkspaceInfo {
  bootstrapNotice?: string;
}

/**
 * The checkout map handed to the agent, or undefined when there is nothing worth
 * showing.
 *
 * A card with a single checkout already starts the session inside it, so a
 * one-row banner would be noise; undefined also covers the case where the
 * workspace could not be resolved at all.
 */
function sessionWorkspaceEntries(
  workspace: PreparedSessionWorkspace
): SessionWorkspaceEntry[] | undefined {
  const resolved = workspace.workspaces ?? [];
  if (resolved.length < 2) {
    return undefined;
  }

  return resolved.map((plan) => ({
    label: plan.repoLabel,
    branch: plan.branch,
    path: plan.worktreePath ?? plan.repoPath,
  }));
}

export interface InspectSessionStateResult {
  activity: import('../types/index.js').SessionActivitySnapshot | null;
  attentionChanged: boolean;
}

/**
 * Why a re-delivery did nothing, so the CLI can say which case it hit.
 *
 * - `no-session`: the card has no live session to deliver into.
 * - `no-brief`: the card never had a stored opening brief.
 * - `not-verified`: a delivery ran, but the paste was never confirmed on the
 *   pane, so nothing was submitted. The only retryable one.
 */
export type RedeliverFailureReason = 'no-session' | 'no-brief' | 'not-verified';

export type RedeliverOutcome =
  | { delivered: true }
  | { delivered: false; reason: RedeliverFailureReason };

const processTableCacheWindowMs = 2000;

// --------------- Helpers -------------------------------------

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    slot: row.slot,
    backendType: row.backend_type as SessionBackendType,
    backendSessionId: row.backend_session_id ?? undefined,
    attachCommand: row.attach_command ?? undefined,
    agentSessionId: row.agent_session_id ?? undefined,
    status: row.status as SessionStatus,
    cwd: row.cwd ?? undefined,
    branch: row.branch ?? undefined,
    lastHeartbeat: row.last_heartbeat ?? undefined,
    lastBufferSnapshot: row.last_buffer_snapshot ?? undefined,
    initialPromptDelivered:
      row.initial_prompt_delivered === null ? undefined : row.initial_prompt_delivered === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --------------- SessionManager ------------------------------

export class SessionManager {
  private backends = new Map<SessionBackendType, SessionBackend>();
  private lastOutputAtBySessionKey = new Map<string, number>();
  private lastBusyBySessionKey = new Map<string, boolean>();
  private openSessionInFlight = new Map<string, Promise<SessionRecord>>();
  private processTableCache = new Map<string, { rows: ProcessRow[]; loadedAt: number }>();
  private processTableLoadInFlight = new Map<string, Promise<ProcessRow[] | null>>();
  private remoteStartInFlight = false;

  /**
   * Set by the daemon so work that finishes after its RPC returned — a remote
   * host waking up, minutes later — can still push the board to the TUI.
   */
  onSessionsChanged?: () => void;

  constructor(
    private db: Db,
    private board: BoardService & {
      linkSession?: (taskId: string, sessionId: string, slot?: SessionSlot) => Promise<void> | void;
      clearTaskSession?: (taskId: string, slot?: SessionSlot) => Promise<void> | void;
      setTaskBranch?: (taskId: string, branchName: string) => Promise<void> | void;
      setTaskLastSessionCwd?: (taskId: string, cwd: string | null) => Promise<void> | void;
      setTaskSessionAttention?: (taskId: string) => boolean;
      clearTaskSessionAttention?: (taskId: string) => boolean;
      clearChildPrAlert?: (taskId: string) => boolean;
    },
    private worktrees: WorktreeService,
    private buffers: TerminalBufferService,
    private onBufferUpdate?: (taskId: string, slot: SessionSlot, buffer: GetBufferResult) => void,
    private sessionBootstrapScript = '',
    private sessionBackend: SessionBackendType = 'tmux',
    private transports: TransportRegistry = new TransportRegistry(),
    private agentPermissionMode: AgentPermissionMode = 'default',
    private agentArgs: Partial<Record<AgentCLI, string[]>> = {},
    /** Powers the remote host back on. Null when nothing can start it. */
    private remoteProvider: RemoteHostProvider | null = null
  ) {
    this.buffers.subscribeAll((taskId, slot, buffer) => {
      this.onBufferUpdate?.(taskId, slot, buffer);
    });
  }

  protected createBackend(backendType: SessionBackendType): SessionBackend {
    if (backendType === 'tmux') {
      return new TmuxBackend();
    }

    if (backendType === 'ssh') {
      const transport = this.transports.getRemote();
      return new SshTmuxBackend({ transport, host: transport.host });
    }

    return new PtyBackend((taskId, slot, data) => {
      if (hasMeaningfulTerminalOutput(data)) {
        this.noteSessionOutput(taskId, slot);
      }
      this.buffers.write(taskId, slot, data);
      const cwd = extractLastOsc7Cwd(data);
      if (cwd) {
        this.board.setTaskLastSessionCwd?.(taskId, cwd);
      }
    });
  }

  /** Session backend selected by config; tests may override. */
  protected getBackend(backendType: SessionBackendType = this.sessionBackend): SessionBackend {
    let backend = this.backends.get(backendType);
    if (!backend) {
      backend = this.createBackend(backendType);
      this.backends.set(backendType, backend);
    }
    return backend;
  }

  private sessionKey(taskId: string, slot: SessionSlot): string {
    return `${taskId}:${slot}`;
  }

  private linkedSessionColumn(slot: SessionSlot): 'session_id' | 'secondary_session_id' {
    return slot === 'secondary' ? 'secondary_session_id' : 'session_id';
  }

  private linkedSessionId(task: TaskRow, slot: SessionSlot): string | null {
    return slot === 'secondary' ? task.secondary_session_id : task.session_id;
  }

  private taskLocation(task: TaskRow): TaskLocation {
    if (isGeneralTaskRow(task)) {
      return 'local';
    }
    return task.location === 'remote' ? 'remote' : 'local';
  }

  /**
   * Remote tasks always use the ssh backend; local tasks keep whatever the
   * config selected. Only session *creation* consults this — every later call
   * reads `backend_type` off the persisted session row.
   */
  private backendTypeForTask(task: TaskRow): SessionBackendType {
    return this.taskLocation(task) === 'remote' ? 'ssh' : this.sessionBackend;
  }

  /**
   * The repo checkout path on whichever host the task runs on, or the home
   * directory for a general task, which has no checkout at all.
   */
  private repoPathForTask(task: TaskRow, repo: RepoRow | null): string {
    if (!repo || isGeneralTaskRow(task)) {
      return homedir();
    }
    if (this.taskLocation(task) !== 'remote') {
      return repo.path;
    }
    if (!repo.remote_path) {
      throw new Error(
        `Task ${task.id} is set to run remotely, but repo ${repo.id} has no remote path configured. ` +
          'Set "remotePath" for the repo, or move the task back to local.'
      );
    }
    return repo.remote_path;
  }

  /**
   * Which host a live session runs on. Derived from the persisted backend type
   * rather than the task row, so it stays correct even if the task's location is
   * changed while a session is still running under the old backend.
   */
  private transportForBackend(backendType: SessionBackendType): ExecTransport {
    return this.transports.forLocation(backendType === 'ssh' ? 'remote' : 'local');
  }

  private noteSessionOutput(taskId: string, slot: SessionSlot): void {
    this.lastOutputAtBySessionKey.set(this.sessionKey(taskId, slot), Date.now());
  }

  /**
   * When the agent on this session last did something.
   *
   * Only a PTY session streams its output through the daemon, so
   * `lastOutputAtBySessionKey` is populated for exactly one backend. Every
   * tmux and ssh session left this undefined — and since
   * `selectBusyProcess` treats an agent process as busy only when it has
   * produced output recently, that made `isBusy` structurally false for them
   * no matter what the agent was doing. That is what `agentboard fleet`'s BUSY
   * column was reporting: not "idle", but "no idea".
   *
   * The conversation file is the missing heartbeat. An agent that is working
   * writes to its own transcript continuously, so the file's mtime answers the
   * same question the pty's byte stream answers, for the backends that have no
   * byte stream — and it needs no parsing, so it cannot break on a transcript
   * format change.
   *
   * Local sessions only: a remote session's transcript lives on the far host,
   * where reading it would cost an SSH round trip per session on every board
   * poll. Those keep the pre-existing behaviour rather than paying that.
   */
  private resolveLastOutputAt(sessionKey: string, session: SessionRecord): number | undefined {
    const streamed = this.lastOutputAtBySessionKey.get(sessionKey);
    if (streamed !== undefined || session.backendType === 'ssh') {
      return streamed;
    }
    return readTranscriptActivity(session.agentSessionId)?.lastActivityAt;
  }

  private clearTaskAttention(taskId: string): boolean {
    return this.board.clearTaskSessionAttention?.(taskId) ?? false;
  }

  protected async loadProcessTableRows(transport?: ExecTransport): Promise<ProcessRow[] | null> {
    return loadProcessTable(transport?.isRemote ? transport : undefined);
  }

  /**
   * Cached per host: a remote `ps` is an SSH round trip, and the TUI polls every
   * task on a 2.5s tick, so one read per host per window is shared by all of them.
   */
  private async getProcessTableRows(transport?: ExecTransport): Promise<ProcessRow[] | null> {
    const key = transport?.id ?? LOCAL_TRANSPORT_ID;
    const now = Date.now();

    const cached = this.processTableCache.get(key);
    if (cached && now - cached.loadedAt <= processTableCacheWindowMs) {
      return cached.rows;
    }

    const inFlight = this.processTableLoadInFlight.get(key);
    if (inFlight) {
      return inFlight;
    }

    const load = this.loadProcessTableRows(transport)
      .then((rows) => {
        if (rows) {
          this.processTableCache.set(key, { rows, loadedAt: Date.now() });
        }
        return rows;
      })
      .finally(() => {
        this.processTableLoadInFlight.delete(key);
      });

    this.processTableLoadInFlight.set(key, load);
    return load;
  }

  private async ensureSessionBranch(
    session: SessionRecord,
    cwd: string,
    branch: string,
    previousBranch?: string
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
        `git -C ${JSON.stringify(cwd)} checkout -b ${branch}`
    );
    const checkoutCmd = commands.join('; ');

    await backend.sendInput(session.backendSessionId, checkoutCmd);
    await backend.sendInput(session.backendSessionId, '\r');
    await this.board.setTaskBranch?.(session.taskId, branch);
  }

  /** How many repo + branch pairs the card spans. */
  private taskBranchCount(taskId: string): number {
    return (
      this.db
        .prepare<
          [string],
          { count: number }
        >('SELECT COUNT(*) AS count FROM task_branches WHERE task_id = ?')
        .get(taskId)?.count ?? 0
    );
  }

  private persistSessionBranch(sessionId: string, branch: string): void {
    this.db
      .prepare<
        [string, number, string],
        void
      >('UPDATE sessions SET branch = ?, updated_at = ? WHERE id = ?')
      .run(branch, Date.now(), sessionId);
  }

  private async prepareWorkspaceForSession(
    taskId: string,
    repoPath: string
  ): Promise<PreparedSessionWorkspace> {
    try {
      return await this.worktrees.prepareTaskWorkspace(taskId);
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

  async openSession(taskId: string, slot: SessionSlot = 'primary'): Promise<SessionRecord> {
    const key = this.sessionKey(taskId, slot);
    const pending = this.openSessionInFlight.get(key);
    if (pending) {
      return pending;
    }

    const request = this.openSessionInner(taskId, slot).finally(() => {
      if (this.openSessionInFlight.get(key) === request) {
        this.openSessionInFlight.delete(key);
      }
    });
    this.openSessionInFlight.set(key, request);
    return request;
  }

  private async openSessionInner(taskId: string, slot: SessionSlot): Promise<SessionRecord> {
    // 1. Load task
    const taskRow = this.db
      .prepare<[string], TaskRow>(
        `SELECT id, title, kind, repo_id, agent_cli, location, track_id, branch_name, worktree_path,
                session_id, secondary_session_id, initial_prompt, session_name
           FROM tasks
          WHERE id = ?`
      )
      .get(taskId);

    if (!taskRow) throw new Error(`Task not found: ${taskId}`);

    const isGeneral = isGeneralTaskRow(taskRow);

    // 2. Load repo — a general task has none, and needs none.
    const repoRow = isGeneral
      ? null
      : (this.db
          .prepare<
            [string],
            RepoRow
          >('SELECT id, path, remote_path, default_base_branch FROM repos WHERE id = ?')
          .get(taskRow.repo_id ?? '') ?? null);

    if (!isGeneral && !repoRow) {
      throw new Error(`Repo not found for task ${taskId} (repoId=${taskRow.repo_id})`);
    }

    // 3. Check for a live session already linked to this task
    const linkedSessionId = this.linkedSessionId(taskRow, slot);
    if (linkedSessionId) {
      const existingRow = this.db
        .prepare<
          [string],
          SessionRow
        >(`SELECT * FROM sessions WHERE id = ? AND status IN ('active','idle')`)
        .get(linkedSessionId);

      if (existingRow) {
        const existing = rowToRecord(existingRow);
        if (existing.backendSessionId) {
          const backend = this.getBackend(existing.backendType);
          const info = await backend.inspect(existing.backendSessionId);
          if (info) {
            // Still alive — reattach. attachMetadata() is the backend's chance to
            // repair whatever attaching needs: tmux re-tags its pane, ssh rebuilds
            // the local wrapper a dropped connection destroyed. It must run on
            // every reattach, not just when attach_command is missing, or a
            // remote session can never be revived.
            const metadata = await backend.attachMetadata(existing.backendSessionId);
            const attachCommand = metadata.command;
            if (attachCommand !== existing.attachCommand) {
              this.db
                .prepare<
                  [string, number, string],
                  void
                >('UPDATE sessions SET attach_command = ?, updated_at = ? WHERE id = ?')
                .run(attachCommand, Date.now(), existing.id);
            }
            // A general task owns no branch, so reattaching must never run a
            // checkout in whatever directory the session happens to sit in.
            if (isGeneral) {
              this.clearTaskAttention(taskId);
              return { ...existing, attachCommand, branch: undefined, slot };
            }

            const currentBranch = resolveTaskBranchName(
              taskRow.title,
              taskRow.id,
              taskRow.branch_name ?? existing.branch
            );
            const previousBranch =
              taskRow.branch_name && taskRow.branch_name !== currentBranch
                ? taskRow.branch_name
                : existing.branch && existing.branch !== currentBranch
                  ? existing.branch
                  : undefined;
            // A worktree's branch is fixed when the worktree is created, so the
            // checkout ensureSessionBranch runs is at best a no-op there. On a
            // card that spans several branches it is actively harmful: each
            // branch has its own worktree, and the checkout would drag whichever
            // one the session sits in onto another branch's name.
            const spansSeveralBranches = this.taskBranchCount(taskId) > 1;
            const shouldResetBranch =
              !spansSeveralBranches &&
              (previousBranch !== undefined ||
                existing.branch == null ||
                existing.branch !== currentBranch);
            if (shouldResetBranch) {
              await this.ensureSessionBranch(
                existing,
                taskRow.worktree_path ?? this.repoPathForTask(taskRow, repoRow),
                currentBranch,
                previousBranch
              );
              this.persistSessionBranch(existing.id, currentBranch);
            }
            this.clearTaskAttention(taskId);
            return { ...existing, attachCommand, branch: currentBranch, slot };
          }
        }
      }
    }

    const backendType = this.backendTypeForTask(taskRow);
    const backend = this.getBackend(backendType);

    // 4. Adopt a session the task lost track of, before creating a second one
    const adopted = await this.adoptExistingSession(taskRow, slot, backendType, backend);
    if (adopted) {
      return adopted;
    }

    // 5. Determine branch (general tasks have none)
    const branch = isGeneral
      ? ''
      : resolveTaskBranchName(taskRow.title, taskRow.id, taskRow.branch_name ?? undefined);

    // 6. Create a backend session
    const backendHealth = await backend.healthCheck();
    if (!backendHealth.available) {
      throw new Error(
        `${backendType} session backend unavailable: ${backendHealth.error ?? 'backend not available'}`
      );
    }

    const taskRepoPath = this.repoPathForTask(taskRow, repoRow);
    const workspace = await this.prepareWorkspaceForSession(taskId, taskRepoPath);
    const agentSessionId = this.resolveAgentSessionId(taskId, slot);

    // `workspaces` rides alongside the shared CreateSessionOpts rather than in
    // it: the backends forward the map to the bootstrap builder, and the shared
    // contract gains the field in the same change that teaches them to.
    const createOpts: CreateSessionOpts & { workspaces?: SessionWorkspaceEntry[] } = {
      taskId,
      taskTitle: taskRow.title,
      slot,
      taskKind: isGeneral ? 'general' : 'repo',
      repoPath: isGeneral ? '' : taskRepoPath,
      branch,
      agentCli: taskRow.agent_cli ?? 'claude',
      cwd: workspace.path,
      baseBranch: repoRow?.default_base_branch ?? 'main',
      usesWorktree: workspace.usedWorktree,
      bootstrapNotice: workspace.bootstrapNotice,
      sessionBootstrapScript: this.sessionBootstrapScript,
      agentPermissionMode: this.agentPermissionMode,
      agentArgs: this.agentArgs,
      workspaces: sessionWorkspaceEntries(workspace),
      agentSessionId,
      initialPrompt: taskRow.initial_prompt ?? undefined,
      sessionName: taskRow.session_name ?? undefined,
      onDeliveryResult: (delivered) => this.persistDeliveryOutcome(taskId, slot, delivered),
    };
    const createdSession = await backend.create(createOpts);
    const sessionRecord: SessionRecord = {
      ...createdSession,
      taskId,
      slot,
      agentSessionId,
      branch: isGeneral ? undefined : createdSession.branch,
    };

    // 7. Persist to DB
    if (!isGeneral) {
      await this.board.setTaskBranch?.(taskId, branch);
    }

    const now = Date.now();
    this.db
      .prepare<
        [
          string,
          string,
          SessionSlot,
          string,
          string | null,
          string | null,
          string | null,
          string,
          string | null,
          string | null,
          number,
          number,
          number,
        ],
        void
      >(
        `INSERT INTO sessions
           (id, task_id, slot, backend_type, backend_session_id, attach_command,
            agent_session_id, status, cwd, branch, last_heartbeat, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionRecord.id,
        taskId,
        sessionRecord.slot,
        sessionRecord.backendType,
        sessionRecord.backendSessionId ?? null,
        sessionRecord.attachCommand ?? null,
        sessionRecord.agentSessionId ?? null,
        sessionRecord.status,
        sessionRecord.cwd ?? null,
        sessionRecord.branch ?? null,
        now,
        now,
        now
      );

    // 8. Link session to task
    await this.board.linkSession?.(taskId, sessionRecord.id, slot);
    this.markSupersededSessions(taskId, slot, sessionRecord.id);
    if (taskRow.track_id === 'backlog') {
      this.board.moveTask({ id: taskId, trackId: 'in-progress' });
    }
    this.clearTaskAttention(taskId);

    return sessionRecord;
  }

  /**
   * The conversation id this task's slot runs its agent under.
   *
   * Reuses the id from whatever session row the slot last had, so a card
   * reopened after its pane died resumes where it left off. Status is
   * deliberately not filtered: the rows worth inheriting from are exactly the
   * dead ones. A slot that has never been opened gets a fresh id, which the
   * bootstrap script starts the conversation under.
   */
  private resolveAgentSessionId(taskId: string, slot: SessionSlot): string {
    const previous = this.db
      .prepare<[string, SessionSlot], { agent_session_id: string }>(
        `SELECT agent_session_id FROM sessions
          WHERE task_id = ?
            AND slot = ?
            AND agent_session_id IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1`
      )
      .get(taskId, slot);

    // A uuid, not generateId(): it is the agent CLI's identifier, and claude
    // rejects --session-id values that are not one.
    return previous?.agent_session_id ?? randomUUID();
  }

  // ---- adoption --------------------------------------------

  /**
   * Reclaim a session row the task no longer points at, when its backend session
   * turns out to still be alive.
   *
   * Backend session names are derived from the task, not stored, so a task that
   * lost its link — a reconcile pass marked it orphaned while the host was
   * briefly unreachable, say — can be matched back to the session it left
   * running. Without this, opening the task inserts a *second* row for the very
   * same backend session, and the board accumulates orphaned twins that keep
   * worktree cleanup from ever running.
   */
  private async adoptExistingSession(
    taskRow: TaskRow,
    slot: SessionSlot,
    backendType: SessionBackendType,
    backend: SessionBackend
  ): Promise<SessionRecord | null> {
    const backendSessionId = buildBackendSessionName(taskRow.title, taskRow.id, slot);
    const candidate = this.db
      .prepare<[string, SessionSlot, SessionBackendType, string], SessionRow>(
        `SELECT * FROM sessions
          WHERE task_id = ?
            AND slot = ?
            AND backend_type = ?
            AND backend_session_id = ?
            AND status <> 'terminated'
          ORDER BY updated_at DESC
          LIMIT 1`
      )
      .get(taskRow.id, slot, backendType, backendSessionId);

    if (!candidate) {
      return null;
    }

    // A TransportUnreachableError propagates on purpose: "cannot tell" must never
    // be read as "dead", or an unreachable host quietly forks a second session
    // alongside the one still running the agent.
    const info = await backend.inspect(backendSessionId);
    if (!info) {
      return null;
    }

    const metadata = await backend.attachMetadata(backendSessionId);
    return this.reviveSessionRow(rowToRecord(candidate), metadata.command, slot);
  }

  /** Put a session row back in service and make the task point at it again. */
  private async reviveSessionRow(
    session: SessionRecord,
    attachCommand: string,
    slot: SessionSlot
  ): Promise<SessionRecord> {
    const now = Date.now();
    this.db
      .prepare<[string, number, number, string], void>(
        `UPDATE sessions
            SET status = 'active', attach_command = ?, last_heartbeat = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(attachCommand, now, now, session.id);

    await this.board.linkSession?.(session.taskId, session.id, slot);
    this.markSupersededSessions(session.taskId, slot, session.id);
    this.collapseDuplicateSessions(session.taskId, slot, session.id);
    this.clearTaskAttention(session.taskId);

    return { ...session, status: 'active', attachCommand, slot };
  }

  /**
   * Delete retired rows that duplicate a live one.
   *
   * {@link markSupersededSessions} retires the losers but keeps them, which is
   * right when they describe a genuinely different backend session. Rows sharing
   * the *same* `backend_session_id` as the live row describe nothing extra —
   * they are bookkeeping from a re-open that failed to recognise its own
   * session, so they are dropped outright.
   */
  private collapseDuplicateSessions(
    taskId: string,
    slot: SessionSlot,
    keepSessionId: string
  ): number {
    const result = this.db
      .prepare<[string, SessionSlot, string, string], void>(
        `DELETE FROM sessions
          WHERE task_id = ?
            AND slot = ?
            AND id <> ?
            AND backend_session_id IS NOT NULL
            AND backend_session_id = (SELECT backend_session_id FROM sessions WHERE id = ?)`
      )
      .run(taskId, slot, keepSessionId, keepSessionId);
    return result.changes;
  }

  // ---- getSession ------------------------------------------

  getSession(taskId: string, slot: SessionSlot = 'primary'): SessionRecord | null {
    const task = this.db
      .prepare<[string], TaskRow>(
        `SELECT id, title, kind, repo_id, agent_cli, location, track_id, branch_name, worktree_path,
                session_id, secondary_session_id, initial_prompt, session_name
           FROM tasks
          WHERE id = ?`
      )
      .get(taskId);

    if (!task) {
      return null;
    }

    const sessionId = this.linkedSessionId(task, slot);
    if (!sessionId) {
      return null;
    }

    const row = this.db
      .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId);

    return row ? rowToRecord(row) : null;
  }

  // ---- sendInput -------------------------------------------

  async sendInput(taskId: string, data: string, slot: SessionSlot = 'primary'): Promise<boolean> {
    const session = this.getSession(taskId, slot);
    if (!session) throw new Error(`No active session for task: ${taskId}`);
    if (!session.backendSessionId) throw new Error(`Session has no backend ID: ${session.id}`);
    if (session.backendType === 'tmux' || session.backendType === 'ssh') {
      throw new Error(`${session.backendType} sessions receive input directly in the tmux pane.`);
    }

    const backend = this.getBackend(session.backendType);
    await backend.sendInput(session.backendSessionId, data);
    return this.clearTaskAttention(taskId);
  }

  acknowledgeSessionAttention(taskId: string): boolean {
    return this.clearTaskAttention(taskId);
  }

  acknowledgeChildPrAlert(taskId: string): boolean {
    return this.board.clearChildPrAlert?.(taskId) ?? false;
  }

  /**
   * Types a message straight into a card's live session and submits it —
   * the same thing a human collaborator would do by attaching and typing.
   *
   * Unlike the public {@link sendInput}, this is not gated to pty sessions: a
   * tmux/ssh session's pane is exactly where this message needs to land, since
   * there is no human already attached to type it themselves. Returns false
   * rather than throwing when the card has no live session — there is simply
   * nowhere to deliver an automated notice, and the caller falls back to a
   * durable board-level flag instead.
   *
   * Delivery reuses the same hardened paste-and-verify machinery as the
   * initial brief (`backend.redeliverPrompt`, see `pane-idle.ts`) instead of
   * a raw `sendInput`: a raw send types the message character-by-character
   * and treats every embedded newline in a multi-line message as an
   * immediate Enter, submitting it early, mid-line, with no confirmation it
   * ever landed. The returned boolean reflects that verification honestly —
   * `true` only once the message's own text was confirmed on the pane and
   * Enter was sent to submit it.
   *
   * That machinery is patient by design, so this call can take minutes on a
   * slow pane: any RPC client waiting on it needs at least
   * `pane-idle.ts`'s `deliveryBudgetMs` before calling the daemon dead — see
   * `rpcTimeoutMs` in `src/cli/rpc.ts`, which derives its timeout from it.
   */
  async notifyTaskSession(
    taskId: string,
    message: string,
    slot: SessionSlot = 'primary'
  ): Promise<boolean> {
    const session = this.getSession(taskId, slot);
    if (!session?.backendSessionId) {
      return false;
    }

    const backend = this.getBackend(session.backendType);
    if (!backend.redeliverPrompt) {
      throw new Error(`${session.backendType} sessions do not support notifying a live session.`);
    }

    const taskRow = this.loadTaskRow(taskId);
    // No `skipIfAlreadyOnPane`: `message` is new text this pane was never
    // given, so a marker match means a stale copy of an earlier notice still
    // on screen — or merely a message that starts the same way — and skipping
    // would drop this one while reporting `true`. Always paste. Stacking is
    // `DeliveryGuard`'s job, and it still applies.
    return backend.redeliverPrompt(
      taskId,
      slot,
      session.backendSessionId,
      message,
      taskRow?.agent_cli ?? undefined,
    );
  }

  /**
   * Manual escape hatch: re-pastes the card's stored brief into an
   * already-running session, for the rare case where automatic delivery
   * (paste + retry inside `backend.create()`) gave up before the pane became
   * responsive — see `SessionBackend.redeliverPrompt`.
   *
   * Returns false when there is nothing to do (no live session, or the task
   * never had a brief), rather than throwing — both are normal states, not
   * errors. Throws only when the session's own backend does not support
   * redelivery (PTY), since that is a real "can't do this" the caller should
   * surface.
   *
   * Reports *which* of its three outcomes happened, rather than a bare
   * `false` the caller has to guess at. All three used to print as "no live
   * session, or no stored brief", which named two causes and omitted the
   * third — so a report of this command failing against a session that
   * `agentboard fleet` listed as live read as the two views disagreeing about
   * the session, when the delivery had in fact been attempted and simply not
   * verified. `not-verified` is also the only one of the three that is worth
   * retrying.
   *
   * Safe to run twice: the backends refuse to start a second delivery into a
   * pane that already has one in flight (`DeliveryGuard`), and this call —
   * alone among the two, since its text is identical by construction — asks
   * `pasteAndVerify` to skip the paste entirely when this brief is already
   * sitting on screen.
   * Like notify, it can take minutes — see `pane-idle.ts`'s `deliveryBudgetMs`
   * and the timeout `src/cli/rpc.ts` derives from it.
   */
  async redeliverInitialPrompt(
    taskId: string,
    slot: SessionSlot = 'primary',
  ): Promise<RedeliverOutcome> {
    const session = this.getSession(taskId, slot);
    if (!session?.backendSessionId) {
      return { delivered: false, reason: 'no-session' };
    }

    const taskRow = this.loadTaskRow(taskId);
    if (!taskRow?.initial_prompt) {
      return { delivered: false, reason: 'no-brief' };
    }

    const backend = this.getBackend(session.backendType);
    if (!backend.redeliverPrompt) {
      throw new Error(`${session.backendType} sessions do not support re-delivering the initial prompt.`);
    }

    const delivered = await backend.redeliverPrompt(
      taskId,
      slot,
      session.backendSessionId,
      taskRow.initial_prompt,
      taskRow.agent_cli ?? undefined,
      // The one caller allowed to skip its paste: this text is the card's
      // stored brief, so a copy already on the pane *is* this same brief from
      // an earlier run, unsubmitted. Re-pasting would stack a duplicate under
      // it; the Enter below is the half that was missing.
      { skipIfAlreadyOnPane: true },
    );
    this.persistDeliveryOutcome(taskId, slot, delivered);
    return delivered ? { delivered: true } : { delivered: false, reason: 'not-verified' };
  }

  /**
   * Records whether the initial brief's paste was ever verified — the one
   * signal `agentboard fleet`'s DELIVERY column and `getAttentionItems` read
   * to tell a genuinely stuck session apart from one that's simply idle.
   *
   * Matched by (task, slot) rather than a session row id: the automatic
   * delivery callback fires from inside `backend.create()`, before this
   * class has assigned that session its own row id, so there is nothing
   * else stable to match on at that point.
   */
  private persistDeliveryOutcome(taskId: string, slot: SessionSlot, delivered: boolean): void {
    this.db
      .prepare<[number, number, string, SessionSlot], void>(
        `UPDATE sessions SET initial_prompt_delivered = ?, updated_at = ? WHERE task_id = ? AND slot = ?`,
      )
      .run(delivered ? 1 : 0, Date.now(), taskId, slot);
  }

  async resizeSession(
    taskId: string,
    cols: number,
    rows: number,
    slot: SessionSlot = 'primary'
  ): Promise<void> {
    const session = this.getSession(taskId, slot);
    if (!session?.backendSessionId || session.backendType === 'tmux' || session.backendType === 'ssh') {
      return;
    }

    this.buffers.resize(taskId, slot, cols, rows);

    const backend = this.getBackend(session.backendType);
    await backend.resize(session.backendSessionId, cols, rows);
  }

  // ---- getBuffer -------------------------------------------

  async getBuffer(taskId: string, slot: SessionSlot = 'primary'): Promise<GetBufferResult> {
    const session = this.getSession(taskId, slot);
    if (!session) {
      return this.buffers.getBuffer(taskId, slot);
    }

    return this.buffers.getBuffer(taskId, slot);
  }

  async inspectSessionState(
    taskId: string,
    slot: SessionSlot = 'primary'
  ): Promise<InspectSessionStateResult> {
    const sessionKey = this.sessionKey(taskId, slot);
    const session = this.getSession(taskId, slot);
    if (!session) {
      this.lastBusyBySessionKey.delete(sessionKey);
      return { activity: null, attentionChanged: false };
    }

    let activity: import('../types/index.js').SessionActivitySnapshot | null;
    if (!session.backendSessionId) {
      activity = deriveFallbackSessionActivity(taskId, session.id, session.status);
    } else {
      const backend = this.getBackend(session.backendType);
      let info: BackendSessionInfo | null;
      try {
        info = await backend.inspect(session.backendSessionId);
      } catch (error) {
        // The host is unreachable, so the session's real state is unknown. Report
        // it as idle rather than orphaned: the remote session is very likely still
        // running, and the board must stay usable while the VPN is down.
        if (error instanceof TransportUnreachableError) {
          return {
            activity: {
              taskId,
              sessionId: session.id,
              slot,
              sessionStatus: 'idle',
              isBusy: false,
              updatedAt: Date.now(),
            },
            attentionChanged: false,
          };
        }
        throw error;
      }

      if (!info) {
        activity = {
          taskId,
          sessionId: session.id,
          slot,
          sessionStatus: 'orphaned',
          isBusy: false,
          updatedAt: Date.now(),
        };
      } else {
        const lastOutputAt = this.resolveLastOutputAt(sessionKey, session);
        if (info.status !== 'active' || info.shellPid === undefined || info.shellPid <= 0) {
          activity = deriveFallbackSessionActivity(
            taskId,
            session.id,
            info.status,
            lastOutputAt,
            info.currentCommand
          );
        } else {
          const processRows = await this.getProcessTableRows(
            this.transportForBackend(session.backendType)
          );
          activity = processRows
            ? deriveSessionActivity(
                taskId,
                session.id,
                info.status,
                processRows,
                info.shellPid,
                lastOutputAt,
                info.currentCommand
              )
            : deriveFallbackSessionActivity(
                taskId,
                session.id,
                info.status,
                lastOutputAt,
                info.currentCommand
              );
        }
      }
    }

    if (activity) {
      activity = { ...activity, slot };
    }

    let attentionChanged = false;
    const previousBusy = this.lastBusyBySessionKey.get(sessionKey) ?? false;
    if (activity.sessionStatus === 'active') {
      if (activity.isBusy) {
        attentionChanged = this.clearTaskAttention(taskId);
      } else if (previousBusy) {
        attentionChanged = this.board.setTaskSessionAttention?.(taskId) ?? false;
      }
      this.lastBusyBySessionKey.set(sessionKey, activity.isBusy);
    } else {
      this.lastBusyBySessionKey.delete(sessionKey);
    }

    return { activity, attentionChanged };
  }

  async inspectSession(
    taskId: string,
    slot: SessionSlot = 'primary'
  ): Promise<import('../types/index.js').SessionActivitySnapshot | null> {
    const result = await this.inspectSessionState(taskId, slot);
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

    this.buffers.destroy(session.taskId, session.slot);
    const key = this.sessionKey(session.taskId, session.slot);
    this.lastOutputAtBySessionKey.delete(key);
    this.lastBusyBySessionKey.delete(key);

    this.db
      .prepare<
        [string, number, string],
        void
      >('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run('terminated', Date.now(), sessionId);
    await this.board.clearTaskSession?.(session.taskId, session.slot);
  }

  async recreateSession(taskId: string, slot: SessionSlot = 'primary'): Promise<SessionRecord> {
    const existing = this.getSession(taskId, slot);
    if (existing) {
      await this.terminateSession(existing.id);
    }

    await this.board.clearTaskSession?.(taskId, slot);

    return this.openSessionInner(taskId, slot);
  }

  // ---- reconnect -------------------------------------------

  /**
   * Re-link a remote task to the machine its agent is running on.
   *
   * Distinct from {@link recreateSession}, which always throws the running agent
   * away. Reconnect repairs the plumbing and keeps the agent whenever it can:
   * the local wrapper pane and the SSH connection are disposable, the remote
   * tmux session holding the agent is not.
   */
  async reconnectSession(
    taskId: string,
    slot: SessionSlot = 'primary'
  ): Promise<ReconnectSessionResult> {
    const taskRow = this.loadTaskRow(taskId);
    if (!taskRow) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (this.taskLocation(taskRow) !== 'remote') {
      throw new Error('Reconnect applies to remote tasks only.');
    }

    const provider = this.remoteProvider;
    if (provider) {
      const status = await provider.status();

      if (status === 'failed') {
        return {
          state: 'unreachable',
          message: `${provider.label} is in a failed state. Fix it in Coder, then reconnect again.`,
        };
      }

      // A build takes minutes, so it runs detached and the board is patched when
      // it lands. Holding the RPC open for it would freeze the TUI instead.
      if (status === 'stopped' || status === 'starting') {
        this.startRemoteHostThenReconnect(taskRow, slot, provider, status === 'stopped');
        return {
          state: 'starting',
          message:
            status === 'stopped'
              ? `Starting ${provider.label}. The card reconnects on its own once it is up.`
              : `${provider.label} is already starting. The card reconnects on its own once it is up.`,
        };
      }
      // 'running' and 'unknown' both fall through: SSH is the authority, and an
      // unanswerable provider must never block a reconnect to a host that is up.
    }

    return this.reconnectToLiveHost(taskRow, slot);
  }

  private async reconnectToLiveHost(
    taskRow: TaskRow,
    slot: SessionSlot
  ): Promise<ReconnectSessionResult> {
    await this.resetRemoteTransport();

    let transport: ReturnType<TransportRegistry['getRemote']>;
    try {
      transport = this.transports.getRemote();
    } catch (error) {
      return { state: 'unreachable', message: errorMessage(error) };
    }

    // Optional warm-up: pay the cold connect once rather than on each of the
    // several round trips below. A failure here is not fatal — every exec opens
    // the master on demand — so the reachability probe stays the real verdict.
    await transport.ensureMaster().catch(() => undefined);

    if ((await transport.reachability()) !== 'ok') {
      return {
        state: 'unreachable',
        message: `Cannot reach ${transport.host}. Check your VPN, then verify: ssh ${transport.host} true`,
      };
    }

    // Ask before opening, because openSession repairs the difference silently
    // and the user should be told which of the two things happened.
    const backend = this.getBackend('ssh');
    const backendSessionId = buildBackendSessionName(taskRow.title, taskRow.id, slot);
    let wasAlive: boolean;
    try {
      wasAlive = (await backend.inspect(backendSessionId)) !== null;
    } catch (error) {
      if (error instanceof TransportUnreachableError) {
        return { state: 'unreachable', message: errorMessage(error) };
      }
      throw error;
    }

    // Clear the local plumbing before reopening. A wrapper pane whose attach
    // loop has died still carries its tag, and the passive attach path reads
    // that tag as a living wrapper — so without this, reconnect reports success
    // while the card stays welded to a dead shell.
    await backend.resetAttachment?.(backendSessionId);

    const session = await this.openSession(taskRow.id, slot);
    return wasAlive
      ? {
          state: 'attached',
          message: `Reconnected to ${backendSessionId} on ${transport.host}.`,
          session,
        }
      : {
          state: 'recreated',
          message: `The remote session was gone, so a fresh one was started on ${transport.host}.`,
          session,
        };
  }

  /**
   * Start the host, then reconnect once it answers.
   *
   * Detached on purpose: a workspace build runs for minutes, and the caller was
   * answered with 'starting' before this began. The board patch at the end is
   * how the result reaches the user.
   */
  private startRemoteHostThenReconnect(
    taskRow: TaskRow,
    slot: SessionSlot,
    provider: RemoteHostProvider,
    needsStart: boolean
  ): void {
    // One build at a time. Two `coder start` calls racing on the same workspace
    // is at best wasted, at worst a second build queued behind the first.
    if (this.remoteStartInFlight) {
      return;
    }
    this.remoteStartInFlight = true;

    void (async () => {
      try {
        if (needsStart) {
          await provider.start();
        }
        if (await provider.waitUntilRunning()) {
          await this.reconnectToLiveHost(taskRow, slot);
        }
      } catch {
        // There is no longer a caller to throw to. The board patch below shows
        // whatever state the attempt actually reached.
      } finally {
        this.remoteStartInFlight = false;
        this.onSessionsChanged?.();
      }
    })();
  }

  /**
   * Discard the remote transport and anything holding a reference to it.
   *
   * The cached backend closed over the transport instance, so dropping only the
   * registry entry would leave the backend talking through the dead
   * ControlMaster — and reporting the sessions behind it as gone.
   */
  private async resetRemoteTransport(): Promise<void> {
    this.backends.delete('ssh');
    await this.transports.resetRemote();
  }

  private loadTaskRow(taskId: string): TaskRow | undefined {
    return this.db
      .prepare<[string], TaskRow>(
        `SELECT id, title, kind, repo_id, agent_cli, location, track_id, branch_name, worktree_path,
                session_id, secondary_session_id, initial_prompt, session_name
           FROM tasks
          WHERE id = ?`
      )
      .get(taskId);
  }

  async setDualSessionMode(taskId: string, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.openSession(taskId, 'primary');
      await this.openSession(taskId, 'secondary');
      return;
    }

    const secondary = this.getSession(taskId, 'secondary');
    if (secondary) {
      await this.terminateSession(secondary.id);
    } else {
      await this.board.clearTaskSession?.(taskId, 'secondary');
    }
  }

  async terminateTaskSessions(taskId: string): Promise<void> {
    const sessions = [this.getSession(taskId, 'primary'), this.getSession(taskId, 'secondary')];
    for (const session of sessions) {
      if (session) {
        await this.terminateSession(session.id);
      }
    }
  }

  // ---- reconcile -------------------------------------------

  /**
   * Retire earlier session rows for a task slot once a new one takes over.
   *
   * Only the row linked from `tasks` is authoritative. When a session had to be
   * recreated, the previous row kept `status='active'` forever — which blocks
   * worktree cleanup on archive and inflates every scan over live sessions.
   *
   * The backend session is deliberately left alone: a superseded row usually
   * carries the *same* `backend_session_id` as the live one, so terminating it
   * would kill the session that is still running.
   */
  private markSupersededSessions(taskId: string, slot: SessionSlot, keepSessionId: string): number {
    const result = this.db
      .prepare<[number, string, SessionSlot, string], void>(
        `UPDATE sessions
            SET status = 'orphaned', updated_at = ?
          WHERE task_id = ?
            AND slot = ?
            AND id <> ?
            AND status IN ('active','idle')`
      )
      .run(Date.now(), taskId, slot, keepSessionId);
    return result.changes;
  }

  /**
   * Retire every live-looking session row no task points at.
   *
   * Same reasoning as {@link markSupersededSessions}, applied board-wide to
   * clean up rows orphaned before that call existed. Backends are untouched.
   */
  private markUnlinkedSessionsOrphaned(): number {
    const result = this.db
      .prepare<[number], void>(
        `UPDATE sessions
            SET status = 'orphaned', updated_at = ?
          WHERE status IN ('active','idle')
            AND id NOT IN (
              SELECT session_id FROM tasks WHERE session_id IS NOT NULL
              UNION
              SELECT secondary_session_id FROM tasks WHERE secondary_session_id IS NOT NULL
            )`
      )
      .run(Date.now());
    return result.changes;
  }

  private markSessionOrphaned(sessionId: string): void {
    this.db
      .prepare<
        [string, number, string],
        void
      >('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run('orphaned', Date.now(), sessionId);
  }

  /**
   * Board-wide sweep of the duplicates {@link collapseDuplicateSessions} clears
   * per task, for pairs created before adoption existed.
   */
  private collapseDuplicateSessionsGlobally(): number {
    const result = this.db
      .prepare<[], void>(
        `DELETE FROM sessions
          WHERE status = 'orphaned'
            AND backend_session_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM sessions live
               WHERE live.task_id = sessions.task_id
                 AND live.slot = sessions.slot
                 AND live.backend_session_id = sessions.backend_session_id
                 AND live.id <> sessions.id
                 AND live.status IN ('active','idle')
            )`
      )
      .run();
    return result.changes;
  }

  async reconcile(): Promise<void> {
    // Retire unlinked rows first: they are known-stale without asking a backend,
    // and on a remote board each skipped row is an SSH round trip saved.
    this.markUnlinkedSessionsOrphaned();
    this.collapseDuplicateSessionsGlobally();

    const rows = this.db
      .prepare<[], SessionRow>(`SELECT * FROM sessions WHERE status IN ('active','idle')`)
      .all();

    for (const row of rows) {
      const session = rowToRecord(row);
      if (!session.backendSessionId) continue;

      try {
        const backend = this.getBackend(session.backendType);
        const info = await backend.inspect(session.backendSessionId);
        if (!info) {
          this.markSessionOrphaned(session.id);
        }
      } catch (error) {
        // An unreachable host means "unknown", not "dead". Marking a remote
        // session orphaned because the VPN happened to be down at daemon start
        // would discard a session that is still running perfectly well.
        if (error instanceof TransportUnreachableError) {
          continue;
        }
        this.markSessionOrphaned(session.id);
      }
    }
  }

  // ---- fleet status -------------------------------------------

  /**
   * One row per live session, for `agentboard fleet` — replaces poking N
   * tmux panes by hand with a single table naming exactly what state each
   * one is in.
   */
  /**
   * Whether this session's agent actually received its opening brief.
   *
   * Read from the conversation itself: a real user turn exists, so the agent
   * has the brief, full stop. That replaces the old signal — whether a pasted
   * brief appeared to render on a terminal before an Enter was sent — which
   * could be wrong in both directions, and is no longer produced at all now
   * that the brief travels in the agent CLI's argv.
   *
   * Falls back to the stored flag when the transcript cannot be read (a remote
   * session, an unwritten conversation, a Claude Code layout change), and to
   * `null` — rendered as "unknown", never as a warning — when neither can
   * answer. A card whose session simply has not written its first turn yet is
   * unknown, not failed.
   */
  private resolveDelivered(session: SessionRecord): boolean | null {
    if (session.backendType !== 'ssh' && transcriptHasUserMessage(session.agentSessionId)) {
      return true;
    }
    return session.initialPromptDelivered ?? null;
  }

  async getFleetStatus(): Promise<FleetSessionStatus[]> {
    const rows = this.db
      .prepare<[], SessionRow>(`SELECT * FROM sessions WHERE status IN ('active','idle')`)
      .all();

    const results: FleetSessionStatus[] = [];
    for (const row of rows) {
      const session = rowToRecord(row);
      if (!session.backendSessionId) continue;

      const task = this.board.getTask(session.taskId);
      const { activity } = await this.inspectSessionState(session.taskId, session.slot);

      let trustPromptShowing = false;
      if (session.backendType === 'tmux' || session.backendType === 'ssh') {
        const backend = this.getBackend(session.backendType);
        if (backend.peekPane) {
          try {
            trustPromptShowing = looksLikeTrustPrompt(await backend.peekPane(session.backendSessionId));
          } catch {
            // Best-effort: an unreachable pane just means "unknown", not a crash.
          }
        }
      }

      results.push({
        taskId: session.taskId,
        taskTitle: task?.title ?? session.taskId,
        slot: session.slot,
        backendType: session.backendType,
        sessionStatus: activity?.sessionStatus ?? 'orphaned',
        isBusy: activity?.isBusy ?? false,
        attentionNeeded: task?.sessionAttentionNeeded ?? false,
        trustPromptShowing,
        delivered: this.resolveDelivered(session),
        createdAt: session.createdAt,
      });
    }

    return results;
  }

  /**
   * Every card that wants a human right now, one reason each — the "poke N
   * commands to find out what's waiting on me" problem `getFleetStatus`
   * already solved for liveness, extended to attention.
   *
   * Task-driven, not session-driven: `getFleetStatus` only iterates *live*
   * sessions, but a subtask's PR can open, or a reviewer can request
   * changes, after the parent's own session has already ended — those cards
   * still need to show up here. Session-level signals (delivery, the trust
   * prompt) are cross-referenced from `getFleetStatus`'s own output, keyed
   * by task id, rather than re-deriving them.
   */
  async getAttentionItems(): Promise<AttentionItem[]> {
    const fleetByTaskId = new Map(
      (await this.getFleetStatus()).map((row) => [row.taskId, row] as const)
    );

    const items: AttentionItem[] = [];
    for (const task of this.board.getTasks()) {
      if (task.archivedAt != null || task.trackId === 'done') {
        continue;
      }

      const fleet = fleetByTaskId.get(task.id);
      const reason =
        fleet?.delivered === false
          ? 'delivery unsubmitted'
          : fleet?.trustPromptShowing
            ? 'trust prompt showing'
            : task.reviewState === 'changes_requested'
              ? 'reviewer requested changes'
              : task.childPrAlertTaskId
                ? `subtask PR opened${this.describeChildPr(task.childPrAlertTaskId)}`
                : task.sessionAttentionNeeded
                  ? 'finished, waiting on you'
                  : null;

      if (reason) {
        items.push({ taskId: task.id, taskTitle: task.title, reason });
      }
    }

    return items;
  }

  /** " — #<pr>" when the alerting child's own PR number is known, else "". */
  private describeChildPr(childTaskId: string): string {
    const prNumber = this.board.getTask(childTaskId)?.prNumber;
    return prNumber ? ` — #${prNumber}` : '';
  }

  // ---- heartbeat -------------------------------------------

  heartbeat(sessionId: string): void {
    const now = Date.now();
    this.db
      .prepare<
        [number, number, string],
        void
      >('UPDATE sessions SET last_heartbeat = ?, updated_at = ? WHERE id = ?')
      .run(now, now, sessionId);
  }
}
