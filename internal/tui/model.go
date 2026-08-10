package tui

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os/exec"
	"runtime"
	"slices"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

const (
	terminalDividerWidth      = 1
	terminalPaneFrameWidth    = 2
	terminalSlotDividerHeight = 1
	missionRailCollapsedWidth = 18
	missionRailExpandedWidth  = 36
	minTerminalPaneWidth      = 40
	terminalResizeStep        = 8
	trackColumnStyleWidth     = 32
	trackColumnRenderWidth    = trackColumnStyleWidth + 2
	minBoardPaneWidth         = missionRailCollapsedWidth + trackColumnRenderWidth
	trackHeaderWidth          = trackColumnStyleWidth - 2
	taskCardStyleWidth        = trackColumnStyleWidth - 2
	taskCardContentWidth      = taskCardStyleWidth - 2
	collapsedTrackStyleWidth  = 10
	collapsedTrackRenderWidth = collapsedTrackStyleWidth + 2
	collapsedTrackHeaderWidth = collapsedTrackStyleWidth - 2
	terminalHeaderHeight      = 1
	terminalFooterHeight      = 1
	terminalInputFlushMillis  = 6
	terminalBoardNavTimeout   = 250 * time.Millisecond
	artifactsPollInterval     = 60 * time.Second
)

// FocusDetail lives here rather than beside the other AppFocus values because
// types.go is a shared contract with the daemon and is frozen; the pane is
// TUI-local state that never crosses the socket.
const FocusDetail AppFocus = "detail"

type boardLoadedMsg struct {
	board BoardSnapshot
	err   error
}

type boardActionMsg struct {
	board               *BoardSnapshot
	status              string
	selectMissionID     string
	selectMissionTaskID string
	openMissionsPane    bool
	activateTaskID      string
	focusTerminalSlot   SessionSlot
	err                 error
}

type sessionOpenedMsg struct {
	taskID    string
	slot      SessionSlot
	session   SessionRecord
	board     *BoardSnapshot
	buffer    *GetBufferResult
	activity  *SessionActivitySnapshot
	layoutErr error
	err       error
	// Replaces the generic "Opened task shell." line. Reconnect uses it to say
	// whether the running agent was recovered or a new one had to be started.
	statusOverride string
}

type bufferLoadedMsg struct {
	taskID string
	slot   SessionSlot
	buffer GetBufferResult
	err    error
}

type sessionActivityMsg struct {
	taskID   string
	slot     SessionSlot
	activity *SessionActivitySnapshot
	err      error
}

type rpcEventMsg struct {
	event RPCEvent
}

type asyncErrorMsg struct {
	err error
}

type tmuxPaneAttachedMsg struct {
	err error
}

type chatTurnMsg struct {
	result ChatTurnResult
	err    error
}

type artifactsLoadedMsg struct {
	snapshot ArtifactsSnapshot
	manual   bool
	err      error
}

type artifactRolloutMsg struct {
	result ArtifactRolloutResult
	err    error
}

type artifactListAppliedMsg struct {
	names []string
	err   error
}

// trackedArtifactsLoadedMsg carries the configured list into the open editor.
type trackedArtifactsLoadedMsg struct {
	names []string
	err   error
}

// leaderTimeoutMsg abandons a chord nobody finished typing.
type leaderTimeoutMsg struct {
	Version int
}

type spinnerTickMsg struct{}
type sessionPollTickMsg struct{}
type artifactsPollTickMsg struct{}
type terminalBoardNavTimeoutMsg struct {
	Version int
}

type boardNavigationAction int

const (
	boardNavigationNone boardNavigationAction = iota
	boardNavigationLeft
	boardNavigationRight
	boardNavigationUp
	boardNavigationDown
)

type missionSelectionRef struct {
	MissionIndex int
	TaskIndex    int
}

type sessionTarget struct {
	TaskID string
	Slot   SessionSlot
}

const (
	missionSummaryRowTaskIndex = -1
	missionEmptyRowTaskIndex   = -2
)

type Model struct {
	client *RPCClient

	width  int
	height int

	repos      []RepoRecord
	pillars    []PillarRecord
	labels     []LabelRecord
	tracks     []TrackRecord
	tasks      []TaskRecord
	missions   []MissionSnapshot
	savedViews []SavedViewRecord
	artifacts  ArtifactsSnapshot

	focus                         AppFocus
	modal                         ModalType
	activeRepoID                  string
	activeViewID                  string
	filters                       FilterModel
	selectedTrackIndex            int
	selectedTaskIndex             int
	selectedMissionIndex          int
	selectedMissionTaskIndex      int
	selectedArtifactIndex         int
	terminalPaneVisible           bool
	terminalLayoutMode            TerminalLayoutMode
	boardDensityMode              string
	boardOverviewMode             bool
	overviewSelectedIndex         int
	missionsPaneExpanded          bool
	activeTaskID                  string
	activeSessionBranch           string
	activeSessionBackendType      SessionBackendType
	activeSessionBackendSessionID string
	activeSessionAttachCommand    string
	secondarySessionBranch        string
	secondarySessionBackendType   SessionBackendType
	secondarySessionBackendID     string
	secondarySessionAttachCommand string
	sessionActivityByTaskID       map[string]*SessionActivitySnapshot
	sessionActivityByKey          map[string]*SessionActivitySnapshot
	terminalPaneWidth             int
	terminalFullscreen            bool
	terminalScrollOffset          int
	secondaryTerminalScrollOffset int
	syncInProgress                bool
	statusMessage                 string
	daemonConnected               bool
	themeMode                     ThemeMode
	buffer                        GetBufferResult
	secondaryBuffer               GetBufferResult
	spinnerIndex                  int
	spinnerChainActive            bool
	terminalCommand               string
	secondaryTerminalCommand      string
	pendingTerminalInput          string
	pendingTerminalInputTaskID    string
	pendingTerminalInputSlot      SessionSlot
	pendingTerminalPushSync       bool
	focusedTerminalSlot           SessionSlot
	watchedSessionTaskID          string
	terminalInputFlushVersion     int
	postPushSyncVersion           int
	terminalBoardNavPending       bool
	terminalBoardNavTaskID        string
	terminalBoardNavSlot          SessionSlot
	terminalBoardNavConsumed      bool
	terminalBoardNavVersion       int
	leaderPending                 bool
	leaderBuffer                  string
	leaderVersion                 int
	detailPaneVisible             bool
	detailBranchIndex             int

	createTaskModal           *createTaskModalState
	createMissionModal        *createMissionModalState
	addMissionTaskModal       *addMissionTaskModalState
	renameTaskModal           *renameTaskModalState
	setBranchModal            *setBranchModalState
	taskDescriptionModal      *taskDescriptionModalState
	prCommentModal            *prCommentModalState
	deleteMissionConfirmModal *deleteMissionConfirmModalState
	deleteConfirmModal        *deleteConfirmModalState
	createPillarModal         *createPillarModalState
	deletePillarConfirmModal  *deletePillarConfirmModalState
	pillarPickerModal         *pillarPickerModalState
	filterModal               *filterModalState
	viewModal                 *viewModalState
	commandPaletteModal       *commandPaletteModalState
	aiChatModal               *aiChatModalState
	missionDependenciesModal  *missionDependenciesModalState
	artifactRolloutModal      *artifactRolloutModalState
	artifactListModal         *artifactListModalState
	branchPRListModal         *branchPRListModalState
}

func NewModel(socketPath string) (*Model, error) {
	client, err := NewRPCClient(socketPath)
	if err != nil {
		return nil, err
	}

	model := &Model{
		client:                   client,
		focus:                    FocusBoard,
		modal:                    ModalNone,
		terminalLayoutMode:       TerminalLayoutMode("side-by-side"),
		selectedMissionTaskIndex: -1,
		sessionActivityByTaskID:  map[string]*SessionActivitySnapshot{},
		sessionActivityByKey:     map[string]*SessionActivitySnapshot{},
		focusedTerminalSlot:      SessionSlotPrimary,
		pendingTerminalInputSlot: SessionSlotPrimary,
		themeMode:                ThemeMode("truecolor"),
	}
	return model, nil
}

func (m *Model) Init() tea.Cmd {
	return tea.Batch(
		m.subscribeCmd(),
		m.loadBoardCmd(),
		waitForEventCmd(m.client.Events()),
		sessionPollTickCmd(),
		m.fetchArtifactsCmd(),
		artifactsPollTickCmd(),
	)
}

func (m *Model) Close() error {
	if m.client == nil {
		return nil
	}
	_ = m.client.Call("shutdownManagedOllama", nil, nil)
	return m.client.Close()
}

