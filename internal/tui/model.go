package tui

import (
	"encoding/json"
	"fmt"
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
	missionRailCollapsedWidth = 18
	missionRailExpandedWidth  = 36
	minTerminalPaneWidth      = 40
	trackColumnStyleWidth     = 32
	trackColumnRenderWidth    = trackColumnStyleWidth + 2
	trackHeaderWidth          = trackColumnStyleWidth - 2
	taskCardStyleWidth        = trackColumnStyleWidth - 2
	taskCardContentWidth      = taskCardStyleWidth - 2
	terminalHeaderHeight      = 1
	terminalFooterHeight      = 1
	terminalInputFlushMillis  = 6
	terminalBoardNavTimeout   = 250 * time.Millisecond
)

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
	taskID   string
	slot     SessionSlot
	session  SessionRecord
	board    *BoardSnapshot
	buffer   *GetBufferResult
	activity *SessionActivitySnapshot
	err      error
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

type chatTurnMsg struct {
	result ChatTurnResult
	err    error
}

type spinnerTickMsg struct{}
type sessionPollTickMsg struct{}
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

	focus                         AppFocus
	modal                         ModalType
	activeRepoID                  string
	activeViewID                  string
	filters                       FilterModel
	selectedTrackIndex            int
	selectedTaskIndex             int
	selectedMissionIndex          int
	selectedMissionTaskIndex      int
	terminalPaneVisible           bool
	terminalLayoutMode            TerminalLayoutMode
	missionsPaneExpanded          bool
	activeTaskID                  string
	activeSessionBranch           string
	activeSessionBackendType      SessionBackendType
	secondarySessionBranch        string
	secondarySessionBackendType   SessionBackendType
	sessionActivityByTaskID       map[string]*SessionActivitySnapshot
	sessionActivityByKey          map[string]*SessionActivitySnapshot
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

	createTaskModal           *createTaskModalState
	createMissionModal        *createMissionModalState
	addMissionTaskModal       *addMissionTaskModalState
	renameTaskModal           *renameTaskModalState
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
		spinnerTickCmd(),
		sessionPollTickCmd(),
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

	case boardLoadedMsg:
		if msg.err != nil {
			m.daemonConnected = false
			m.statusMessage = msg.err.Error()
			return m, nil
		}
		m.applyBoard(msg.board)
		return m, m.syncSessionUpdateWatchCmd()

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
		m.setTerminalSessionMetadata(msg.slot, msg.session.Branch, msg.session.BackendType)
		m.terminalPaneVisible = true
		m.terminalFullscreen = false
		m.setTerminalScrollOffset(msg.slot, 0)
		m.focus = FocusTerminal
		if msg.buffer != nil {
			m.setTerminalBuffer(msg.slot, *msg.buffer)
		}
		if msg.activity != nil {
			m.setSessionActivity(msg.taskID, msg.slot, msg.activity)
		}
		m.statusMessage = "Opened task shell."
		return m, tea.Batch(
			m.syncSessionUpdateWatchCmd(),
			m.resizeActiveSessionCmd(),
			m.loadVisibleTerminalStateCmd(),
		)

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
		return m, nil

	case asyncErrorMsg:
		if msg.err != nil {
			m.statusMessage = msg.err.Error()
		}
		return m, nil

	case chatTurnMsg:
		if m.aiChatModal == nil {
			return m, nil
		}
		m.aiChatModal.Pending = false
		if msg.err != nil {
			m.aiChatModal.Input = m.aiChatModal.PendingPrompt
			m.aiChatModal.PendingPrompt = ""
			m.statusMessage = msg.err.Error()
			return m, nil
		}
		m.aiChatModal.PendingPrompt = ""
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
		return nil
	default:
		return nil
	}
}

