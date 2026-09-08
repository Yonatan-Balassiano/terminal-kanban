// ============================================================
// AgentBoard — shared types
// All services, TUI, CLI, and RPC use these definitions.
// ============================================================

// --------------- Primitives / Enums -------------------------

export type PRState = 'none' | 'draft' | 'open' | 'merged' | 'closed';
export type CIState = 'none' | 'pending' | 'failed' | 'passed';
export type ReviewState = 'none' | 'approved' | 'changes_requested' | 'commented';
export type GitHubSyncStatus = 'idle' | 'syncing' | 'ok' | 'error';
export type SessionStatus = 'active' | 'idle' | 'orphaned' | 'terminated';
export type SessionSlot = 'primary' | 'secondary';
export type SessionBackendType = 'tmux' | 'pty' | 'ssh';
export type RepoHealth = 'ok' | 'missing' | 'not-git' | 'unreachable';
/** Which machine a task's worktree and agent session live on. */
export type TaskLocation = 'local' | 'remote';
/**
 * What a card is attached to.
 *
 * `repo` is the normal card: a repo, a branch, a worktree, GitHub sync.
 * `general` is a standalone card — a title and an agent session in the user's
 * home directory, with no repo, branch, worktree, or GitHub state.
 */
export type TaskKind = 'repo' | 'general';
export type ThemeMode = 'truecolor' | '256color' | 'monochrome';
export type WorktreeMode = 'off' | 'auto' | 'always';
export type PreferredIDE = 'system' | 'webstorm' | 'idea' | 'cursor' | 'vscode';
export type GitState = 'unknown' | 'clean' | 'dirty' | 'untracked' | 'conflicted' | 'detached';
export type TerminalLayoutMode = 'side-by-side' | 'top-bottom';
export type SessionActivityKind = 'agent' | 'process';
export type AgentCLI = 'claude' | 'codex';
/**
 * How much the agent CLI is allowed to do without asking.
 *
 * 'bypass' skips the agent's own permission prompts — appropriate for a session
 * already isolated in its own worktree, and required for an unattended remote
 * session where nobody is watching to approve each step.
 */
export type AgentPermissionMode = 'default' | 'bypass';
export type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type EventType =
  | 'task.created'
  | 'task.renamed'
  | 'task.moved'
  | 'task.archived'
  | 'task.deleted'
  | 'pillar.changed'
  | 'label.changed'
  | 'session.created'
  | 'session.attached'
  | 'session.terminated'
  | 'sync.completed'
  | 'sync.failed'
  | 'recovery.marker'
  | 'repo.added'
  | 'repo.removed'
  | 'ai.turn.completed'
  | 'ai.tool.executed';

// --------------- DB Records ---------------------------------

export interface RepoRecord {
  id: string;
  label: string;
  path: string;
  githubOwner?: string;
  githubRepo?: string;
  githubUrl?: string;
  defaultBaseBranch: string;
  defaultPillarId?: string;
  preferredIde?: PreferredIDE;
  ideCommand?: string;
  worktreeMode: WorktreeMode;
  worktreeRoot?: string;
  /** Path to this repo's checkout on the configured remote host. Absent = local only. */
  remotePath?: string;
  health: RepoHealth;
  createdAt: number;
  updatedAt: number;
}

export interface PillarRecord {
  id: string;
  label: string;
  icon?: string;
  color?: string;
}

export interface LabelRecord {
  id: string;
  label: string;
  color?: string;
}

export interface TrackRecord {
  id: string;
  label: string;
  sortOrder: number;
}

/**
 * One repo + branch a card is working in, and the pull request it carries.
 *
 * This is the level actions operate at. A card can hold several, so anything
 * that merges, comments on, or opens "the PR" has to name which branch it
 * means — the card itself no longer has a single answer.
 */