func (m *Model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		if m.activeTaskID != "" && m.terminalPaneShouldRender() {
			return m, tea.Batch(m.resizeActiveSessionCmd(), m.loadVisibleTerminalStateCmd())
		}
		return m, nil

	case spinnerTickMsg:
		m.spinnerIndex = (m.spinnerIndex + 1) % len(spinnerFrames)
		if !m.needsSpinnerTick() {
			m.spinnerChainActive = false
			return m, nil
		}
		m.spinnerChainActive = true
		return m, spinnerTickCmd()

	case flushTerminalInputMsg:
		if msg.Version != m.terminalInputFlushVersion {
			return m, nil
		}
		return m, m.flushPendingTerminalInputCmd()

	case postPushSyncMsg:
		if msg.Version != m.postPushSyncVersion {
			return m, nil
		}
		if msg.TaskID == "" {
			return m, nil
		}
		m.statusMessage = "Watching pushed branch for PR creation."
		return m, m.schedulePostPushSyncCmd(msg.TaskID)

	case leaderTimeoutMsg:
		// A newer chord (or a completed one) has already moved on.
		if msg.Version != m.leaderVersion || !m.leaderPending {
			return m, nil
		}
		m.clearLeader()
		return m, nil

	case terminalBoardNavTimeoutMsg:
		if msg.Version != m.terminalBoardNavVersion || !m.terminalBoardNavPending {
			return m, nil
		}
		return m, m.flushPendingTerminalBoardNavCmd()

	case sessionPollTickMsg:
		targets := m.sessionTargets()
		if len(targets) == 0 || m.focus == FocusTerminal {
			return m, sessionPollTickCmd()
		}

		commands := []tea.Cmd{sessionPollTickCmd()}
		for _, target := range targets {
			commands = append(commands, m.inspectSessionCmd(target.TaskID, target.Slot))
		}
		return m, tea.Batch(commands...)

	case artifactsPollTickMsg:
		return m, tea.Batch(artifactsPollTickCmd(), m.fetchArtifactsCmd())

	case artifactsLoadedMsg:
		m.applyArtifacts(msg)
		return m, nil

	case artifactRolloutMsg:
		return m, m.applyArtifactRollout(msg)

	case trackedArtifactsLoadedMsg:
		// The modal may already be gone; the reply is then simply dropped.
		if m.artifactListModal == nil {
			return m, nil
		}
		m.artifactListModal.Loading = false
		if msg.err != nil {
			m.artifactListModal.Error = msg.err.Error()
			return m, nil
		}
		m.artifactListModal.Names = msg.names
		m.artifactListModal.Selected = 0
		return m, nil

	case artifactListAppliedMsg:
		if msg.err != nil {
			if m.artifactListModal != nil {
				m.artifactListModal.Applying = false
				m.artifactListModal.Error = msg.err.Error()
			}
			m.statusMessage = "Could not save artifacts: " + msg.err.Error()
			return m, nil
		}
		m.closeModal()
		m.statusMessage = fmt.Sprintf("Tracking %d artifact(s).", len(msg.names))
		// The rail refreshes upstream in the background; pull the new rows in
		// rather than leaving the footer showing the old list.
		return m, m.fetchArtifactsCmd()

	case boardLoadedMsg:
		if msg.err != nil {
			m.daemonConnected = false
			m.statusMessage = msg.err.Error()
			return m, nil
		}
		m.applyBoard(msg.board)
		cmds := []tea.Cmd{m.syncSessionUpdateWatchCmd()}
		if spin := m.startSpinnerChainCmd(); spin != nil {
			cmds = append(cmds, spin)
		}
		return m, tea.Batch(cmds...)

	case boardActionMsg:
		if msg.err != nil {
			m.statusMessage = msg.err.Error()
			return m, nil
		}
		if msg.board != nil {
			m.applyBoard(*msg.board)
			if msg.selectMissionID != "" {
				m.selectMissionByID(msg.selectMissionID, msg.selectMissionTaskID)
			}
			if msg.openMissionsPane {
				m.missionsPaneExpanded = true
				m.focus = FocusMissions
			}
		}
		if msg.status != "" {
			m.statusMessage = msg.status
		}
		if msg.activateTaskID != "" {
			m.activeTaskID = msg.activateTaskID
			m.terminalPaneVisible = true
			m.focusedTerminalSlot = normalizeSessionSlot(msg.focusTerminalSlot)
			m.normalizeFocusedTerminalSlot()
		}
		commands := []tea.Cmd{m.syncSessionUpdateWatchCmd()}
		if m.activeTaskID != "" && m.terminalPaneShouldRender() {
			commands = append(commands, m.loadVisibleTerminalStateCmd())
		}
		if spin := m.startSpinnerChainCmd(); spin != nil {
			commands = append(commands, spin)
		}
		return m, tea.Batch(commands...)

	case sessionOpenedMsg:
		if msg.err != nil {
			m.statusMessage = msg.err.Error()
			m.focus = FocusBoard
			return m, nil
		}
		if msg.board != nil {
			m.applyBoard(*msg.board)
		}
		m.activeTaskID = msg.taskID
		m.focusedTerminalSlot = normalizeSessionSlot(msg.slot)
		m.setTerminalSessionMetadata(msg.slot, msg.session.Branch, msg.session.BackendType, msg.session.BackendSessionID, msg.session.AttachCommand)
		m.terminalPaneVisible = !msg.session.BackendType.attachesInTmuxPane()
		m.terminalFullscreen = false
		m.setTerminalScrollOffset(msg.slot, 0)
		if msg.session.BackendType.attachesInTmuxPane() {
			m.focus = FocusBoard
		} else {
			m.focus = FocusTerminal
		}
		if msg.buffer != nil {
			m.setTerminalBuffer(msg.slot, *msg.buffer)
		}
		if msg.activity != nil {
			m.setSessionActivity(msg.taskID, msg.slot, msg.activity)
		}
		if msg.layoutErr != nil {
			m.statusMessage = msg.layoutErr.Error()
		} else if msg.statusOverride != "" {
			m.statusMessage = msg.statusOverride
		} else if msg.session.BackendType.attachesInTmuxPane() {
			m.statusMessage = "Attached task shell in tmux pane."
		} else {
			m.statusMessage = "Opened task shell."
		}
		cmds := []tea.Cmd{m.syncSessionUpdateWatchCmd()}
		if !msg.session.BackendType.attachesInTmuxPane() {
			cmds = append(cmds, m.resizeActiveSessionCmd(), m.loadVisibleTerminalStateCmd())
		}
		if spin := m.startSpinnerChainCmd(); spin != nil {
			cmds = append(cmds, spin)
		}
		return m, tea.Batch(cmds...)

	case bufferLoadedMsg:
		if msg.err == nil && msg.taskID == m.activeTaskID {
			m.setTerminalBuffer(msg.slot, msg.buffer)
		}
		return m, nil

	case sessionActivityMsg:
		if msg.err != nil {
			return m, nil
		}
		if msg.activity == nil {
			m.setSessionActivity(msg.taskID, msg.slot, nil)
			return m, nil
		}
		m.setSessionActivity(msg.taskID, msg.slot, msg.activity)
		if spin := m.startSpinnerChainCmd(); spin != nil {
			return m, spin
		}
		return m, nil

	case asyncErrorMsg:
		if msg.err != nil {
			m.statusMessage = msg.err.Error()
		}
		return m, nil

	case tmuxPaneAttachedMsg:
		if msg.err != nil {
			m.statusMessage = msg.err.Error()
			return m, nil
		}
		m.statusMessage = "Attached task shell in tmux pane."
		return m, nil

	case chatTurnMsg:
		if m.aiChatModal == nil {
			return m, nil
		}
		m.aiChatModal.Pending = false
		if msg.err != nil {
			m.aiChatModal.Input = m.aiChatModal.PendingPrompt
			m.aiChatModal.PendingPrompt = ""
			m.aiChatModal.LastError = msg.err.Error()
			m.statusMessage = msg.err.Error()
			return m, nil
		}
		m.aiChatModal.PendingPrompt = ""
		m.aiChatModal.LastError = ""
		m.aiChatModal.Transcript = append([]ChatMessage{}, msg.result.Transcript...)
		m.aiChatModal.Executions = append([]ChatToolExecution{}, msg.result.Executions...)
		if shouldAutoCloseAIChatModal(msg.result.Executions) {
			m.statusMessage = "AI changes applied."
			m.closeModal()
			return m, nil
		}
		m.statusMessage = "AI chat completed."
		return m, nil

	case rpcEventMsg:
		next := waitForEventCmd(m.client.Events())
		return m, tea.Batch(next, m.handleRPCEvent(msg.event))

	case tea.KeyMsg:
		if m.modal != ModalNone {
			return m, m.handleModalKey(msg)
		}
		return m, m.handleKey(msg)
	}

	return m, nil
}

func shouldAutoCloseAIChatModal(executions []ChatToolExecution) bool {
	if len(executions) == 0 {
		return false
	}

	for _, execution := range executions {
		if execution.Status == "failed" {
			return false
		}
		if execution.Status == "completed" && isBoardCRUDTool(execution.ToolName) {
			return true
		}
	}
	return false
}

func isBoardCRUDTool(toolName string) bool {
	switch toolName {
	case "create_task",
		"create_mission",
		"add_mission_task",
		"move_task",
		"assign_pillar",
		"update_task_description":
		return true
	default:
		return false
	}
}

func (m *Model) handleRPCEvent(event RPCEvent) tea.Cmd {
	switch event.Type {
	case "board_patch":
		var board BoardSnapshot
		if err := json.Unmarshal(event.Payload, &board); err != nil {
			return func() tea.Msg { return asyncErrorMsg{err: err} }
		}
		return func() tea.Msg { return boardLoadedMsg{board: board} }
	case "session_update":
		var update SessionUpdateEvent
		if err := json.Unmarshal(event.Payload, &update); err != nil {
			return func() tea.Msg { return asyncErrorMsg{err: err} }
		}
		if update.TaskID == "" || update.TaskID != m.activeTaskID || !m.terminalPaneShouldRender() {
			return nil
		}
		slot := normalizeSessionSlot(update.Slot)
		return func() tea.Msg {
			return bufferLoadedMsg{
				taskID: update.TaskID,
				slot:   slot,
				buffer: GetBufferResult{
					Lines:     update.Lines,
					ANSILines: defaultANSILines(update.Lines, update.ANSILines),
					CursorX:   update.CursorX,
					CursorY:   update.CursorY,
				},
			}
		}
	case "sync_status":
		var payload SyncStatusPayload
		if err := json.Unmarshal(event.Payload, &payload); err == nil {
			if payload.Status == "started" {
				m.syncInProgress = true
			} else {
				m.syncInProgress = false
			}
		}
		if spin := m.startSpinnerChainCmd(); spin != nil {
			return spin
		}
		return nil
	default:
		return nil
	}
}

func (m *Model) handleKey(key tea.KeyMsg) tea.Cmd {
	if cmd, handled := m.handleTerminalResizeKey(key); handled {
		return cmd
	}

	if m.terminalBoardNavPending {
		return m.handlePendingTerminalBoardNavKey(key)
	}

	if m.focus == FocusTerminal {
		return m.handleTerminalKey(key)
	}
	if m.focus == FocusMissions {
		return m.handleMissionKey(key)
	}

	// Only branch navigation and closing are claimed here; everything else falls
	// through to the board so the pane can be read while moving between cards.
	if m.focus == FocusDetail {
		if cmd, handled := m.handleDetailPaneKey(key); handled {
			return cmd
		}
	}

	// A pending chord claims the next key before anything else on the board, so
	// the "g" in ",ga" cannot be read as the layout modal partway through.
	if m.leaderPending {
		if key.Type == tea.KeyCtrlC {
			m.clearLeader()
			return tea.Quit
		}
		return m.handleLeaderKey(key)
	}

	if key.Type == tea.KeyCtrlC {
		return tea.Quit
	}

	if key.String() == "ctrl+d" {
		m.openTaskDescriptionModal(m.selectedTask())
		return nil
	}

	if key.String() == "ctrl+p" {
		m.openCommandPaletteModal()
		return nil
	}

	if key.String() == "ctrl+r" {
		return m.reconnectSelectedTaskCmd()
	}

	if m.boardOverviewMode {
		return m.handleOverviewKey(key)
	}

	switch key.String() {
	// j joins hjkl here. It used to open the PR comment modal, which is why
	// boardNavigationActionForKey already mapped it to "down" but nothing ever
	// reached that arm; commenting now lives at ",pc".
	case "left", "h", "right", "l", "up", "k", "down", "j":
		m.applyBoardNavigation(boardNavigationActionForKey(key))
	case "tab":
		if m.activeTaskID == "" {
			return nil
		}
		return m.armTerminalBoardNav(m.activeTaskID, m.focusedTerminalSlot, false)
	case leaderKey:
		// Was previous-repo, which now lives at ",rp" alongside ",rn".
		return m.armLeader("")
	case ".":
		m.switchRepo(1)
		return m.persistActiveRepoCmd()
	case ":":
		m.openCommandPaletteModal()
		return nil
	case "enter":
		task := m.selectedTask()
		if task != nil {
			if task.ID == m.activeTaskID && m.terminalBackendTypeForSlot(SessionSlotPrimary).attachesInTmuxPane() {
				m.focusedTerminalSlot = SessionSlotPrimary
				if backendSessionID := m.terminalBackendSessionIDForSlot(SessionSlotPrimary); backendSessionID != "" {
					return m.attachTmuxSessionCmd(backendSessionID)
				}
			}
			return m.openSessionCmd(task.ID, false, SessionSlotPrimary)
		}
	case "R":
		task := m.selectedTask()
		if task != nil {
			return m.openSessionCmd(task.ID, true, SessionSlotPrimary)
		}
	case "s":
		return m.syncCmd()
	case "S":
		return m.refreshArtifactsCmd()
	case ";":
		m.moveArtifactSelection(1)
		return nil
	case "G":
		// The portal, not the gradual rollout: an immediate GA is the thing the
		// API cannot do, and it is what this key is reached for. The gradual
		// rollout keeps its confirm on Ctrl+G.
		return m.openArtifactDevPortalCmd()
	case "ctrl+g":
		m.openArtifactRolloutModal()
		return nil
	case "T":
		// Sits with the other artifact keys (S refresh, ; select, G roll out).
		return m.openArtifactListModal()
	case "u":
		return m.toggleMissionsPaneCmd(true)
	case "t":
		task := m.selectedTask()
		if task != nil && task.ID != m.activeTaskID && m.taskHasSessionSlot(task, SessionSlotPrimary) {
			return m.openSessionCmd(task.ID, false, SessionSlotPrimary)
		}
		if m.activeTaskID == "" {
			m.statusMessage = "No session open for the selected task."
			return nil
		}
		return m.focusActiveTerminalCmd(false)
	case "z":
		if m.activeTaskID == "" {
			m.statusMessage = "No session open to expand."
			return nil
		}
		return m.focusActiveTerminalCmd(true)
	case "[":
		task := m.selectedTask()
		if task != nil {
			return m.moveContextTaskCmd(task, -1)
		}
	case "]":
		task := m.selectedTask()
		if task != nil {
			return m.moveContextTaskCmd(task, 1)
		}
	case "e":
		m.toggleDetailPane()
		return nil
	case "E":
		m.openBranchPRListModal(m.selectedTask())
		return nil
	case "?":
		m.openHelpModal()
	case "q":
		return tea.Quit
	case "f":
		m.openFilterModal()
	case "g":
		m.openViewModal()
	case "L":
		if m.boardDensityMode == "list" {
			m.boardDensityMode = ""
		} else {
			m.boardDensityMode = "list"
		}
		return nil
	case "O":
		m.boardOverviewMode = true
		m.overviewSelectedIndex = 0
		for i, scope := range m.overviewScopes() {
			if scope.ID == m.activeRepoID {
				m.overviewSelectedIndex = i
				break
			}
		}
		return nil
	case "!":
		for _, task := range m.tasks {
			if task.SessionAttentionNeeded {
				m.selectTaskByID(task.ID)
				break
			}
		}
		return nil
	case "1", "2", "3", "4", "5", "6", "7", "8", "9":
		idx := int(key.String()[0] - '1')
		if idx < len(m.repos) {
			if m.activeRepoID == m.repos[idx].ID {
				m.activeRepoID = ""
				m.selectedTrackIndex = 0
				m.selectedTaskIndex = 0
				return m.setUIStateCmd(map[string]interface{}{"activeRepoId": ""})
			}
			m.activeRepoID = m.repos[idx].ID
			m.selectedTrackIndex = 0
			m.selectedTaskIndex = 0
			return m.persistActiveRepoCmd()
		}
		return nil
	case "n":
		m.openCreateTaskModal()
	case "r":
		m.openRenameTaskModal(m.selectedTask())
	case "w":
		m.openSetBranchModal(m.selectedTask())
	case "p":
		m.openPillarPickerModal(m.selectedTask())
	case "P":
		m.openCreatePillarModal("")
	case "D":
		if task := m.selectedTask(); task != nil {
			m.openDeletePillarConfirmModal(task.PillarID, task.ID)
		} else {
			m.statusMessage = "Select a task to delete its pillar."
		}
	case "B":
		task := m.selectedTask()
		if task != nil {
			return m.toggleDualSessionCmd(task)
		}
	case "a", "A":
		m.openAIChatModal()
		return nil
	case "d":
		m.openDeleteConfirmModal(m.selectedTask())
	case "c":
		task := m.selectedTask()
		if task != nil {
			return m.createTaskPRCmd(task)
		}
	case "C":
		task := m.selectedTask()
		if task != nil {
			return m.retryPushedBranchPRCreationCmd(task)
		}
	case "o":
		task := m.selectedTask()
		if task != nil {
			return m.openPRCmd(task, false)
		}
	case "v":
		task := m.selectedTask()
		if task != nil {
			return m.openPRCmd(task, true)
		}
	case "m":
		task := m.selectedTask()
		if task != nil {
			return m.mergeTaskPRCmd(task)
		}
	case "i":
		task := m.selectedTask()
		if task != nil {
			return m.openTaskInIDECmd(task)
		}
	case "x":
		task := m.selectedTask()
		if task != nil {
			return m.revealTaskWorkspaceCmd(task)
		}
	}

	return nil
}

