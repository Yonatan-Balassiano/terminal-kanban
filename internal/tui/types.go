package tui

type PRState string
type CIState string
type ReviewState string
type GitHubSyncStatus string
type SessionStatus string
type SessionSlot string
type SessionBackendType string
type RepoHealth string
type ThemeMode string
type WorktreeMode string
type PreferredIDE string
type GitState string
type TerminalLayoutMode string
type SessionActivityKind string
type AgentCLI string
type ArtifactStatus string
type ArtifactMode string

type AppFocus string
type ModalType string

const (
	SessionSlotPrimary   SessionSlot = "primary"
	SessionSlotSecondary SessionSlot = "secondary"
)

const (
	SessionBackendTmux SessionBackendType = "tmux"
	SessionBackendPty  SessionBackendType = "pty"
	SessionBackendSSH  SessionBackendType = "ssh"
)

const (
	TaskLocationLocal  = "local"
	TaskLocationRemote = "remote"
)

// GeneralScopeID is the board scope that shows only general tasks. It stands in
// for a repo ID in activeRepoID, which is why it uses a shape no real repo ID
// can take.
const GeneralScopeID = "__general__"

const (
	// TaskKindRepo is the normal card: a repo, a branch, a worktree, GitHub state.
	TaskKindRepo = "repo"
	// TaskKindGeneral is a standalone card — a title and an agent session, with
	// no repo, branch, worktree, or PR.
	TaskKindGeneral = "general"
)

// IsGeneral reports whether the task is a standalone card with no repo.
func (t TaskRecord) IsGeneral() bool {
	return t.Kind == TaskKindGeneral
}

const (
	ArtifactStatusInSync  ArtifactStatus = "in-sync"
	ArtifactStatusDrift   ArtifactStatus = "drift"
	ArtifactStatusNoGA    ArtifactStatus = "no-ga"
	ArtifactStatusUnknown ArtifactStatus = "unknown"
)

// Any mode other than LIVE is tagged in the footer so a DEV or MAINTENANCE
// artifact is never read as production.
const ArtifactModeLive ArtifactMode = "LIVE"

const (
	FocusBoard     AppFocus = "board"
	FocusTerminal  AppFocus = "terminal"
	FocusFilterBar AppFocus = "filterbar"
	FocusModal     AppFocus = "modal"
	FocusSearch    AppFocus = "search"
)

const (
	ModalCreateTask      ModalType = "create-task"
	ModalCommandPalette  ModalType = "command-palette"
	ModalRenameTask      ModalType = "rename-task"
	ModalTaskDescription ModalType = "task-description"
	ModalPRComment       ModalType = "pr-comment"
	ModalDeleteConfirm   ModalType = "delete-confirm"
	ModalFilterPicker    ModalType = "filter-picker"
	ModalCreatePillar    ModalType = "create-pillar"
	ModalDeletePillar    ModalType = "delete-pillar-confirm"
	ModalPillarPicker    ModalType = "pillar-picker"
	ModalViewPicker      ModalType = "view-picker"
	ModalAIChat          ModalType = "ai-chat"
	ModalSetBranch       ModalType = "set-branch"
	ModalArtifactRollout ModalType = "artifact-rollout"
	ModalHelp            ModalType = "help"
	ModalNone            ModalType = ""
)

type RepoRecord struct {
	ID                string       `json:"id"`
	Label             string       `json:"label"`
	Path              string       `json:"path"`
	GitHubOwner       string       `json:"githubOwner"`
	GitHubRepo        string       `json:"githubRepo"`
	GitHubURL         string       `json:"githubUrl"`
	DefaultBaseBranch string       `json:"defaultBaseBranch"`
	DefaultPillarID   string       `json:"defaultPillarId"`
	PreferredIDE      PreferredIDE `json:"preferredIde"`
	IDECommand        string       `json:"ideCommand"`
	WorktreeMode      WorktreeMode `json:"worktreeMode"`
	WorktreeRoot      string       `json:"worktreeRoot"`
	RemotePath        string       `json:"remotePath"`
	Health            RepoHealth   `json:"health"`
	CreatedAt         int64        `json:"createdAt"`
	UpdatedAt         int64        `json:"updatedAt"`
}

type PillarRecord struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Icon  string `json:"icon"`
	Color string `json:"color"`
}

type LabelRecord struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Color string `json:"color"`
}

type TrackRecord struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	SortOrder int    `json:"sortOrder"`
}

