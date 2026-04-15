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
export type SessionBackendType = 'tmux' | 'pty';
export type RepoHealth = 'ok' | 'missing' | 'not-git';
export type ThemeMode = 'truecolor' | '256color' | 'monochrome';
export type WorktreeMode = 'off' | 'auto' | 'always';
export type PreferredIDE = 'system' | 'webstorm' | 'idea' | 'cursor' | 'vscode';
export type GitState = 'unknown' | 'clean' | 'dirty' | 'untracked' | 'conflicted' | 'detached';
export type TerminalLayoutMode = 'side-by-side' | 'top-bottom';
export type SessionActivityKind = 'agent' | 'process';
export type AgentCLI = 'claude' | 'codex';

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
  | 'repo.removed';

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

export interface TaskRecord {
  id: string;
  title: string;
  description?: string;
  repoId: string;
  agentCli: AgentCLI;
  trackId: string;
  pillarId?: string;
  /** Resolved label IDs (joined from task_labels) */
  labels: string[];
  branchName?: string;
  worktreePath?: string;
  sessionId?: string;
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
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRecord {
  id: string;
  taskId: string;
  backendType: SessionBackendType;
  /** Backend-specific session identifier (e.g. tmux session name) */
  backendSessionId?: string;
  /** Shell command to reattach, e.g. "tmux attach -t agentboard_abc123" */
  attachCommand?: string;
  status: SessionStatus;
  cwd?: string;
  branch?: string;
  lastHeartbeat?: number;
  lastBufferSnapshot?: string;
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

export interface SessionBackend {
  create(opts: CreateSessionOpts): Promise<SessionRecord>;
  attachMetadata(backendSessionId: string): Promise<AttachMetadata>;
  sendInput(backendSessionId: string, data: string): Promise<void>;
  resize(backendSessionId: string, cols: number, rows: number): Promise<void>;
  list(): Promise<BackendSessionInfo[]>;
  inspect(backendSessionId: string): Promise<BackendSessionInfo | null>;
  terminate(backendSessionId: string): Promise<void>;
  healthCheck(): Promise<BackendHealth>;
}

export interface CreateSessionOpts {
  taskId: string;
  taskTitle: string;
  repoPath: string;
  branch: string;
  agentCli: AgentCLI;
  cwd?: string;
  baseBranch?: string;
  usesWorktree?: boolean;
  bootstrapNotice?: string;
  sessionBootstrapScript: string;
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
  sessionStatus: SessionStatus;
  isBusy: boolean;
  kind?: SessionActivityKind;
  command?: string;
  label?: string;
  pid?: number;
  updatedAt: number;
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
  | 'acknowledgeSessionAttention'
  | 'sendInput'
  | 'resizeSession'
  | 'getBuffer'
  | 'inspectSession'
  | 'prepareTaskWorkspace'
  | 'createTaskPR'
  | 'commentTaskPR'
  | 'schedulePostPushSync'
  | 'mergeTaskPR'
  | 'triggerSync'
  | 'daemonStatus'
  | 'doctor'
  | 'subscribe';

// --------------- RPC param/result types ---------------------

export interface GetBoardParams {
  repoId?: string;
  filter?: FilterModel;
}
export type GetBoardResult = BoardSnapshot;

export type SetUIStateParams = Partial<UIStateRecord>;

export interface CreateTaskParams {
  title: string;
  repoId: string;
  agentCli?: AgentCLI;
  trackId?: string;
  pillarId?: string;
}
export type CreateTaskResult = TaskRecord;

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
}
export type OpenSessionResult = SessionRecord;

export interface AcknowledgeSessionAttentionParams {
  taskId: string;
}

export interface SendInputParams {
  taskId: string;
  data: string;
}

export interface ResizeSessionParams {
  taskId: string;
  cols: number;
  rows: number;
}

export interface GetBufferParams {
  taskId: string;
}

export interface InspectSessionParams {
  taskId: string;
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
}

export interface SavedViewConfig {
  id: string;
  label: string;
  filters: FilterModel;
}

export interface AppConfig {
  sessionBackend: SessionBackendType;
  sessionBootstrapScript: string;
  pollIntervalMs: number;
  githubTokenEnvVar?: string;
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
  agentMacros?: AgentMacro[];
}