// handleDetailPaneKey claims the keys that mean something to the PR pane and
// reports whether it consumed the press. Only the arrows are taken: 'k' still
// moves the board and 'j' still opens a comment, so every board key a user knows
// keeps working while the pane is open — which is the point of a pane.
func (m *Model) handleDetailPaneKey(key tea.KeyMsg) (tea.Cmd, bool) {
	switch key.String() {
	case "up":
		m.moveDetailBranchSelection(-1)
		return nil, true
	case "down":
		m.moveDetailBranchSelection(1)
		return nil, true
	case "esc", "e":
		m.toggleDetailPane()
		return nil, true
	}
	return nil, false
}

func (m *Model) handleOverviewKey(key tea.KeyMsg) tea.Cmd {
	switch key.String() {
	case "up", "k":
		m.overviewSelectedIndex = max(0, m.overviewSelectedIndex-1)
	case "down", "j":
		m.overviewSelectedIndex = min(len(m.overviewScopes())-1, m.overviewSelectedIndex+1)
	case "enter":
		scopes := m.overviewScopes()
		if m.overviewSelectedIndex < len(scopes) {
			m.activeRepoID = scopes[m.overviewSelectedIndex].ID
			m.selectedTrackIndex = 0
			m.selectedTaskIndex = 0
			m.boardOverviewMode = false
			return m.persistActiveRepoCmd()
		}
	case "0":
		m.activeRepoID = ""
		m.boardOverviewMode = false
		m.selectedTrackIndex = 0
		m.selectedTaskIndex = 0
		return m.setUIStateCmd(map[string]interface{}{"activeRepoId": ""})
	case "O", "esc", "q":
		m.boardOverviewMode = false
	case "s":
		return m.syncCmd()
	case "?":
		m.openHelpModal()
	}
	return nil
}

func (m *Model) handleTerminalResizeKey(key tea.KeyMsg) (tea.Cmd, bool) {
	switch key.String() {
	case "shift+left", "shift+←":
		return m.resizeTerminalPaneCmd(terminalResizeStep), true
	case "shift+right", "shift+→":
		return m.resizeTerminalPaneCmd(-terminalResizeStep), true
	default:
		return nil, false
	}
}

func (m *Model) handleMissionKey(key tea.KeyMsg) tea.Cmd {
	if key.Type == tea.KeyCtrlC {
		return tea.Quit
	}

	switch key.String() {
	case "esc":
		return m.toggleMissionsPaneCmd(false)
	case "up", "k":
		m.moveMissionSelection(-1)
		return nil
	case "down", "j":
		m.moveMissionSelection(1)
		return nil
	case "enter":
		selectedTask := m.selectedMissionTask()
		if selectedTask == nil {
			return nil
		}
		if !selectedTask.ReleasedToBoard {
			m.statusMessage = "Release the mission task before selecting it on the board."
			return nil
		}
		if m.selectTaskByID(selectedTask.TaskID) {
			m.focus = FocusBoard
			m.missionsPaneExpanded = false
			return m.setUIStateCmd(map[string]interface{}{
				"missionsPaneExpanded":  false,
				"selectedMissionId":     selectedTask.MissionID,
				"selectedMissionTaskId": selectedTask.TaskID,
			})
		}
		return nil
	case "u":
		if selectedTask := m.selectedMissionTask(); selectedTask != nil && !selectedTask.ReleasedToBoard {
			return m.releaseMissionTaskCmd(selectedTask.TaskID)
		}
		return m.toggleMissionsPaneCmd(false)
	case "N":
		m.openCreateMissionModal()
		return nil
	case "n":
		if m.selectedMission() == nil {
			m.openCreateMissionModal()
			return nil
		}
		m.openAddMissionTaskModal(m.selectedMission())
		return nil
	case "b":
		m.openMissionDependenciesModal(m.selectedMissionTask())
		return nil
	case "d":
		m.openDeleteMissionConfirmModal(m.selectedMission())
		return nil
	case "a", "A":
		m.openAIChatModal()
		return nil
	case ":":
		m.openCommandPaletteModal()
		return nil
	case "?":
		m.openHelpModal()
		return nil
	}

	return nil
}

func (m *Model) handleTerminalKey(key tea.KeyMsg) tea.Cmd {
	if m.terminalBoardNavPending {
		return m.handlePendingTerminalBoardNavKey(key)
	}

	return m.handleDirectTerminalKey(key)
}

func (m *Model) handleDirectTerminalKey(key tea.KeyMsg) tea.Cmd {
	if key.String() == "shift+tab" {
		if !m.activeTaskUsesDualTerminal() {
			return nil
		}
		m.focusedTerminalSlot = m.alternateTerminalSlot(m.focusedTerminalSlot)
		return m.resizeActiveSessionCmd()
	}

	switch key.Type {
	case tea.KeyTab:
		if m.activeTaskID == "" {
			return nil
		}
		return m.armTerminalBoardNav(m.activeTaskID, m.focusedTerminalSlot, false)
	case tea.KeyEsc:
		flushCmd := m.flushPendingTerminalInputCmd()
		m.setTerminalCommand(m.focusedTerminalSlot, "")
		m.focus = FocusBoard
		m.terminalFullscreen = false
		return flushCmd
	case tea.KeyPgUp:
		m.setTerminalScrollOffset(m.focusedTerminalSlot, m.terminalScrollOffsetForSlot(m.focusedTerminalSlot)+10)
		return nil
	case tea.KeyPgDown:
		m.setTerminalScrollOffset(
			m.focusedTerminalSlot,
			max(0, m.terminalScrollOffsetForSlot(m.focusedTerminalSlot)-10),
		)
		return nil
	case tea.KeyShiftUp:
		m.setTerminalScrollOffset(m.focusedTerminalSlot, m.terminalScrollOffsetForSlot(m.focusedTerminalSlot)+1)
		return nil
	case tea.KeyShiftDown:
		m.setTerminalScrollOffset(
			m.focusedTerminalSlot,
			max(0, m.terminalScrollOffsetForSlot(m.focusedTerminalSlot)-1),
		)
		return nil
	}

	if m.activeTaskID == "" {
		return nil
	}

	data := encodeTerminalKey(key)
	if data == "" {
		return nil
	}

	slot := m.focusedTerminalSlot
	commandBeforeSubmit := m.terminalCommandForSlot(slot)
	m.setTerminalCommand(slot, appendTerminalCommand(commandBeforeSubmit, key))

	if m.terminalScrollOffsetForSlot(slot) != 0 {
		m.setTerminalScrollOffset(slot, 0)
	}

	return m.queueTerminalInputCmd(
		m.activeTaskID,
		slot,
		data,
		key,
		shouldTriggerTerminalPushSync(commandBeforeSubmit, key),
	)
}

func boardNavigationActionForKey(key tea.KeyMsg) boardNavigationAction {
	switch key.String() {
	case "left", "h":
		return boardNavigationLeft
	case "right", "l":
		return boardNavigationRight
	case "up", "k":
		return boardNavigationUp
	case "down", "j":
		return boardNavigationDown
	default:
		return boardNavigationNone
	}
}

func (m *Model) applyBoardNavigation(action boardNavigationAction) bool {
	previousTrackIndex := m.selectedTrackIndex
	previousTaskIndex := m.selectedTaskIndex

	switch action {
	case boardNavigationLeft:
		m.selectedTrackIndex = max(0, m.selectedTrackIndex-1)
	case boardNavigationRight:
		m.selectedTrackIndex = min(max(0, len(m.sortedTracks())-1), m.selectedTrackIndex+1)
	case boardNavigationUp:
		m.selectedTaskIndex = max(0, m.selectedTaskIndex-1)
	case boardNavigationDown:
		m.selectedTaskIndex = min(max(0, len(m.selectedTrackTasks())-1), m.selectedTaskIndex+1)
	default:
		return false
	}

	m.selectedTaskIndex = clamp(m.selectedTaskIndex, 0, max(0, len(m.selectedTrackTasks())-1))
	return m.selectedTrackIndex != previousTrackIndex || m.selectedTaskIndex != previousTaskIndex
}

func (m *Model) selectTaskByID(taskID string) bool {
	if taskID == "" {
		return false
	}

	tracks := m.sortedTracks()
	tasksByTrack := m.tasksByTrack()
	for trackIndex, track := range tracks {
		for taskIndex, task := range tasksByTrack[track.ID] {
			if task.ID != taskID {
				continue
			}
			m.selectedTrackIndex = trackIndex
			m.selectedTaskIndex = taskIndex
			return true
		}
	}

	return false
}

func (m *Model) previewTaskShell(task *TaskRecord, preferredSlot SessionSlot) tea.Cmd {
	if task == nil || task.ID == "" || task.SessionID == "" {
		return nil
	}

	slot := m.resolveTerminalSlotForTask(task, preferredSlot)
	if task.ID == m.activeTaskID {
		m.focusedTerminalSlot = slot
		m.normalizeFocusedTerminalSlot()
		return nil
	}

	m.activeTaskID = task.ID
	m.focusedTerminalSlot = slot
	m.activeSessionBranch = task.BranchName
	m.activeSessionBackendType = ""
	m.activeSessionBackendSessionID = ""
	m.activeSessionAttachCommand = ""
	m.secondarySessionBranch = task.BranchName
	m.secondarySessionBackendType = ""
	m.secondarySessionBackendID = ""
	m.secondarySessionAttachCommand = ""
	m.terminalPaneVisible = true
	m.terminalScrollOffset = 0
	m.secondaryTerminalScrollOffset = 0
	m.buffer = GetBufferResult{}
	m.secondaryBuffer = GetBufferResult{}

	return tea.Batch(
		m.syncSessionUpdateWatchCmd(),
		m.loadVisibleTerminalStateCmd(),
	)
}