type TaskRecord struct {
	ID                        string           `json:"id"`
	Title                     string           `json:"title"`
	Description               string           `json:"description"`
	Kind                      string           `json:"kind"`
	RepoID                    string           `json:"repoId"`
	Location                  string           `json:"location"`
	AgentCLI                  AgentCLI         `json:"agentCli"`
	TrackID                   string           `json:"trackId"`
	PillarID                  string           `json:"pillarId"`
	Labels                    []string         `json:"labels"`
	BranchName                string           `json:"branchName"`
	WorktreePath              string           `json:"worktreePath"`
	SessionID                 string           `json:"sessionId"`
	SecondarySessionID        string           `json:"secondarySessionId"`
	LastSessionCWD            string           `json:"lastSessionCwd"`
	SortKey                   float64          `json:"sortKey"`
	PRNumber                  *int             `json:"prNumber"`
	PRState                   PRState          `json:"prState"`
	PRDraft                   bool             `json:"prDraft"`
	PRURL                     string           `json:"prUrl"`
	CIState                   CIState          `json:"ciState"`
	CISummary                 string           `json:"ciSummary"`
	FailingCheckName          string           `json:"failingCheckName"`
	CIRequiredTotal           int              `json:"ciRequiredTotal"`
	CIRequiredPassed          int              `json:"ciRequiredPassed"`
	CIRequiredFailed          int              `json:"ciRequiredFailed"`
	CIRequiredPending         int              `json:"ciRequiredPending"`
	ReviewState               ReviewState      `json:"reviewState"`
	ReviewSummary             string           `json:"reviewSummary"`
	UnresolvedThreadCount     int              `json:"unresolvedThreadCount"`
	GitHubSyncStatus          GitHubSyncStatus `json:"githubSyncStatus"`
	GitHubSyncError           string           `json:"githubSyncError"`
	GitHubLastSyncedAt        *int64           `json:"githubLastSyncedAt"`
	GitState                  GitState         `json:"gitState"`
	GitAheadCount             int              `json:"gitAheadCount"`
	GitBehindCount            int              `json:"gitBehindCount"`
	HasUntracked              bool             `json:"hasUntracked"`
	HasConflicts              bool             `json:"hasConflicts"`
	SessionAttentionNeeded    bool             `json:"sessionAttentionNeeded"`
	SessionAttentionUpdatedAt *int64           `json:"sessionAttentionUpdatedAt"`
	// Every repo and branch this card is working in. The flat PR, CI and review
	// fields above are a rollup of these.
	Branches       []TaskBranchRecord `json:"branches"`
	ActiveBranchID string             `json:"activeBranchId"`
	PRCount        int                `json:"prCount"`
	PROpenCount    int                `json:"prOpenCount"`
	PRMergedCount  int                `json:"prMergedCount"`
	// Nil until the daemon has resolved where this card's merged work got to.
	// Nil is "not known", never "not shipped".
	Release    *TaskReleaseSummary `json:"release"`
	ArchivedAt *int64              `json:"archivedAt"`
	CreatedAt  int64               `json:"createdAt"`
	UpdatedAt  int64               `json:"updatedAt"`
}

// TaskBranchRecord is one repo + branch a card is working in, and the pull
// request that branch carries. Actions that merge, comment on, or open "the PR"
// operate at this level, because a card no longer has a single answer.
type TaskBranchRecord struct {
	ID                    string           `json:"id"`
	TaskID                string           `json:"taskId"`
	RepoID                string           `json:"repoId"`
	BranchName            string           `json:"branchName"`
	BaseBranch            string           `json:"baseBranch"`
	WorktreePath          string           `json:"worktreePath"`
	SortKey               float64          `json:"sortKey"`
	PRNumber              *int             `json:"prNumber"`
	PRURL                 string           `json:"prUrl"`
	PRState               PRState          `json:"prState"`
	PRDraft               bool             `json:"prDraft"`
	MergeCommitSha        string           `json:"mergeCommitSha"`
	MergedAt              *int64           `json:"mergedAt"`
	CIState               CIState          `json:"ciState"`
	CISummary             string           `json:"ciSummary"`
	FailingCheckName      string           `json:"failingCheckName"`
	CIRequiredTotal       int              `json:"ciRequiredTotal"`
	CIRequiredPassed      int              `json:"ciRequiredPassed"`
	CIRequiredFailed      int              `json:"ciRequiredFailed"`
	CIRequiredPending     int              `json:"ciRequiredPending"`
	ReviewState           ReviewState      `json:"reviewState"`
	ReviewSummary         string           `json:"reviewSummary"`
	UnresolvedThreadCount int              `json:"unresolvedThreadCount"`
	GitState              GitState         `json:"gitState"`
	GitAheadCount         int              `json:"gitAheadCount"`
	GitBehindCount        int              `json:"gitBehindCount"`
	HasUntracked          bool             `json:"hasUntracked"`
	HasConflicts          bool             `json:"hasConflicts"`
	GitHubSyncStatus      GitHubSyncStatus `json:"githubSyncStatus"`
	GitHubSyncError       string           `json:"githubSyncError"`
	GitHubLastSyncedAt    *int64           `json:"githubLastSyncedAt"`
	CreatedAt             int64            `json:"createdAt"`
	UpdatedAt             int64            `json:"updatedAt"`
}

