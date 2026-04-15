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
	terminalDividerWidth     = 1
	minTerminalPaneWidth     = 40
	trackColumnStyleWidth    = 32
	trackColumnRenderWidth   = trackColumnStyleWidth + 2
	trackHeaderWidth         = trackColumnStyleWidth - 2
	taskCardStyleWidth       = trackColumnStyleWidth - 2
	taskCardContentWidth     = taskCardStyleWidth - 2
	terminalHeaderHeight     = 1
	terminalFooterHeight     = 1
	terminalInputFlushMillis = 6
	terminalBoardNavTimeout  = 250 * time.Millisecond
)

type boardLoadedMsg struct {
	board BoardSnapshot
	err   error
}

type boardActionMsg struct {
	board  *BoardSnapshot
	status string
	err    error
}

type sessionOpenedMsg struct {
	taskID   string
	session  SessionRecord
	board    *BoardSnapshot
	buffer   *GetBufferResult
	activity *SessionActivitySnapshot
	err      error
}

type bufferLoadedMsg struct {
	taskID string
	buffer GetBufferResult
	err    error
}

type sessionActivityMsg struct {
	taskID   string
	activity *SessionActivitySnapshot
	err      error
}

type rpcEventMsg struct {
	event RPCEvent
}

type asyncErrorMsg struct {
	err error
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

type Model struct {
	client *RPCClient

	width  int
	height int

	repos      []RepoRecord
	pillars    []PillarRecord
	labels     []LabelRecord
	tracks     []TrackRecord
	tasks      []TaskRecord
	savedViews []SavedViewRecord

	focus                      AppFocus
	modal                      ModalType
	activeRepoID               string
	activeViewID               string
	filters                    FilterModel
	selectedTrackIndex         int
	selectedTaskIndex          int
	terminalPaneVisible        bool
	terminalLayoutMode         TerminalLayoutMode
	activeTaskID               string
	activeSessionBranch        string
	activeSessionBackendType   SessionBackendType
	sessionActivityByTaskID    map[string]*SessionActivitySnapshot
	terminalFullscreen         bool
	terminalScrollOffset       int
	syncInProgress             bool
	statusMessage              string
	daemonConnected            bool
	themeMode                  ThemeMode
	buffer                     GetBufferResult
	spinnerIndex               int
	terminalCommand            string
	pendingTerminalInput       string
	pendingTerminalInputTaskID string
	pendingTerminalPushSync    bool
	terminalInputFlushVersion  int
	postPushSyncVersion        int
	terminalBoardNavPending    bool
	terminalBoardNavTaskID     string
	terminalBoardNavConsumed   bool
	terminalBoardNavVersion    int

	createTaskModal          *createTaskModalState
	renameTaskModal          *renameTaskModalState
	taskDescriptionModal     *taskDescriptionModalState
	archiveConfirmModal      *archiveConfirmModalState
	deleteConfirmModal       *deleteConfirmModalState
	createPillarModal        *createPillarModalState
	deletePillarConfirmModal *deletePillarConfirmModalState
	pillarPickerModal        *pillarPickerModalState
	filterModal              *filterModalState
	viewModal                *viewModalState
	commandPaletteModal      *commandPaletteModalState
}

func NewModel(socketPath string) (*Model, error) {
	client, err := NewRPCClient(socketPath)
	if err != nil {
		return nil, err
	}

	model := &Model{
		client:                  client,
		focus:                   FocusBoard,
		modal:                   ModalNone,
		terminalLayoutMode:      TerminalLayoutMode("side-by-side"),
		sessionActivityByTaskID: map[string]*SessionActivitySnapshot{},
		themeMode:               ThemeMode("truecolor"),
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
	return m.client.Close()
}

func (m *Model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		if m.activeTaskID != "" && m.terminalPaneShouldRender() {
			return m, tea.Batch(m.resizeActiveSessionCmd(), m.loadBufferCmd(m.activeTaskID))
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
		taskIDs := m.sessionTaskIDs()
		if len(taskIDs) == 0 || m.focus == FocusTerminal {
			return m, sessionPollTickCmd()
		}

		commands := []tea.Cmd{sessionPollTickCmd()}
		for _, taskID := range taskIDs {
			commands = append(commands, m.inspectSessionCmd(taskID))
		}
		return m, tea.Batch(commands...)

	case boardLoadedMsg:
		if msg.err != nil {
			m.daemonConnected = false
			m.statusMessage = msg.err.Error()
			return m, nil
		}
		m.applyBoard(msg.board)
		return m, nil

	case boardActionMsg:
		if msg.err != nil {
			m.statusMessage = msg.err.Error()
			return m, nil
		}
		if msg.board != nil {
			m.applyBoard(*msg.board)
		}
		if msg.status != "" {
			m.statusMessage = msg.status
		}
		if m.activeTaskID != "" && m.terminalPaneShouldRender() {
			return m, tea.Batch(m.loadBufferCmd(m.activeTaskID), m.inspectSessionCmd(m.activeTaskID))
		}
		return m, nil

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
		m.activeSessionBranch = msg.session.Branch
		m.activeSessionBackendType = msg.session.BackendType
		m.terminalPaneVisible = true
		m.terminalFullscreen = false
		m.terminalScrollOffset = 0
		m.focus = FocusTerminal
		if msg.buffer != nil {
			m.buffer = *msg.buffer
		}
		if msg.activity != nil {
			m.sessionActivityByTaskID[msg.taskID] = msg.activity
		}
		m.statusMessage = "Opened task shell."
		return m, tea.Batch(m.resizeActiveSessionCmd(), m.inspectSessionCmd(msg.taskID))

	case bufferLoadedMsg:
		if msg.err == nil && msg.taskID == m.activeTaskID {
			m.buffer = msg.buffer
		}
		return m, nil

	case sessionActivityMsg:
		if msg.err != nil {
			return m, nil
		}
		if msg.activity == nil {
			delete(m.sessionActivityByTaskID, msg.taskID)
			return m, nil
		}
		m.sessionActivityByTaskID[msg.taskID] = msg.activity
		return m, nil

	case asyncErrorMsg:
		if msg.err != nil {
			m.statusMessage = msg.err.Error()
		}
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
		return func() tea.Msg {
			return bufferLoadedMsg{
				taskID: update.TaskID,
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
	case "left", "h", "right", "l", "up", "k", "down", "j":
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
			return m.openSessionCmd(task.ID, false)
		}
	case "R":
		task := m.selectedTask()
		if task != nil {
			return m.openSessionCmd(task.ID, true)
		}
	case "s":
		return m.syncCmd()
	case "t":
		if m.activeTaskID == "" {
			m.statusMessage = "No session open for the selected task."
			return nil
		}
		m.terminalPaneVisible = true
		m.focus = FocusTerminal
		return m.resizeActiveSessionCmd()
	case "z":
		if m.activeTaskID == "" {
			m.statusMessage = "No session open to expand."
			return nil
		}
		m.terminalPaneVisible = true
		m.terminalFullscreen = true
		m.focus = FocusTerminal
		return m.resizeActiveSessionCmd()
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
	case "a":
		m.openArchiveConfirmModal(m.selectedTask())
	case "d":
		m.openDeleteConfirmModal(m.selectedTask())
	case "c":
		task := m.selectedTask()
		if task != nil {
			return m.boardActionCmd("createTaskPR", map[string]string{"taskId": task.ID}, fmt.Sprintf("Ensured PR for task %s", task.ID))
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
			if blocker := getMergeBlockerReason(*task); blocker != "" {
				m.statusMessage = blocker
				return nil
			}
			return m.boardActionCmd("mergeTaskPR", map[string]string{"taskId": task.ID}, fmt.Sprintf("Merged PR #%d", derefInt(task.PRNumber)))
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

func (m *Model) handleTerminalKey(key tea.KeyMsg) tea.Cmd {
	if m.terminalBoardNavPending {
		return m.handlePendingTerminalBoardNavKey(key)
	}

	return m.handleDirectTerminalKey(key)
}

func (m *Model) handleDirectTerminalKey(key tea.KeyMsg) tea.Cmd {
	switch key.Type {
	case tea.KeyTab:
		if m.activeTaskID == "" {
			return nil
		}
		return m.armTerminalBoardNav(m.activeTaskID, false)
	case tea.KeyEsc:
		flushCmd := m.flushPendingTerminalInputCmd()
		m.terminalCommand = ""
		m.focus = FocusBoard
		m.terminalFullscreen = false
		return flushCmd
	case tea.KeyPgUp:
		m.terminalScrollOffset += 10
		return nil
	case tea.KeyPgDown:
		m.terminalScrollOffset = max(0, m.terminalScrollOffset-10)
		return nil
	case tea.KeyShiftUp:
		m.terminalScrollOffset += 1
		return nil
	case tea.KeyShiftDown:
		m.terminalScrollOffset = max(0, m.terminalScrollOffset-1)
		return nil
	}

	if m.activeTaskID == "" {
		return nil
	}

	data := encodeTerminalKey(key)
	if data == "" {
		return nil
	}

	commandBeforeSubmit := m.terminalCommand
	m.terminalCommand = appendTerminalCommand(m.terminalCommand, key)

	if m.terminalScrollOffset != 0 {
		m.terminalScrollOffset = 0
	}

	return m.queueTerminalInputCmd(
		m.activeTaskID,
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

func (m *Model) handlePendingTerminalBoardNavKey(key tea.KeyMsg) tea.Cmd {
	if key.Type == tea.KeyEsc {
		m.clearTerminalBoardNav()
		flushCmd := m.flushPendingTerminalInputCmd()
		m.terminalCommand = ""
		m.focus = FocusBoard
		m.terminalFullscreen = false
		return flushCmd
	}

	if key.Type == tea.KeyTab {
		return m.armTerminalBoardNav(m.terminalBoardNavTaskID, m.terminalBoardNavConsumed)
	}

	if action := boardNavigationActionForKey(key); action != boardNavigationNone {
		m.applyBoardNavigation(action)

		task := m.selectedTask()
		nextTaskID := m.terminalBoardNavTaskID
		if task != nil {
			nextTaskID = task.ID
		}
		rearmCmd := m.armTerminalBoardNav(nextTaskID, true)

		if task == nil {
			m.statusMessage = "Selected track has no task."
			return rearmCmd
		}
		if task.ID == m.activeTaskID {
			return rearmCmd
		}
		return tea.Batch(m.openSessionCmd(task.ID, false), rearmCmd)
	}

	if m.terminalBoardNavConsumed {
		m.clearTerminalBoardNav()
		return m.handleDirectTerminalKey(key)
	}

	if m.terminalBoardNavTaskID == "" {
		m.clearTerminalBoardNav()
		return nil
	}

	switch key.Type {
	case tea.KeyPgUp:
		taskID := m.terminalBoardNavTaskID
		m.clearTerminalBoardNav()
		m.terminalScrollOffset += 10
		return m.queueTerminalInputCmd(taskID, "\t", tea.KeyMsg{Type: tea.KeyTab}, false)
	case tea.KeyPgDown:
		taskID := m.terminalBoardNavTaskID
		m.clearTerminalBoardNav()
		m.terminalScrollOffset = max(0, m.terminalScrollOffset-10)
		return m.queueTerminalInputCmd(taskID, "\t", tea.KeyMsg{Type: tea.KeyTab}, false)
	case tea.KeyShiftUp:
		taskID := m.terminalBoardNavTaskID
		m.clearTerminalBoardNav()
		m.terminalScrollOffset += 1
		return m.queueTerminalInputCmd(taskID, "\t", tea.KeyMsg{Type: tea.KeyTab}, false)
	case tea.KeyShiftDown:
		taskID := m.terminalBoardNavTaskID
		m.clearTerminalBoardNav()
		m.terminalScrollOffset = max(0, m.terminalScrollOffset-1)
		return m.queueTerminalInputCmd(taskID, "\t", tea.KeyMsg{Type: tea.KeyTab}, false)
	}

	data := encodeTerminalKey(key)
	if data == "" {
		m.clearTerminalBoardNav()
		return nil
	}

	taskID := m.terminalBoardNavTaskID
	commandBeforeSubmit := m.terminalCommand
	m.clearTerminalBoardNav()
	m.terminalCommand = appendTerminalCommand(m.terminalCommand, key)
	if m.terminalScrollOffset != 0 {
		m.terminalScrollOffset = 0
	}

	return m.queueTerminalInputCmd(
		taskID,
		"\t"+data,
		key,
		shouldTriggerTerminalPushSync(commandBeforeSubmit, key),
	)
}

func (m *Model) flushPendingTerminalBoardNavCmd() tea.Cmd {
	taskID := m.terminalBoardNavTaskID
	consumed := m.terminalBoardNavConsumed
	m.clearTerminalBoardNav()
	if taskID == "" || consumed {
		return nil
	}
	return m.queueTerminalInputCmd(taskID, "\t", tea.KeyMsg{Type: tea.KeyTab}, false)
}

func (m *Model) clearTerminalBoardNav() {
	m.terminalBoardNavPending = false
	m.terminalBoardNavTaskID = ""
	m.terminalBoardNavConsumed = false
}

func (m *Model) armTerminalBoardNav(taskID string, consumed bool) tea.Cmd {
	m.terminalBoardNavPending = true
	m.terminalBoardNavTaskID = taskID
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

func (m *Model) openSessionCmd(taskID string, recreate bool) tea.Cmd {
	return func() tea.Msg {
		method := "openSession"
		if recreate {
			method = "recreateSession"
		}

		var session SessionRecord
		if err := m.client.Call(method, map[string]string{"taskId": taskID}, &session); err != nil {
			return sessionOpenedMsg{err: err}
		}

		var board BoardSnapshot
		if err := m.client.Call("getBoard", nil, &board); err != nil {
			return sessionOpenedMsg{err: err}
		}

		var buffer GetBufferResult
		if err := m.client.Call("getBuffer", map[string]string{"taskId": taskID}, &buffer); err != nil {
			return sessionOpenedMsg{err: err}
		}
		buffer.ANSILines = defaultANSILines(buffer.Lines, buffer.ANSILines)

		var activity *SessionActivitySnapshot
		var nextActivity SessionActivitySnapshot
		if err := m.client.Call("inspectSession", map[string]string{"taskId": taskID}, &nextActivity); err == nil && nextActivity.TaskID != "" {
			activity = &nextActivity
		}

		return sessionOpenedMsg{
			taskID:   taskID,
			session:  session,
			board:    &board,
			buffer:   &buffer,
			activity: activity,
		}
	}
}

func (m *Model) loadBufferCmd(taskID string) tea.Cmd {
	return func() tea.Msg {
		var buffer GetBufferResult
		err := m.client.Call("getBuffer", map[string]string{"taskId": taskID}, &buffer)
		buffer.ANSILines = defaultANSILines(buffer.Lines, buffer.ANSILines)
		return bufferLoadedMsg{taskID: taskID, buffer: buffer, err: err}
	}
}

func (m *Model) inspectSessionCmd(taskID string) tea.Cmd {
	return func() tea.Msg {
		var activity SessionActivitySnapshot
		err := m.client.Call("inspectSession", map[string]string{"taskId": taskID}, &activity)
		if err != nil {
			return sessionActivityMsg{taskID: taskID, activity: nil, err: err}
		}
		if activity.TaskID == "" {
			return sessionActivityMsg{taskID: taskID, activity: nil}
		}
		return sessionActivityMsg{taskID: taskID, activity: &activity}
	}
}

func (m *Model) sendInputCmd(taskID, data string) tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Notify("sendInput", map[string]string{"taskId": taskID, "data": data}); err != nil {
			return asyncErrorMsg{err: err}
		}
		return nil
	}
}

func (m *Model) syncCmd() tea.Cmd {
	m.syncInProgress = true
	return m.boardActionCmd("triggerSync", nil, "Sync complete.")
}

func (m *Model) schedulePostPushSyncCmd(taskID string) tea.Cmd {
	return func() tea.Msg {
		if err := m.client.Call("schedulePostPushSync", map[string]string{"taskId": taskID}, nil); err != nil {
			return boardActionMsg{err: err}
		}
		return boardActionMsg{status: "Watching pushed branch for PR creation."}
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

func (m *Model) resizeActiveSessionCmd() tea.Cmd {
	taskID := m.activeTaskID
	if taskID == "" || !m.terminalPaneShouldRender() {
		return nil
	}

	columns := m.terminalContentWidth()
	rows := m.terminalViewportHeight()
	if columns < 20 {
		columns = 20
	}
	if rows < 5 {
		rows = 5
	}

	return func() tea.Msg {
		err := m.client.Call("resizeSession", map[string]interface{}{
			"taskId": taskID,
			"cols":   columns,
			"rows":   rows,
		}, nil)
		if err != nil {
			return asyncErrorMsg{err: err}
		}
		return nil
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
	m.tasks = board.Tasks
	m.savedViews = board.SavedViews
	m.daemonConnected = true

	sessionTaskIDs := map[string]struct{}{}
	for _, task := range board.Tasks {
		if task.SessionID != "" {
			sessionTaskIDs[task.ID] = struct{}{}
		}
	}

	nextActivity := map[string]*SessionActivitySnapshot{}
	for taskID, activity := range m.sessionActivityByTaskID {
		if _, ok := sessionTaskIDs[taskID]; ok {
			nextActivity[taskID] = activity
		}
	}
	m.sessionActivityByTaskID = nextActivity

	if board.UIState.ActiveRepoID != "" || m.activeRepoID == "" {
		m.activeRepoID = board.UIState.ActiveRepoID
	}
	if board.UIState.ActiveViewID != "" || m.activeViewID == "" {
		m.activeViewID = board.UIState.ActiveViewID
	}
	if board.UIState.Filters != nil {
		m.filters = *board.UIState.Filters
	}
	if board.UIState.TerminalPaneVisible != nil {
		m.terminalPaneVisible = *board.UIState.TerminalPaneVisible
	}
	if board.UIState.TerminalLayoutMode != "" {
		m.terminalLayoutMode = board.UIState.TerminalLayoutMode
	}
	if board.UIState.ThemeMode != "" {
		m.themeMode = board.UIState.ThemeMode
	}

	if m.activeTaskID != "" && m.taskByID(m.activeTaskID) == nil {
		m.activeTaskID = ""
		m.activeSessionBranch = ""
		m.activeSessionBackendType = ""
		m.terminalPaneVisible = false
		m.terminalFullscreen = false
		m.terminalScrollOffset = 0
	}

	m.selectedTrackIndex = clamp(m.selectedTrackIndex, 0, max(0, len(m.sortedTracks())-1))
	m.selectedTaskIndex = clamp(m.selectedTaskIndex, 0, max(0, len(m.selectedTrackTasks())-1))
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

func (m *Model) repoByID(repoID string) *RepoRecord {
	for _, repo := range m.repos {
		if repo.ID == repoID {
			return &repo
		}
	}
	return nil
}

func (m *Model) sessionTaskIDs() []string {
	seen := map[string]struct{}{}
	ids := []string{}
	for _, task := range m.tasks {
		if task.SessionID != "" {
			seen[task.ID] = struct{}{}
			ids = append(ids, task.ID)
		}
	}
	if m.activeTaskID != "" {
		if _, ok := seen[m.activeTaskID]; !ok {
			ids = append(ids, m.activeTaskID)
		}
	}
	return ids
}

func (m *Model) terminalPaneShouldRender() bool {
	return m.terminalPaneVisible && m.activeTaskID != ""
}

func (m *Model) boardRenderWidth() int {
	return max(1, len(m.sortedTracks())) * trackColumnRenderWidth
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

func (m *Model) terminalViewportHeight() int {
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
	if height <= 2 {
		return max(1, height-terminalHeaderHeight)
	}
	return max(1, height-terminalHeaderHeight-terminalFooterHeight)
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