func (m *Model) handleKey(key tea.KeyMsg) tea.Cmd {
	if m.focus == FocusTerminal {
		return m.handleTerminalKey(key)
	}
	if m.focus == FocusMissions {
		return m.handleMissionKey(key)
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

	switch key.String() {
	case "left", "h", "right", "l", "up", "k", "down":
		m.applyBoardNavigation(boardNavigationActionForKey(key))
	case ",":
		m.switchRepo(-1)
		return m.persistActiveRepoCmd()
	case ".":
		m.switchRepo(1)
		return m.persistActiveRepoCmd()
	case ":":
		m.openCommandPaletteModal()
		return nil
	case "enter":
		task := m.selectedTask()
		if task != nil {
			return m.openSessionCmd(task.ID, false, SessionSlotPrimary)
		}
	case "R":
		task := m.selectedTask()
		if task != nil {
			return m.openSessionCmd(task.ID, true, SessionSlotPrimary)
		}
	case "s":
		return m.syncCmd()
	case "u":
		return m.toggleMissionsPaneCmd(true)
	case "t":
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
	case "?":
		m.openHelpModal()
	case "q":
		return tea.Quit
	case "f":
		m.openFilterModal()
	case "g":
		m.openViewModal()
	case "n":
		m.openCreateTaskModal()
	case "r":
		m.openRenameTaskModal(m.selectedTask())
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
	case "j":
		m.openPRCommentModal(m.selectedTask())
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
	m.secondarySessionBranch = task.BranchName
	m.secondarySessionBackendType = ""
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

func spinnerTickCmd() tea.Cmd {
	return tea.Tick(80*time.Millisecond, func(_ time.Time) tea.Msg { return spinnerTickMsg{} })
}

func sessionPollTickCmd() tea.Cmd {
	return tea.Tick(1500*time.Millisecond, func(_ time.Time) tea.Msg { return sessionPollTickMsg{} })
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

func (m *Model) focusActiveTerminalCmd(fullscreen bool) tea.Cmd {
	if m.activeTaskID == "" {
		return nil
	}

	m.terminalPaneVisible = true
	m.terminalFullscreen = fullscreen
	m.normalizeFocusedTerminalSlot()
	m.focus = FocusTerminal

	return tea.Batch(
		m.resizeActiveSessionCmd(),
		m.acknowledgeSessionAttentionCmd(m.activeTaskID),
	)
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
	return m.boardActionCmd("triggerSync", nil, "Sync complete.")
}

func (m *Model) createTaskPRCmd(task *TaskRecord) tea.Cmd {
	if task == nil {
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
	m.tasks = board.Tasks
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

func (m *Model) switchRepo(direction int) {
	repoIDs := []string{""}
	for _, repo := range m.repos {
		repoIDs = append(repoIDs, repo.ID)
	}
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
	if m.activeRepoID != "" {
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

	totalHeight = max(2, totalHeight)
	bottom := max(1, totalHeight/4)
	top := totalHeight - bottom
	const minPaneHeight = 4
	if totalHeight >= minPaneHeight*2 {
		if bottom < minPaneHeight {
			bottom = minPaneHeight
			top = totalHeight - bottom
		}
		if top < minPaneHeight {
			top = minPaneHeight
			bottom = totalHeight - top
		}
	}
	if bottom <= 0 {
		bottom = 1
		top = max(1, totalHeight-bottom)
	}
	return top, bottom
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

func (m *Model) setTerminalSessionMetadata(slot SessionSlot, branch string, backendType SessionBackendType) {
	if normalizeSessionSlot(slot) == SessionSlotSecondary {
		m.secondarySessionBranch = branch
		m.secondarySessionBackendType = backendType
		return
	}
	m.activeSessionBranch = branch
	m.activeSessionBackendType = backendType
}

func (m *Model) clearTerminalSlotState(slot SessionSlot) {
	m.setTerminalSessionMetadata(slot, "", "")
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
	return m.terminalPaneVisible && m.activeTaskID != ""
}

func (m *Model) boardRenderWidth() int {
	return m.missionRailWidth() + max(1, len(m.sortedTracks()))*trackColumnRenderWidth
}

func (m *Model) canShowTerminalPane() bool {
	return m.width-m.boardRenderWidth()-terminalDividerWidth >= minTerminalPaneWidth
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
		return max(1, m.width)
	}
	return max(1, m.width-m.boardRenderWidth()-terminalDividerWidth)
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
	return max(1, height)
}

func (m *Model) terminalViewportHeight() int {
	primaryHeight, secondaryHeight := splitTerminalSlotHeights(m.activeTaskUsesDualTerminal(), m.terminalPaneHeight())
	if normalizeSessionSlot(m.focusedTerminalSlot) == SessionSlotSecondary && secondaryHeight > 0 {
		return terminalSlotViewportHeight(secondaryHeight)
	}
	return terminalSlotViewportHeight(primaryHeight)
}

func (m *Model) contentHeight() int {
	height := m.height - 2 - 1
	if shouldShowFilterBar(m.filters, m.focus) {
		height--
	}
	return max(1, height)
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