export interface TaskBranchRecord {
  id: string;
  taskId: string;
  repoId: string;
  branchName: string;
  baseBranch?: string;
  worktreePath?: string;
  sortKey: number;
  prNumber?: number;
  prUrl?: string;
  prState: PRState;
  prDraft: boolean;
  /** The squashed commit this branch landed as; the anchor for release tracking. */
  mergeCommitSha?: string;
  mergedAt?: number;
  ciState: CIState;
  ciSummary?: string;
  failingCheckName?: string;
  ciRequiredTotal: number;
  ciRequiredPassed: number;
  ciRequiredFailed: number;
  ciRequiredPending: number;
  reviewState: ReviewState;
  reviewSummary?: string;
  unresolvedThreadCount: number;
  gitState: GitState;
  gitAheadCount: number;
  gitBehindCount: number;
  hasUntracked: boolean;
  hasConflicts: boolean;
  githubSyncStatus: GitHubSyncStatus;
  githubSyncError?: string;
  githubLastSyncedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRecord {
  id: string;
  title: string;
  description?: string;
  /**
   * The opening prompt handed to the agent when this card starts a fresh
   * conversation. Absent on cards that were never given a brief.
   */
  initialPrompt?: string;
  kind: TaskKind;
  /** Set when this card was spun off from another one as its subtask. */
  parentTaskId?: string;
  /** The child task whose PR is waiting on this card to review, if any. */
  childPrAlertTaskId?: string;
  /**
   * This card's session's `--name` — how other Claude Code sessions address
   * it via SendMessage/ListAgents. Assigned once at creation; for a subtask,
   * prefixed with the parent's own sessionName so hierarchy is visible
   * straight off the flat session list.
   */
  sessionName?: string;
  /** Absent on general tasks, which belong to no repo. */
  repoId?: string;
  agentCli: AgentCLI;
  location: TaskLocation;
  trackId: string;
  pillarId?: string;
  /** Resolved label IDs (joined from task_labels) */
  labels: string[];
  branchName?: string;
  worktreePath?: string;
  sessionId?: string;
  secondarySessionId?: string;
  lastSessionCwd?: string;
  /** Floating-point key for manual card ordering within a track */
  sortKey: number;
  prNumber?: number;
  prState: PRState;
  prDraft: boolean;
  prUrl?: string;
  ciState: CIState;
  ciSummary?: string;
  failingCheckName?: string;
  ciRequiredTotal: number;
  ciRequiredPassed: number;
  ciRequiredFailed: number;
  ciRequiredPending: number;
  reviewState: ReviewState;
  reviewSummary?: string;
  unresolvedThreadCount: number;
  githubSyncStatus: GitHubSyncStatus;
  githubSyncError?: string;
  githubLastSyncedAt?: number;
  gitState: GitState;
  gitAheadCount: number;
  gitBehindCount: number;
  hasUntracked: boolean;
  hasConflicts: boolean;
  sessionAttentionNeeded: boolean;
  sessionAttentionUpdatedAt?: number;
  /**
   * Every repo and branch this card is working in.
   *
   * A card spanning several repositories has one entry per repository, and
   * stacked work in one repository has one entry per branch. The flat `pr*`,
   * `ci*` and `review*` fields above are a rollup of these.
   */
  branches: TaskBranchRecord[];
  /** Which branch the session is currently working in. */
  activeBranchId?: string;
  prCount: number;
  prOpenCount: number;
  prMergedCount: number;
  /**
   * How far this card's merged work has travelled towards production.
   *
   * Absent until a pull request merges and the release status is resolved;
   * absent is "not known", never "not shipped".
   */
  release?: TaskReleaseSummary;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRecord {
  id: string;
  taskId: string;
  slot: SessionSlot;
  backendType: SessionBackendType;
  /** Backend-specific session identifier (e.g. tmux session name) */
  backendSessionId?: string;
  /** Shell command to reattach, e.g. "tmux attach -t agentboard_abc123" */
  attachCommand?: string;
  /** The agent CLI's own conversation id — see CreateSessionOpts.agentSessionId. */
  agentSessionId?: string;
  status: SessionStatus;
  cwd?: string;
  branch?: string;
  lastHeartbeat?: number;
  lastBufferSnapshot?: string;
  /**
   * Whether the initial brief's paste was ever verified on screen before
   * being submitted — undefined means no delivery attempt has run yet.
   * `false` means it's still sitting unsubmitted; see
   * `redeliverInitialPrompt`.
   */
  initialPromptDelivered?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SavedViewRecord {
  id: string;
  label: string;
  filters: FilterModel;
  /** System views (e.g. "needs-review") cannot be deleted */
  isSystem: boolean;
  createdAt: number;
}

export interface EventRecord {
  id: string;
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface UIStateRecord {
  activeRepoId?: string;
  activeViewId?: string;
  filters?: FilterModel;
  selectedTrackId?: string;
  selectedTaskId?: string;
  terminalPaneVisible?: boolean;
  terminalLayoutMode?: TerminalLayoutMode;
  terminalPaneWidth?: number;
  themeMode?: ThemeMode;
}

// --------------- Filter / View model ------------------------

export interface FilterModel {
  repoIds?: string[];
  pillarIds?: string[];
  labelIds?: string[];
  trackIds?: string[];
  prState?: PRState[];
  ciState?: CIState[];
  sessionState?: SessionStatus[];
  searchText?: string;
  includeArchived?: boolean;
}

// --------------- Board snapshot (TUI read model) ------------

export interface BoardSnapshot {
  repos: RepoRecord[];
  pillars: PillarRecord[];
  labels: LabelRecord[];
  tracks: TrackRecord[];
  tasks: TaskRecord[];
  savedViews: SavedViewRecord[];
  uiState: UIStateRecord;
}

// --------------- Session backend abstraction ----------------

export interface RedeliverPromptOptions {
  /**
   * Let the delivery skip its paste when `prompt`'s own opening is already on
   * the pane, and still send the Enter.
   *
   * Defaults to false — always paste. Only a caller re-sending text the pane
   * was already given (`SessionManager.redeliverInitialPrompt`, whose text is
   * the card's stored brief) may set it; see
   * `PasteVerifyOptions.skipIfAlreadyOnPane` in `pane-idle.ts` for why a
   * notify must not.
   */
  skipIfAlreadyOnPane?: boolean;
}

export interface SessionBackend {
  create(opts: CreateSessionOpts): Promise<SessionRecord>;
  attachMetadata(backendSessionId: string): Promise<AttachMetadata>;
  sendInput(backendSessionId: string, data: string): Promise<void>;
  resize(backendSessionId: string, cols: number, rows: number): Promise<void>;
  list(): Promise<BackendSessionInfo[]>;
  inspect(backendSessionId: string): Promise<BackendSessionInfo | null>;
  terminate(backendSessionId: string): Promise<void>;
  healthCheck(): Promise<BackendHealth>;
  /**
   * Discard the local plumbing that fronts a session on another machine, so the
   * next attach rebuilds it. Never touches the session itself.
   *
   * Only backends that have such plumbing implement this — a local tmux or PTY
   * session is its own front end and has nothing to reset.
   */
  resetAttachment?(backendSessionId: string): Promise<void>;
  /**
   * Re-delivers a prompt into an already-running session's pane — the manual
   * escape hatch for a session whose automatic initial-prompt delivery
   * (paste + retry, see pane-idle.ts) still didn't land within its window: a
   * slow SessionStart hook chain has no upper bound, so no fixed retry budget
   * can be guaranteed sufficient. Also the mechanism `notifyTaskSession` reuses
   * to type an automated notice into a session honestly, instead of the
   * unverified `sendInput` it used to use.
   *
   * Only backends that deliver prompts via paste implement this — PTY's
   * delivery path is argv-based and has no equivalent to re-run.
   *
   * Resolves `true` when the paste was verified to have rendered and Enter
   * was sent to submit it, `false` when the paste never verified — in which
   * case nothing was submitted, and whatever is on screen is left as-is
   * rather than risking a mangled fragment.
   *
   * `options.skipIfAlreadyOnPane` is what tells those two callers apart, since
   * nothing else about the call does: only a re-send of text the pane was
   * already given may skip its paste when that text is still on screen. See
   * `PasteVerifyOptions.skipIfAlreadyOnPane` in `pane-idle.ts` — for a notify,
   * whose text is a brand-new message, skipping drops it and reports success.
   */
  redeliverPrompt?(
    taskId: string,
    slot: SessionSlot,
    backendSessionId: string,
    prompt: string,
    agentCli?: string,
    options?: RedeliverPromptOptions,
  ): Promise<boolean>;
  /**
   * A one-shot snapshot of a live pane's rendered content, for detecting a
   * state the session's own status fields don't carry — e.g. the trust
   * prompt (see `redeliverPrompt`'s note) still showing.
   *
   * Only backends whose sessions are external panes implement this — a PTY
   * session's content already flows through `getBuffer`.
   */
  peekPane?(backendSessionId: string): Promise<string>;
  /**
   * The stable, backend-native id of the pane a session is running in.
   *
   * tmux window *indices* are renumbered as windows come and go, so an index
   * cached even a few minutes earlier can silently address a different card —
   * which is exactly how one agent's state was misread. A pane id is fixed for
   * the pane's whole life, so it is what external tooling should be given.
   *
   * Only backends whose sessions are external panes implement this.
   */
  resolvePaneId?(backendSessionId: string): Promise<string | null>;
}

export interface CreateSessionOpts {
  taskId: string;
  taskTitle: string;
  slot: SessionSlot;
  /** The `--name` to launch the agent CLI under, when the CLI supports one. */
  sessionName?: string;
  /** Defaults to 'repo'. A 'general' session skips all branch checkout. */
  taskKind?: TaskKind;
  /** Empty for general tasks. */
  repoPath: string;
  /** Empty for general tasks. */
  branch: string;
  agentCli: AgentCLI;
  cwd?: string;
  baseBranch?: string;
  usesWorktree?: boolean;
  bootstrapNotice?: string;
  sessionBootstrapScript: string;
  agentPermissionMode?: AgentPermissionMode;
  agentArgs?: Partial<Record<AgentCLI, string[]>>;
  /**
   * The conversation id to run the agent CLI under, stable for the life of the
   * card's slot.
   *
   * A card outlives the tmux pane it was last opened in, so relaunching one
   * would otherwise drop the user into a blank agent. Pinning the id lets the
   * bootstrap script resume that exact conversation — not merely the newest one
   * in the directory, which a card's second pane or a sibling task would win.
   */
  agentSessionId?: string;
  /**
   * The card's brief, handed to the agent as its opening prompt.
   *
   * Only reaches the agent when the conversation is starting fresh: replaying it
   * into a resumed conversation would re-run work the agent already did.
   */
  initialPrompt?: string;
  /**
   * Messages that arrived while this card had no session, delivered on the
   * agent's argv only if this open turns out to be a resume. `initialPrompt`
   * covers the fresh-start case; session-bootstrap.sh picks between them, so
   * neither can be delivered twice.
   */
  resumeNotice?: string;
  /**
   * Reports whether the automatic initial-prompt delivery (paste + retry
   * inside `create()`) was ever verified on screen — the one delivery path
   * `SessionManager` cannot observe directly, since it's fire-and-forget on
   * purpose (see `deliverInitialPrompt`'s own comment on why). Backends that
   * deliver via paste call this once delivery settles, success or failure;
   * backends with nothing to deliver (no `initialPrompt`) never call it.
   */
  onDeliveryResult?: (delivered: boolean) => void;
}

export interface AttachMetadata {
  /** Full shell command the user can run to reattach, e.g. "tmux attach -t ab_abc123" */
  command: string;
}

export interface BackendSessionInfo {
  backendSessionId: string;
  status: SessionStatus;
  lastActivity?: number;
  shellPid?: number;
  currentCommand?: string;
}

export interface SessionActivitySnapshot {
  taskId: string;
  sessionId?: string;
  slot?: SessionSlot;
  sessionStatus: SessionStatus;
  isBusy: boolean;
  kind?: SessionActivityKind;
  command?: string;
  label?: string;
  pid?: number;
  updatedAt: number;
}

/**
 * One live session's state, rolled up for `agentboard fleet` — the "poke N
 * tmux panes by hand" problem, solved by one table instead.
 */
export interface FleetSessionStatus {
  taskId: string;
  taskTitle: string;
  slot: SessionSlot;
  backendType: SessionBackendType;
  sessionStatus: SessionStatus;
  isBusy: boolean;
  attentionNeeded: boolean;
  /**
   * The session is sitting at Claude Code's own trust prompt — see
   * `SessionBackend.redeliverPrompt`'s note on why this used to hang a
   * `--start`ed session forever. Always false once `autoTrustIfPrompted`
   * (pane-idle.ts) is dismissing it on its own; a session still showing
   * `true` here means that dismissal itself didn't happen or didn't work.
   * Only ever set for tmux/ssh sessions — PTY has no separate pane to check.
   */
  trustPromptShowing: boolean;
  /** The backend's own session name, e.g. the `ab_*` tmux session. */
  backendSessionId?: string;
  /**
   * The pane this session runs in, addressable directly (`tmux send-keys -t
   * %42`). Stable for the pane's whole life, unlike a window index — see
   * `SessionBackend.resolvePaneId`. Absent for PTY sessions, and for a pane
   * that could not be resolved.
   */
  paneId?: string;
  /**
   * Whether the initial brief's paste was ever verified on screen — `null`
   * means no delivery attempt has run yet (or this backend doesn't track
   * it), `false` means it's sitting unsubmitted and `redeliverInitialPrompt`
   * is the fix.
   */
  delivered: boolean | null;
  createdAt: number;
}

/**
 * One task that wants a human right now, and the single most-actionable
 * reason why — see `SessionManager.getAttentionItems`'s priority order.
 */
export interface AttentionItem {
  taskId: string;
  taskTitle: string;
  reason: string;
}

export interface BackendHealth {
  available: boolean;
  version?: string;
  error?: string;
}

// --------------- RPC envelope --------------------------------

export interface RPCRequest {
  id: string;
  method: RPCMethod;
  params?: unknown;
}

export interface RPCResponse {
  id: string;
  result?: unknown;
  error?: RPCError;
}

export interface RPCError {
  code: number;
  message: string;
  data?: unknown;
}

/** Server-push event streamed over the IPC connection */
export interface RPCEvent {
  type: 'board_patch' | 'session_update' | 'sync_status' | 'daemon_health';
  payload: unknown;
}

export type RPCMethod =
  | 'getBoard'
  | 'setUIState'
  | 'createTask'
  | 'renameTask'
  | 'updateTaskDescription'
  | 'moveTask'
  | 'reorderTask'
  | 'createPillar'
  | 'deletePillar'
  | 'assignPillar'
  | 'setLabels'
  | 'archiveTask'
  | 'deleteTask'
  | 'addRepo'
  | 'updateRepo'
  | 'listRepos'
  | 'removeRepo'
  | 'listSavedViews'
  | 'createSavedView'
  | 'deleteSavedView'
  | 'openSession'
  | 'recreateSession'
  | 'reconnectSession'
  | 'teleportTaskPreflight'
  | 'teleportTask'
  | 'setDualSessionMode'
  | 'acknowledgeSessionAttention'
  | 'acknowledgeChildPrAlert'
  | 'sendInput'
  | 'notifyTaskSession'
  | 'redeliverInitialPrompt'
  | 'getFleetStatus'
  | 'getAttentionItems'
  | 'watchSessionUpdates'
  | 'resizeSession'
  | 'getBuffer'
  | 'inspectSession'
  | 'prepareTaskWorkspace'
  | 'syncTaskToMain'
  | 'createTaskPR'
  | 'commentTaskPR'
  | 'schedulePostPushSync'
  | 'mergeTaskPR'
  | 'setTaskBranch'
  | 'triggerSync'
  | 'chatTurn'
  | 'shutdownManagedOllama'
  | 'daemonStatus'
  | 'doctor'
  | 'getArtifacts'
  | 'refreshArtifacts'
  | 'rolloutArtifact'
  | 'getReleaseStatus'
  | 'refreshReleaseStatus'
  | 'setTrackedArtifacts'
  | 'getTrackedArtifacts'
  | 'addTaskBranch'
  | 'removeTaskBranch'
  | 'setActiveTaskBranch'
  | 'mergeTaskBranchPR'
  | 'commentTaskBranchPR'
  | 'subscribe';

// --------------- RPC param/result types ---------------------

export interface GetBoardParams {
  repoId?: string;
  filter?: FilterModel;
}
export type GetBoardResult = BoardSnapshot;

export type SetUIStateParams = Partial<UIStateRecord>;

export interface WatchSessionUpdatesParams {
  taskId?: string;
}

export interface CreateTaskParams {
  title: string;
  /** Free-text context shown on the card. */
  description?: string;
  /** Opening prompt for the agent's first conversation on this card. */
  initialPrompt?: string;
  /** Defaults to 'repo'. A 'general' task takes no repoId. */
  kind?: TaskKind;
  /** The card this one was spun off from, if it was created as a subtask. */
  parentTaskId?: string;
  /**
   * Explicit `--name` for this card's session. Defaults to the title
   * (prefixed with the parent's own sessionName, for a subtask) when omitted.
   */
  sessionName?: string;
  /** Required for 'repo' tasks, ignored for 'general' ones. */
  repoId?: string;
  agentCli?: AgentCLI;
  trackId?: string;
  pillarId?: string;
  /** Defaults to 'local'. 'remote' requires the repo to have a remotePath. */
  location?: TaskLocation;
}
export type CreateTaskResult = TaskRecord;

export interface SetTaskBranchParams {
  id: string;
  branchName: string;
}

export interface RenameTaskParams {
  id: string;
  title: string;
}

export interface UpdateTaskDescriptionParams {
  id: string;
  description: string;
}

export interface MoveTaskParams {
  id: string;
  trackId: string;
  sortKey?: number;
}

export interface ReorderTaskParams {
  id: string;
  /** New sort key within the same track */
  sortKey: number;
}

export interface CreatePillarParams {
  label: string;
}
export type CreatePillarResult = PillarRecord;

export interface DeletePillarParams {
  id: string;
}

export interface AssignPillarParams {
  id: string;
  pillarId: string | null;
}

export interface SetLabelsParams {
  id: string;
  labelIds: string[];
}

export interface ArchiveTaskParams {
  id: string;
}

export interface DeleteTaskParams {
  id: string;
}

export interface AddRepoParams {
  path: string;
  label?: string;
}
export type AddRepoResult = RepoRecord;

export interface UpdateRepoParams {
  id: string;
  label?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubUrl?: string;
  defaultBaseBranch?: string;
  defaultPillarId?: string;
  preferredIde?: PreferredIDE;
  ideCommand?: string;
  worktreeMode?: WorktreeMode;
  worktreeRoot?: string;
  remotePath?: string | null;
}
export type UpdateRepoResult = RepoRecord;

export interface RemoveRepoParams {
  id: string;
}

export interface CreateSavedViewParams {
  label: string;
  filters: FilterModel;
}
export type CreateSavedViewResult = SavedViewRecord;

export interface DeleteSavedViewParams {
  id: string;
}

export interface OpenSessionParams {
  taskId: string;
  slot?: SessionSlot;
}
export type OpenSessionResult = SessionRecord;

export interface ReconnectSessionParams {
  taskId: string;
  slot?: SessionSlot;
}

/**
 * What reconnect managed to do.
 *
 * 'attached'    — the remote session was still alive and is linked again.
 * 'recreated'   — the host is up but its session was gone (a workspace stop
 *                 kills the tmux server), so a fresh one was started.
 * 'starting'    — the workspace was off; the build runs in the background and
 *                 the board is patched once it lands.
 * 'unreachable' — the host could not be reached and could not be started.
 */
export type ReconnectSessionState = 'attached' | 'recreated' | 'starting' | 'unreachable';

export interface ReconnectSessionResult {
  state: ReconnectSessionState;
  message: string;
  session?: SessionRecord;
}

export type TeleportDirection = 'local-to-remote' | 'remote-to-local';

export interface TeleportTaskParams {
  taskId: string;
  direction: TeleportDirection;
}
export type TeleportTaskPreflightResult = DoctorCheck[];

export interface TeleportTaskResult {
  checks: DoctorCheck[];
  session: SessionRecord;
  wipCommitted: boolean;
  transcriptCopied: boolean;
}

export interface SetDualSessionModeParams {
  taskId: string;
  enabled: boolean;
}

export interface AcknowledgeSessionAttentionParams {
  taskId: string;
}

export interface AcknowledgeChildPrAlertParams {
  taskId: string;
}

export interface SendInputParams {
  taskId: string;
  data: string;
  slot?: SessionSlot;
}

/**
 * Types a message straight into another card's live session, the way a human
 * collaborator would by attaching and typing — for one task's agent to ping
 * another's, e.g. "address the PR comments" after reviewing a subtask's PR.
 */
export interface NotifyTaskSessionParams {
  taskId: string;
  message: string;
  slot?: SessionSlot;
}

/**
 * Re-delivers a card's stored brief into its already-running session — the
 * manual escape hatch for automatic delivery giving up too soon. See
 * `SessionManager.redeliverInitialPrompt`.
 */
export interface RedeliverInitialPromptParams {
  taskId: string;
  slot?: SessionSlot;
}

export interface ResizeSessionParams {
  taskId: string;
  cols: number;
  rows: number;
  slot?: SessionSlot;
}

export interface GetBufferParams {
  taskId: string;
  slot?: SessionSlot;
}

export interface InspectSessionParams {
  taskId: string;
  slot?: SessionSlot;
}

export interface PrepareTaskWorkspaceParams {
  taskId: string;
}

export interface TaskWorkspaceResult {
  taskId: string;
  path: string;
  repoPath: string;
  usedWorktree: boolean;
}

export interface CreateTaskPRParams {
  taskId: string;
}

export interface CommentTaskPRParams {
  taskId: string;
  body: string;
}

export interface SchedulePostPushSyncParams {
  taskId: string;
}

export interface MergeTaskPRParams {
  taskId: string;
}

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  createdAt: number;
  toolName?: string;
}

export interface ChatContext {
  activeRepoId?: string;
  selectedTaskId?: string;
  activeTaskId?: string;
  filters?: FilterModel;
}

export interface ChatTurnParams {
  prompt: string;
  transcript?: ChatMessage[];
  context?: ChatContext;
}

export interface ChatToolExecution {
  toolName: string;
  args: Record<string, unknown>;
  status: 'started' | 'completed' | 'failed';
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
}

export interface ChatTurnResult {
  assistantMessage: ChatMessage;
  transcript: ChatMessage[];
  executions: ChatToolExecution[];
}

export interface TaskSyncPatch {
  prNumber?: number | null;
  prState?: PRState;
  prDraft?: boolean;
  prUrl?: string | null;
  ciState?: CIState;
  ciSummary?: string | null;
  failingCheckName?: string | null;
  ciRequiredTotal?: number;
  ciRequiredPassed?: number;
  ciRequiredFailed?: number;
  ciRequiredPending?: number;
  reviewState?: ReviewState;
  reviewSummary?: string | null;
  unresolvedThreadCount?: number;
  githubSyncStatus?: GitHubSyncStatus;
  githubSyncError?: string | null;
  githubLastSyncedAt?: number | null;
  gitState?: GitState;
  gitAheadCount?: number;
  gitBehindCount?: number;
  hasUntracked?: boolean;
  hasConflicts?: boolean;
}

/**
 * A sync patch for one branch.
 *
 * Everything a card carries, plus the merge facts that only exist per branch —
 * a card has no single merge commit once it spans several pull requests.
 */
export interface TaskBranchSyncPatch extends TaskSyncPatch {
  mergeCommitSha?: string | null;
  mergedAt?: number | null;
}

export interface GetBufferResult {
  lines: string[];
  ansiLines: string[];
  cursorX: number;
  cursorY: number;
}

export interface SyncResult {
  tasksUpdated: number;
  errors: string[];
}

export interface DaemonStatus {
  version: string;
  pid: number;
  uptime: number;
  dbPath: string;
  socketPath: string;
}

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  remediation?: string;
}
export type DoctorResult = DoctorCheck[];

// --------------- Config -------------------------------------

export interface AgentMacro {
  id: string;
  label: string;
  command: string;
  args?: string[];
  /** Values may use ${env:VAR_NAME} syntax */
  env?: Record<string, string>;
}

export interface TrackConfig {
  id: string;
  label: string;
  sortOrder: number;
}

export interface PillarConfig {
  id: string;
  label: string;
  icon?: string;
  color?: string;
}

export interface RepoConfig {
  id: string;
  label: string;
  path: string;
  githubOwner?: string;
  githubRepo?: string;
  githubUrl?: string;
  defaultBaseBranch?: string;
  defaultPillarId?: string;
  preferredIde?: PreferredIDE;
  ideCommand?: string;
  worktreeMode?: WorktreeMode;
  worktreeRoot?: string;
  remotePath?: string;
}

export interface SavedViewConfig {
  id: string;
  label: string;
  filters: FilterModel;
}

export interface AIChatConfig {
  enabled: boolean;
  provider: 'ollama';
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
  maxToolRounds: number;
  historyLimit: number;
  systemPrompt?: string;
}

export interface TmuxConfig {
  autoLayout: boolean;
  layoutSessionName: string;
}

/** Where an artifact stands between production and its newest release candidate. */
export type ArtifactStatus = 'in-sync' | 'drift' | 'no-ga' | 'unknown';

export interface ArtifactRecord {
  /** Full project id, e.g. com.wixpress.web5.ecom-integrations */
  name: string;
  /** Group prefix stripped, for the narrow rail. */
  shortName: string;
  /** Deployment mode reported by devex: LIVE, DEV, MAINTENANCE. */
  mode?: string;
  isArchived?: boolean;
  /** Version currently in production. Absent for libraries and proto packages. */
  gaVersion?: string;
  latestRcVersion?: string;
  /** How many versions the newest RC is ahead of GA. */
  drift?: number;
  status: ArtifactStatus;
  repoUrl?: string;
  pathInRepo?: string;
  /** Release candidates built since the current GA. */
  pendingRcCount?: number;
  /**
   * How many of those RCs were built from a commit you authored — the signal for
   * "this one is waiting on me to roll it out". Undefined when ownership could
   * not be determined, which is distinct from a confident zero.
   */
  myPendingCount?: number;
  /**
   * A rollout currently moving this artifact towards production.
   *
   * Read by the release-status resolver so asking "is my commit mid-rollout"
   * costs no extra calls per pull request.
   */
  rolloutInFlight?: RolloutInFlight;
}

/** An in-flight production rollout, as far as the artifacts rail can see it. */
export interface RolloutInFlight {
  status: string;
  toVersion?: string;
  startedAt?: string;
}

/**
 * How far a merged pull request has travelled towards production.
 *
 * The ordering is a pipeline, not a ranking: `awaiting-build` -> `rc-built` ->
 * `rolling-out` -> `ga`. The three outcomes that are not stages of that
 * pipeline are kept separate on purpose — `no-artifact` is a confident "nothing
 * to ship here", while `unknown` is "could not tell", and conflating them would
 * let an outage read as success.
 */
export type ReleaseStage =
  | 'unknown'
  | 'not-merged'
  | 'no-artifact'
  | 'awaiting-build'
  | 'rc-built'
  | 'rolling-out'
  | 'ga';

/**
 * How the release candidate carrying a commit was identified.
 *
 * Only containment is recorded, because it is the only uncertain step: once the
 * candidate is known, comparing it against the production version is exact.
 * `time-order` is the weak one — it means the candidate was merely the first
 * built after the merge, with no ancestry check behind it.
 */
export type ReleaseEvidence = 'none' | 'where-is-my-commit' | 'ancestry' | 'time-order';

/**
 * How much the verdict can be trusted.
 *
 * `inferred` is reserved for release candidates built in a different repository
 * from the pull request — the monorepo mirror — where commit ancestry cannot be
 * checked and only build ordering supports the conclusion.
 */
export type ReleaseConfidence = 'confirmed' | 'inferred' | 'unknown';

/** Why a verdict came back `unknown`. Drives both the UI text and the retry delay. */
export type ReleaseUnknownReason =
  | 'not-polled'
  | 'mcp-auth'
  | 'mcp-error'
  | 'gh-error'
  | 'repo-not-tracked'
  | 'catalog-unavailable'
  | 'no-merge-commit'
  | 'commit-not-found'
  | 'unparseable-version';

/** Where one pull request stands with respect to one artifact. */
export interface ArtifactReleaseStatus {
  artifactName: string;
  shortName: string;
  stage: ReleaseStage;
  confidence: ReleaseConfidence;
  evidence: ReleaseEvidence;
  reason?: ReleaseUnknownReason;
  /** The release candidate proven to carry this pull request's merge commit. */
  containingRcVersion?: string;
  containingRcCommit?: string;
  /** Production version at the moment of the check, for explaining the verdict. */
  gaVersion?: string;
  rolloutToVersion?: string;
  /**
   * False for artifacts that never go GA — libraries and proto packages publish
   * release candidates forever, so gating a card on one would never complete.
   */
  gates: boolean;
  checkedAt: number;
}

/** Where one pull request stands across every artifact it touches. */
export interface PRReleaseStatus {
  repoSlug: string;
  prNumber: number;
  stage: ReleaseStage;
  confidence: ReleaseConfidence;
  reason?: ReleaseUnknownReason;
  artifacts: ArtifactReleaseStatus[];
  checkedAt: number;
}

/**
 * A card's release position, condensed to what one badge can say.
 *
 * The card shows the least-progressed pull request, because a feature is only
 * as shipped as its slowest part.
 */
export interface TaskReleaseSummary {
  stage: ReleaseStage;
  confidence: ReleaseConfidence;
  reason?: ReleaseUnknownReason;
  /** How many gating pull requests have reached production. */
  gaCount: number;
  gatingCount: number;
  /** The artifact holding the card back, shortened for the badge text. */
  blockingArtifact?: string;
  /** Its full project id, which is what a rollout has to name. */
  blockingArtifactName?: string;
  blockingRcVersion?: string;
  blockingGaVersion?: string;
  checkedAt: number;
}

/** Exposure strategy for a production rollout. There is deliberately no immediate option. */
export type RolloutGraduality = 'gradual_safer' | 'gradual_quicker';

export interface RolloutArtifactParams {
  /** Full project id. */
  name: string;
  /**
   * Version to roll out. Sent explicitly rather than re-read server-side so the
   * rollout is always the one the user actually saw and confirmed, even if a
   * newer RC landed in between.
   */
  targetVersion: string;
  graduality?: RolloutGraduality;
}

export interface RolloutArtifactResult {
  ok: boolean;
  transactionId?: string;
  status?: string;
  /** Human-readable outcome for the status bar. */
  message: string;
}

export interface ArtifactsSnapshot {
  artifacts: ArtifactRecord[];
  /** Epoch ms of the last successful refresh; 0 before the first one. */
  refreshedAt: number;
  /** True when these rows could not be refreshed and may be out of date. */
  stale: boolean;
  /** True when the failure was an expired or missing MCP login. */
  needsAuth?: boolean;
  error?: string;
}

/** Artifacts rail configuration. */
export interface ArtifactsConfig {
  /** Full project ids to track. An empty list hides the rail. */
  list: string[];
  refreshIntervalMs?: number;
  /** MCP endpoint serving the devex tools. */
  mcpServerUrl?: string;
  /**
   * GitHub login used to decide which pending RCs are yours.
   *
   * Deliberately a GitHub login rather than a git email: commits here are
   * authored under `<id>+<login>@users.noreply.github.com`, so matching on the
   * local git email finds nothing at all. Resolved from `gh api user` when unset.
   */
  githubLogin?: string;
}

/** Connection details for the machine that hosts remote tasks. */
export interface RemoteConfig {
  sshHost: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  /**
   * Who can power the host on again. Absent means AgentBoard can reach the host
   * or not, but can never start it — reconnect then requires a running host.
   */
  provider?: RemoteProviderKind;
  /** Coder workspace as `owner/name`, e.g. `alice/dev-box`. Required for 'coder'. */
  workspace?: string;
  /** Path to the `coder` binary. Defaults to `coder` on PATH. */
  coderBin?: string;
  /** How long to wait for a workspace build to reach 'running'. */
  startTimeoutMs?: number;
}

export type RemoteProviderKind = 'coder';

/**
 * Power state of the machine that hosts remote tasks.
 *
 * 'unknown' means the provider could not answer — a missing CLI, a hung control
 * plane, an unparseable response. It is never treated as a failure: callers fall
 * through to a plain SSH reachability probe, which is the authoritative signal.
 */
export type RemoteWorkspaceStatus = 'running' | 'stopped' | 'starting' | 'failed' | 'unknown';

export interface AppConfig {
  sessionBackend: SessionBackendType;
  tmux: TmuxConfig;
  sessionBootstrapScript: string;
  pollIntervalMs: number;
  githubTokenEnvVar?: string;
  remote?: RemoteConfig;
  artifacts?: ArtifactsConfig;
  /** Defaults to 'default'. 'bypass' skips the agent CLI's permission prompts. */
  agentPermissionMode?: AgentPermissionMode;
  /** Extra CLI arguments per agent, appended after any permission-mode flags. */
  agentArgs?: Partial<Record<AgentCLI, string[]>>;
  aiChat: AIChatConfig;
  tracks: TrackConfig[];
  pillars: PillarConfig[];
  repos: RepoConfig[];
  savedViews: SavedViewConfig[];
  agentMacros: AgentMacro[];
  theme?: ThemeMode;
  iconMode?: 'unicode' | 'ascii';
}

export interface RepoOverlayConfig {
  defaultBaseBranch?: string;
  defaultPillarId?: string;
  preferredIde?: PreferredIDE;
  ideCommand?: string;
  worktreeMode?: WorktreeMode;
  worktreeRoot?: string;
  remotePath?: string;
  agentMacros?: AgentMacro[];
}
