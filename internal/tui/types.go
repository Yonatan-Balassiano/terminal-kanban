package tui

type PRState string
type CIState string
type ReviewState string
type SessionStatus string
type SessionBackendType string
type RepoHealth string
type ThemeMode string
type WorktreeMode string
type PreferredIDE string
type GitState string
type TerminalLayoutMode string
type SessionActivityKind string

type AppFocus string
type ModalType string

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
	ModalArchiveConfirm  ModalType = "archive-confirm"
	ModalDeleteConfirm   ModalType = "delete-confirm"
	ModalFilterPicker    ModalType = "filter-picker"
	ModalCreatePillar    ModalType = "create-pillar"
	ModalDeletePillar    ModalType = "delete-pillar-confirm"
	ModalPillarPicker    ModalType = "pillar-picker"
	ModalViewPicker      ModalType = "view-picker"
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
	ID                    string      `json:"id"`
	Title                 string      `json:"title"`
	Description           string      `json:"description"`
	RepoID                string      `json:"repoId"`
	TrackID               string      `json:"trackId"`
	PillarID              string      `json:"pillarId"`
	Labels                []string    `json:"labels"`
	BranchName            string      `json:"branchName"`
	WorktreePath          string      `json:"worktreePath"`
	SessionID             string      `json:"sessionId"`
	LastSessionCWD        string      `json:"lastSessionCwd"`
	SortKey               float64     `json:"sortKey"`
	PRNumber              *int        `json:"prNumber"`
	PRState               PRState     `json:"prState"`
	PRDraft               bool        `json:"prDraft"`
	PRURL                 string      `json:"prUrl"`
	CIState               CIState     `json:"ciState"`
	CISummary             string      `json:"ciSummary"`
	FailingCheckName      string      `json:"failingCheckName"`
	ReviewState           ReviewState `json:"reviewState"`
	ReviewSummary         string      `json:"reviewSummary"`
	UnresolvedThreadCount int         `json:"unresolvedThreadCount"`
	GitState              GitState    `json:"gitState"`
	GitAheadCount         int         `json:"gitAheadCount"`
	GitBehindCount        int         `json:"gitBehindCount"`
	HasUntracked          bool        `json:"hasUntracked"`
	HasConflicts          bool        `json:"hasConflicts"`
	ArchivedAt            *int64      `json:"archivedAt"`
	CreatedAt             int64       `json:"createdAt"`
	UpdatedAt             int64       `json:"updatedAt"`
}

type SessionRecord struct {
	ID               string             `json:"id"`
	TaskID           string             `json:"taskId"`
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
	ActiveRepoID        string             `json:"activeRepoId"`
	ActiveViewID        string             `json:"activeViewId"`
	Filters             *FilterModel       `json:"filters"`
	SelectedTrackID     string             `json:"selectedTrackId"`
	SelectedTaskID      string             `json:"selectedTaskId"`
	TerminalPaneVisible *bool              `json:"terminalPaneVisible"`
	TerminalLayoutMode  TerminalLayoutMode `json:"terminalLayoutMode"`
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

type SessionUpdateEvent struct {
	TaskID    string   `json:"taskId"`
	Lines     []string `json:"lines"`
	ANSILines []string `json:"ansiLines"`
	CursorX   int      `json:"cursorX"`
	CursorY   int      `json:"cursorY"`
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