// TaskReleaseSummary is how far a card's merged work has travelled towards
// production, condensed to what one badge can show.
type TaskReleaseSummary struct {
	Stage       string `json:"stage"`
	Confidence  string `json:"confidence"`
	Reason      string `json:"reason"`
	GaCount     int    `json:"gaCount"`
	GatingCount int    `json:"gatingCount"`
	// The artifact holding the card back, already shortened for a narrow card.
	BlockingArtifact string `json:"blockingArtifact"`
	// The full project id; the short name above cannot name a rollout target.
	BlockingArtifactName string `json:"blockingArtifactName"`
	BlockingRcVersion    string `json:"blockingRcVersion"`
	BlockingGaVersion    string `json:"blockingGaVersion"`
	CheckedAt            int64  `json:"checkedAt"`
}

type ArtifactRecord struct {
	Name      string       `json:"name"`
	ShortName string       `json:"shortName"`
	Mode      ArtifactMode `json:"mode,omitempty"`
	// Libraries and proto packages publish RCs but never go GA, so an absent GA
	// version is meaningful data rather than a gap.
	GAVersion       string `json:"gaVersion,omitempty"`
	LatestRCVersion string `json:"latestRcVersion"`
	Drift           *int   `json:"drift,omitempty"`
	// Release candidates built since the current GA.
	PendingRcCount *int `json:"pendingRcCount,omitempty"`
	// How many of those RCs came from the user. Nil means ownership could not be
	// resolved, which must stay distinguishable from a confident zero: rendering
	// an unknown as 0 would claim none of the pending work is theirs.
	MyPendingCount *int           `json:"myPendingCount,omitempty"`
	Status         ArtifactStatus `json:"status"`
	RepoURL        string         `json:"repoUrl"`
	PathInRepo     string         `json:"pathInRepo"`
	IsArchived     bool           `json:"isArchived"`
}

type ArtifactsSnapshot struct {
	Artifacts   []ArtifactRecord `json:"artifacts"`
	RefreshedAt int64            `json:"refreshedAt"`
	Stale       bool             `json:"stale"`
	NeedsAuth   bool             `json:"needsAuth"`
	Error       string           `json:"error,omitempty"`
}

type ArtifactRolloutResult struct {
	OK            bool   `json:"ok"`
	TransactionID string `json:"transactionId"`
	Status        string `json:"status"`
	Message       string `json:"message"`
}

type SessionRecord struct {
	ID               string             `json:"id"`
	TaskID           string             `json:"taskId"`
	Slot             SessionSlot        `json:"slot"`
	BackendType      SessionBackendType `json:"backendType"`
	BackendSessionID string             `json:"backendSessionId"`
	AttachCommand    string             `json:"attachCommand"`
	Status           SessionStatus      `json:"status"`
	CWD              string             `json:"cwd"`
	Branch           string             `json:"branch"`
	LastHeartbeat    int64              `json:"lastHeartbeat"`
	LastBufferSnap   string             `json:"lastBufferSnapshot"`
	CreatedAt        int64              `json:"createdAt"`
	UpdatedAt        int64              `json:"updatedAt"`
}

// Outcome of reconnecting a remote card. State is one of "attached",
// "recreated", "starting", or "unreachable"; only the first two carry a session
// — a waking or unreachable host has nothing to attach to yet.
type ReconnectSessionResult struct {
	State   string         `json:"state"`
	Message string         `json:"message"`
	Session *SessionRecord `json:"session,omitempty"`
}