func (m *Model) handlePendingTerminalBoardNavKey(key tea.KeyMsg) tea.Cmd {
	if key.Type == tea.KeyEsc {
		m.clearTerminalBoardNav()
		flushCmd := m.flushPendingTerminalInputCmd()
		m.setTerminalCommand(m.focusedTerminalSlot, "")
		m.focus = FocusBoard
		m.terminalFullscreen = false
		return flushCmd
	}

	if key.Type == tea.KeyTab {
		return m.armTerminalBoardNav(
			m.terminalBoardNavTaskID,
			m.terminalBoardNavSlot,
			m.terminalBoardNavConsumed,
		)
	}

	if action := boardNavigationActionForKey(key); action != boardNavigationNone {
		m.applyBoardNavigation(action)

		task := m.selectedTask()
		nextTaskID := m.terminalBoardNavTaskID
		nextSlot := m.terminalBoardNavSlot
		if task != nil {
			nextTaskID = task.ID
			nextSlot = m.resolveTerminalSlotForTask(task, m.terminalBoardNavSlot)
		}
		rearmCmd := m.armTerminalBoardNav(nextTaskID, nextSlot, true)

		if task == nil {
			m.statusMessage = "Selected track has no task."
			return rearmCmd
		}
		if task.ID == m.activeTaskID {
			m.focusedTerminalSlot = nextSlot
			return rearmCmd
		}
		return tea.Batch(
			m.previewTaskShell(task, nextSlot),
			m.openSessionCmd(task.ID, false, nextSlot),
			rearmCmd,
		)
	}

	if m.terminalBoardNavConsumed {
		m.clearTerminalBoardNav()
		return m.handleDirectTerminalKey(key)
	}

	if m.terminalBoardNavTaskID == "" {
		m.clearTerminalBoardNav()
		return nil
	}

	slot := m.terminalBoardNavSlot
	switch key.Type {
	case tea.KeyPgUp:
		taskID := m.terminalBoardNavTaskID
		m.clearTerminalBoardNav()
		m.setTerminalScrollOffset(slot, m.terminalScrollOffsetForSlot(slot)+10)
		return m.queueTerminalInputCmd(taskID, slot, "\t", tea.KeyMsg{Type: tea.KeyTab}, false)
	case tea.KeyPgDown:
		taskID := m.terminalBoardNavTaskID
		m.clearTerminalBoardNav()
		m.setTerminalScrollOffset(slot, max(0, m.terminalScrollOffsetForSlot(slot)-10))
		return m.queueTerminalInputCmd(taskID, slot, "\t", tea.KeyMsg{Type: tea.KeyTab}, false)
	case tea.KeyShiftUp:
		taskID := m.terminalBoardNavTaskID
		m.clearTerminalBoardNav()
		m.setTerminalScrollOffset(slot, m.terminalScrollOffsetForSlot(slot)+1)
		return m.queueTerminalInputCmd(taskID, slot, "\t", tea.KeyMsg{Type: tea.KeyTab}, false)
	case tea.KeyShiftDown:
		taskID := m.terminalBoardNavTaskID
		m.clearTerminalBoardNav()
		m.setTerminalScrollOffset(slot, max(0, m.terminalScrollOffsetForSlot(slot)-1))
		return m.queueTerminalInputCmd(taskID, slot, "\t", tea.KeyMsg{Type: tea.KeyTab}, false)
	}

	data := encodeTerminalKey(key)
	if data == "" {
		m.clearTerminalBoardNav()
		return nil
	}

	taskID := m.terminalBoardNavTaskID
	commandBeforeSubmit := m.terminalCommandForSlot(slot)
	m.clearTerminalBoardNav()
	m.setTerminalCommand(slot, appendTerminalCommand(commandBeforeSubmit, key))
	if m.terminalScrollOffsetForSlot(slot) != 0 {
		m.setTerminalScrollOffset(slot, 0)
	}

	return m.queueTerminalInputCmd(
		taskID,
		slot,
		"\t"+data,
		key,
		shouldTriggerTerminalPushSync(commandBeforeSubmit, key),
	)
}

func (m *Model) flushPendingTerminalBoardNavCmd() tea.Cmd {
	taskID := m.terminalBoardNavTaskID
	slot := m.terminalBoardNavSlot
	consumed := m.terminalBoardNavConsumed
	m.clearTerminalBoardNav()
	if taskID == "" || consumed {
		return nil
	}
	return m.queueTerminalInputCmd(taskID, slot, "\t", tea.KeyMsg{Type: tea.KeyTab}, false)
}

func (m *Model) clearTerminalBoardNav() {
	m.terminalBoardNavPending = false
	m.terminalBoardNavTaskID = ""
	m.terminalBoardNavSlot = SessionSlotPrimary
	m.terminalBoardNavConsumed = false
}

func (m *Model) armTerminalBoardNav(taskID string, slot SessionSlot, consumed bool) tea.Cmd {
	m.selectTaskByID(taskID)
	m.terminalBoardNavPending = true
	m.terminalBoardNavTaskID = taskID
	m.terminalBoardNavSlot = normalizeSessionSlot(slot)
	m.terminalBoardNavConsumed = consumed
	m.terminalBoardNavVersion++
	version := m.terminalBoardNavVersion
	return tea.Tick(terminalBoardNavTimeout, func(_ time.Time) tea.Msg {
		return terminalBoardNavTimeoutMsg{Version: version}
	})
}

func (m *Model) View() string {
	if m.width <= 0 || m.height <= 0 {
		return ""
	}
	return renderView(m)
}

func (m *Model) loadBoardCmd() tea.Cmd {
	return func() tea.Msg {
		var board BoardSnapshot
		err := m.client.Call("getBoard", nil, &board)
		return boardLoadedMsg{board: board, err: err}
	}
}

func (m *Model) subscribeCmd() tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Subscribe(); err != nil {
			return asyncErrorMsg{err: err}
		}
		return nil
	}
}

func waitForEventCmd(events <-chan RPCEvent) tea.Cmd {
	return func() tea.Msg {
		event, ok := <-events
		if !ok {
			return asyncErrorMsg{err: fmt.Errorf("rpc connection closed")}
		}
		return rpcEventMsg{event: event}
	}
}

func (m *Model) needsSpinnerTick() bool {
	if m.syncInProgress {
		return true
	}
	if m.aiChatModal != nil && m.aiChatModal.Pending {
		return true
	}
	for _, a := range m.sessionActivityByKey {
		if a != nil && a.IsBusy {
			return true
		}
	}
	return false
}

func (m *Model) startSpinnerChainCmd() tea.Cmd {
	if !m.needsSpinnerTick() || m.spinnerChainActive {
		return nil
	}
	m.spinnerChainActive = true
	return spinnerTickCmd()
}

func spinnerTickCmd() tea.Cmd {
	return tea.Tick(80*time.Millisecond, func(_ time.Time) tea.Msg { return spinnerTickMsg{} })
}

func sessionPollTickCmd() tea.Cmd {
	return tea.Tick(2500*time.Millisecond, func(_ time.Time) tea.Msg { return sessionPollTickMsg{} })
}

func artifactsPollTickCmd() tea.Cmd {
	return tea.Tick(artifactsPollInterval, func(_ time.Time) tea.Msg { return artifactsPollTickMsg{} })
}

func (m *Model) fetchArtifactsCmd() tea.Cmd {
	return m.artifactsCmd("getArtifacts", false)
}

// setTrackedArtifactsCmd rewrites which artifacts the rail follows.
//
// The daemon persists the list as well as applying it, so the change survives a
// restart rather than reverting the next time the board starts.
func (m *Model) setTrackedArtifactsCmd(names []string) tea.Cmd {
	payload := append([]string{}, names...)
	return func() tea.Msg {
		var result struct {
			Names []string `json:"names"`
		}
		if err := m.client.Call("setTrackedArtifacts", map[string]any{"names": payload}, &result); err != nil {
			return artifactListAppliedMsg{err: err}
		}
		return artifactListAppliedMsg{names: result.Names}
	}
}

// fetchTrackedArtifactsCmd asks which artifacts are configured.
//
// Deliberately not the rail snapshot: that holds what resolved, which is a
// shorter list whenever devex is unreachable or a refresh is still in flight.
func (m *Model) fetchTrackedArtifactsCmd() tea.Cmd {
	return func() tea.Msg {
		var result struct {
			Names []string `json:"names"`
		}
		if err := m.client.Call("getTrackedArtifacts", nil, &result); err != nil {
			return trackedArtifactsLoadedMsg{err: err}
		}
		return trackedArtifactsLoadedMsg{names: result.Names}
	}
}

func (m *Model) refreshArtifactsCmd() tea.Cmd {
	return m.artifactsCmd("refreshArtifacts", true)
}

func (m *Model) artifactsCmd(method string, manual bool) tea.Cmd {
	return func() tea.Msg {
		var snapshot ArtifactsSnapshot
		if err := m.client.Call(method, nil, &snapshot); err != nil {
			return artifactsLoadedMsg{manual: manual, err: err}
		}
		return artifactsLoadedMsg{snapshot: snapshot, manual: manual}
	}
}

// A failed load keeps the last chips on screen but marks them stale, so the
// footer never presents versions it could not confirm. Only an explicit refresh
// talks back through the status bar; the 60s poll stays silent.
func (m *Model) applyArtifacts(msg artifactsLoadedMsg) {
	if msg.err != nil {
		m.artifacts.Stale = true
		m.artifacts.Error = msg.err.Error()
		if msg.manual {
			m.statusMessage = msg.err.Error()
		}
		return
	}

	m.artifacts = msg.snapshot
	m.selectedArtifactIndex = clamp(m.selectedArtifactIndex, 0, max(0, len(msg.snapshot.Artifacts)-1))
	if msg.manual {
		m.statusMessage = "Artifacts refreshed."
	}
}

func (m *Model) moveArtifactSelection(delta int) {
	m.selectedArtifactIndex = wrapIndex(m.selectedArtifactIndex, len(m.artifacts.Artifacts), delta)
}

func (m *Model) selectedArtifact() *ArtifactRecord {
	artifacts := m.artifacts.Artifacts
	if len(artifacts) == 0 {
		return nil
	}
	artifact := artifacts[clamp(m.selectedArtifactIndex, 0, len(artifacts)-1)]
	return &artifact
}

func (m *Model) rolloutArtifactCmd(params map[string]string) tea.Cmd {
	return func() tea.Msg {
		var result ArtifactRolloutResult
		if err := m.client.Call("rolloutArtifact", params, &result); err != nil {
			return artifactRolloutMsg{err: err}
		}
		return artifactRolloutMsg{result: result}
	}
}

func (m *Model) applyArtifactRollout(msg artifactRolloutMsg) tea.Cmd {
	if msg.err != nil {
		m.statusMessage = "Rollout failed: " + msg.err.Error()
		return nil
	}

	m.statusMessage = artifactRolloutStatusMessage(msg.result)
	if !msg.result.OK {
		return nil
	}
	return m.refreshArtifactsCmd()
}

func artifactRolloutStatusMessage(result ArtifactRolloutResult) string {
	message := result.Message
	if message == "" {
		message = ternaryString(result.OK, "Rollout requested.", "Rollout was rejected.")
	}
	if result.OK {
		return message
	}
	return "Rollout failed: " + message
}

func (m *Model) boardActionCmd(method string, params interface{}, status string) tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Call(method, params, nil); err != nil {
			return boardActionMsg{err: err}
		}
		var board BoardSnapshot
		if err := m.client.Call("getBoard", nil, &board); err != nil {
			return boardActionMsg{err: err}
		}
		return boardActionMsg{board: &board, status: status}
	}
}

