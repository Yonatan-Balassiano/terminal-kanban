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
type MissionTaskStatus string

type AppFocus string
type ModalType string

const (
	SessionSlotPrimary   SessionSlot = "primary"
	SessionSlotSecondary SessionSlot = "secondary"
)

const (
	SessionBackendTmux SessionBackendType = "tmux"
	SessionBackendPty  SessionBackendType = "pty"
)

const (
	FocusBoard     AppFocus = "board"
	FocusTerminal  AppFocus = "terminal"
	FocusFilterBar AppFocus = "filterbar"
	FocusModal     AppFocus = "modal"
	FocusSearch    AppFocus = "search"
	FocusMissions  AppFocus = "missions"
)

const (
	ModalCreateTask      ModalType = "create-task"
	ModalCreateMission   ModalType = "create-mission"
	ModalAddMissionTask  ModalType = "add-mission-task"
	ModalCommandPalette  ModalType = "command-palette"
	ModalMissionDeps     ModalType = "mission-dependencies"
	ModalDeleteMission   ModalType = "delete-mission-confirm"
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
	RepoID                    string           `json:"repoId"`
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
	ArchivedAt                *int64           `json:"archivedAt"`
	CreatedAt                 int64            `json:"createdAt"`
	UpdatedAt                 int64            `json:"updatedAt"`
}

type MissionRecord struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	SortKey     float64 `json:"sortKey"`
	CompletedAt *int64  `json:"completedAt"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
}

type MissionStatusCounts struct {
	Backlog    int `json:"backlog"`
	InProgress int `json:"inProgress"`
	PR         int `json:"pr"`
	Merged     int `json:"merged"`
}

type MissionTaskRecord struct {
	MissionID       string            `json:"missionId"`
	TaskID          string            `json:"taskId"`
	SortKey         float64           `json:"sortKey"`
	ReleasedToBoard bool              `json:"releasedToBoard"`
	ReleasedAt      *int64            `json:"releasedAt"`
	BlockerTaskIDs  []string          `json:"blockerTaskIds"`
	BlockedTaskIDs  []string          `json:"blockedTaskIds"`
	Status          MissionTaskStatus `json:"status"`
	IsBlocked       bool              `json:"isBlocked"`
	Task            TaskRecord        `json:"task"`
}

type MissionSnapshot struct {
	ID          string              `json:"id"`
	Title       string              `json:"title"`
	SortKey     float64             `json:"sortKey"`
	CompletedAt *int64              `json:"completedAt"`
	CreatedAt   int64               `json:"createdAt"`
	UpdatedAt   int64               `json:"updatedAt"`
	Counts      MissionStatusCounts `json:"counts"`
	Tasks       []MissionTaskRecord `json:"tasks"`
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

type SavedViewRecord struct {
	ID        string      `json:"id"`
	Label     string      `json:"label"`
	Filters   FilterModel `json:"filters"`
	IsSystem  bool        `json:"isSystem"`
	CreatedAt int64       `json:"createdAt"`
}

type UIStateRecord struct {
	ActiveRepoID          string             `json:"activeRepoId"`
	ActiveViewID          string             `json:"activeViewId"`
	Filters               *FilterModel       `json:"filters"`
	SelectedTrackID       string             `json:"selectedTrackId"`
	SelectedTaskID        string             `json:"selectedTaskId"`
	SelectedMissionID     string             `json:"selectedMissionId"`
	SelectedMissionTaskID string             `json:"selectedMissionTaskId"`
	TerminalPaneVisible   *bool              `json:"terminalPaneVisible"`
	TerminalLayoutMode    TerminalLayoutMode `json:"terminalLayoutMode"`
	TerminalPaneWidth     *int               `json:"terminalPaneWidth"`
	MissionsPaneExpanded  *bool              `json:"missionsPaneExpanded"`
	ThemeMode             ThemeMode          `json:"themeMode"`
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
	Missions   []MissionSnapshot `json:"missions"`
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
	ActiveRepoID          string       `json:"activeRepoId"`
	SelectedTaskID        string       `json:"selectedTaskId"`
	SelectedMissionID     string       `json:"selectedMissionId"`
	SelectedMissionTaskID string       `json:"selectedMissionTaskId"`
	ActiveTaskID          string       `json:"activeTaskId"`
	Filters               *FilterModel `json:"filters"`
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