type SavedViewRecord struct {
	ID        string      `json:"id"`
	Label     string      `json:"label"`
	Filters   FilterModel `json:"filters"`
	IsSystem  bool        `json:"isSystem"`
	CreatedAt int64       `json:"createdAt"`
}

type UIStateRecord struct {
	ActiveRepoID        string             `json:"activeRepoId"`
	ActiveViewID        string             `json:"activeViewId"`
	Filters             *FilterModel       `json:"filters"`
	SelectedTrackID     string             `json:"selectedTrackId"`
	SelectedTaskID      string             `json:"selectedTaskId"`
	TerminalPaneVisible *bool              `json:"terminalPaneVisible"`
	TerminalLayoutMode  TerminalLayoutMode `json:"terminalLayoutMode"`
	TerminalPaneWidth   *int               `json:"terminalPaneWidth"`
	ThemeMode           ThemeMode          `json:"themeMode"`
}

type FilterModel struct {
	RepoIDs         []string        `json:"repoIds,omitempty"`
	PillarIDs       []string        `json:"pillarIds,omitempty"`
	LabelIDs        []string        `json:"labelIds,omitempty"`
	TrackIDs        []string        `json:"trackIds,omitempty"`
	PRState         []PRState       `json:"prState,omitempty"`
	CIState         []CIState       `json:"ciState,omitempty"`
	SessionState    []SessionStatus `json:"sessionState,omitempty"`
	SearchText      string          `json:"searchText,omitempty"`
	IncludeArchived bool            `json:"includeArchived,omitempty"`
}

type BoardSnapshot struct {
	Repos      []RepoRecord      `json:"repos"`
	Pillars    []PillarRecord    `json:"pillars"`
	Labels     []LabelRecord     `json:"labels"`
	Tracks     []TrackRecord     `json:"tracks"`
	Tasks      []TaskRecord      `json:"tasks"`
	SavedViews []SavedViewRecord `json:"savedViews"`
	UIState    UIStateRecord     `json:"uiState"`
}

type SessionActivitySnapshot struct {
	TaskID        string              `json:"taskId"`
	SessionID     string              `json:"sessionId"`
	Slot          SessionSlot         `json:"slot"`
	SessionStatus SessionStatus       `json:"sessionStatus"`
	IsBusy        bool                `json:"isBusy"`
	Kind          SessionActivityKind `json:"kind"`
	Command       string              `json:"command"`
	Label         string              `json:"label"`
	PID           *int                `json:"pid"`
	UpdatedAt     int64               `json:"updatedAt"`
}

type GetBufferResult struct {
	Lines     []string `json:"lines"`
	ANSILines []string `json:"ansiLines"`
	CursorX   int      `json:"cursorX"`
	CursorY   int      `json:"cursorY"`
}

type SyncResult struct {
	TasksUpdated int      `json:"tasksUpdated"`
	Errors       []string `json:"errors"`
}

type TaskWorkspaceResult struct {
	Path string `json:"path"`
}

type ChatMessage struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	CreatedAt int64  `json:"createdAt"`
	ToolName  string `json:"toolName"`
}

type ChatToolExecution struct {
	ToolName   string                 `json:"toolName"`
	Args       map[string]interface{} `json:"args"`
	Status     string                 `json:"status"`
	StartedAt  int64                  `json:"startedAt"`
	FinishedAt *int64                 `json:"finishedAt"`
	Summary    string                 `json:"summary"`
	Error      string                 `json:"error"`
}

type ChatContext struct {
	ActiveRepoID   string       `json:"activeRepoId"`
	SelectedTaskID string       `json:"selectedTaskId"`
	ActiveTaskID   string       `json:"activeTaskId"`
	Filters        *FilterModel `json:"filters"`
}

type ChatTurnResult struct {
	AssistantMessage ChatMessage         `json:"assistantMessage"`
	Transcript       []ChatMessage       `json:"transcript"`
	Executions       []ChatToolExecution `json:"executions"`
}

type SessionUpdateEvent struct {
	TaskID    string      `json:"taskId"`
	Slot      SessionSlot `json:"slot"`
	Lines     []string    `json:"lines"`
	ANSILines []string    `json:"ansiLines"`
	CursorX   int         `json:"cursorX"`
	CursorY   int         `json:"cursorY"`
}

type SyncStatusPayload struct {
	Status string `json:"status"`
}

type CommandPaletteItem struct {
	ID             string
	Title          string
	Section        string
	Detail         string
	Shortcut       string
	Keywords       []string
	Disabled       bool
	DisabledReason string
}