func (m *Model) openSessionCmd(taskID string, recreate bool, slot SessionSlot) tea.Cmd {
	return func() tea.Msg {
		method := "openSession"
		if recreate {
			method = "recreateSession"
		}
		normalizedSlot := normalizeSessionSlot(slot)

		var session SessionRecord
		if err := m.client.Call(method, map[string]string{"taskId": taskID, "slot": string(normalizedSlot)}, &session); err != nil {
			return sessionOpenedMsg{err: err}
		}

		var board BoardSnapshot
		if err := m.client.Call("getBoard", nil, &board); err != nil {
			return sessionOpenedMsg{err: err}
		}

		if session.BackendType.attachesInTmuxPane() {
			return sessionOpenedMsg{
				taskID:    taskID,
				slot:      normalizedSlot,
				session:   session,
				board:     &board,
				layoutErr: attachTaskSessionInTmux(session.BackendSessionID),
			}
		}

		var buffer GetBufferResult
		if err := m.client.Call("getBuffer", map[string]string{"taskId": taskID, "slot": string(normalizedSlot)}, &buffer); err != nil {
			return sessionOpenedMsg{err: err}
		}
		buffer.ANSILines = defaultANSILines(buffer.Lines, buffer.ANSILines)

		var activity *SessionActivitySnapshot
		var nextActivity SessionActivitySnapshot
		if err := m.client.Call("inspectSession", map[string]string{"taskId": taskID, "slot": string(normalizedSlot)}, &nextActivity); err == nil && nextActivity.TaskID != "" {
			activity = &nextActivity
		}

		return sessionOpenedMsg{
			taskID:   taskID,
			slot:     normalizedSlot,
			session:  session,
			board:    &board,
			buffer:   &buffer,
			activity: activity,
		}
	}
}

// Guard the reconnect keybinding: the RPC rejects local tasks, but saying so
// here costs no round trip and reads better than a daemon error.
func (m *Model) reconnectSelectedTaskCmd() tea.Cmd {
	task := m.selectedTask()
	if task == nil {
		m.statusMessage = "Select a task to reconnect it."
		return nil
	}
	if task.Location != TaskLocationRemote {
		m.statusMessage = "Reconnect applies to remote tasks."
		return nil
	}
	return m.reconnectSessionCmd(task.ID, SessionSlotPrimary)
}

// Re-link a remote card to the machine its agent runs on, waking the host first
// when something is configured to do that.
func (m *Model) reconnectSessionCmd(taskID string, slot SessionSlot) tea.Cmd {
	return func() tea.Msg {
		normalizedSlot := normalizeSessionSlot(slot)

		var result ReconnectSessionResult
		if err := m.client.Call("reconnectSession", map[string]string{"taskId": taskID, "slot": string(normalizedSlot)}, &result); err != nil {
			return sessionOpenedMsg{err: err}
		}

		var board BoardSnapshot
		if err := m.client.Call("getBoard", nil, &board); err != nil {
			return sessionOpenedMsg{err: err}
		}

		// A waking host and an unreachable one both leave nothing to attach to.
		// Refresh the board and let the message explain what happens next; the
		// daemon pushes another patch when a background start finishes.
		if result.Session == nil {
			return boardActionMsg{board: &board, status: result.Message}
		}

		session := *result.Session
		if session.BackendType.attachesInTmuxPane() {
			return sessionOpenedMsg{
				taskID:         taskID,
				slot:           normalizedSlot,
				session:        session,
				board:          &board,
				statusOverride: result.Message,
				layoutErr:      attachTaskSessionInTmux(session.BackendSessionID),
			}
		}

		var buffer GetBufferResult
		if err := m.client.Call("getBuffer", map[string]string{"taskId": taskID, "slot": string(normalizedSlot)}, &buffer); err != nil {
			return sessionOpenedMsg{err: err}
		}
		buffer.ANSILines = defaultANSILines(buffer.Lines, buffer.ANSILines)

		return sessionOpenedMsg{
			taskID:         taskID,
			slot:           normalizedSlot,
			session:        session,
			board:          &board,
			buffer:         &buffer,
			statusOverride: result.Message,
		}
	}
}

func (m *Model) focusActiveTerminalCmd(fullscreen bool) tea.Cmd {
	if m.activeTaskID == "" {
		return nil
	}

	m.normalizeFocusedTerminalSlot()
	if m.terminalBackendTypeForSlot(m.focusedTerminalSlot).attachesInTmuxPane() {
		backendSessionID := m.terminalBackendSessionIDForSlot(m.focusedTerminalSlot)
		if backendSessionID == "" {
			return m.openSessionCmd(m.activeTaskID, false, m.focusedTerminalSlot)
		}
		return m.attachTmuxSessionCmd(backendSessionID)
	}

	m.terminalPaneVisible = true
	m.terminalFullscreen = fullscreen
	m.focus = FocusTerminal

	return tea.Batch(
		m.resizeActiveSessionCmd(),
		m.acknowledgeSessionAttentionCmd(m.activeTaskID),
	)
}

func (m *Model) attachTmuxSessionCmd(backendSessionID string) tea.Cmd {
	return func() tea.Msg {
		return tmuxPaneAttachedMsg{err: attachTaskSessionInTmux(backendSessionID)}
	}
}

func (m *Model) loadBufferCmd(taskID string, slot SessionSlot) tea.Cmd {
	return func() tea.Msg {
		normalizedSlot := normalizeSessionSlot(slot)
		var buffer GetBufferResult
		err := m.client.Call("getBuffer", map[string]string{"taskId": taskID, "slot": string(normalizedSlot)}, &buffer)
		buffer.ANSILines = defaultANSILines(buffer.Lines, buffer.ANSILines)
		return bufferLoadedMsg{taskID: taskID, slot: normalizedSlot, buffer: buffer, err: err}
	}
}

func (m *Model) inspectSessionCmd(taskID string, slot SessionSlot) tea.Cmd {
	return func() tea.Msg {
		normalizedSlot := normalizeSessionSlot(slot)
		var activity SessionActivitySnapshot
		err := m.client.Call("inspectSession", map[string]string{"taskId": taskID, "slot": string(normalizedSlot)}, &activity)
		if err != nil {
			return sessionActivityMsg{taskID: taskID, slot: normalizedSlot, activity: nil, err: err}
		}
		if activity.TaskID == "" {
			return sessionActivityMsg{taskID: taskID, slot: normalizedSlot, activity: nil}
		}
		return sessionActivityMsg{taskID: taskID, slot: normalizedSlot, activity: &activity}
	}
}

func (m *Model) desiredSessionUpdateWatchTaskID() string {
	if !m.terminalPaneShouldRender() {
		return ""
	}
	return m.activeTaskID
}

func (m *Model) syncSessionUpdateWatchCmd() tea.Cmd {
	if m.client == nil {
		return nil
	}

	taskID := m.desiredSessionUpdateWatchTaskID()
	if taskID == m.watchedSessionTaskID {
		return nil
	}

	m.watchedSessionTaskID = taskID

	return func() tea.Msg {
		params := map[string]string{}
		if taskID != "" {
			params["taskId"] = taskID
		}
		if err := m.client.Call("watchSessionUpdates", params, nil); err != nil {
			return asyncErrorMsg{err: err}
		}
		return nil
	}
}

func (m *Model) acknowledgeSessionAttentionCmd(taskID string) tea.Cmd {
	if taskID == "" || m.client == nil {
		return nil
	}

	return func() tea.Msg {
		if err := m.client.Call("acknowledgeSessionAttention", map[string]string{"taskId": taskID}, nil); err != nil {
			return asyncErrorMsg{err: err}
		}
		return nil
	}
}

func (m *Model) sendInputCmd(taskID string, slot SessionSlot, data string) tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Notify("sendInput", map[string]string{"taskId": taskID, "slot": string(normalizeSessionSlot(slot)), "data": data}); err != nil {
			return asyncErrorMsg{err: err}
		}
		return nil
	}
}

func (m *Model) syncCmd() tea.Cmd {
	m.syncInProgress = true
	base := m.boardActionCmd("triggerSync", nil, "Sync complete.")
	if spin := m.startSpinnerChainCmd(); spin != nil {
		return tea.Batch(base, spin)
	}
	return base
}

func (m *Model) createTaskPRCmd(task *TaskRecord) tea.Cmd {
	if task == nil {
		return nil
	}
	if task.IsGeneral() {
		m.statusMessage = "General tasks have no repo or branch, so they cannot have a PR."
		return nil
	}
	m.statusMessage = "PR creation in progress..."
	return m.boardActionCmd(
		"createTaskPR",
		map[string]string{"taskId": task.ID},
		fmt.Sprintf("Ensured PR for task %s", task.ID),
	)
}

func (m *Model) commentTaskPRCmd(task *TaskRecord, body string) tea.Cmd {
	if task == nil {
		return nil
	}
	if blocker := getPRCommentBlockerReason(*task); blocker != "" {
		m.statusMessage = blocker
		return nil
	}

	body = strings.TrimSpace(body)
	if body == "" {
		m.statusMessage = "PR comment cannot be empty."
		return nil
	}

	taskID := task.ID
	prNumber := 0
	if task.PRNumber != nil {
		prNumber = *task.PRNumber
	}

	m.statusMessage = "Posting PR comment..."
	return func() tea.Msg {
		if err := m.client.Call("commentTaskPR", map[string]string{
			"taskId": taskID,
			"body":   body,
		}, nil); err != nil {
			return boardActionMsg{err: err}
		}
		if prNumber > 0 {
			return boardActionMsg{status: fmt.Sprintf("Commented on PR #%d.", prNumber)}
		}
		return boardActionMsg{status: "Commented on PR."}
	}
}

// commentTaskBranchPRCmd posts to one branch's PR. The card-level command cannot
// stand in for it: on a multi-PR card the card has no single PR to post to.
func (m *Model) commentTaskBranchPRCmd(branch TaskBranchRecord, body string) tea.Cmd {
	if blocker := getBranchPRCommentBlockerReason(branch); blocker != "" {
		m.statusMessage = blocker
		return nil
	}

	body = strings.TrimSpace(body)
	if body == "" {
		m.statusMessage = "PR comment cannot be empty."
		return nil
	}

	branchID := branch.ID
	prNumber := derefInt(branch.PRNumber)

	m.statusMessage = "Posting PR comment..."
	return func() tea.Msg {
		if err := m.client.Call("commentTaskBranchPR", map[string]string{
			"branchId": branchID,
			"body":     body,
		}, nil); err != nil {
			return boardActionMsg{err: err}
		}
		if prNumber > 0 {
			return boardActionMsg{status: fmt.Sprintf("Commented on PR #%d.", prNumber)}
		}
		return boardActionMsg{status: "Commented on PR."}
	}
}

func (m *Model) retryPushedBranchPRCreationCmd(task *TaskRecord) tea.Cmd {
	if task == nil {
		return nil
	}
	if task.BranchName == "" {
		m.statusMessage = "Selected task has no branch to watch for PR creation."
		return nil
	}
	m.statusMessage = "PR creation in progress..."
	return m.schedulePostPushSyncCmd(task.ID)
}

func (m *Model) mergeTaskPRCmd(task *TaskRecord) tea.Cmd {
	if task == nil {
		return nil
	}
	if blocker := getMergeBlockerReason(*task); blocker != "" {
		m.statusMessage = blocker
		return nil
	}
	m.statusMessage = "Merge in progress..."
	return m.boardActionCmd(
		"mergeTaskPR",
		map[string]string{"taskId": task.ID},
		fmt.Sprintf("Merged PR #%d", derefInt(task.PRNumber)),
	)
}

// mergeTaskBranchPRCmd merges exactly the PR the user picked. It takes the whole
// branch record rather than an ID so the guard runs against the state that was on
// screen when they chose it.
func (m *Model) mergeTaskBranchPRCmd(branch TaskBranchRecord) tea.Cmd {
	if blocker := getBranchMergeBlockerReason(branch); blocker != "" {
		m.statusMessage = blocker
		return nil
	}
	m.statusMessage = "Merge in progress..."
	return m.boardActionCmd(
		"mergeTaskBranchPR",
		map[string]string{"branchId": branch.ID},
		fmt.Sprintf("Merged PR #%d", derefInt(branch.PRNumber)),
	)
}

// openBranchPRCmd opens one branch's PR, resolved through that branch's own repo
// — on a cross-repo card the card's repo is the wrong project.
func (m *Model) openBranchPRCmd(branch TaskBranchRecord, checks bool) tea.Cmd {
	url := getBranchPRURL(branch, m.repoByID(branch.RepoID))
	if url == "" {
		m.statusMessage = "PR link is not available for the selected branch."
		return nil
	}
	if checks {
		url += "/checks"
	}
	return func() tea.Msg {
		if err := openExternal(url); err != nil {
			return asyncErrorMsg{err: err}
		}
		return boardActionMsg{status: "Opened browser."}
	}
}

func (m *Model) schedulePostPushSyncCmd(taskID string) tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Call("schedulePostPushSync", map[string]string{"taskId": taskID}, nil); err != nil {
			return boardActionMsg{err: err}
		}
		return boardActionMsg{status: "Watching pushed branch for PR creation."}
	}
}

func (m *Model) chatTurnCmd(prompt string) tea.Cmd {
	return func() tea.Msg {
		var result ChatTurnResult
		err := m.client.Call("chatTurn", map[string]interface{}{
			"prompt":     prompt,
			"transcript": m.chatTranscript(),
			"context":    m.chatContext(),
		}, &result)
		return chatTurnMsg{result: result, err: err}
	}
}

func (m *Model) moveContextTaskCmd(task *TaskRecord, direction int) tea.Cmd {
	trackIndex := indexTrack(m.sortedTracks(), task.TrackID)
	nextIndex := trackIndex + direction
	sortedTracks := m.sortedTracks()
	if trackIndex < 0 || nextIndex < 0 || nextIndex >= len(sortedTracks) {
		return nil
	}
	return m.boardActionCmd(
		"moveTask",
		map[string]string{"id": task.ID, "trackId": sortedTracks[nextIndex].ID},
		"Moved task.",
	)
}

func (m *Model) setUIStateCmd(patch map[string]interface{}) tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Call("setUIState", patch, nil); err != nil {
			return asyncErrorMsg{err: err}
		}
		return nil
	}
}

func (m *Model) resizeTerminalPaneCmd(delta int) tea.Cmd {
	// Both panes occupy the same split, so the width applies to whichever is up.
	if !m.sidePaneShouldRender() {
		m.statusMessage = "Open a task shell before resizing the terminal pane."
		return nil
	}
	if m.terminalLayoutMode == TerminalLayoutMode("top-bottom") || m.terminalFullscreen {
		m.statusMessage = "Terminal split resizing is available in side-by-side layout."
		return nil
	}

	currentWidth := m.sideBySideTerminalContentWidth()
	nextWidth := m.clampSideBySideTerminalContentWidth(currentWidth + delta)
	m.terminalPaneWidth = nextWidth
	m.statusMessage = fmt.Sprintf("Terminal width: %d columns.", nextWidth)

	return tea.Batch(
		m.setUIStateCmd(map[string]interface{}{"terminalPaneWidth": nextWidth}),
		m.resizeActiveSessionCmd(),
	)
}

func (m *Model) toggleMissionsPaneCmd(open bool) tea.Cmd {
	m.missionsPaneExpanded = open
	m.clampMissionSelection()
	if open {
		m.focus = FocusMissions
	} else {
		m.focus = FocusBoard
	}

	selectedMissionID := ""
	selectedMissionTaskID := ""
	if mission := m.selectedMission(); mission != nil {
		selectedMissionID = mission.ID
	}
	if missionTask := m.selectedMissionTask(); missionTask != nil {
		selectedMissionTaskID = missionTask.TaskID
	}

	return m.setUIStateCmd(map[string]interface{}{
		"missionsPaneExpanded":  open,
		"selectedMissionId":     selectedMissionID,
		"selectedMissionTaskId": selectedMissionTaskID,
	})
}

func (m *Model) toggleDualSessionCmd(task *TaskRecord) tea.Cmd {
	if task == nil {
		return nil
	}

	enable := task.SecondarySessionID == ""
	status := "Closed dual shell."
	focusSlot := SessionSlotPrimary
	if enable {
		status = "Opened dual shell."
		focusSlot = SessionSlotSecondary
	}

	m.statusMessage = map[bool]string{
		true:  "Opening dual shell...",
		false: "Closing dual shell...",
	}[enable]

	taskID := task.ID
	return func() tea.Msg {
		if err := m.client.Call("setDualSessionMode", map[string]interface{}{
			"taskId":  taskID,
			"enabled": enable,
		}, nil); err != nil {
			return boardActionMsg{err: err}
		}

		var board BoardSnapshot
		if err := m.client.Call("getBoard", nil, &board); err != nil {
			return boardActionMsg{err: err}
		}

		return boardActionMsg{
			board:             &board,
			status:            status,
			activateTaskID:    taskID,
			focusTerminalSlot: focusSlot,
		}
	}
}

func (m *Model) resizeActiveSessionCmd() tea.Cmd {
	taskID := m.activeTaskID
	if taskID == "" || !m.terminalPaneShouldRender() {
		return nil
	}

	columns := m.terminalContentWidth()
	if columns < 20 {
		columns = 20
	}

	task := m.taskByID(taskID)
	if task == nil {
		return nil
	}

	commands := []tea.Cmd{}
	primaryHeight, secondaryHeight := splitTerminalSlotHeights(m.activeTaskUsesDualTerminal(), m.terminalPaneHeight())
	for _, target := range []struct {
		slot   SessionSlot
		height int
	}{
		{slot: SessionSlotPrimary, height: primaryHeight},
		{slot: SessionSlotSecondary, height: secondaryHeight},
	} {
		if !m.taskHasSessionSlot(task, target.slot) || target.height <= 0 {
			continue
		}
		rows := terminalSlotViewportHeight(target.height)
		if rows < 5 {
			rows = 5
		}
		slot := target.slot
		height := rows
		commands = append(commands, func() tea.Msg {
			err := m.client.Call("resizeSession", map[string]interface{}{
				"taskId": taskID,
				"slot":   string(slot),
				"cols":   columns,
				"rows":   height,
			}, nil)
			if err != nil {
				return asyncErrorMsg{err: err}
			}
			return nil
		})
	}

	return tea.Batch(commands...)
}

// devPortalProjectURL is where an artifact is administered by hand.
//
// The rollout API only offers a gradual rollout; an immediate GA has to be done
// from the portal, so the board's job is to get you to the right page rather
// than to pretend it can do it.
const devPortalProjectURL = "https://wix-bo.com/dev/project/"

func artifactDevPortalURL(artifact ArtifactRecord) string {
	if artifact.Name == "" {
		return ""
	}
	// The full project id, not the shortened rail label: the portal keys on
	// com.wixpress.enterprise.web5.conversation-configuration, and the chip
	// shows only the tail of that.
	return devPortalProjectURL + url.PathEscape(artifact.Name)
}

// openArtifactDevPortalCmd opens the selected artifact in the dev portal.
//
// Unlike a rollout this reads nothing and changes nothing, so it is offered for
// every artifact — including in-sync ones, where the portal is still the place
// to go look at why.
func (m *Model) openArtifactDevPortalCmd() tea.Cmd {
	artifact := m.selectedArtifact()
	if artifact == nil {
		m.statusMessage = "No artifact selected — press ; to pick one."
		return nil
	}

	target := artifactDevPortalURL(*artifact)
	if target == "" {
		m.statusMessage = "That artifact has no project id to open."
		return nil
	}

	name := artifactDisplayName(*artifact)
	return func() tea.Msg {
		if err := openExternal(target); err != nil {
			return asyncErrorMsg{err: err}
		}
		return boardActionMsg{status: "Opened " + name + " in the dev portal."}
	}
}

func (m *Model) openPRCmd(task *TaskRecord, checks bool) tea.Cmd {
	return func() tea.Msg {
		url := getTaskPRURL(task, m.repoByID(task.RepoID))
		if url == "" {
			return asyncErrorMsg{err: fmt.Errorf("PR link is not available for the selected task.")}
		}
		if checks {
			url += "/checks"
		}
		if err := openExternal(url); err != nil {
			return asyncErrorMsg{err: err}
		}
		return boardActionMsg{status: "Opened browser."}
	}
}

func (m *Model) applyBoard(board BoardSnapshot) {
	m.repos = board.Repos
	m.pillars = board.Pillars
	m.labels = board.Labels
	m.tracks = board.Tracks
	oldAttention := map[string]bool{}
	for _, task := range m.tasks {
		oldAttention[task.ID] = task.SessionAttentionNeeded
	}
	m.tasks = board.Tasks
	for _, task := range m.tasks {
		if task.SessionAttentionNeeded && !oldAttention[task.ID] {
			fmt.Print("\a")
			break
		}
	}
	m.missions = board.Missions
	m.savedViews = board.SavedViews
	m.daemonConnected = true

	sessionKeys := map[string]struct{}{}
	for _, task := range board.Tasks {
		if task.SessionID != "" {
			sessionKeys[m.sessionKey(task.ID, SessionSlotPrimary)] = struct{}{}
		}
		if task.SecondarySessionID != "" {
			sessionKeys[m.sessionKey(task.ID, SessionSlotSecondary)] = struct{}{}
		}
	}

	nextActivityByKey := map[string]*SessionActivitySnapshot{}
	for key, activity := range m.sessionActivityByKey {
		if _, ok := sessionKeys[key]; ok {
			nextActivityByKey[key] = activity
		}
	}
	m.sessionActivityByKey = nextActivityByKey
	m.sessionActivityByTaskID = map[string]*SessionActivitySnapshot{}
	for _, task := range board.Tasks {
		m.refreshTaskSessionActivity(task.ID)
	}

	if board.UIState.ActiveRepoID != "" || m.activeRepoID == "" {
		m.activeRepoID = board.UIState.ActiveRepoID
	}
	if board.UIState.ActiveViewID != "" || m.activeViewID == "" {
		m.activeViewID = board.UIState.ActiveViewID
	}
	if board.UIState.Filters != nil {
		m.filters = *board.UIState.Filters
	}
	if board.UIState.SelectedMissionID != "" || len(m.missions) == 0 {
		m.selectMissionByID(board.UIState.SelectedMissionID, board.UIState.SelectedMissionTaskID)
	}
	if board.UIState.TerminalPaneVisible != nil {
		m.terminalPaneVisible = *board.UIState.TerminalPaneVisible
	}
	if board.UIState.TerminalLayoutMode != "" {
		m.terminalLayoutMode = board.UIState.TerminalLayoutMode
	}
	if board.UIState.TerminalPaneWidth != nil {
		m.terminalPaneWidth = max(0, *board.UIState.TerminalPaneWidth)
	}
	if board.UIState.MissionsPaneExpanded != nil {
		m.missionsPaneExpanded = *board.UIState.MissionsPaneExpanded
	}
	if board.UIState.ThemeMode != "" {
		m.themeMode = board.UIState.ThemeMode
	}

	if m.activeTaskID != "" && m.taskByID(m.activeTaskID) == nil {
		m.clearActiveTerminalState()
	} else {
		m.normalizeFocusedTerminalSlot()
		if !m.activeTaskUsesDualTerminal() {
			m.clearTerminalSlotState(SessionSlotSecondary)
		}
	}

	m.selectedTrackIndex = clamp(m.selectedTrackIndex, 0, max(0, len(m.sortedTracks())-1))
	m.selectedTaskIndex = clamp(m.selectedTaskIndex, 0, max(0, len(m.selectedTrackTasks())-1))
	m.clampMissionSelection()
}

func (m *Model) chatTranscript() []ChatMessage {
	if m.aiChatModal == nil || len(m.aiChatModal.Transcript) == 0 {
		return nil
	}
	return append([]ChatMessage{}, m.aiChatModal.Transcript...)
}

func (m *Model) chatContext() ChatContext {
	selectedTaskID := ""
	if task := m.selectedTask(); task != nil {
		selectedTaskID = task.ID
	}
	selectedMissionID := ""
	if mission := m.selectedMission(); mission != nil {
		selectedMissionID = mission.ID
	}
	selectedMissionTaskID := ""
	if missionTask := m.selectedMissionTask(); missionTask != nil {
		selectedMissionTaskID = missionTask.TaskID
	}

	filters := m.filters
	return ChatContext{
		ActiveRepoID:          m.activeRepoID,
		SelectedTaskID:        selectedTaskID,
		SelectedMissionID:     selectedMissionID,
		SelectedMissionTaskID: selectedMissionTaskID,
		ActiveTaskID:          m.activeTaskID,
		Filters:               &filters,
	}
}

// isGeneralScope reports whether the board is narrowed to general tasks — the
// cards that belong to no repo, and so would otherwise be reachable only from
// the all-repos scope.
func (m *Model) isGeneralScope() bool {
	return m.activeRepoID == GeneralScopeID
}

func (m *Model) switchRepo(direction int) {
	repoIDs := []string{""}
	for _, repo := range m.repos {
		repoIDs = append(repoIDs, repo.ID)
	}
	repoIDs = append(repoIDs, GeneralScopeID)
	if len(repoIDs) == 0 {
		m.activeRepoID = ""
		return
	}
	currentIndex := slices.Index(repoIDs, m.activeRepoID)
	if currentIndex < 0 {
		currentIndex = 0
	}
	nextIndex := (currentIndex + direction + len(repoIDs)) % len(repoIDs)
	m.activeRepoID = repoIDs[nextIndex]
	m.selectedTrackIndex = 0
	m.selectedTaskIndex = 0
}

func (m *Model) sortedTracks() []TrackRecord {
	tracks := append([]TrackRecord{}, m.tracks...)
	sort.Slice(tracks, func(i, j int) bool {
		return tracks[i].SortOrder < tracks[j].SortOrder
	})
	return tracks
}

func (m *Model) visibleTasks() []TaskRecord {
	visible := append([]TaskRecord{}, m.tasks...)
	if m.isGeneralScope() {
		visible = filterTasks(visible, func(task TaskRecord) bool { return task.IsGeneral() })
	} else if m.activeRepoID != "" {
		visible = filterTasks(visible, func(task TaskRecord) bool { return task.RepoID == m.activeRepoID })
	}
	if len(m.filters.RepoIDs) > 0 {
		visible = filterTasks(visible, func(task TaskRecord) bool { return slices.Contains(m.filters.RepoIDs, task.RepoID) })
	}
	if len(m.filters.PillarIDs) > 0 {
		visible = filterTasks(visible, func(task TaskRecord) bool {
			return task.PillarID != "" && slices.Contains(m.filters.PillarIDs, task.PillarID)
		})
	}
	if len(m.filters.TrackIDs) > 0 {
		visible = filterTasks(visible, func(task TaskRecord) bool { return slices.Contains(m.filters.TrackIDs, task.TrackID) })
	}
	if !m.filters.IncludeArchived {
		visible = filterTasks(visible, func(task TaskRecord) bool { return task.ArchivedAt == nil })
	}
	if m.filters.SearchText != "" {
		needle := strings.ToLower(m.filters.SearchText)
		visible = filterTasks(visible, func(task TaskRecord) bool {
			return strings.Contains(strings.ToLower(task.Title), needle)
		})
	}
	return visible
}

func (m *Model) tasksByTrack() map[string][]TaskRecord {
	tasksByTrack := map[string][]TaskRecord{}
	for _, track := range m.sortedTracks() {
		tasksByTrack[track.ID] = []TaskRecord{}
	}
	for _, task := range m.visibleTasks() {
		tasksByTrack[task.TrackID] = append(tasksByTrack[task.TrackID], task)
	}
	for trackID := range tasksByTrack {
		sort.Slice(tasksByTrack[trackID], func(i, j int) bool {
			return tasksByTrack[trackID][i].SortKey < tasksByTrack[trackID][j].SortKey
		})
	}
	return tasksByTrack
}

func (m *Model) selectedTrackTasks() []TaskRecord {
	tracks := m.sortedTracks()
	if len(tracks) == 0 || m.selectedTrackIndex < 0 || m.selectedTrackIndex >= len(tracks) {
		return nil
	}
	return m.tasksByTrack()[tracks[m.selectedTrackIndex].ID]
}

func (m *Model) contextTask() *TaskRecord {
	if m.activeTaskID != "" {
		for _, task := range m.tasks {
			if task.ID == m.activeTaskID {
				return &task
			}
		}
	}

	selected := m.selectedTrackTasks()
	if len(selected) == 0 {
		return nil
	}

	index := clamp(m.selectedTaskIndex, 0, len(selected)-1)
	task := selected[index]
	return &task
}

func (m *Model) selectedTask() *TaskRecord {
	selected := m.selectedTrackTasks()
	if len(selected) == 0 {
		return nil
	}

	index := clamp(m.selectedTaskIndex, 0, len(selected)-1)
	task := selected[index]
	return &task
}

func (m *Model) missionRailWidth() int {
	if m.missionsPaneExpanded || m.focus == FocusMissions {
		return missionRailExpandedWidth
	}
	return missionRailCollapsedWidth
}

func (m *Model) missionRows() []missionSelectionRef {
	rows := make([]missionSelectionRef, 0, len(m.missions)*2)
	for missionIndex, mission := range m.missions {
		rows = append(rows, missionSelectionRef{MissionIndex: missionIndex, TaskIndex: missionSummaryRowTaskIndex})
		if !m.missionsPaneExpanded && m.focus != FocusMissions {
			continue
		}
		if len(mission.Tasks) == 0 {
			rows = append(rows, missionSelectionRef{MissionIndex: missionIndex, TaskIndex: missionEmptyRowTaskIndex})
			continue
		}
		for taskIndex := range mission.Tasks {
			rows = append(rows, missionSelectionRef{MissionIndex: missionIndex, TaskIndex: taskIndex})
		}
	}
	return rows
}

func (m *Model) selectedMission() *MissionSnapshot {
	if len(m.missions) == 0 {
		return nil
	}
	index := clamp(m.selectedMissionIndex, 0, len(m.missions)-1)
	mission := m.missions[index]
	return &mission
}

func (m *Model) selectedMissionTask() *MissionTaskRecord {
	mission := m.selectedMission()
	if mission == nil || len(mission.Tasks) == 0 || m.selectedMissionTaskIndex < 0 {
		return nil
	}
	index := clamp(m.selectedMissionTaskIndex, 0, len(mission.Tasks)-1)
	task := mission.Tasks[index]
	return &task
}

func (m *Model) clampMissionSelection() {
	if len(m.missions) == 0 {
		m.selectedMissionIndex = 0
		m.selectedMissionTaskIndex = -1
		return
	}
	m.selectedMissionIndex = clamp(m.selectedMissionIndex, 0, len(m.missions)-1)
	mission := m.missions[m.selectedMissionIndex]
	if len(mission.Tasks) == 0 {
		m.selectedMissionTaskIndex = -1
		return
	}
	if m.selectedMissionTaskIndex >= len(mission.Tasks) {
		m.selectedMissionTaskIndex = len(mission.Tasks) - 1
	}
	if m.selectedMissionTaskIndex < -1 {
		m.selectedMissionTaskIndex = -1
	}
}

func (m *Model) moveMissionSelection(delta int) {
	rows := m.missionRows()
	if len(rows) == 0 {
		return
	}

	currentIndex := 0
	for index, row := range rows {
		if row.MissionIndex == m.selectedMissionIndex && row.TaskIndex == m.selectedMissionTaskIndex {
			currentIndex = index
			break
		}
	}

	nextIndex := clamp(currentIndex+delta, 0, len(rows)-1)
	m.selectedMissionIndex = rows[nextIndex].MissionIndex
	m.selectedMissionTaskIndex = rows[nextIndex].TaskIndex
}

func (m *Model) selectMissionByID(missionID, taskID string) bool {
	if missionID == "" {
		m.clampMissionSelection()
		return false
	}

	for missionIndex, mission := range m.missions {
		if mission.ID != missionID {
			continue
		}
		m.selectedMissionIndex = missionIndex
		m.selectedMissionTaskIndex = missionSummaryRowTaskIndex
		if taskID != "" {
			for taskIndex, missionTask := range mission.Tasks {
				if missionTask.TaskID == taskID {
					m.selectedMissionTaskIndex = taskIndex
					return true
				}
			}
		}
		return true
	}

	m.clampMissionSelection()
	return false
}

func (m *Model) repoByID(repoID string) *RepoRecord {
	for _, repo := range m.repos {
		if repo.ID == repoID {
			return &repo
		}
	}
	return nil
}

func normalizeSessionSlot(slot SessionSlot) SessionSlot {
	if slot == SessionSlotSecondary {
		return SessionSlotSecondary
	}
	return SessionSlotPrimary
}

func splitTerminalSlotHeights(dual bool, totalHeight int) (int, int) {
	if !dual {
		return max(1, totalHeight), 0
	}

	availableHeight := max(1, totalHeight-dualTerminalDividerHeight(totalHeight))
	if availableHeight == 1 {
		return 1, 0
	}

	bottom := max(1, availableHeight/4)
	top := availableHeight - bottom
	const minPaneHeight = 4
	if availableHeight < minPaneHeight*2 {
		top = (availableHeight + 1) / 2
		bottom = availableHeight - top
	} else {
		if bottom < minPaneHeight {
			bottom = minPaneHeight
			top = availableHeight - bottom
		}
		if top < minPaneHeight {
			top = minPaneHeight
			bottom = availableHeight - top
		}
	}
	if bottom <= 0 {
		bottom = 1
		top = max(1, availableHeight-bottom)
	}
	return top, bottom
}

func dualTerminalDividerHeight(totalHeight int) int {
	if totalHeight >= terminalSlotDividerHeight+2 {
		return terminalSlotDividerHeight
	}
	return 0
}

func terminalSlotViewportHeight(height int) int {
	if height <= 2 {
		return max(1, height-terminalHeaderHeight)
	}
	return max(1, height-terminalHeaderHeight-terminalFooterHeight)
}

func (m *Model) sessionKey(taskID string, slot SessionSlot) string {
	return taskID + ":" + string(normalizeSessionSlot(slot))
}

func (m *Model) taskHasSessionSlot(task *TaskRecord, slot SessionSlot) bool {
	if task == nil {
		return false
	}
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		return task.SecondarySessionID != ""
	}
	return task.SessionID != ""
}

func (m *Model) activeTaskUsesDualTerminal() bool {
	return m.taskHasSessionSlot(m.taskByID(m.activeTaskID), SessionSlotSecondary)
}

func (m *Model) visibleTerminalSlotsForTask(task *TaskRecord) []SessionSlot {
	if task == nil {
		return nil
	}
	slots := []SessionSlot{SessionSlotPrimary}
	if task.SecondarySessionID != "" {
		slots = append(slots, SessionSlotSecondary)
	}
	return slots
}

func (m *Model) sessionTargets() []sessionTarget {
	targets := []sessionTarget{}
	seen := map[string]struct{}{}
	for _, task := range m.tasks {
		for _, slot := range m.visibleTerminalSlotsForTask(&task) {
			if !m.taskHasSessionSlot(&task, slot) {
				continue
			}
			key := m.sessionKey(task.ID, slot)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			targets = append(targets, sessionTarget{TaskID: task.ID, Slot: slot})
		}
	}
	if m.activeTaskID != "" {
		task := m.taskByID(m.activeTaskID)
		for _, slot := range m.visibleTerminalSlotsForTask(task) {
			key := m.sessionKey(m.activeTaskID, slot)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			targets = append(targets, sessionTarget{TaskID: m.activeTaskID, Slot: slot})
		}
	}
	return targets
}

func (m *Model) terminalCommandForSlot(slot SessionSlot) string {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		return m.secondaryTerminalCommand
	}
	return m.terminalCommand
}

func (m *Model) setTerminalCommand(slot SessionSlot, command string) {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		m.secondaryTerminalCommand = command
		return
	}
	m.terminalCommand = command
}

func (m *Model) terminalScrollOffsetForSlot(slot SessionSlot) int {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		return m.secondaryTerminalScrollOffset
	}
	return m.terminalScrollOffset
}

func (m *Model) setTerminalScrollOffset(slot SessionSlot, offset int) {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		m.secondaryTerminalScrollOffset = offset
		return
	}
	m.terminalScrollOffset = offset
}

func (m *Model) terminalBufferForSlot(slot SessionSlot) GetBufferResult {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		return m.secondaryBuffer
	}
	return m.buffer
}

func (m *Model) setTerminalBuffer(slot SessionSlot, buffer GetBufferResult) {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		m.secondaryBuffer = buffer
		return
	}
	m.buffer = buffer
}

func (m *Model) terminalBranchForSlot(slot SessionSlot) string {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		return m.secondarySessionBranch
	}
	return m.activeSessionBranch
}

func (m *Model) terminalBackendTypeForSlot(slot SessionSlot) SessionBackendType {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		return m.secondarySessionBackendType
	}
	return m.activeSessionBackendType
}

// attachesInTmuxPane reports whether the session lives in a tmux pane rather than an
// embedded PTY. A remote session is reached through a local tmux wrapper session, so
// it joins panes and renders through exactly the same path as a local tmux session.
func (backendType SessionBackendType) attachesInTmuxPane() bool {
	return backendType == SessionBackendTmux || backendType == SessionBackendSSH
}

func (m *Model) terminalBackendSessionIDForSlot(slot SessionSlot) string {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		return m.secondarySessionBackendID
	}
	return m.activeSessionBackendSessionID
}

func (m *Model) terminalAttachCommandForSlot(slot SessionSlot) string {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		return m.secondarySessionAttachCommand
	}
	return m.activeSessionAttachCommand
}

func (m *Model) setTerminalSessionMetadata(slot SessionSlot, branch string, backendType SessionBackendType, backendSessionID string, attachCommand string) {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		m.secondarySessionBranch = branch
		m.secondarySessionBackendType = backendType
		m.secondarySessionBackendID = backendSessionID
		m.secondarySessionAttachCommand = attachCommand
		return
	}
	m.activeSessionBranch = branch
	m.activeSessionBackendType = backendType
	m.activeSessionBackendSessionID = backendSessionID
	m.activeSessionAttachCommand = attachCommand
}

func (m *Model) clearTerminalSlotState(slot SessionSlot) {
	m.setTerminalSessionMetadata(slot, "", "", "", "")
	m.setTerminalBuffer(slot, GetBufferResult{})
	m.setTerminalScrollOffset(slot, 0)
	m.setTerminalCommand(slot, "")
}

func (m *Model) clearActiveTerminalState() {
	m.activeTaskID = ""
	m.terminalPaneVisible = false
	m.terminalFullscreen = false
	m.focusedTerminalSlot = SessionSlotPrimary
	m.clearTerminalSlotState(SessionSlotPrimary)
	m.clearTerminalSlotState(SessionSlotSecondary)
}

func (m *Model) resolveTerminalSlotForTask(task *TaskRecord, preferred SessionSlot) SessionSlot {
	if normalizeSessionSlot(preferred) == SessionSlotSecondary && !m.taskHasSessionSlot(task, SessionSlotSecondary) {
		return SessionSlotPrimary
	}
	return normalizeSessionSlot(preferred)
}

func (m *Model) alternateTerminalSlot(slot SessionSlot) SessionSlot {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		return SessionSlotPrimary
	}
	return SessionSlotSecondary
}

func (m *Model) normalizeFocusedTerminalSlot() {
	m.focusedTerminalSlot = m.resolveTerminalSlotForTask(m.taskByID(m.activeTaskID), m.focusedTerminalSlot)
}

func (m *Model) sessionActivity(taskID string, slot SessionSlot) *SessionActivitySnapshot {
	return m.sessionActivityByKey[m.sessionKey(taskID, slot)]
}

func (m *Model) refreshTaskSessionActivity(taskID string) {
	primary := m.sessionActivity(taskID, SessionSlotPrimary)
	secondary := m.sessionActivity(taskID, SessionSlotSecondary)
	next := primary
	switch {
	case primary != nil && primary.IsBusy:
		next = primary
	case secondary != nil && secondary.IsBusy:
		next = secondary
	case primary != nil:
		next = primary
	default:
		next = secondary
	}
	if next == nil {
		delete(m.sessionActivityByTaskID, taskID)
		return
	}
	m.sessionActivityByTaskID[taskID] = next
}

func (m *Model) setSessionActivity(taskID string, slot SessionSlot, activity *SessionActivitySnapshot) {
	key := m.sessionKey(taskID, slot)
	if activity == nil {
		delete(m.sessionActivityByKey, key)
		m.refreshTaskSessionActivity(taskID)
		return
	}
	activity.Slot = normalizeSessionSlot(slot)
	m.sessionActivityByKey[key] = activity
	m.refreshTaskSessionActivity(taskID)
}

func (m *Model) loadVisibleTerminalStateCmd() tea.Cmd {
	if !m.terminalPaneShouldRender() || m.activeTaskID == "" {
		return nil
	}

	task := m.taskByID(m.activeTaskID)
	if task == nil {
		return nil
	}

	commands := []tea.Cmd{}
	for _, slot := range m.visibleTerminalSlotsForTask(task) {
		commands = append(commands, m.loadBufferCmd(task.ID, slot), m.inspectSessionCmd(task.ID, slot))
	}
	return tea.Batch(commands...)
}

func (m *Model) terminalPaneShouldRender() bool {
	return m.terminalPaneVisible && m.activeTaskID != "" && !m.terminalBackendTypeForSlot(m.focusedTerminalSlot).attachesInTmuxPane()
}

// detailPaneShouldRender gates on a selected card, not on branches: a card with
// one PR still has a PR worth reading, and refusing to open would make the key
// feel broken.
func (m *Model) detailPaneShouldRender() bool {
	return m.detailPaneVisible && m.selectedTask() != nil
}

// sidePaneShouldRender is whether the board gives up half its width. Both panes
// share that one slot, so the split maths stays in one place and 'z' and
// Shift+←/→ keep behaving the same whichever pane is showing.
func (m *Model) sidePaneShouldRender() bool {
	return m.detailPaneShouldRender() || m.terminalPaneShouldRender()
}

// toggleDetailPane opens the PR pane on the selected card, or closes it. Closing
// hands focus back to the board rather than to the terminal, because the board
// is where the user was.
func (m *Model) toggleDetailPane() {
	if m.detailPaneVisible {
		m.detailPaneVisible = false
		m.detailBranchIndex = 0
		if m.focus == FocusDetail {
			m.focus = FocusBoard
		}
		return
	}

	task := m.selectedTask()
	if task == nil {
		m.statusMessage = "Select a card to inspect its PRs."
		return
	}
	m.detailPaneVisible = true
	m.detailBranchIndex = 0
	m.focus = FocusDetail
}

// moveDetailBranchSelection walks the selected card's branches. It clamps rather
// than wraps so the ends of a five-repo feature stay findable by feel.
func (m *Model) moveDetailBranchSelection(delta int) {
	task := m.selectedTask()
	if task == nil || len(task.Branches) == 0 {
		m.detailBranchIndex = 0
		return
	}
	m.detailBranchIndex = clamp(m.detailBranchIndex+delta, 0, len(task.Branches)-1)
}

// taskBranchRepoLabel names the repo a branch lives in, falling back to the raw
// repo ID: an unfamiliar ID is still identifiable, a blank is not.
func (m *Model) taskBranchRepoLabel(branch TaskBranchRecord) string {
	if repo := m.repoByID(branch.RepoID); repo != nil && repo.Label != "" {
		return repo.Label
	}
	return branch.RepoID
}

func (m *Model) boardRenderWidth() int {
	return m.missionRailWidth() + max(1, len(m.sortedTracks()))*trackColumnRenderWidth
}

func (m *Model) canShowTerminalPane() bool {
	return m.width-terminalDividerWidth-terminalPaneFrameWidth-minBoardPaneWidth >= minTerminalPaneWidth
}

func (m *Model) terminalTakesOver() bool {
	narrowMode := m.terminalPaneShouldRender() && !m.canShowTerminalPane()
	return m.terminalPaneShouldRender() && m.focus == FocusTerminal && (narrowMode || m.terminalFullscreen)
}

func (m *Model) terminalUsesFullWidth() bool {
	return m.terminalTakesOver() || (m.terminalPaneShouldRender() && m.terminalLayoutMode == TerminalLayoutMode("top-bottom"))
}

func (m *Model) terminalContentWidth() int {
	if m.terminalUsesFullWidth() {
		return max(1, m.width-terminalPaneFrameWidth)
	}
	return m.sideBySideTerminalContentWidth()
}

func (m *Model) terminalPaneHeight() int {
	contentHeight := m.contentHeight()
	height := contentHeight
	if m.terminalPaneShouldRender() && m.terminalLayoutMode == TerminalLayoutMode("top-bottom") && !m.terminalTakesOver() {
		divider := 0
		if contentHeight >= 3 {
			divider = 1
		}
		boardHeight := max(1, (contentHeight-divider+1)/2)
		height = max(1, contentHeight-boardHeight-divider)
	}
	return terminalPaneContentHeight(height)
}

func (m *Model) terminalViewportHeight() int {
	primaryHeight, secondaryHeight := splitTerminalSlotHeights(m.activeTaskUsesDualTerminal(), m.terminalPaneHeight())
	if normalizeSessionSlot(m.focusedTerminalSlot) == SessionSlotSecondary && secondaryHeight > 0 {
		return terminalSlotViewportHeight(secondaryHeight)
	}
	return terminalSlotViewportHeight(primaryHeight)
}

func (m *Model) contentHeight() int {
	height := m.height - headerHeight - artifactFooterHeight - statusBarHeight
	if shouldShowFilterBar(m.filters, m.focus) {
		height--
	}
	return max(1, height)
}

func (m *Model) sideBySideTerminalContentWidth() int {
	if m.width <= terminalDividerWidth+terminalPaneFrameWidth {
		return 1
	}

	defaultWidth := m.width - m.boardRenderWidth() - terminalDividerWidth - terminalPaneFrameWidth
	if defaultWidth < minTerminalPaneWidth {
		defaultWidth = minTerminalPaneWidth
	}
	if m.terminalPaneWidth > 0 {
		defaultWidth = m.terminalPaneWidth
	}

	return m.clampSideBySideTerminalContentWidth(defaultWidth)
}

func (m *Model) clampSideBySideTerminalContentWidth(width int) int {
	maxWidth := max(1, m.width-terminalDividerWidth-terminalPaneFrameWidth-minBoardPaneWidth)
	if maxWidth < minTerminalPaneWidth {
		return clamp(width, 1, maxWidth)
	}
	return clamp(width, minTerminalPaneWidth, maxWidth)
}

func (m *Model) sideBySideTerminalOuterWidth() int {
	return min(max(1, m.width-terminalDividerWidth-1), m.sideBySideTerminalContentWidth()+terminalPaneFrameWidth)
}

func (m *Model) sideBySideBoardWidth() int {
	return max(1, m.width-terminalDividerWidth-m.sideBySideTerminalOuterWidth())
}

func terminalPaneContentHeight(outerHeight int) int {
	return max(1, outerHeight-terminalPaneFrameWidth)
}

func encodeTerminalKey(key tea.KeyMsg) string {
	switch key.Type {
	case tea.KeyCtrlC:
		return "\x03"
	case tea.KeyEnter:
		return "\r"
	case tea.KeyTab:
		return "\t"
	case tea.KeyBackspace, tea.KeyDelete:
		return "\x7f"
	case tea.KeyUp:
		return "\x1b[A"
	case tea.KeyDown:
		return "\x1b[B"
	case tea.KeyLeft:
		return "\x1b[D"
	case tea.KeyRight:
		return "\x1b[C"
	}

	if len(key.Runes) > 0 {
		return string(key.Runes)
	}

	return ""
}

func openExternal(target string) error {
	var command string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		command = "open"
		args = []string{target}
	case "linux":
		command = "xdg-open"
		args = []string{target}
	case "windows":
		command = "cmd"
		args = []string{"/c", "start", "", target}
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}
	return exec.Command(command, args...).Start()
}

func defaultANSILines(lines, ansiLines []string) []string {
	if len(ansiLines) == len(lines) {
		return ansiLines
	}
	return lines
}

func filterTasks(tasks []TaskRecord, keep func(TaskRecord) bool) []TaskRecord {
	filtered := make([]TaskRecord, 0, len(tasks))
	for _, task := range tasks {
		if keep(task) {
			filtered = append(filtered, task)
		}
	}
	return filtered
}

func indexTrack(tracks []TrackRecord, trackID string) int {
	for index, track := range tracks {
		if track.ID == trackID {
			return index
		}
	}
	return -1
}

func derefInt(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

func clamp(value, lower, upper int) int {
	if value < lower {
		return lower
	}
	if value > upper {
		return upper
	}
	return value
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
